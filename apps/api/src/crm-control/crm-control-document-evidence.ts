import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface CrmControlDocumentEvidence { sha256: string; size: number; capturedAt: string; label: string; source: 'field' | 'sent'; }
const HASH = /^[a-f0-9]{64}$/;
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};

export function crmControlDocumentDirectory(): string | null {
  const configured = process.env.CRM_CONTROL_DOCUMENT_DIR
    || (process.env.CRM_CONTROL_EVIDENCE_DIR ? path.join(process.env.CRM_CONTROL_EVIDENCE_DIR, 'documents') : '');
  return configured && path.isAbsolute(configured) ? path.resolve(configured) : null;
}

/** Only already bound deal files enter the public proof list. Contact mail can belong to another deal. */
export function crmControlDocumentEvidence(snapshot: unknown): CrmControlDocumentEvidence[] {
  const source = record(snapshot), proposal = record(source.proposalSources), browser = record(source.browserSources);
  const output: CrmControlDocumentEvidence[] = [];
  const add = (item: any, kind: 'field' | 'sent', label: string) => {
    const artifact = record(item?.artifact);
    if (!HASH.test(artifact.sha256) || artifact.storageKey !== `${artifact.sha256}.bin` || !Number.isSafeInteger(artifact.size)
      || artifact.size < 1 || artifact.size > 20 * 1024 * 1024 || typeof artifact.capturedAt !== 'string'
      || !Number.isFinite(Date.parse(artifact.capturedAt))) return;
    if (output.some(existing => existing.sha256 === artifact.sha256 && existing.source === kind)) return;
    output.push({ sha256: artifact.sha256, size: artifact.size, capturedAt: artifact.capturedAt, source: kind, label: label.slice(0, 300) });
  };
  for (const item of Array.isArray(proposal.fieldFiles) ? proposal.fieldFiles : []) add(item, 'field', typeof item?.name === 'string' ? item.name : 'Файл поля «КП»');
  for (const item of Array.isArray(proposal.sentAttachments) ? proposal.sentAttachments : []) add(item, 'sent', typeof item?.name === 'string' ? item.name : 'Отправленное вложение');
  for (const item of Array.isArray(browser.documents) ? browser.documents : []) if (item?.binding === 'DEAL') add(item, 'sent', 'Вложение отправленного письма');
  return output;
}

/** Bounded immutable bytes for a private, server-selected relative path. */
export async function readCrmControlPrivateArtifact(root: string, key: string, sha256: string, maxBytes: number, expectedSize?: number) {
  if (!path.isAbsolute(root) || /^(?:\\\\|\/\/)/.test(root) || !HASH.test(sha256)
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024
    || typeof key !== 'string' || !key || path.isAbsolute(key) || key.includes('\\') || key.split('/').some(part => !part || part === '.' || part === '..')
    || (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxBytes))) throw new Error('DOCUMENT_INVALID');
  const folder = path.resolve(root);
  if (await realpath(folder) !== folder || (await lstat(folder)).isSymbolicLink()) throw new Error('DOCUMENT_INVALID');
  const target = path.join(folder, key), parent = path.dirname(target);
  if (await realpath(parent) !== parent) throw new Error('DOCUMENT_INVALID');
  if ((await lstat(target)).isSymbolicLink()) throw new Error('DOCUMENT_INVALID');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes || (expectedSize !== undefined && stat.size !== expectedSize)) throw new Error('DOCUMENT_INVALID');
    const bytes = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < bytes.length) {
      const result = await handle.read(bytes, read, bytes.length - read, read);
      if (!result.bytesRead) break;
      read += result.bytesRead;
    }
    if (read !== stat.size) throw new Error('DOCUMENT_INVALID');
    buffer = bytes.subarray(0, read);
  } finally { await handle.close(); }
  if (createHash('sha256').update(buffer).digest('hex') !== sha256) throw new Error('DOCUMENT_INVALID');
  return buffer;
}

export async function readCrmControlDocument(root: string, artifact: CrmControlDocumentEvidence) {
  const buffer = await readCrmControlPrivateArtifact(root, `${artifact.sha256}.bin`, artifact.sha256, 20 * 1024 * 1024, artifact.size);
  return { buffer, contentType: buffer.subarray(0, 5).toString('ascii') === '%PDF-' ? 'application/pdf' : 'application/octet-stream' };
}
