import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { CrmControlLocalExtractionClient, CrmControlLocalExtractionOptions, CrmControlLocalSource } from './crm-control-local-extraction.client';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

describe('local document and ASR subprocess boundary', () => {
  let directory: string, options: CrmControlLocalExtractionOptions, source: CrmControlLocalSource;
  let launch: jest.Mock, child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: jest.Mock };
  let respond: ((request: any, script: string) => Promise<void>) | null;
  const client = () => new CrmControlLocalExtractionClient(options, launch as unknown as typeof spawn);
  const document = () => ({ extractorVersion: 'local-documents-v1', sourceSha256: source.sha256,
    format: 'pdf', mimeType: 'application/pdf', status: 'COMPLETE', problems: [], textChars: 17,
    units: [{ locator: { kind: 'page', page: 1 }, text: 'Синтетический PDF', complete: true }] });
  const transcript = () => ({ wrapperVersion: 'local-asr-v1', sourceSha256: source.sha256, cacheKey: 'a'.repeat(64),
    modelSha256: options.whisper!.modelSha256, binarySha256: 'b'.repeat(64), durationMs: 1000, channelCount: 1,
    status: 'UNVERIFIED', processingComplete: true, channelBinding: null, problems: ['ASR_UNVERIFIED', 'SPEAKER_ROLES_UNKNOWN'],
    segments: [{ channel: 0, startMs: 0, endMs: 900, text: 'Синтетическая речь', textHash: hash('Синтетическая речь'),
      actor: { role: 'unknown', actorId: null }, quality: 'ASR_UNVERIFIED' }] });

  async function artifact(payload: any, recording = false) {
    const folder = path.join(directory, recording ? '.transcribed/local-asr-v1' : '.extracted/local-documents-v1');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // Python writes canonical sorted keys, including nested channel metadata.
    const bytes = JSON.stringify(payload, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    const outputPath = path.join(folder, `${recording ? payload.cacheKey : source.sha256}.${hash(bytes)}.json`);
    await writeFile(outputPath, bytes, { mode: 0o600 });
    return { ok: true, sha256: source.sha256, status: payload.status, cacheHit: false, outputPath,
      ...(recording ? { wrapperVersion: payload.wrapperVersion, processingComplete: payload.processingComplete, segmentCount: payload.segments.length }
        : { extractorVersion: payload.extractorVersion, unitCount: payload.units.length }) };
  }
  function close(summary: any) { child.stdout.end(JSON.stringify(summary)); child.emit('close', 0); }
  async function started() {
    for (let index = 0; index < 50 && !launch.mock.calls.length; index++) await new Promise(resolve => setTimeout(resolve, 2));
    expect(launch).toHaveBeenCalledTimes(1);
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'crm-local-extraction-'));
    const scripts = path.join(directory, 'scripts');
    await mkdir(scripts);
    for (const file of ['extract.py', 'transcribe.py', 'model.bin', 'whisper-cli']) await writeFile(path.join(scripts, file), 'synthetic');
    const filePath = path.join(directory, 'source.bin');
    await writeFile(filePath, 'synthetic-file');
    source = { filePath, sha256: hash('synthetic-file'), mimeType: null };
    options = { pythonPath: process.execPath, scriptsDirectory: scripts, documentDirectory: directory, recordingDirectory: directory,
      whisper: { binaryPath: path.join(scripts, 'whisper-cli'), modelPath: path.join(scripts, 'model.bin'), modelSha256: hash('synthetic') } };
    respond = async (_request, script) => close(await artifact(script.endsWith('transcribe.py') ? transcript() : document(), script.endsWith('transcribe.py')));
    launch = jest.fn((_python, args) => {
      child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() });
      child.kill.mockImplementation(() => { setImmediate(() => child.emit('close', null)); return true; });
      const chunks: Buffer[] = [];
      child.stdin.on('data', data => chunks.push(data));
      child.stdin.on('finish', () => { if (respond) void respond(JSON.parse(Buffer.concat(chunks).toString()), args[1]); });
      return child;
    });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reads the private artifact and retains page/cell locators without printing source text', async () => {
    const result = await client().extract(source);
    expect(result).toMatchObject({ status: 'READY', payload: { status: 'COMPLETE', units: [{ text: 'Синтетический PDF', locator: { page: 1 } }] } });
    expect(launch.mock.calls[0][2]).toMatchObject({ shell: false, windowsHide: true });
  });
  it('strips inherited API credentials and passes JSON only on stdin', async () => {
    process.env.CRM_TEST_SECRET = 'do-not-inherit';
    try { await client().extract(source); } finally { delete process.env.CRM_TEST_SECRET; }
    expect(launch.mock.calls[0][2].env.CRM_TEST_SECRET).toBeUndefined();
    expect(launch.mock.calls[0][1]).toHaveLength(2);
    expect(launch.mock.calls[0][1].join(' ')).not.toContain(source.sha256);
  });
  it.each(['https://example.invalid/source', '..', 'outside'])('rejects source escape %s before spawning', async variant => {
    const requested = variant === 'outside' ? path.join(path.dirname(directory), 'outside.bin') : variant;
    expect(await client().extract({ ...source, filePath: requested })).toMatchObject({ status: 'ERROR', code: 'LOCAL_SOURCE_REJECTED' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('does not spawn without configured scripts or model hash', async () => {
    options.whisper!.modelSha256 = 'not-a-hash';
    expect(await client().transcribe(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_EXTRACTION_NOT_CONFIGURED' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('never upgrades unknown speakers or ASR text quality', async () => {
    expect(await client().transcribe(source)).toMatchObject({ status: 'READY', payload: { status: 'UNVERIFIED', segments: [{ actor: { role: 'unknown' }, quality: 'ASR_UNVERIFIED' }] } });
  });
  it('accepts exact server stereo binding even when JSON keys are sorted differently', async () => {
    const metadata = { status: 'SERVER_VERIFIED_STEREO' as const, recordingSha256: source.sha256, proofId: 'synthetic-proof',
      channels: [{ channel: 1 as const, role: 'customer' as const, actorId: 'c1' }, { channel: 0 as const, role: 'manager' as const, actorId: 'm1' }] };
    respond = async request => {
      const value: any = transcript(); value.channelCount = 2;
      const { status: _status, ...binding } = request.channelMetadata;
      value.channelBinding = binding; value.segments[0].actor = { role: 'manager', actorId: 'm1' };
      close(await artifact(value, true));
    };
    expect(await client().transcribe(source, metadata)).toMatchObject({ status: 'READY' });
  });
  it('rejects a forged customer label when no server channel proof exists', async () => {
    respond = async () => { const value: any = transcript(); value.segments[0].actor = { role: 'customer', actorId: 'c1' }; close(await artifact(value, true)); };
    expect(await client().transcribe(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
  });
  it('rejects artifact paths outside the version folder', async () => {
    respond = async () => { const summary = await artifact(document()); summary.outputPath = source.filePath; close(summary); };
    expect(await client().extract(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
  });
  it('rejects content changed under a valid artifact filename', async () => {
    respond = async () => { const summary = await artifact(document()); await writeFile(summary.outputPath, '{}'); close(summary); };
    expect(await client().extract(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
  });
  it.each(['source', 'complete', 'text-count'])('rejects inconsistent document evidence: %s', async variant => {
    respond = async () => { const value: any = document();
      if (variant === 'source') value.sourceSha256 = '0'.repeat(64);
      if (variant === 'complete') value.units[0].complete = false;
      if (variant === 'text-count') value.textChars = 1;
      close(await artifact(value)); };
    expect(await client().extract(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
  });
  it.each(['model', 'time', 'text-hash'])('rejects inconsistent ASR evidence: %s', async variant => {
    respond = async () => { const value: any = transcript();
      if (variant === 'model') value.modelSha256 = '0'.repeat(64);
      if (variant === 'time') value.segments[0].endMs = 1001;
      if (variant === 'text-hash') value.segments[0].textHash = '0'.repeat(64);
      close(await artifact(value, true)); };
    expect(await client().transcribe(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
  });
  it('allows only one running local child and releases its slot after completion', async () => {
    respond = null;
    const instance = client(); const first = instance.extract(source); await started();
    expect(await instance.transcribe(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_BUSY' });
    close(await artifact(document())); expect(await first).toMatchObject({ status: 'READY' });
    respond = async () => close(await artifact(document()));
    expect(await instance.extract(source)).toMatchObject({ status: 'READY' });
  });
  it('cancels gracefully and waits for the child to close', async () => {
    respond = null; const abort = new AbortController(); const result = client().extract(source, abort.signal); await started(); abort.abort();
    expect(await result).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_CANCELLED' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('enforces an outer timeout without surfacing stderr', async () => {
    respond = null; options.documentTimeoutMs = 20;
    const result = client().extract(source); await started(); child.stderr.write('private-client-and-token');
    expect(await result).toEqual({ status: 'ERROR', code: 'LOCAL_PROCESS_TIMEOUT', retryable: true });
  });
  it('rejects excess stdout and sanitizes spawn failures', async () => {
    respond = async () => { child.stdout.write(Buffer.alloc(33 * 1024)); };
    expect(await client().extract(source)).toMatchObject({ status: 'ERROR', code: 'LOCAL_PROCESS_INVALID_RESULT' });
    launch.mockImplementation(() => { throw new Error('private-client-and-token'); });
    expect(await client().extract(source)).toEqual({ status: 'ERROR', code: 'LOCAL_PROCESS_UNAVAILABLE', retryable: true });
  });
});
