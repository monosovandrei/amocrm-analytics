import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

const HASH = /^[a-f0-9]{64}$/;
const DOCUMENT_VERSION = 'local-documents-v1';
const ASR_VERSION = 'local-asr-v1';
const MAX_STDOUT = 32 * 1024;
const MAX_ARTIFACT = 16 * 1024 * 1024;

export interface CrmControlLocalSource { filePath: string; sha256: string; mimeType: string | null }
/** Created only by a trusted telephony adapter, never forwarded from user input. */
export interface CrmControlServerChannelMetadata {
  status: 'SERVER_VERIFIED_STEREO'; recordingSha256: string; proofId: string;
  channels: Array<{ channel: 0 | 1; role: 'manager' | 'customer'; actorId: string }>;
}
export interface CrmControlLocalExtractionOptions {
  pythonPath: string; scriptsDirectory: string; documentDirectory: string; recordingDirectory: string;
  whisper?: { binaryPath: string; modelPath: string; modelSha256: string };
  documentTimeoutMs?: number; transcriptionTimeoutMs?: number;
}
export interface CrmControlDocumentPayload {
  extractorVersion: string; sourceSha256: string; format: string; mimeType: string | null;
  status: 'COMPLETE' | 'UNVERIFIED'; problems: string[]; textChars: number;
  units: Array<{ text: string; locator: Record<string, unknown>; complete: boolean; [key: string]: unknown }>;
}
export interface CrmControlTranscriptPayload {
  wrapperVersion: string; cacheKey: string; sourceSha256: string; modelSha256: string; binarySha256: string;
  durationMs: number; channelCount: 1 | 2; status: 'UNVERIFIED'; processingComplete: boolean;
  channelBinding: Omit<CrmControlServerChannelMetadata, 'status'> | null; problems: string[];
  segments: Array<{ channel: number; startMs: number; endMs: number; text: string; textHash: string;
    actor: { role: 'unknown' | 'manager' | 'customer'; actorId: string | null }; quality: 'ASR_UNVERIFIED' }>;
}
type ErrorCode = 'LOCAL_EXTRACTION_NOT_CONFIGURED' | 'LOCAL_SOURCE_REJECTED' | 'LOCAL_PROCESS_BUSY'
  | 'LOCAL_PROCESS_TIMEOUT' | 'LOCAL_PROCESS_CANCELLED' | 'LOCAL_PROCESS_UNAVAILABLE' | 'LOCAL_PROCESS_INVALID_RESULT';
export type CrmControlLocalExtractionResult<T> = {
  status: 'READY'; outputPath: string; outputSha256: string; cacheHit: boolean; payload: T;
} | { status: 'ERROR'; code: ErrorCode; retryable: boolean };

const error = (code: ErrorCode, retryable = false) => ({ status: 'ERROR' as const, code, retryable });
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: any): string => JSON.stringify(value, (_key, item) => record(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const chars = (value: string) => Array.from(value).length;
const codes = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100
  && value.every(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code));

function absolute(value: string) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || value.includes('\0')
    || /^(?:\\\\|\/\/)/.test(value) || value.split(/[\\/]/).includes('..')) throw new Error();
  return path.resolve(value);
}

async function noSymlinks(value: string) {
  const resolved = absolute(value);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error();
  }
  return resolved;
}

function contained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return !!relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function sourcePath(root: string, input: CrmControlLocalSource, maximum: number) {
  if (!record(input) || !HASH.test(input.sha256) || typeof input.filePath !== 'string'
    || !(input.mimeType === null || typeof input.mimeType === 'string' && input.mimeType.length <= 256)) throw new Error();
  root = await noSymlinks(root);
  const candidate = await noSymlinks(input.filePath);
  const stat = await lstat(candidate);
  if (!contained(root, candidate) || !(await lstat(root)).isDirectory() || !stat.isFile() || stat.size > maximum) throw new Error();
  return { root, source: { filePath: candidate, sha256: input.sha256, mimeType: input.mimeType } };
}

