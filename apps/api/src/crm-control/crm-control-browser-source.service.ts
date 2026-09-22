import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CrmControlEvidenceService, CrmSourceBrowserBatch, CrmSourceCardJob } from './crm-control-evidence.service';
import { CrmBrowserHistory, observeCrmBrowserHistory } from './crm-control-browser-history';
import { archiveMailAttachment, downloadMailAttachment } from './crm-control-browser-files';
import { CrmControlDocumentArtifact } from './crm-control-proposal-sources';
import { readCrmControlPrivateArtifact } from './crm-control-document-evidence';

export interface CrmBrowserDocumentSource {
  messageId: string; threadId: string; attachmentId: string; sentAt: string; metadataHash: string;
  binding: 'DEAL' | 'NOT_BOUND'; bindingReason: 'TIMELINE_MESSAGE' | 'THREAD_ENTITY' | 'UNVERIFIED';
  sourceEntryIds: string[]; artifact?: CrmControlDocumentArtifact; errorCode?: string;
}
export interface CrmBrowserAccountCurrency {
  status: 'VERIFIED' | 'UNAVAILABLE' | 'CONFLICT'; code: string | null; accountCode: string | null; localeCode: string | null;
  source: 'AMOCRM.constant(account).currency'; observedAt: string;
}
export interface CrmBrowserSourceBundle {
  schemaVersion: 1; dealExternalId: string; startedAt: string; finishedAt: string;
  manifest?: { storageKey: string; sha256: string; size: number };
  documents: CrmBrowserDocumentSource[]; communicationsComplete: false; reasonCodes: string[];
  accountCurrency?: CrmBrowserAccountCurrency;
}
export interface CrmBrowserPrivateManifest {
  schemaVersion: 1; kind: 'crm-browser-history'; dealExternalId: string; startedAt: string; finishedAt: string;
  history: CrmBrowserHistory; documents: CrmBrowserDocumentSource[];
  accountCurrency?: CrmBrowserAccountCurrency;
}
export interface CrmBrowserSourceBatch {
  collectCurrent(job: CrmSourceCardJob, options?: { collectAttachments?: boolean }): Promise<CrmBrowserSourceBundle>;
}
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));
export function parseCrmBrowserAccountCurrency(raw: unknown, observedAt: string): CrmBrowserAccountCurrency {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const iso = (value: unknown) => typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value)
    && CURRENCY_CODES.has(value.toUpperCase()) ? value.toUpperCase() : null;
  const accountCode = iso(source.accountCode), localeCode = iso(source.localeCode);
  const status = !accountCode || !localeCode ? 'UNAVAILABLE' : accountCode !== localeCode ? 'CONFLICT' : 'VERIFIED';
  return { status, code: status === 'VERIFIED' ? accountCode : null, accountCode, localeCode,
    source: 'AMOCRM.constant(account).currency', observedAt };
}
const safeCode = (error: unknown) => error instanceof Error && /^(MAIL|HISTORY|TIMELINE|COLLECTION|NOTE|CHAT)_[A-Z_]+$/.test(error.message)
  ? error.message : 'HISTORY_SOURCE_UNAVAILABLE';

/** Worker-only source archive. The API snapshot gets references, never mail bodies or signed URLs. */
@Injectable()
export class CrmControlBrowserSourceService {
  constructor(private readonly evidence: CrmControlEvidenceService) {}

  async withBatch<T>(action: (batch: CrmBrowserSourceBatch) => Promise<T>) {
    const archiveCache = new Map<string, CrmControlDocumentArtifact>();
    return this.evidence.withSourceBatch(async browser => action({
      collectCurrent: (job, options) => this.collect(browser, job, archiveCache, options?.collectAttachments !== false),
    }));
  }

