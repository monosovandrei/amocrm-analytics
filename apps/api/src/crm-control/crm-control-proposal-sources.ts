import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CrmControlDriveReader, downloadProposalFile, readProposalFileField } from './crm-control-drive';
import { CrmControlDealMessageEvidence } from './crm-control-source.types';

export interface CrmControlDocumentArtifact {
  sha256: string;
  size: number;
  contentType: string | null;
  storageKey: string;
  capturedAt: string;
}
export interface CrmControlProposalSources {
  fieldId: string | null;
  fieldReadComplete: boolean;
  fieldFiles: Array<{ fileUuid: string; versionUuid: string; name: string; artifact?: CrmControlDocumentArtifact; errorCode?: string }>;
  sentAttachments: Array<{ messageId: string; sentAt: string; name: string | null; artifact?: CrmControlDocumentArtifact; errorCode?: string }>;
  problems: string[];
  /** Available attachments cannot establish the absence of a later offer in missing history. */
  sentHistoryComplete: false;
}

function problem(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return /^(FILE|INVALID_FILE|INVALID_DRIVE)_[A-Z0-9_]+$/.test(code) ? code : 'DOCUMENT_SOURCE_UNAVAILABLE';
}

/** Private, content-addressed source archive. File names from CRM never select local paths. */
export class CrmControlProposalSourceCollector {
  private readonly downloads = new Map<string, CrmControlDocumentArtifact>();
  constructor(private readonly drive: CrmControlDriveReader | null, private readonly directory: string | null,
    private readonly download = downloadProposalFile) {}

  async collect(customFields: unknown, fieldId: string | null, messages: readonly CrmControlDealMessageEvidence[]): Promise<CrmControlProposalSources> {
    const result: CrmControlProposalSources = { fieldId, fieldReadComplete: false, fieldFiles: [], sentAttachments: [], problems: [], sentHistoryComplete: false };
    const signal = AbortSignal.timeout(120_000);
    let filesStarted = 0, bytesRemaining = 64 * 1024 * 1024;
    const next = () => {
      if (signal.aborted || filesStarted >= 32 || bytesRemaining <= 0) throw new Error('FILE_COLLECTION_LIMIT');
      filesStarted++;
    };
    const archive = async (url: string) => {
      signal.throwIfAborted();
      const artifact = await this.archive(url, signal, Math.min(bytesRemaining, 20 * 1024 * 1024));
      bytesRemaining -= artifact.size;
      return artifact;
    };
    const failure = (error: unknown) => {
      const code = signal.aborted ? 'FILE_COLLECTION_LIMIT' : problem(error);
      if (code === 'FILE_COLLECTION_LIMIT' && !result.problems.includes(code)) result.problems.push(code);
      return code;
    };
    if (!fieldId) result.problems.push('PROPOSAL_FIELD_NOT_IDENTIFIED');
    else {
      const field = readProposalFileField(customFields, fieldId);
      result.fieldReadComplete = field.complete;
      if (field.problem) result.problems.push(field.problem);
      for (const reference of field.files) {
        const item: CrmControlProposalSources['fieldFiles'][number] = { fileUuid: reference.fileUuid, versionUuid: reference.versionUuid, name: reference.name };
        try {
          next();
          if (!this.drive) throw new Error('DOCUMENT_SOURCE_UNAVAILABLE');
          const resolved = await this.drive.resolve(reference, { signal });
          item.artifact = await archive(resolved.downloadUrl);
        } catch (error) { item.errorCode = failure(error); }
        result.fieldFiles.push(item);
      }
    }
    for (const { message } of [...messages].sort((a, b) => (b.message.occurredAt?.getTime() ?? 0) - (a.message.occurredAt?.getTime() ?? 0))) {
      if (!message.eligibleAsOutgoingEvidence || !message.messageId || !message.occurredAt) continue;
      for (const attachment of message.attachments) {
        // Classification as an offer is a separate step. A file name is only display text.
        const item: CrmControlProposalSources['sentAttachments'][number] = { messageId: message.messageId,
          sentAt: message.occurredAt.toISOString(), name: attachment.name };
        try {
          next();
          if (!attachment.url) throw new Error('INVALID_FILE_DOWNLOAD_ORIGIN');
          item.artifact = await archive(attachment.url);
        } catch (error) { item.errorCode = failure(error); }
        result.sentAttachments.push(item);
      }
    }
    return result;
  }

  private async archive(url: string, signal: AbortSignal, maxBytes: number): Promise<CrmControlDocumentArtifact> {
    if (!this.directory || !path.isAbsolute(this.directory)) throw new Error('DOCUMENT_SOURCE_UNAVAILABLE');
    const key = createHash('sha256').update(url).digest('hex');
    const existing = this.downloads.get(key);
    if (existing) {
      if (existing.size > maxBytes) throw new Error('FILE_COLLECTION_LIMIT');
      return existing;
    }
      const file = await this.download(url, { signal, maxBytes });
      signal.throwIfAborted();
      const storageKey = `${file.sha256}.bin`;
      const folder = path.resolve(this.directory!);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const target = path.join(folder, storageKey);
      let existingBytes: Buffer | null = null;
      try { existingBytes = await readFile(target); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      if (existingBytes) {
        if (createHash('sha256').update(existingBytes).digest('hex') !== file.sha256) throw new Error('FILE_ARCHIVE_HASH_MISMATCH');
      } else {
        const temporary = path.join(folder, `${file.sha256}.${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, file.bytes, { flag: 'wx', mode: 0o600 });
          await rename(temporary, target);
        } finally { await unlink(temporary).catch(() => {}); }
      }
      const artifact = { sha256: file.sha256, size: file.size, contentType: file.contentType, storageKey, capturedAt: new Date().toISOString() };
      this.downloads.set(key, artifact);
      return artifact;
  }
}
