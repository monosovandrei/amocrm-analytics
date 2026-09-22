import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { CrmControlCallSource, crmControlCallSourceIdentity } from './crm-control-call-source';

export interface CrmCallDownloadRoute {
  origin: string;
  /** Exact path shape, not an arbitrary regular expression or a wildcard prefix. */
  segments: readonly (string | { parameter: string; kind: 'digits' | 'uuid' | 'token'; suffix?: '.wav' | '.mp3' | '.ogg' | '.flac' | '.m4a' | '.amr' | '.aac' })[];
  trailingSlash?: boolean;
  query: readonly { name: string; required?: boolean; allowEmpty?: boolean }[];
  /** Every redirect must retain this exact recording identity, even when its signed token changes. */
  identity: { pathParameter: string } | { queryParameter: string };
}
export interface CrmCallDownloadRoutePolicy { kind?: 'routes'; routes: readonly CrmCallDownloadRoute[] }
/** Exact permission for one server-loaded, directly bound call source. This is not an HTTP request DTO. */
export interface CrmCallFrozenSkytelPolicy {
  kind: 'frozen_skytel_mp3_v1'; sourceIdentityHash: string; exactUrlHash: string;
}
/** No generic/default provider permission. Omitted policy authorizes no download. */
export type CrmCallDownloadPolicy = CrmCallDownloadRoutePolicy | CrmCallFrozenSkytelPolicy;
export class CrmCallDownloadError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = 'CrmCallDownloadError'; }
}
export interface CrmCallDownloadResponse { status: number; headers: Record<string, string | undefined>; body: Readable }
export type CrmCallDownloadTransport = (url: string, signal: AbortSignal) => Promise<CrmCallDownloadResponse>;
export interface CrmCallRecordingArtifact {
  storageKey: string; sha256: string; size: number; contentType: string | null; format: string; capturedAt: string; sourceUrlHash: string;
}
const MAX_BYTES = 100 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const SKYTEL_ORIGIN = 'https://userapi.skytel.spb.ru';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const name = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value);
const fail = (code: string, retryable = false): never => { throw new CrmCallDownloadError(code, retryable); };
function rejectTraversal(raw: string) {
  const rawPath = raw.replace(/^[a-z]+:\/\/[^/?#]+/i, '').split(/[?#]/)[0];
  for (const part of rawPath.split('/')) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { return fail('CALL_URL_REJECTED'); }
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) return fail('CALL_URL_REJECTED');
  }
}
function safeUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(raw)) return fail('CALL_URL_REJECTED');
  let url: URL;
  try { url = new URL(raw); } catch { return fail('CALL_URL_REJECTED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname)
    || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    || /\.(?:local|localhost|internal|invalid|test)$/.test(url.hostname)) return fail('CALL_URL_REJECTED');
  // URL canonicalization must not hide path traversal before policy matching.
  rejectTraversal(raw);
  return url;
}

