import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { archiveCrmControlCallRecording, CrmCallDownloadPolicy, CrmCallDownloadResponse,
  createCrmControlSkytelRecordingPolicy, isCrmCallPublicAddress, validateCrmCallRecordingUrl } from './crm-control-call-download';
import { normalizeCrmControlCallSources } from './crm-control-call-source';
const dns = require('node:dns/promises') as typeof import('node:dns/promises');
const https = require('node:https') as typeof import('node:https');

// Synthetic route only. This is not a declaration of the production provider's URL contract.
const origin = 'https://userapi.skytel.spb.ru';
const policy: CrmCallDownloadPolicy = { routes: [{ origin, segments: ['synthetic-recordings', { parameter: 'id', kind: 'digits', suffix: '.wav' }],
  query: [{ name: 'token', required: true }], identity: { pathParameter: 'id' } }] };
const source = `${origin}/synthetic-recordings/123.wav?token=synthetic-secret`;
const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([24,0,0,0]), Buffer.from('WAVEfmt '), Buffer.alloc(20)]);
const response = (extra: Partial<CrmCallDownloadResponse> = {}): CrmCallDownloadResponse => ({ status: 200,
  headers: { 'content-type': 'audio/wav', 'content-length': String(wav.length) }, body: Readable.from([wav.subarray(0, 7), wav.subarray(7)]), ...extra });
const error = (code: string, retryable = false) => expect.objectContaining({ code, message: code, retryable });
const frozenUrl = `${origin}/synthetic.2026-09-22_call:alpha+beta.mp3`;
function frozenSource(url = frozenUrl) {
  const observedAt = new Date('2026-09-22T16:05:00Z');
  return normalizeCrmControlCallSources({ id: 'observation-1', dealId: 'amo:100', dealExternalId: '100', managerId: 'manager-1',
    observedAt, snapshotHash: 'a'.repeat(64), snapshot: { observedAt: observedAt.toISOString(), sourceCompleteness: { deal: true },
      deal: { id: 'amo:100', externalId: '100', responsibleId: 'manager-1', createdAt: '2026-09-01T00:00:00Z' },
      notes: [{ externalId: '700', type: 'call_out', raw: { id: 700, entity_id: 100, note_type: 'call_out',
        created_at: Date.parse('2026-09-22T12:00:00Z') / 1000, params: { uniq: 'synthetic', link: url } } }] } }).sources[0];
}

describe('exact frozen Skytel recording permission', () => {
  it('accepts the observed root opaque MP3 only and carries the frozen source identity', () => {
    const bound = frozenSource(), exact = createCrmControlSkytelRecordingPolicy(bound);
    expect(exact).toEqual({ kind: 'frozen_skytel_mp3_v1', sourceIdentityHash: bound.sourceIdentityHash,
      exactUrlHash: createHash('sha256').update(frozenUrl).digest('hex') });
    expect(validateCrmCallRecordingUrl(frozenUrl, exact)).toEqual({ url: frozenUrl, identity: exact.exactUrlHash });
    expect(JSON.stringify(exact)).not.toContain('alpha');
    expect(() => validateCrmCallRecordingUrl(frozenUrl.replace('alpha', 'other'), exact)).toThrow('CALL_URL_REJECTED');
    expect(() => validateCrmCallRecordingUrl(frozenUrl, undefined)).toThrow('CALL_DOWNLOAD_NOT_CONFIGURED');
  });
  it.each([
    `${origin}/folder/recording.mp3`, `${origin}/recording.mp3?`, `${origin}/recording.mp3?token=synthetic`,
    `${origin}/recording.mp3#`, `${origin}/recording.MP3`, `${origin}/recording.wav`, `${origin}/recording.mp3/`,
    `${origin}/a/../recording.mp3`, `${origin}/recording%2fother.mp3`, `${origin}/recording%252fother.mp3`,
    `${origin}:443/recording.mp3`, 'https://other.example/recording.mp3',
  ])('rejects unreviewed shape even when its exact hash matches the source: %s', url => {
    expect(() => createCrmControlSkytelRecordingPolicy(frozenSource(url))).toThrow('CALL_URL_REJECTED');
  });
  it('cannot create permission from contact/unbound calls or changed source fields', () => {
    const bound = frozenSource();
    for (const change of [{ status: 'UNBOUND', binding: 'UNVERIFIED' }, { status: 'INVALID' }, { ownerId: 'other' },
      { observationId: 'other' }, { noteId: 'other' }, { sourceHash: 'b'.repeat(64) }, { snapshotHash: 'b'.repeat(64) },
      { recordingUrl: frozenUrl.replace('alpha', 'other') }, { recordingUrlHash: 'b'.repeat(64) }]) {
      expect(() => createCrmControlSkytelRecordingPolicy({ ...bound, ...change } as any)).toThrow('CALL_SOURCE_UNVERIFIED');
    }
  });
  it('rejects a hybrid policy instead of falling back to broader route permissions', () => {
    const exact = createCrmControlSkytelRecordingPolicy(frozenSource());
    expect(() => validateCrmCallRecordingUrl(frozenUrl, { ...exact, routes: policy.routes } as any)).toThrow('CALL_POLICY_INVALID');
  });
});

