import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CrmControlDocumentArtifact } from './crm-control-proposal-sources';

/** Observed from the real mail attachment API; the ID must survive every redirect. No cookie/OAuth forwarding. */
export function validateMailAttachmentDownload(value: string, attachmentId: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MAIL_DOWNLOAD_URL_INVALID'); }
  if (!/^[1-9]\d*$/.test(attachmentId) || url.origin !== 'https://amoattachonsr.amocrm.com'
    || url.pathname !== '/attachment/download' || url.username || url.password || url.hash
    || url.searchParams.get('id') !== attachmentId) throw new Error('MAIL_DOWNLOAD_IDENTITY_INVALID');
  const keys = new Set<string>();
  for (const [key, item] of url.searchParams) {
    if (!['token', 'ts', 'k', 'id'].includes(key) || keys.has(key) || !item || item.length > 8192) throw new Error('MAIL_DOWNLOAD_URL_INVALID');
    keys.add(key);
  }
  if (keys.size !== 4 || !/^\d+$/.test(url.searchParams.get('ts') ?? '')) throw new Error('MAIL_DOWNLOAD_URL_INVALID');
  return url.href;
}

export function detectMailArtifactType(bytes: Buffer, header: string | null): string {
  const declared = header?.split(';')[0].trim().toLowerCase();
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'application/x-ole-storage';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return ['application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'].includes(declared ?? '') ? declared! : 'application/zip';
  }
  if (declared === 'text/plain' && !bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) return 'text/plain';
  throw new Error('MAIL_ATTACHMENT_TYPE_UNSUPPORTED');
}

export async function downloadMailAttachment(value: string, attachmentId: string, options: {
  signal: AbortSignal; maxBytes: number; fetch?: typeof fetch;
}) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 20 * 1024 * 1024) throw new Error('MAIL_ATTACHMENT_LIMIT');
  const request = options.fetch ?? fetch;
  let url = validateMailAttachmentDownload(value, attachmentId);
  for (let redirects = 0; redirects <= 3; redirects++) {
    options.signal.throwIfAborted();
    const response = await request(url, { signal: options.signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('MAIL_ATTACHMENT_REDIRECT_INVALID');
      url = validateMailAttachmentDownload(new URL(location, url).href, attachmentId);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error('MAIL_ATTACHMENT_DOWNLOAD_FAILED'); }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > options.maxBytes) { await response.body?.cancel(); throw new Error('MAIL_ATTACHMENT_TOO_LARGE'); }
    if (!response.body) throw new Error('MAIL_ATTACHMENT_EMPTY');
    const reader = response.body.getReader(), chunks: Buffer[] = []; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > options.maxBytes) throw new Error('MAIL_ATTACHMENT_TOO_LARGE');
        chunks.push(Buffer.from(chunk.value));
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    if (!size) throw new Error('MAIL_ATTACHMENT_EMPTY');
    const bytes = Buffer.concat(chunks, size), contentType = detectMailArtifactType(bytes, response.headers.get('content-type'));
    return { bytes, size, contentType, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  throw new Error('MAIL_ATTACHMENT_REDIRECT_LIMIT');
}

/** Uses hashes, never client filenames, for private archive paths. */
export async function archiveMailAttachment(directory: string, file: Awaited<ReturnType<typeof downloadMailAttachment>>): Promise<CrmControlDocumentArtifact> {
  if (!path.isAbsolute(directory) || createHash('sha256').update(file.bytes).digest('hex') !== file.sha256) throw new Error('MAIL_ARCHIVE_INVALID');
  const folder = path.resolve(directory), storageKey = `${file.sha256}.bin`, target = path.join(folder, storageKey);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new Error('MAIL_ARCHIVE_INVALID');
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== file.sha256) throw new Error('MAIL_ARCHIVE_INVALID');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    const temporary = path.join(folder, `${file.sha256}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, file.bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => undefined); }
  }
  return { storageKey, sha256: file.sha256, size: file.size, contentType: file.contentType, capturedAt: new Date().toISOString() };
}
