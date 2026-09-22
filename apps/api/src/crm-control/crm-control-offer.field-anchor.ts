import type { CrmControlOfferFile, CrmControlOfferScope } from './crm-control-offer.validation';

export interface CrmControlFieldAnchorAttachment {
  sourceId: string; threadId: string; messageId: string; attachmentId: string; sentAt: string;
  /** Server-attributed direction; an attachment name or a URL does not establish this. */
  direction: 'outgoing' | 'incoming' | 'unknown';
  binding: 'DEAL' | 'NOT_BOUND';
  /** Verified Drive metadata or downloaded byte hash. Never UUID hints parsed from URLs. */
  file: CrmControlOfferFile | null;
}
export interface CrmControlOfferFieldAnchor {
  status: 'EXACT_FILE_SENT'; scope: CrmControlOfferScope;
  sourceId: string; threadId: string; messageId: string; attachmentId: string; sentAt: string;
  fieldIndexes: number[]; matchMethod: 'SHA256' | 'FILE_VERSION'; file: CrmControlOfferFile;
  /** Only the identical bytes already authorized by the deal field may be read or quoted. */
  contentAuthorized: boolean;
  latestVerified: false;
  laterUnboundAttachments: number; orderUnverifiedAttachments: number;
}
export interface CrmControlOfferFieldAnchors {
  anchors: CrmControlOfferFieldAnchor[]; issues: string[];
  /** Neither an exact file match nor a terminal mail thread proves all-channel coverage. */
  historyStatus: 'UNVERIFIED';
}
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,256}$/.test(value);
const date = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value), day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value.slice(0, 10)
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60 ? parsed : null;
};
function file(value: CrmControlOfferFile | null | undefined): CrmControlOfferFile | null {
  if (!value || typeof value !== 'object') return null;
  const sha256 = typeof value.sha256 === 'string' && HASH.test(value.sha256) ? value.sha256 : null;
  const fileUuid = typeof value.fileUuid === 'string' && UUID.test(value.fileUuid) ? value.fileUuid.toLowerCase() : null;
  const versionUuid = typeof value.versionUuid === 'string' && UUID.test(value.versionUuid) ? value.versionUuid.toLowerCase() : null;
  return sha256 || (fileUuid && versionUuid) ? { sha256, fileUuid, versionUuid } : null;
}
const sameVersion = (left: CrmControlOfferFile, right: CrmControlOfferFile) => !!left.fileUuid && !!left.versionUuid
  && left.fileUuid === right.fileUuid && left.versionUuid === right.versionUuid;
const key = (item: CrmControlFieldAnchorAttachment) => JSON.stringify([item.sourceId, item.attachmentId]);

/** Proves sending of a field file only. It does not bind the rest of a contact's thread to this deal. */
export function anchorCrmControlOfferField(input: { scope: CrmControlOfferScope; createdAt: string; observedAt: string;
  fieldFiles: readonly (CrmControlOfferFile | null)[]; attachments: readonly CrmControlFieldAnchorAttachment[] }): CrmControlOfferFieldAnchors {
  const output: CrmControlOfferFieldAnchors = { anchors: [], issues: [], historyStatus: 'UNVERIFIED' };
  const issues = new Set<string>();
  const start = date(input.createdAt), end = date(input.observedAt);
  if (!input.scope || !['dealId','ownerId','observationId'].every(name => identifier(input.scope[name as keyof CrmControlOfferScope]))
    || !HASH.test(input.scope.snapshotHash) || start === null || end === null || start > end
    || !Array.isArray(input.fieldFiles) || !Array.isArray(input.attachments)) {
    return { ...output, issues: ['FIELD_ANCHOR_SCOPE_INVALID'] };
  }
  if (input.fieldFiles.length > 64 || input.attachments.length > 64) issues.add('FIELD_ANCHOR_LIMIT');
  const fields = input.fieldFiles.slice(0, 64).map(file);
  const attachments = input.attachments.slice(0, 64), byKey = new Map<string, CrmControlFieldAnchorAttachment>();
  const conflicts = new Set<string>();
  for (const item of attachments) {
    if (!item || !['sourceId','threadId','messageId','attachmentId'].every(name => identifier(item[name as keyof CrmControlFieldAnchorAttachment]))
      || item.sourceId !== `mail:${item.threadId}:${item.messageId}`) {
      issues.add('FIELD_ANCHOR_SOURCE_INVALID'); continue;
    }
    const previous = byKey.get(key(item));
    if (previous && JSON.stringify([file(previous.file), date(previous.sentAt), previous.threadId, previous.messageId, previous.direction, previous.binding])
      !== JSON.stringify([file(item.file), date(item.sentAt), item.threadId, item.messageId, item.direction, item.binding])) conflicts.add(key(item));
    byKey.set(key(item), item);
  }
  if (conflicts.size) issues.add('FIELD_ANCHOR_SOURCE_CONFLICT');
  for (const item of byKey.values()) {
    if (item.binding !== 'NOT_BOUND' || item.direction !== 'outgoing' || conflicts.has(key(item))) continue;
    const identity = file(item.file), sentAt = date(item.sentAt);
    if (!identity) continue;
    if (sentAt === null || sentAt < start || sentAt > end) { issues.add('FIELD_ANCHOR_TIME_UNVERIFIED'); continue; }
    if (fields.some(field => field && sameVersion(field, identity) && field.sha256 && identity.sha256 && field.sha256 !== identity.sha256)) {
      issues.add('FIELD_ANCHOR_IDENTITY_CONFLICT'); continue;
    }
    const byteIndexes = fields.flatMap((field, index) => field?.sha256 && field.sha256 === identity.sha256 ? [index] : []);
    const versionIndexes = fields.flatMap((field, index) => field && sameVersion(field, identity) ? [index] : []);
    if (!byteIndexes.length && !versionIndexes.length) continue;
    output.anchors.push({ status: 'EXACT_FILE_SENT', scope: { ...input.scope }, sourceId: item.sourceId, threadId: item.threadId,
      messageId: item.messageId, attachmentId: item.attachmentId, sentAt: new Date(sentAt).toISOString(),
      fieldIndexes: byteIndexes.length ? byteIndexes : versionIndexes, matchMethod: byteIndexes.length ? 'SHA256' : 'FILE_VERSION',
      file: identity, contentAuthorized: byteIndexes.length > 0, latestVerified: false,
      laterUnboundAttachments: 0, orderUnverifiedAttachments: 0 });
  }
  const anchored = new Set(output.anchors.map(item => JSON.stringify([item.sourceId, item.attachmentId])));
  for (const anchor of output.anchors) {
    const when = Date.parse(anchor.sentAt);
    for (const item of byKey.values()) {
      if (item.threadId !== anchor.threadId || item.direction !== 'outgoing' || item.binding !== 'NOT_BOUND' || anchored.has(key(item))) continue;
      const sentAt = date(item.sentAt);
      if (sentAt !== null && sentAt > end!) continue;
      if (sentAt === null || sentAt === when || conflicts.has(key(item))) anchor.orderUnverifiedAttachments++;
      else if (sentAt > when) anchor.laterUnboundAttachments++;
    }
    if (anchor.laterUnboundAttachments) issues.add('FIELD_ANCHOR_LATER_UNBOUND_ATTACHMENTS');
    if (anchor.orderUnverifiedAttachments) issues.add('FIELD_ANCHOR_ORDER_UNVERIFIED');
    if (!anchor.contentAuthorized) issues.add('FIELD_ANCHOR_CONTENT_NOT_AUTHORIZED');
  }
  output.issues = [...issues];
  return output;
}
