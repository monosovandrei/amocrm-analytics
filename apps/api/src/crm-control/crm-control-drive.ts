import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVE_HOST = /^drive(?:-[a-z0-9]+)?\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i;
export interface ProposalFileReference { fileUuid: string; versionUuid: string; name: string; size: number | null }
export interface ProposalFieldRead { complete: boolean; files: ProposalFileReference[]; problem: string | null }
export interface CrmControlDrivePort { getDrive<T = any>(origin: string, path: string, options?: { signal?: AbortSignal }): Promise<T> }

export function readProposalFileField(customFields: unknown, fieldId: string): ProposalFieldRead {
  if (!/^\d+$/.test(fieldId) || !Array.isArray(customFields)) return { complete: false, files: [], problem: 'INVALID_FIELD_SOURCE' };
  const matching = customFields.filter(field => String(field?.field_id) === fieldId);
  if (!matching.length) return { complete: true, files: [], problem: null };
  if (matching.length !== 1 || !Array.isArray(matching[0].values)) return { complete: false, files: [], problem: 'INVALID_FIELD_VALUES' };
  const files: ProposalFileReference[] = [];
  for (const item of matching[0].values) {
    const value = item?.value;
    if (!value || typeof value !== 'object' || !UUID.test(value.file_uuid) || !UUID.test(value.version_uuid)) {
      return { complete: false, files, problem: 'FILE_VERSION_MISSING' };
    }
    files.push({ fileUuid: value.file_uuid.toLowerCase(), versionUuid: value.version_uuid.toLowerCase(),
      name: typeof value.file_name === 'string' ? value.file_name : '',
      size: Number.isSafeInteger(value.file_size) && value.file_size >= 0 ? value.file_size : null });
  }
  return { complete: true, files, problem: null };
}

export function validatedDriveOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !DRIVE_HOST.test(url.hostname) || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash) throw new Error('INVALID_DRIVE_ORIGIN');
  return url.origin;
}

function downloadUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('FILE_DOWNLOAD_LINK_MISSING');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !DRIVE_HOST.test(url.hostname) || url.username || url.password || url.port
    || !url.pathname.startsWith('/download/') || url.hash) throw new Error('INVALID_FILE_DOWNLOAD_ORIGIN');
  return url.toString();
}

export interface ResolvedProposalFile extends ProposalFileReference {
  mimeType: string | null;
  downloadUrl: string;
  metadataSha256: string;
}

/** Reads the field's exact version. A current/main Drive version is never substituted. */
export class CrmControlDriveReader {
  private readonly origin: string;
  constructor(private readonly client: CrmControlDrivePort, driveOrigin: string) { this.origin = validatedDriveOrigin(driveOrigin); }

  async resolve(reference: ProposalFileReference, options: { signal?: AbortSignal } = {}): Promise<ResolvedProposalFile> {
    options.signal?.throwIfAborted();
    if (!UUID.test(reference.fileUuid) || !UUID.test(reference.versionUuid)) throw new Error('INVALID_FILE_REFERENCE');
    const path = `/v1.0/files/${reference.fileUuid}`;
    const file = await this.client.getDrive<any>(this.origin, path, options);
    options.signal?.throwIfAborted();
    if (String(file?.uuid).toLowerCase() !== reference.fileUuid.toLowerCase()) throw new Error('FILE_IDENTITY_MISMATCH');
    if (file.is_trashed || file.deleted_at) throw new Error('FILE_DELETED');
    if (String(file.version_uuid).toLowerCase() === reference.versionUuid.toLowerCase()) {
      return this.resolved(reference, file, file?._links?.download_version?.href);
    }
    for (let page = 1; page <= 100; page++) {
      options.signal?.throwIfAborted();
      const response = await this.client.getDrive<any>(this.origin, `${path}/versions?limit=100&page=${page}`, options);
      options.signal?.throwIfAborted();
      const versions = response?._embedded?.versions;
      if (!Array.isArray(versions)) throw new Error('INVALID_FILE_VERSIONS');
      const version = versions.find(item => String(item?.uuid).toLowerCase() === reference.versionUuid.toLowerCase());
      if (version) {
        if (String(version.file_uuid).toLowerCase() !== reference.fileUuid.toLowerCase()) throw new Error('FILE_IDENTITY_MISMATCH');
        return this.resolved(reference, version, version?._links?.download?.href);
      }
      if (!response?._links?.next?.href) throw new Error('FILE_VERSION_NOT_FOUND');
    }
    throw new Error('FILE_VERSIONS_LIMIT');
  }

  private resolved(reference: ProposalFileReference, metadata: any, link: unknown): ResolvedProposalFile {
    const target = downloadUrl(link);
    const segments = new URL(target).pathname.toLowerCase().split('/');
    if (!segments.includes(reference.fileUuid.toLowerCase()) || !segments.includes(reference.versionUuid.toLowerCase())) throw new Error('FILE_DOWNLOAD_VERSION_MISMATCH');
    return { ...reference, downloadUrl: target, mimeType: typeof metadata?.metadata?.mime_type === 'string' ? metadata.metadata.mime_type : null,
      size: Number.isSafeInteger(metadata.size) && metadata.size >= 0 ? metadata.size : reference.size,
      metadataSha256: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
  }
}

/** Signed download links are read without OAuth headers; each redirect is revalidated. */
export async function downloadProposalFile(url: string, options: { maxBytes?: number; timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}) {
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 100 * 1024 * 1024) throw new Error('INVALID_FILE_LIMIT');
  const request = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  let target = downloadUrl(url);
  const originalPath = new URL(target).pathname;
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const response = await request(target, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('FILE_REDIRECT_WITHOUT_LOCATION');
      target = downloadUrl(new URL(location, target).toString());
      if (new URL(target).pathname !== originalPath) throw new Error('FILE_REDIRECT_IDENTITY_CHANGED');
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`FILE_DOWNLOAD_HTTP_${response.status}`); }
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) { await response.body?.cancel(); throw new Error('FILE_TOO_LARGE'); }
    if (!response.body) throw new Error('FILE_BODY_MISSING');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new Error('FILE_TOO_LARGE');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!size) throw new Error('FILE_EMPTY');
    const bytes = Buffer.concat(chunks, size);
    return { bytes, size, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: response.headers.get('content-type') };
  }
  throw new Error('FILE_REDIRECT_LIMIT');
}
