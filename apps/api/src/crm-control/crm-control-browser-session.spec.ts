import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireCrmBrowserSessionLease, CrmBrowserSessionError, CrmBrowserSessionLease } from './crm-control-browser-session';

const state = (value = 'synthetic-refresh-one') => ({ cookies: [{ name: 'refresh', value }], origins: [] });
const code = (value: string) => ({ code: `CRM_BROWSER_SESSION_${value}`, message: `CRM_BROWSER_SESSION_${value}` });
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('browser session lease and refresh persistence', () => {
  let directory: string, file: string;
  const leases: CrmBrowserSessionLease[] = [], children: ChildProcessWithoutNullStreams[] = [];
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'crm-session-')); file = path.join(directory, 'session.json'); });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exit;
      }
    }
    for (const lease of leases.splice(0)) await lease.release();
    await rm(directory, { recursive: true, force: true });
  });
  async function acquire(options?: Parameters<typeof acquireCrmBrowserSessionLease>[1]) {
    const lease = await acquireCrmBrowserSessionLease(file, options); leases.push(lease); return lease;
  }
  async function entries() { return (await readdir(`${file}.lock`)).filter(name => /^\d+-/.test(name)); }

  async function childHolder() {
    const script = `
      const {acquireCrmBrowserSessionLease}=require(process.argv[1]);
      (async()=>{const lease=await acquireCrmBrowserSessionLease(process.argv[2],{waitMs:3000});
        process.stdout.write('ACQUIRED\\n');
        process.stdin.on('data',async bytes=>{try {
          if(bytes.toString().trim()==='SAVE') {const previous=await lease.readState();await lease.saveState({cookies:[{name:'refresh',value:'synthetic-from-child'}],origins:[]},previous.rawHash);process.stdout.write('SAVED\\n');}
          else if(bytes.toString().trim()==='RELEASE') {await lease.release();process.exit(0);}
          else if(bytes.toString().trim()==='CRASH') process.exit(0);
        }catch{process.stdout.write('FAILED\\n');process.exit(1);}});
      })().catch(()=>{process.stdout.write('FAILED\\n');process.exit(1);});`;
    const child = spawn(process.execPath, ['-r', require.resolve('ts-node/register/transpile-only'), '-e', script,
      path.join(__dirname, 'crm-control-browser-session.ts'), file], { env: { ...process.env,
      TS_NODE_PROJECT: path.resolve(__dirname, '../../tsconfig.json') }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    let output = ''; const listeners = new Set<() => void>();
    child.stdout.on('data', chunk => { output += chunk; for (const listener of listeners) listener(); });
    child.stderr.resume();
    const wait = (marker: string) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Session child did not reach expected state')); }, 7000);
      const check = () => { if (output.includes(marker)) { clearTimeout(timer); listeners.delete(check); resolve(); }
        else if (output.includes('FAILED')) { clearTimeout(timer); listeners.delete(check); reject(new Error('Session child failed')); } };
      listeners.add(check); check();
    });
    await wait('ACQUIRED');
    return { child, wait, send: (command: string) => child.stdin.write(`${command}\n`),
      exit: () => new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); }) };
  }

  it('supports first login and persists exact hashes with private, complete JSON bytes', async () => {
    const lease = await acquire(); expect(await lease.readState()).toEqual({ state: null, rawHash: null });
    const result = await lease.saveState(state(), null), bytes = await readFile(file);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(state());
    expect(result.rawHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(await lease.readState()).toEqual({ state: state(), rawHash: result.rawHash });
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes concurrent callers and reads the token persisted by the previous holder', async () => {
    await writeFile(file, JSON.stringify(state()));
    const first = await acquire(), previous = await first.readState(); let secondEntered = false;
    const secondPromise = acquire({ waitMs: 1000 }).then(value => { secondEntered = true; return value; });
    await sleep(80); expect(secondEntered).toBe(false);
    await first.saveState(state('synthetic-refresh-two'), previous.rawHash); await first.release();
    const second = await secondPromise;
    expect(await second.readState()).toMatchObject({ state: state('synthetic-refresh-two') });
  });

  it('never has two active holders under contention and cleans every released contender', async () => {
    let active = 0, maximum = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      const lease = await acquire({ waitMs: 5000 }); active++; maximum = Math.max(maximum, active);
      await sleep(8); active--; await lease.release();
    }));
    expect(maximum).toBe(1); expect(await entries()).toEqual([]);
  });

  it('returns a bounded busy result without leaking session bytes or removing a live owner', async () => {
    const holder = await acquire(); await holder.saveState(state(), null);
    await expect(acquire({ waitMs: 0 })).rejects.toMatchObject(code('BUSY'));
    expect(await entries()).toHaveLength(1); expect(await holder.readState()).toMatchObject({ state: state() });
  });

  it('rejects a stale expected hash and preserves a new login written during the old browser session', async () => {
    const lease = await acquire(); const first = await lease.saveState(state(), null);
    await writeFile(file, JSON.stringify(state('synthetic-new-login')));
    await expect(lease.saveState(state('stale-refresh'), first.rawHash)).rejects.toMatchObject(code('CONFLICT'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state('synthetic-new-login'));
    expect((await readdir(directory)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('serializes saves on one lease so only the first writer can consume an expected hash', async () => {
    const lease = await acquire(); const first = await lease.saveState(state(), null);
    const results = await Promise.allSettled([lease.saveState(state('first'), first.rawHash), lease.saveState(state('second'), first.rawHash)]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject(code('CONFLICT'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state('first'));
  });

  it('is idempotent on release and a released holder cannot save over the next login', async () => {
    const lease = await acquire(); const initial = await lease.saveState(state(), null); await lease.release(); await lease.release();
    const next = await acquire(); const newer = await next.saveState(state('next'), initial.rawHash);
    await expect(lease.saveState(state('old'), initial.rawHash)).rejects.toMatchObject(code('LEASE_LOST'));
    expect((await next.readState()).rawHash).toBe(newer.rawHash);
  });

  it('does not remove a directory whose owner metadata was replaced', async () => {
    const lease = await acquire(), own = (await entries())[0], ownerFile = path.join(`${file}.lock`, own, 'owner.json');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')); owner.ticket++;
    await writeFile(ownerFile, JSON.stringify(owner));
    await expect(lease.saveState(state(), null)).rejects.toMatchObject(code('LEASE_LOST'));
    await lease.release(); expect(await entries()).toEqual([own]);
  });

  it.each(['not-json-synthetic-cookie', '{"cookies":[]}', '[]'])('rejects malformed state without returning its body (%s)', async text => {
    await writeFile(file, text); const lease = await acquire();
    await expect(lease.readState()).rejects.toMatchObject(code('STATE_INVALID'));
  });

  it('rejects relative, traversal and symlinked parent paths before opening a state file', async () => {
    await expect(acquireCrmBrowserSessionLease('relative-session.json')).rejects.toMatchObject(code('PATH_INVALID'));
    await expect(acquireCrmBrowserSessionLease(path.join(directory, 'child') + `${path.sep}..${path.sep}session.json`)).rejects.toMatchObject(code('PATH_INVALID'));
    const target = await mkdtemp(path.join(os.tmpdir(), 'crm-session-target-')), linked = path.join(directory, 'linked');
    try {
      await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(acquireCrmBrowserSessionLease(path.join(linked, 'session.json'))).rejects.toMatchObject(code('PATH_INVALID'));
      expect(await readdir(target)).toEqual([]);
    } finally { await rm(linked, { force: true }); await rm(target, { recursive: true, force: true }); }
  });

  it('rejects unsupported lease settings with fixed errors', async () => {
    for (const options of [{ waitMs: -1 }, { waitMs: 60_001 }, { staleMs: 20_000 }, { staleMs: NaN }]) {
      await expect(acquire(options)).rejects.toMatchObject(code('PATH_INVALID'));
    }
    expect(new CrmBrowserSessionError('CRM_BROWSER_SESSION_BUSY').message).not.toContain(directory);
  });

  it('serializes separate Node processes and sees the refreshed state after the first process releases', async () => {
    await writeFile(file, JSON.stringify(state())); const holder = await childHolder();
    await expect(acquire({ waitMs: 0 })).rejects.toMatchObject(code('BUSY'));
    holder.send('SAVE'); await holder.wait('SAVED'); holder.send('RELEASE'); await holder.exit();
    const next = await acquire(); expect(await next.readState()).toMatchObject({ state: state('synthetic-from-child') });
  }, 15000);

  it('never steals a live process lease even if its heartbeat is stale', async () => {
    const holder = await childHolder(), name = (await entries())[0], old = new Date(Date.now() - 60_000);
    await utimes(path.join(`${file}.lock`, name, 'heartbeat'), old, old);
    await expect(acquire({ waitMs: 0, staleMs: 30_000 })).rejects.toMatchObject(code('BUSY'));
    expect(await entries()).toEqual([name]); holder.send('RELEASE'); await holder.exit();
  }, 15000);

  it('recovers only a dead stale contender after a crash and retains complete persisted refresh bytes', async () => {
    await writeFile(file, JSON.stringify(state())); const holder = await childHolder();
    holder.send('SAVE'); await holder.wait('SAVED'); holder.send('CRASH'); await holder.exit();
    const name = (await entries())[0]; await expect(acquire({ waitMs: 0 })).rejects.toMatchObject(code('BUSY'));
    const old = new Date(Date.now() - 60_000); await utimes(path.join(`${file}.lock`, name, 'heartbeat'), old, old);
    const recovered = await acquire({ waitMs: 0, staleMs: 30_000 });
    expect(await recovered.readState()).toMatchObject({ state: state('synthetic-from-child') });
    expect(await entries()).not.toContain(name);
  }, 15000);

  it('does not reclaim an expired owner belonging to another hostname', async () => {
    const holder = await childHolder(); holder.send('CRASH'); await holder.exit();
    const name = (await entries())[0], ownerFile = path.join(`${file}.lock`, name, 'owner.json');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8')); owner.host = 'another-host-not-this-server';
    await writeFile(ownerFile, JSON.stringify(owner));
    const old = new Date(Date.now() - 60_000); await utimes(path.join(`${file}.lock`, name, 'heartbeat'), old, old);
    await expect(acquire({ waitMs: 0, staleMs: 30_000 })).rejects.toMatchObject(code('BUSY'));
    expect(await entries()).toEqual([name]);
  }, 15000);
});
