import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type CrmBrowserSessionErrorCode = 'CRM_BROWSER_SESSION_PATH_INVALID' | 'CRM_BROWSER_SESSION_BUSY'
  | 'CRM_BROWSER_SESSION_LEASE_LOST' | 'CRM_BROWSER_SESSION_STATE_INVALID' | 'CRM_BROWSER_SESSION_CONFLICT'
  | 'CRM_BROWSER_SESSION_IO';
export class CrmBrowserSessionError extends Error {
  constructor(readonly code: CrmBrowserSessionErrorCode) { super(code); this.name = 'CrmBrowserSessionError'; }
}
export interface CrmBrowserSessionLease {
  /** null/null is the first-login case. No credentials or paths occur in errors. */
  readState(): Promise<{ state: unknown; rawHash: string | null }>;
  /** Every login/refresh writer must hold this same lease. Compare against the bytes returned by readState. */
  saveState(state: unknown, expectedRawHash: string | null): Promise<{ rawHash: string }>;
  release(): Promise<void>;
}
export interface CrmBrowserSessionLeaseOptions { waitMs?: number; staleMs?: number }

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const HOST = os.hostname();
const ENTRY = /^(\d+)-([a-f0-9-]{36})$/;
const HASH = /^[a-f0-9]{64}$/;
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const fault = (code: CrmBrowserSessionErrorCode): never => { throw new CrmBrowserSessionError(code); };
const safeError = (error: unknown): never => { if (error instanceof CrmBrowserSessionError) throw error; return fault('CRM_BROWSER_SESSION_IO'); };
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function plainPath(value: string, includeLeaf: boolean): Promise<string> {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0')
    || /^(?:\\\\|\/\/)/.test(value) || value.split(/[\\/]/).includes('..')) return fault('CRM_BROWSER_SESSION_PATH_INVALID');
  const absolute = path.resolve(value), target = includeLeaf ? absolute : path.dirname(absolute);
  const root = path.parse(target).root; let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return fault('CRM_BROWSER_SESSION_PATH_INVALID');
  }
  if (await realpath(target) !== target) return fault('CRM_BROWSER_SESSION_PATH_INVALID');
  return absolute;
}

interface Owner { version: 1; pid: number; host: string; nonce: string; ticket: number | null }
interface Contender { directory: string; name: string; owner: Owner; heartbeat: number }
async function contender(root: string, name: string): Promise<Contender | null> {
  const parts = ENTRY.exec(name);
  if (!parts) return null;
  const directory = path.join(root, name);
  try {
    await plainPath(directory, true);
    const file = path.join(directory, 'owner.json'), heartbeatFile = path.join(directory, 'heartbeat');
    const [stat, beat] = await Promise.all([lstat(file), lstat(heartbeatFile)]);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048 || !beat.isFile() || beat.isSymbolicLink()) return fault('CRM_BROWSER_SESSION_LEASE_LOST');
    const owner = JSON.parse(await readFile(file, 'utf8')) as Owner;
    if (owner.version !== 1 || owner.pid !== Number(parts[1]) || owner.nonce !== parts[2] || typeof owner.host !== 'string'
      || (owner.ticket !== null && (!Number.isSafeInteger(owner.ticket) || owner.ticket < 1))) return fault('CRM_BROWSER_SESSION_LEASE_LOST');
    return { directory, name, owner, heartbeat: beat.mtimeMs };
  } catch (error) { if (missing(error)) return null; throw error; }
}
async function contenders(root: string) {
  return (await Promise.all((await readdir(root)).filter(name => ENTRY.test(name)).map(name => contender(root, name))))
    .filter((item): item is Contender => !!item);
}
function definitelyDead(owner: Owner) {
  if (owner.host !== HOST) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ESRCH'; }
}
async function reap(item: Contender, staleMs: number): Promise<boolean> {
  if (Date.now() - item.heartbeat <= staleMs || !definitelyDead(item.owner)) return false;
  // The unique pid+nonce path is never reused. Removing it cannot steal a replacement owner's lease.
  await rm(item.directory, { recursive: true, force: true });
  return true;
}
function validState(state: unknown) {
  return !!state && typeof state === 'object' && !Array.isArray(state)
    && Array.isArray((state as { cookies?: unknown }).cookies) && Array.isArray((state as { origins?: unknown }).origins);
}
async function stateBytes(statePath: string): Promise<Buffer | null> {
  await plainPath(statePath, false);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) return fault('CRM_BROWSER_SESSION_STATE_INVALID');
    handle = await open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const pinned = await handle.stat();
    if (!pinned.isFile() || pinned.size > MAX_STATE_BYTES) return fault('CRM_BROWSER_SESSION_STATE_INVALID');
    const bytes = Buffer.alloc(pinned.size + 1); let count = 0;
    while (count < bytes.length) {
      const part = await handle.read(bytes, count, bytes.length - count, count);
      if (!part.bytesRead) break; count += part.bytesRead;
    }
    if (count !== pinned.size) return fault('CRM_BROWSER_SESSION_CONFLICT');
    return bytes.subarray(0, count);
  } catch (error) { if (missing(error)) return null; throw error; }
  finally { await handle?.close(); }
}