function binding(metadata: CrmControlServerChannelMetadata | undefined, digest: string) {
  if (metadata === undefined) return null;
  if (!record(metadata) || metadata.status !== 'SERVER_VERIFIED_STEREO' || metadata.recordingSha256 !== digest
    || typeof metadata.proofId !== 'string' || !metadata.proofId.trim() || metadata.proofId.length > 256
    || !Array.isArray(metadata.channels) || metadata.channels.length !== 2) throw new Error();
  const channels = [...metadata.channels].sort((a, b) => a.channel - b.channel);
  if (channels.some((item, index) => !record(item) || item.channel !== index || !['manager', 'customer'].includes(item.role)
    || typeof item.actorId !== 'string' || !item.actorId.trim() || item.actorId.length > 256)
    || channels[0].role === channels[1].role) throw new Error();
  return { recordingSha256: digest, proofId: metadata.proofId,
    channels: channels.map(({ channel, role, actorId }) => ({ channel, role, actorId })) };
}

/** No logging, credentials, shell, network calls or service lifecycle operations. */
export class CrmControlLocalExtractionClient {
  private busy = false;
  constructor(private readonly options: CrmControlLocalExtractionOptions,
    private readonly launch: typeof spawn = spawn) {}

  extract(input: CrmControlLocalSource, signal?: AbortSignal): Promise<CrmControlLocalExtractionResult<CrmControlDocumentPayload>> {
    return this.execute('document', input, undefined, signal) as Promise<CrmControlLocalExtractionResult<CrmControlDocumentPayload>>;
  }

  transcribe(input: CrmControlLocalSource, metadata?: CrmControlServerChannelMetadata,
    signal?: AbortSignal): Promise<CrmControlLocalExtractionResult<CrmControlTranscriptPayload>> {
    return this.execute('recording', input, metadata, signal) as Promise<CrmControlLocalExtractionResult<CrmControlTranscriptPayload>>;
  }