  private async collect(browser: CrmSourceBrowserBatch, job: CrmSourceCardJob, archiveCache: Map<string, CrmControlDocumentArtifact>, collectAttachments: boolean): Promise<CrmBrowserSourceBundle> {
    const startedAt = new Date().toISOString();
    const base: CrmBrowserSourceBundle = { schemaVersion: 1, dealExternalId: job.dealExternalId, startedAt,
      finishedAt: startedAt, documents: [], communicationsComplete: false, reasonCodes: [] };
    const read = await browser.readCard(job, page => {
      const observer = observeCrmBrowserHistory(page, { origin: new URL(job.sourceUrl).origin, dealExternalId: job.dealExternalId });
      return { dispose: observer.dispose, collect: async () => {
        // Confirm the account's currency against the same source used by the native UI; never infer it from a symbol or a document.
        const currencyValues = await page.evaluate(() => {
          const amo = (window as any).AMOCRM;
          const boundedCode = (value: unknown) => typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value) ? value : null;
          let accountCode: unknown = null;
          try { accountCode = amo?.constant?.('account')?.currency; } catch { /* Missing authority stays unknown. */ }
          return { accountCode: boundedCode(accountCode), localeCode: boundedCode(amo?.system?.locale?.currency) };
        }).catch(() => null);
        const accountCurrency = parseCrmBrowserAccountCurrency(currencyValues, new Date().toISOString());
        const history = await observer.collect(), documents: CrmBrowserDocumentSource[] = [];
        const reasons = new Set(history.reasonCodes), signal = AbortSignal.timeout(120_000);
        if (accountCurrency.status !== 'VERIFIED') reasons.add(`ACCOUNT_CURRENCY_${accountCurrency.status}`);
        let bytesRemaining = 64 * 1024 * 1024, filesStarted = 0;
        for (const thread of history.threads) for (const message of thread.messages) {
          if (!message.sent) continue;
          const sourceEntryIds = history.entries.filter(entry => entry.binding === 'DEAL'
            && entry.mail?.threadId === thread.id && entry.mail.messageId === message.id).map(entry => entry.id);
          const bindingReason = sourceEntryIds.length ? 'TIMELINE_MESSAGE' : thread.binding === 'DEAL' ? 'THREAD_ENTITY' : 'UNVERIFIED';
          for (const attachment of message.attachments) {
            const item: CrmBrowserDocumentSource = { threadId: thread.id, messageId: message.id, attachmentId: attachment.id,
              sentAt: message.occurredAt, metadataHash: attachment.sourceHash, sourceEntryIds,
              binding: bindingReason === 'UNVERIFIED' ? 'NOT_BOUND' : 'DEAL', bindingReason };
            documents.push(item);
            try {
              if (!collectAttachments) throw new Error('MAIL_ATTACHMENT_COLLECTION_DISABLED');
              const cacheKey = `${attachment.id}:${attachment.sourceHash}`;
              const cached = archiveCache.get(cacheKey);
              if (cached) {
                archiveCache.delete(cacheKey); archiveCache.set(cacheKey, cached);
                item.artifact = { ...cached }; continue;
              }
              if (signal.aborted || filesStarted >= 32 || bytesRemaining <= 0) throw new Error('COLLECTION_LIMIT');
              filesStarted++;
              const resolved = await observer.prepareAttachment({ threadId: thread.id, messageId: message.id, attachmentId: attachment.id }, signal);
              const file = await downloadMailAttachment(resolved.downloadUrl, attachment.id, { signal, maxBytes: Math.min(bytesRemaining, 20 * 1024 * 1024) });
              item.artifact = await archiveMailAttachment(this.directory(), file); bytesRemaining -= file.size;
              archiveCache.set(cacheKey, item.artifact);
              if (archiveCache.size > 256) archiveCache.delete(archiveCache.keys().next().value!);
            } catch (error) { item.errorCode = signal.aborted ? 'COLLECTION_LIMIT' : safeCode(error); reasons.add(item.errorCode); }
          }
        }
        const finishedAt = new Date().toISOString();
        const manifest: CrmBrowserPrivateManifest = { schemaVersion: 1, kind: 'crm-browser-history', dealExternalId: job.dealExternalId,
          startedAt, finishedAt, history, documents, accountCurrency };
        return { ...base, finishedAt, manifest: await this.storeManifest(manifest), documents, accountCurrency, reasonCodes: [...reasons] };
      } };
    });
    if (read.ok) return read.value;
    return { ...base, finishedAt: new Date().toISOString(), reasonCodes: [read.errorCode] };
  }

  private directory() { return path.resolve(process.env.CRM_CONTROL_DOCUMENT_DIR
    || path.join(process.env.CRM_CONTROL_EVIDENCE_DIR || 'outputs/crm-control-evidence', 'documents')); }

  private async storeManifest(manifest: CrmBrowserPrivateManifest) {
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('HISTORY_MANIFEST_LIMIT');
    const sha256 = createHash('sha256').update(bytes).digest('hex'), storageKey = `${sha256}.browser-history.json`;
    const folder = this.directory(); await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = path.join(folder, `${sha256}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path.join(folder, storageKey)); }
    finally { await unlink(temporary).catch(() => undefined); }
    return { sha256, storageKey, size: bytes.length };
  }

  /** Internal semantic-worker read; caller supplies the immutable reference and exact lead, not an arbitrary path. */
  async readManifest(reference: NonNullable<CrmBrowserSourceBundle['manifest']>, dealExternalId: string): Promise<CrmBrowserPrivateManifest> {
    if (!HASH.test(reference.sha256) || reference.storageKey !== `${reference.sha256}.browser-history.json`
      || !/^[1-9]\d*$/.test(dealExternalId) || !Number.isSafeInteger(reference.size) || reference.size < 1 || reference.size > MAX_MANIFEST_BYTES) {
      throw new Error('HISTORY_MANIFEST_INVALID');
    }
    let bytes: Buffer;
    try { bytes = await readCrmControlPrivateArtifact(this.directory(), reference.storageKey, reference.sha256, MAX_MANIFEST_BYTES, reference.size); }
    catch { throw new Error('HISTORY_MANIFEST_INVALID'); }
    const data = JSON.parse(bytes.toString('utf8')) as CrmBrowserPrivateManifest;
    if (data.kind !== 'crm-browser-history' || data.schemaVersion !== 1 || data.dealExternalId !== dealExternalId
      || data.history?.dealExternalId !== dealExternalId || !Array.isArray(data.history.entries) || !Array.isArray(data.documents)) {
      throw new Error('HISTORY_MANIFEST_INVALID');
    }
    return data;
  }
}