function frozenSkytelUrl(raw: unknown): string {
  const url = safeUrl(raw);
  // Exact source spelling is retained, including opaque punctuation. Encoded path separators cannot become another endpoint.
  if (typeof raw !== 'string' || !raw.startsWith(`${SKYTEL_ORIGIN}/`) || url.origin !== SKYTEL_ORIGIN
    || /[?#]/.test(raw) || url.search || url.hash) return fail('CALL_URL_REJECTED');
  const filename = raw.slice(SKYTEL_ORIGIN.length + 1);
  if (filename.length < 5 || filename.length > 1024 || filename.includes('/') || !filename.endsWith('.mp3')) return fail('CALL_URL_REJECTED');
  let decoded: string;
  try { decoded = decodeURIComponent(filename); } catch { return fail('CALL_URL_REJECTED'); }
  if (!decoded.slice(0, -4) || /[/\\%?#\u0000-\u001f\u007f]/.test(decoded)) return fail('CALL_URL_REJECTED');
  return raw;
}

/** The internal queue must rebuild this permission from its DB observation and compare sourceIdentityHash before downloading. */
export function createCrmControlSkytelRecordingPolicy(source: CrmControlCallSource): CrmCallFrozenSkytelPolicy {
  if (!source || source.status !== 'BOUND' || source.binding !== 'DIRECT_LEAD_NOTE' || !source.noteId || !source.ownerId
    || !source.observationId || !source.dealId || !HASH.test(source.snapshotHash) || !HASH.test(source.sourceHash)
    || source.sourceIdentityVersion !== 'call-source-v1' || !HASH.test(source.sourceIdentityHash)
    || !source.recordingUrl || !source.recordingUrlHash || !HASH.test(source.recordingUrlHash)
    || hash(source.recordingUrl) !== source.recordingUrlHash || crmControlCallSourceIdentity(source) !== source.sourceIdentityHash) {
    return fail('CALL_SOURCE_UNVERIFIED');
  }
  frozenSkytelUrl(source.recordingUrl);
  return { kind: 'frozen_skytel_mp3_v1', sourceIdentityHash: source.sourceIdentityHash, exactUrlHash: source.recordingUrlHash };
}

export function validateCrmCallRecordingUrl(raw: unknown, policy: CrmCallDownloadPolicy | undefined): { url: string; identity: string } {
  if (policy?.kind === 'frozen_skytel_mp3_v1') {
    if (!HASH.test(policy.sourceIdentityHash) || !HASH.test(policy.exactUrlHash) || 'routes' in policy) return fail('CALL_POLICY_INVALID');
    const url = frozenSkytelUrl(raw);
    if (hash(url) !== policy.exactUrlHash) return fail('CALL_URL_REJECTED');
    return { url, identity: policy.exactUrlHash };
  }
  if (!policy || !('routes' in policy) || !Array.isArray(policy.routes) || !policy.routes.length || policy.routes.length > 16) return fail('CALL_DOWNLOAD_NOT_CONFIGURED');
  const url = safeUrl(raw), matches: Array<{ url: string; identity: string }> = [];
  for (const route of policy.routes) {
    if (!route || !Array.isArray(route.segments) || !route.segments.length || route.segments.length > 16
      || !route.segments.some((segment: CrmCallDownloadRoute['segments'][number]) => typeof segment === 'string') || !Array.isArray(route.query) || route.query.length > 32
      || (route.trailingSlash !== undefined && typeof route.trailingSlash !== 'boolean')) return fail('CALL_POLICY_INVALID');
    const origin = safeUrl(route.origin);
    if (origin.origin !== route.origin || origin.pathname !== '/' || origin.search) return fail('CALL_POLICY_INVALID');
    const parameters = new Set<string>(), queryNames = new Set<string>();
    for (const segment of route.segments) {
      if (typeof segment === 'string') {
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(segment) || ['.', '..'].includes(segment)) return fail('CALL_POLICY_INVALID');
      } else if (!segment || !name(segment.parameter) || parameters.has(segment.parameter) || !['digits', 'uuid', 'token'].includes(segment.kind)
        || (segment.suffix !== undefined && !['.wav','.mp3','.ogg','.flac','.m4a','.amr','.aac'].includes(segment.suffix))) return fail('CALL_POLICY_INVALID');
      else parameters.add(segment.parameter);
    }
    for (const item of route.query) {
      if (!item || typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.name) || queryNames.has(item.name)
        || (item.required !== undefined && typeof item.required !== 'boolean') || (item.allowEmpty !== undefined && typeof item.allowEmpty !== 'boolean')) return fail('CALL_POLICY_INVALID');
      queryNames.add(item.name);
    }
    const identity = route.identity;
    if (!identity || Object.keys(identity).length !== 1 || ('pathParameter' in identity ? !parameters.has(identity.pathParameter)
      : !('queryParameter' in identity) || !queryNames.has(identity.queryParameter))) return fail('CALL_POLICY_INVALID');
    if (url.origin !== route.origin || url.pathname.endsWith('/') !== (route.trailingSlash === true)) continue;
    const parts = url.pathname.slice(1).replace(/\/$/, '').split('/').map(decodeURIComponent);
    if (parts.length !== route.segments.length) continue;
    const values = new Map<string, string>();
    const pathMatches = route.segments.every((segment: CrmCallDownloadRoute['segments'][number], index: number) => {
      if (typeof segment === 'string') return parts[index] === segment;
      const part = parts[index], suffix = segment.suffix ?? '';
      if (suffix && !part.endsWith(suffix)) return false;
      const value = suffix ? part.slice(0, -suffix.length) : part;
      const valid = segment.kind === 'digits' ? /^[1-9]\d{0,63}$/.test(value) : segment.kind === 'uuid'
        ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) : /^[A-Za-z0-9_-]{1,256}$/.test(value);
      if (valid) values.set(segment.parameter, value);
      return valid;
    });
    if (!pathMatches) continue;
    const seen = new Set<string>(); let queryValid = true;
    for (const [key, value] of url.searchParams) {
      const rule = route.query.find((item: CrmCallDownloadRoute['query'][number]) => item.name === key);
      if (!rule || seen.has(key) || (!value && !rule.allowEmpty) || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) queryValid = false;
      seen.add(key);
    }
    if (!queryValid || route.query.some((item: CrmCallDownloadRoute['query'][number]) => item.required && !seen.has(item.name))) continue;
    const value = 'pathParameter' in identity ? values.get(identity.pathParameter) : url.searchParams.get(identity.queryParameter);
    if (value) matches.push({ url: url.href, identity: value });
  }
  if (matches.length !== 1) return fail('CALL_URL_REJECTED');
  return matches[0];
}

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],
  ['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip, prefix, 'ipv4');
const v6Global = new BlockList(); v6Global.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::',32],['2001:db8::',32],['2002::',16]] as const) blocked.addSubnet(ip, prefix, 'ipv6');
export function isCrmCallPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && v6Global.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

/** DNS is checked and pinned to the socket. No browser cookies, OAuth, referer or caller-supplied headers enter this transport. */
const transport: CrmCallDownloadTransport = (url, signal) => new Promise((resolve, reject) => {
  const request = httpsRequest(url, { method: 'GET', agent: false, signal, headers: { Accept: 'audio/*,application/octet-stream', 'Accept-Encoding': 'identity' },
    lookup: (hostname, _options, callback) => {
      void lookup(hostname, { all: true, verbatim: true }).then(addresses => {
        if (signal.aborted) return callback(new CrmCallDownloadError('CALL_DOWNLOAD_CANCELLED'), '', 4);
        if (!addresses.length || addresses.some(item => !isCrmCallPublicAddress(item.address))) return callback(new CrmCallDownloadError('CALL_ADDRESS_REJECTED'), '', 4);
        // Agent-free single socket: do not let a second DNS lookup select an unchecked address.
        if (_options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }, () => callback(new CrmCallDownloadError('CALL_DOWNLOAD_UNAVAILABLE', true), '', 4));
    } }, response => {
    response.on('error', () => undefined); // An abort may arrive before the archive reader is attached.
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(',') : value;
    resolve({ status: response.statusCode ?? 0, headers, body: response });
  });
  request.once('error', reject); request.end();
});
function audioFormat(bytes: Buffer): string | null {
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (bytes.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  if (bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'mov';
  if (bytes.toString('ascii', 0, 6) === '#!AMR\n' || bytes.toString('ascii', 0, 9) === '#!AMR-WB\n') return 'amr';
  if (bytes.toString('ascii', 0, 3) === 'ID3') return 'mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return (bytes[1] & 0x06) === 0 ? 'aac' : 'mp3';
  return null;
}
async function existingArchive(target: string, expected: string, size: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size || (process.platform !== 'win32' && (stat.mode & 0o077))) return fail('CALL_ARCHIVE_INVALID');
  const digest = createHash('sha256'); let read = 0;
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) {
    signal.throwIfAborted();
    read += chunk.length; if (read > size) return fail('CALL_ARCHIVE_INVALID'); digest.update(chunk);
  } } finally { await handle.close(); }
  if (read !== size || digest.digest('hex') !== expected) return fail('CALL_ARCHIVE_INVALID');
}

/** One attempt only. A persistent caller owns retry budgets; this function never silently retries or refreshes source URLs. */
export async function archiveCrmControlCallRecording(url: string, policy: CrmCallDownloadPolicy | undefined,
  options: { directory: string; signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; transport?: CrmCallDownloadTransport }): Promise<CrmCallRecordingArtifact> {
  const initial = validateCrmCallRecordingUrl(url, policy);
  const maximum = options.maxBytes ?? MAX_BYTES, timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_BYTES || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return fail('CALL_DOWNLOAD_LIMIT_INVALID');
  const timeout = AbortSignal.timeout(timeoutMs), signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let temporary: string | undefined, body: Readable | undefined;
  try {
    signal.throwIfAborted();
    const directory = options.directory;
    if (!path.isAbsolute(directory) || directory.split(/[\\/]/).includes('..') || /^(?:\\\\|\/\/)/.test(directory)) return fail('CALL_ARCHIVE_INVALID');
    const root = path.resolve(directory), stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root || (process.platform !== 'win32' && (stat.mode & 0o077))) return fail('CALL_ARCHIVE_INVALID');
    let target = initial.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      const response = await (options.transport ?? transport)(target, signal); body = response.body;
      if ([301,302,303,307,308].includes(response.status)) {
        body.destroy(); body = undefined;
        if (policy?.kind === 'frozen_skytel_mp3_v1') return fail('CALL_REDIRECT_REJECTED');
        if (redirects === 3) return fail('CALL_REDIRECT_LIMIT');
        const location = response.headers.location;
        if (!location) return fail('CALL_REDIRECT_REJECTED');
        if (/[\u0000-\u0020\u007f\\]/.test(location)) return fail('CALL_REDIRECT_REJECTED');
        rejectTraversal(location);
        let resolved: string;
        try { resolved = new URL(location, target).href; } catch { return fail('CALL_REDIRECT_REJECTED'); }
        const next = validateCrmCallRecordingUrl(resolved, policy);
        if (next.identity !== initial.identity) return fail('CALL_REDIRECT_IDENTITY_CHANGED');
        target = next.url; continue;
      }
      if (response.status !== 200) return fail('CALL_DOWNLOAD_HTTP_ERROR', response.status === 408 || response.status === 429 || response.status >= 500 && response.status <= 599);
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') return fail('CALL_RESPONSE_REJECTED');
      const contentType = response.headers['content-type']?.split(';')[0].trim().toLowerCase() ?? null;
      if (contentType && !contentType.startsWith('audio/') && !['application/octet-stream','binary/octet-stream','application/ogg','video/mp4'].includes(contentType)) return fail('CALL_RESPONSE_REJECTED');
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) return fail('CALL_RECORDING_TOO_LARGE');
      temporary = path.join(root, `.call-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600), digest = createHash('sha256');
      let size = 0, header = Buffer.alloc(0);
      const abort = () => body?.destroy(new CrmCallDownloadError(options.signal?.aborted ? 'CALL_DOWNLOAD_CANCELLED' : 'CALL_DOWNLOAD_TIMEOUT', !options.signal?.aborted));
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        for await (const chunk of body) {
          signal.throwIfAborted(); const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.length; if (size > maximum) return fail('CALL_RECORDING_TOO_LARGE');
          if (header.length < 64) header = Buffer.concat([header, bytes.subarray(0, 64 - header.length)]);
          digest.update(bytes);
          for (let offset = 0; offset < bytes.length;) {
            const written = await file.write(bytes, offset, bytes.length - offset); if (!written.bytesWritten) return fail('CALL_ARCHIVE_UNAVAILABLE', true);
            offset += written.bytesWritten;
          }
        }
        if (!size || (length !== undefined && Number(length) !== size)) return fail('CALL_RESPONSE_INCOMPLETE', true);
        const format = audioFormat(header);
        if (!format || (policy?.kind === 'frozen_skytel_mp3_v1' && format !== 'mp3')) return fail('CALL_AUDIO_FORMAT_REJECTED');
        signal.throwIfAborted(); await file.sync(); await file.close();
        const sha256 = digest.digest('hex'), storageKey = `${sha256}.audio`, destination = path.join(root, storageKey);
        try { await link(temporary, destination); }
        catch (error: any) { if (error?.code !== 'EEXIST') throw error; await existingArchive(destination, sha256, size, signal); }
        await unlink(temporary); temporary = undefined;
        if (process.platform !== 'win32') { const folder = await open(root, constants.O_RDONLY); try { await folder.sync(); } finally { await folder.close(); } }
        return { storageKey, sha256, size, contentType, format, capturedAt: new Date().toISOString(), sourceUrlHash: createHash('sha256').update(initial.url).digest('hex') };
      } finally { signal.removeEventListener('abort', abort); await file.close().catch(() => undefined); }
    }
    return fail('CALL_REDIRECT_LIMIT');
  } catch (error) {
    if (error instanceof CrmCallDownloadError) throw error;
    if (options.signal?.aborted) return fail('CALL_DOWNLOAD_CANCELLED');
    if (timeout.aborted) return fail('CALL_DOWNLOAD_TIMEOUT', true);
    return fail('CALL_DOWNLOAD_UNAVAILABLE', true);
  } finally { body?.destroy(); if (temporary) await unlink(temporary).catch(() => undefined); }
}