  private async execute(kind: 'document' | 'recording', input: CrmControlLocalSource,
    metadata?: CrmControlServerChannelMetadata, signal?: AbortSignal): Promise<CrmControlLocalExtractionResult<any>> {
    if (signal?.aborted) return error('LOCAL_PROCESS_CANCELLED');
    if (this.busy) return error('LOCAL_PROCESS_BUSY', true);
    this.busy = true;
    try {
      let python: string, script: string, scripts: string;
      try {
        python = await realpath(absolute(this.options.pythonPath));
        scripts = await realpath(absolute(this.options.scriptsDirectory));
        script = await noSymlinks(path.join(scripts, kind === 'document' ? 'extract.py' : 'transcribe.py'));
        if (!(await lstat(python)).isFile() || !(await lstat(script)).isFile()) throw new Error();
        if (kind === 'recording' && (!this.options.whisper || !HASH.test(this.options.whisper.modelSha256)
          || !absolute(this.options.whisper.binaryPath) || !absolute(this.options.whisper.modelPath))) throw new Error();
      } catch { return error('LOCAL_EXTRACTION_NOT_CONFIGURED'); }
      let root: string, source: CrmControlLocalSource, channelBinding: ReturnType<typeof binding>;
      try {
        ({ root, source } = await sourcePath(kind === 'document' ? this.options.documentDirectory : this.options.recordingDirectory,
          input, (kind === 'document' ? 20 : 100) * 1024 * 1024));
        channelBinding = binding(metadata, source.sha256);
      } catch { return error('LOCAL_SOURCE_REJECTED'); }
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', LC_ALL: 'C', LANG: 'C', OMP_NUM_THREADS: '2',
        OPENBLAS_NUM_THREADS: '1', CRM_CONTROL_DOCUMENT_DIR: root, CRM_CONTROL_RECORDING_DIR: root });
      if (kind === 'recording') Object.assign(env, {
        CRM_CONTROL_WHISPER_CLI: this.options.whisper!.binaryPath, CRM_CONTROL_WHISPER_MODEL_PATH: this.options.whisper!.modelPath,
        CRM_CONTROL_WHISPER_MODEL_SHA256: this.options.whisper!.modelSha256,
      });
      const maximum = kind === 'document' ? 125_000 : 905_000;
      const requested = kind === 'document' ? this.options.documentTimeoutMs : this.options.transcriptionTimeoutMs;
      const timeout = requested !== undefined && Number.isFinite(requested) ? Math.min(maximum, Math.max(10, requested)) : maximum;
      const request = JSON.stringify({ ...source, ...(channelBinding ? { channelMetadata: { status: 'SERVER_VERIFIED_STEREO', ...channelBinding } } : {}) });
      const output = await this.run(python, script, scripts, env, request, timeout, signal);
      if (output.status === 'ERROR') return output;
      try {
        const summary = JSON.parse(output.stdout);
        if (!record(summary) || summary.ok !== true || summary.sha256 !== source.sha256 || typeof summary.cacheHit !== 'boolean') throw new Error();
        const version = kind === 'document' ? DOCUMENT_VERSION : ASR_VERSION;
        const folder = path.join(root, kind === 'document' ? '.extracted' : '.transcribed', version);
        const outputPath = await noSymlinks(summary.outputPath);
        const filename = path.basename(outputPath);
        if (path.dirname(outputPath) !== folder || !/^[a-f0-9]{64}\.[a-f0-9]{64}\.json$/.test(filename)) throw new Error();
        const expectedOutputHash = filename.split('.')[1];
        const handle = await open(outputPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let bytes: Buffer;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > MAX_ARTIFACT || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error();
          const buffer = Buffer.alloc(stat.size + 1);
          const result = await handle.read(buffer, 0, buffer.length, 0);
          if (result.bytesRead !== stat.size) throw new Error();
          bytes = buffer.subarray(0, result.bytesRead);
        } finally { await handle.close(); }
        if (hash(bytes) !== expectedOutputHash) throw new Error();
        const payload = JSON.parse(bytes.toString('utf8'));
        if (!record(payload) || payload.sourceSha256 !== source.sha256 || !codes(payload.problems)) throw new Error();
        if (kind === 'document') {
          if (filename.split('.')[0] !== source.sha256 || payload.extractorVersion !== DOCUMENT_VERSION
            || summary.extractorVersion !== DOCUMENT_VERSION || !['COMPLETE', 'UNVERIFIED'].includes(payload.status)
            || summary.status !== payload.status || !Array.isArray(payload.units) || payload.units.length > 50_000
            || payload.units.some((unit: any) => !record(unit) || typeof unit.text !== 'string' || !record(unit.locator)
              || typeof unit.complete !== 'boolean')
            || payload.textChars !== payload.units.reduce((size: number, unit: any) => size + chars(unit.text), 0)
            || payload.textChars > 200_000 || summary.unitCount !== payload.units.length
            || (payload.status === 'COMPLETE' && (payload.problems.length || !payload.units.length || payload.units.some((unit: any) => !unit.complete)))) throw new Error();
        } else {
          if (payload.wrapperVersion !== ASR_VERSION || summary.wrapperVersion !== ASR_VERSION || payload.status !== 'UNVERIFIED'
            || summary.status !== 'UNVERIFIED' || payload.modelSha256 !== this.options.whisper!.modelSha256
            || !HASH.test(payload.binarySha256) || payload.cacheKey !== filename.split('.')[0]
            || ![1, 2].includes(payload.channelCount) || !Number.isInteger(payload.durationMs) || payload.durationMs <= 0 || payload.durationMs > 1_800_000
            || typeof payload.processingComplete !== 'boolean' || summary.processingComplete !== payload.processingComplete
            || canonical(payload.channelBinding) !== canonical(channelBinding)
            || !Array.isArray(payload.segments) || payload.segments.length > 10_000 || summary.segmentCount !== payload.segments.length
            || !payload.problems.includes('ASR_UNVERIFIED')) throw new Error();
          let total = 0;
          for (const segment of payload.segments) {
            if (!record(segment) || !Number.isInteger(segment.channel) || segment.channel < 0 || segment.channel >= payload.channelCount
              || !Number.isInteger(segment.startMs) || !Number.isInteger(segment.endMs) || segment.startMs < 0
              || segment.endMs <= segment.startMs || segment.endMs > payload.durationMs || typeof segment.text !== 'string'
              || !segment.text.trim() || chars(segment.text) > 16_000 || segment.textHash !== hash(segment.text)
              || segment.quality !== 'ASR_UNVERIFIED' || !record(segment.actor)) throw new Error();
            const actor = channelBinding?.channels[segment.channel] ?? { role: 'unknown', actorId: null };
            if (segment.actor.role !== actor.role || segment.actor.actorId !== actor.actorId) throw new Error();
            total += chars(segment.text);
          }
          if (total > 200_000 || (channelBinding && payload.channelCount !== 2)) throw new Error();
        }
        return { status: 'READY', outputPath, outputSha256: expectedOutputHash, cacheHit: summary.cacheHit, payload };
      } catch { return error('LOCAL_PROCESS_INVALID_RESULT'); }
    } finally { this.busy = false; }
  }

  private run(python: string, script: string, cwd: string, env: NodeJS.ProcessEnv, request: string,
    timeoutMs: number, signal?: AbortSignal): Promise<{ status: 'OK'; stdout: string } | Extract<CrmControlLocalExtractionResult<never>, { status: 'ERROR' }>> {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(error('LOCAL_PROCESS_CANCELLED')); return; }
      let child: ChildProcessWithoutNullStreams;
      try { child = this.launch(python, ['-B', script], { cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams; }
      catch { resolve(error('LOCAL_PROCESS_UNAVAILABLE', true)); return; }
      let size = 0, settled = false, stopped: ErrorCode | undefined;
      const chunks: Buffer[] = [];
      let hardKill: NodeJS.Timeout | undefined;
      const stop = (code: ErrorCode) => {
        if (stopped) return;
        stopped = code;
        child.kill('SIGTERM'); // Python catches TERM, kills its child group, then returns a fixed error.
        hardKill = setTimeout(() => {
          if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
          else child.kill('SIGKILL');
        }, 3000);
        hardKill.unref();
      };
      const abort = () => stop('LOCAL_PROCESS_CANCELLED');
      const timer = setTimeout(() => stop('LOCAL_PROCESS_TIMEOUT'), timeoutMs);
      const finish = (result: { status: 'OK'; stdout: string } | Extract<CrmControlLocalExtractionResult<never>, { status: 'ERROR' }>) => {
        if (settled) return;
        settled = true; clearTimeout(timer); if (hardKill) clearTimeout(hardKill);
        signal?.removeEventListener('abort', abort); resolve(result);
      };
      child.stdout.on('data', (data: Buffer) => { size += data.length;
        if (size > MAX_STDOUT) stop('LOCAL_PROCESS_INVALID_RESULT'); else chunks.push(data); });
      child.stderr.on('data', () => undefined); // Never preserve third-party text or credential-bearing diagnostics.
      child.stdin.on('error', () => stop('LOCAL_PROCESS_UNAVAILABLE'));
      child.on('error', () => finish(error('LOCAL_PROCESS_UNAVAILABLE', true)));
      child.on('close', code => finish(stopped ? error(stopped, stopped === 'LOCAL_PROCESS_TIMEOUT')
        : code === 0 ? { status: 'OK', stdout: Buffer.concat(chunks).toString('utf8') } : error('LOCAL_PROCESS_UNAVAILABLE', true)));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(request);
    });
  }
}