describe('explicit provider recording policy', () => {
  it('is disabled by default and matches only the explicitly approved path/parameters', () => {
    expect(() => validateCrmCallRecordingUrl(source, undefined)).toThrow('CALL_DOWNLOAD_NOT_CONFIGURED');
    expect(() => validateCrmCallRecordingUrl(source, { routes: [] })).toThrow('CALL_DOWNLOAD_NOT_CONFIGURED');
    expect(validateCrmCallRecordingUrl(source, policy)).toEqual({ url: source, identity: '123' });
  });
  it.each([
    source.replace('https:', 'http:'), source.replace('skytel.spb.ru', 'skytel.spb.ru.attacker.com'),
    source.replace('userapi.skytel.spb.ru', '127.0.0.1'), source.replace('https://', 'https://login:password@'),
    source.replace('synthetic-recordings', 'any-path'), source.replace('/123.wav', '/123/another.wav'),
    source.replace('/123.wav', '/%2e%2e/synthetic-recordings/123.wav'), source.replace('/123.wav', '/12%2f3.wav'),
    source + '#fragment', source + '&token=duplicate', source + '&unexpected=1', source.replace('?token=synthetic-secret', ''),
  ])('rejects an unapproved URL without printing it: %s', value => {
    expect(() => validateCrmCallRecordingUrl(value, policy)).toThrow('CALL_URL_REJECTED');
  });
  it('rejects policies without a fixed path or stable recording identity', () => {
    expect(() => validateCrmCallRecordingUrl(source, { routes: [{ ...policy.routes[0], segments: [{ parameter: 'id', kind: 'token' }] }] })).toThrow('CALL_POLICY_INVALID');
    expect(() => validateCrmCallRecordingUrl(source, { routes: [{ ...policy.routes[0], identity: { queryParameter: 'missing' } }] })).toThrow('CALL_POLICY_INVALID');
  });
  it('supports an explicitly named query identity but rejects ambiguous overlapping routes', () => {
    const queryPolicy: CrmCallDownloadPolicy = { routes: [{ origin, segments: ['synthetic-download'],
      query: [{ name: 'record', required: true }, { name: 'token', required: true }], identity: { queryParameter: 'record' } }] };
    expect(validateCrmCallRecordingUrl(`${origin}/synthetic-download?record=record-1&token=synthetic`, queryPolicy).identity).toBe('record-1');
    expect(() => validateCrmCallRecordingUrl(source, { routes: [policy.routes[0], policy.routes[0]] })).toThrow('CALL_URL_REJECTED');
  });
  it.each(['127.0.0.1','10.1.2.3','192.168.1.2','100.64.0.1','169.254.169.254','0.0.0.0','224.1.2.3','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::1'])('rejects internal/reserved DNS address %s', address => {
    expect(isCrmCallPublicAddress(address)).toBe(false);
  });
  it('allows public IPv4 and IPv6 addresses only', () => {
    expect(isCrmCallPublicAddress('93.184.216.34')).toBe(true);
    expect(isCrmCallPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('one-attempt private recording archive', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), 'crm-call-download-')); });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('crm-call-download-')) throw Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  it('streams verified bytes to one content-addressed artifact, cleans temporary files and preserves deduplication', async () => {
    const download = jest.fn(async () => response());
    const first = await archiveCrmControlCallRecording(source, policy, { directory, transport: download });
    const second = await archiveCrmControlCallRecording(source, policy, { directory, transport: download });
    expect(first).toMatchObject({ size: wav.length, sha256: createHash('sha256').update(wav).digest('hex'), format: 'wav' });
    expect(second.storageKey).toBe(first.storageKey);
    expect(await readFile(path.join(directory, first.storageKey))).toEqual(wav);
    expect(await readdir(directory)).toEqual([first.storageKey]);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret'); expect(JSON.stringify(first)).not.toContain(origin);
  });
  it('never replaces an existing corrupted file under the same content hash', async () => {
    const key = `${createHash('sha256').update(wav).digest('hex')}.audio`;
    await writeFile(path.join(directory, key), Buffer.alloc(wav.length, 1), { mode: 0o600 });
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: async () => response() })).rejects.toEqual(error('CALL_ARCHIVE_INVALID'));
    expect(await readFile(path.join(directory, key))).toEqual(Buffer.alloc(wav.length, 1)); expect(await readdir(directory)).toEqual([key]);
  });
  it('archives exact bound MP3 bytes with the original frozen URL hash', async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);
    const exact = createCrmControlSkytelRecordingPolicy(frozenSource());
    const artifact = await archiveCrmControlCallRecording(frozenUrl, exact, { directory, transport: async () => response({
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(mp3.length) }, body: Readable.from([mp3]),
    }) });
    expect(artifact).toMatchObject({ format: 'mp3', sourceUrlHash: exact.exactUrlHash, size: mp3.length });
    expect(await readFile(path.join(directory, artifact.storageKey))).toEqual(mp3);
  });
  it('rejects a different audio format behind the frozen MP3 URL', async () => {
    const exact = createCrmControlSkytelRecordingPolicy(frozenSource());
    await expect(archiveCrmControlCallRecording(frozenUrl, exact, { directory, transport: async () => response() }))
      .rejects.toEqual(error('CALL_AUDIO_FORMAT_REJECTED'));
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([frozenUrl, '/same-provider-different.mp3', 'https://other.example/recording.mp3'])('never follows any exact-source redirect: %s', location => {
    const download = jest.fn(async () => response({ status: 302, headers: { location } }));
    const exact = createCrmControlSkytelRecordingPolicy(frozenSource());
    return expect(archiveCrmControlCallRecording(frozenUrl, exact, { directory, transport: download })).rejects.toEqual(error('CALL_REDIRECT_REJECTED'))
      .then(async () => { expect(download).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]); });
  });
  it('permits an approved same-record redirect with a new token, never copying the old query', async () => {
    const download = jest.fn().mockResolvedValueOnce(response({ status: 302, headers: { location: '/synthetic-recordings/123.wav?token=fresh' } }))
      .mockResolvedValueOnce(response());
    await archiveCrmControlCallRecording(source, policy, { directory, transport: download });
    expect(download.mock.calls.map(call => call[0])).toEqual([source, `${origin}/synthetic-recordings/123.wav?token=fresh`]);
    expect(download.mock.calls.every(call => call.length === 2 && call[1] instanceof AbortSignal)).toBe(true);
  });
  it.each([
    ['/synthetic-recordings/456.wav?token=new', 'CALL_REDIRECT_IDENTITY_CHANGED'],
    ['https://attacker.com/synthetic-recordings/123.wav?token=new', 'CALL_URL_REJECTED'],
    ['/a/../synthetic-recordings/123.wav?token=new', 'CALL_URL_REJECTED'],
  ])('rejects redirect %s before issuing another request', async (location, code) => {
    const download = jest.fn(async () => response({ status: 302, headers: { location } }));
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: download })).rejects.toEqual(error(code));
    expect(download).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]);
  });
  it('bounds redirect loops and closes each discarded response body', async () => {
    const bodies: Readable[] = [];
    const download = jest.fn(async () => {
      const reply = response({ status: 302, headers: { location: '/synthetic-recordings/123.wav?token=loop' } }); bodies.push(reply.body); return reply;
    });
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: download })).rejects.toEqual(error('CALL_REDIRECT_LIMIT'));
    expect(download).toHaveBeenCalledTimes(4); expect(bodies.every(body => body.destroyed)).toBe(true); expect(await readdir(directory)).toEqual([]);
  });
  it('rejects malformed redirect targets permanently', async () => {
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: async () => response({ status: 302, headers: { location: 'https://[' } }) }))
      .rejects.toEqual(error('CALL_REDIRECT_REJECTED'));
  });
  it.each([[403, false], [404, false], [408, true], [429, true], [503, true]])('classifies HTTP %s without internal retries or response-body leaks', async (status, retryable) => {
    const download = jest.fn(async () => response({ status, body: Readable.from(['private diagnostic token']) }));
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: download })).rejects.toEqual(error('CALL_DOWNLOAD_HTTP_ERROR', retryable));
    expect(download).toHaveBeenCalledTimes(1); expect(await readdir(directory)).toEqual([]);
  });
  it.each([
    [() => response(), 10, 'CALL_RECORDING_TOO_LARGE'],
    [() => response({ headers: {}, body: Readable.from([wav, wav]) }), wav.length, 'CALL_RECORDING_TOO_LARGE'],
    [() => response({ headers: { 'content-type': 'text/html' } }), 100, 'CALL_RESPONSE_REJECTED'],
    [() => response({ headers: { 'content-encoding': 'gzip' } }), 100, 'CALL_RESPONSE_REJECTED'],
    [() => response({ headers: {}, body: Readable.from(['#EXTM3U\nhttps://private.example/audio']) }), 100, 'CALL_AUDIO_FORMAT_REJECTED'],
  ] as const)('rejects oversized/non-audio content and removes every partial file', async (make, maxBytes, code) => {
    await expect(archiveCrmControlCallRecording(source, policy, { directory, maxBytes, transport: async () => make() })).rejects.toEqual(error(code));
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects an incomplete body as a bounded retryable failure', async () => {
    await expect(archiveCrmControlCallRecording(source, policy, { directory, transport: async () => response({ headers: { 'content-length': '99' } }) }))
      .rejects.toEqual(error('CALL_RESPONSE_INCOMPLETE', true));
    expect(await readdir(directory)).toEqual([]);
  });
  it('honors cancellation before any transport and during a stalled body', async () => {
    const controller = new AbortController(); controller.abort(); const download = jest.fn(async () => response());
    await expect(archiveCrmControlCallRecording(source, policy, { directory, signal: controller.signal, transport: download })).rejects.toEqual(error('CALL_DOWNLOAD_CANCELLED'));
    expect(download).not.toHaveBeenCalled();
    const running = new AbortController(), body = new PassThrough();
    const pending = archiveCrmControlCallRecording(source, policy, { directory, signal: running.signal, transport: async () => {
      setTimeout(() => running.abort(), 15); return response({ headers: {}, body });
    } });
    await expect(pending).rejects.toEqual(error('CALL_DOWNLOAD_CANCELLED')); expect(body.destroyed).toBe(true); expect(await readdir(directory)).toEqual([]);
  });
  it('times out a stalled body without publishing an archive', async () => {
    await expect(archiveCrmControlCallRecording(source, policy, { directory, timeoutMs: 15,
      transport: async () => response({ headers: {}, body: new PassThrough() }) })).rejects.toEqual(error('CALL_DOWNLOAD_TIMEOUT', true));
    expect(await readdir(directory)).toEqual([]);
  });
  it('pins checked DNS addresses to the native TLS request and sends no credentials', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
    const native = jest.spyOn(https, 'request').mockImplementation(((url: string, options: any, complete: any) => {
      const request: any = new EventEmitter(); request.end = () => options.lookup(new URL(url).hostname, { all: true }, (failure: Error | null, addresses: any) => {
        if (failure) { request.emit('error', failure); return; }
        expect(addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
        const body: any = Readable.from([wav]); body.statusCode = 200; body.headers = { 'content-type': 'audio/wav' }; complete(body);
      }); return request;
    }) as any);
    await archiveCrmControlCallRecording(source, policy, { directory });
    const options = (native.mock.calls[0] as any)[1];
    expect(options.agent).toBe(false); expect(options.headers).toEqual({ Accept: 'audio/*,application/octet-stream', 'Accept-Encoding': 'identity' });
    expect(dns.lookup).toHaveBeenCalledTimes(1);
  });
  it('rejects a DNS answer containing even one private address before response bytes arrive', async () => {
    jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }] as any);
    jest.spyOn(https, 'request').mockImplementation(((url: string, options: any) => {
      const request: any = new EventEmitter(); request.end = () => options.lookup(new URL(url).hostname, {}, (failure: Error) => request.emit('error', failure)); return request;
    }) as any);
    await expect(archiveCrmControlCallRecording(source, policy, { directory })).rejects.toEqual(error('CALL_ADDRESS_REJECTED'));
    expect(await readdir(directory)).toEqual([]);
  });
});