/**
 * A filesystem Lamport bakery lock with dynamic, unique contenders. Unlike deleting a common stale lock,
 * recovery never has a pathname ABA race with a new owner. A live PID is never evicted by clock/GC delays.
 * Local filesystems only: all API/worker/login callers must use this module and the same absolute state path.
 */
export async function acquireCrmBrowserSessionLease(statePath: string, options: CrmBrowserSessionLeaseOptions = {}): Promise<CrmBrowserSessionLease> {
  const waitMs = options.waitMs ?? 3000, staleMs = options.staleMs ?? 45_000;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60_000 || !Number.isInteger(staleMs) || staleMs < 30_000 || staleMs > 600_000) return fault('CRM_BROWSER_SESSION_PATH_INVALID');
  let own: Contender | undefined, preparing: string | undefined, heartbeatTimer: NodeJS.Timeout | undefined;
  try {
    const target = await plainPath(statePath, false), root = `${target}.lock`;
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await plainPath(root, true);
    if (!(await lstat(root)).isDirectory()) return fault('CRM_BROWSER_SESSION_PATH_INVALID');
    const nonce = randomUUID(), name = `${process.pid}-${nonce}`, directory = path.join(root, name);
    const owner: Owner = { version: 1, pid: process.pid, host: HOST, nonce, ticket: null };
    preparing = path.join(root, `.prepare-${name}`);
    await mkdir(preparing, { mode: 0o700 });
    await writeFile(path.join(preparing, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(preparing, 'heartbeat'), '', { flag: 'wx', mode: 0o600 });
    await rename(preparing, directory); preparing = undefined;
    own = { directory, name, owner, heartbeat: Date.now() };
    const initial = await contenders(root);
    for (const item of initial) if (item.name !== name) await reap(item, staleMs);
    owner.ticket = Math.max(0, ...initial.map(item => item.owner.ticket ?? 0)) + 1;
    if (!Number.isSafeInteger(owner.ticket)) return fault('CRM_BROWSER_SESSION_LEASE_LOST');
    const published = path.join(directory, `${nonce}.json`);
    await writeFile(published, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    await rename(published, path.join(directory, 'owner.json'));
    const deadline = Date.now() + waitMs;
    while (true) {
      let waiting = false;
      for (const item of await contenders(root)) {
        if (item.name === name || await reap(item, staleMs)) continue;
        if (item.owner.ticket === null || item.owner.ticket < owner.ticket || (item.owner.ticket === owner.ticket && item.name < name)) waiting = true;
      }
      if (!waiting) break;
      if (Date.now() >= deadline) return fault('CRM_BROWSER_SESSION_BUSY');
      await delay(Math.min(50, deadline - Date.now()));
    }
    let closed = false, lost = false, pending = Promise.resolve();
    const assertOwner = async () => {
      if (closed || lost) return fault('CRM_BROWSER_SESSION_LEASE_LOST');
      await plainPath(root, true);
      const current = await contender(root, name);
      if (!current || current.owner.nonce !== nonce || current.owner.ticket !== owner.ticket || current.owner.pid !== process.pid || current.owner.host !== HOST) return fault('CRM_BROWSER_SESSION_LEASE_LOST');
    };
    const touch = async () => { try { await assertOwner(); const now = new Date(); await utimes(path.join(directory, 'heartbeat'), now, now); } catch { lost = true; } };
    heartbeatTimer = setInterval(() => { void touch(); }, 10_000); heartbeatTimer.unref();
    // Saves and release are serialized within one lease, too. A heartbeat never overwrites owner metadata.
    const ordered = <T>(action: () => Promise<T>): Promise<T> => {
      const result = pending.then(action); pending = result.then(() => undefined, () => undefined); return result;
    };
    const read = async () => {
      await assertOwner(); const bytes = await stateBytes(target); await assertOwner();
      if (!bytes) return { state: null, rawHash: null };
      let state: unknown;
      try { state = JSON.parse(bytes.toString('utf8')); } catch { return fault('CRM_BROWSER_SESSION_STATE_INVALID'); }
      if (!validState(state)) return fault('CRM_BROWSER_SESSION_STATE_INVALID');
      return { state, rawHash: digest(bytes) };
    };
    return {
      readState: () => ordered(async () => { try { return await read(); } catch (error) { return safeError(error); } }),
      saveState: (state, expectedRawHash) => ordered(async () => {
        let temporary: string | undefined;
        try {
          await assertOwner();
          if (!validState(state) || (expectedRawHash !== null && (typeof expectedRawHash !== 'string' || !HASH.test(expectedRawHash)))) return fault('CRM_BROWSER_SESSION_STATE_INVALID');
          const serialized = JSON.stringify(state);
          if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) return fault('CRM_BROWSER_SESSION_STATE_INVALID');
          const current = await stateBytes(target);
          if ((current ? digest(current) : null) !== expectedRawHash) return fault('CRM_BROWSER_SESSION_CONFLICT');
          temporary = `${target}.${nonce}.${randomUUID()}.tmp`;
          const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          try { await handle.writeFile(serialized, 'utf8'); await handle.sync(); } finally { await handle.close(); }
          await assertOwner();
          const beforeReplace = await stateBytes(target);
          if ((beforeReplace ? digest(beforeReplace) : null) !== expectedRawHash) return fault('CRM_BROWSER_SESSION_CONFLICT');
          await rename(temporary, target); temporary = undefined;
          if (process.platform !== 'win32') {
            const parent = await open(path.dirname(target), constants.O_RDONLY);
            try { await parent.sync(); } finally { await parent.close(); }
          }
          return { rawHash: digest(serialized) };
        } catch (error) { return safeError(error); }
        finally { if (temporary) await unlink(temporary).catch(() => undefined); }
      }),
      release: () => ordered(async () => {
        if (closed) return;
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          // A failed heartbeat can mark this lease lost while its own unique directory still needs cleanup.
          const current = await contender(root, name);
          if (current && current.owner.nonce === nonce && current.owner.ticket === owner.ticket
            && current.owner.pid === process.pid && current.owner.host === HOST) await rm(directory, { recursive: true, force: true });
        }
        catch (error) { if (!(error instanceof CrmBrowserSessionError) && !missing(error)) return safeError(error); }
        finally { closed = true; }
      }),
    };
  } catch (error) {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (preparing) await rm(preparing, { recursive: true, force: true }).catch(() => undefined);
    if (own) await rm(own.directory, { recursive: true, force: true }).catch(() => undefined);
    return safeError(error);
  }
}
