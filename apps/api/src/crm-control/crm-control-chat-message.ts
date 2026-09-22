import { createHash } from 'node:crypto';
import { CrmControlChatBindingProof, CrmControlChatBindingResult, crmControlChatSourceHash } from './crm-control-chat-binding';
import { crmControlAttachmentUrl } from './crm-control-source.normalizer';
import type { CrmControlSourceAttachment } from './crm-control-source.types';

export interface CrmControlChatAccountUser { amojoId: string; crmUserId: string }
/** Native Chat.getExternalContact / ExistingExternalChatTarget getters, not a contact merely linked to the lead. */
export interface CrmControlChatExternalContact { chatId: string; contactId: string; amojoId: string }
export interface CrmControlChatMessageInput {
  value: unknown;
  binding: CrmControlChatBindingResult;
  /** Native account users.getByAmoJoId(), never getChatsStat users/counts. */
  accountUsers: readonly CrmControlChatAccountUser[];
  accountUnknownActorIds?: readonly string[];
  externalContact?: CrmControlChatExternalContact | null;
  /** Transport contract, not a magnitude guess. The observed native created_at contract defaults to seconds. */
  createdAtUnit?: 'SECONDS' | 'MILLISECONDS';
}

/** Private source shape used by the immutable semantic request builder. It contains no inferred supplier role. */
export interface CrmControlNormalizedChatMessage {
  messageId: string;
  chatId: string;
  talkId: string;
  contactId: string;
  connectionId: string;
  rawSha256: string;
  text: string | null;
  textSha256: string | null;
  occurredAt: string | null;
  timestampUnit: 'SECONDS' | 'MILLISECONDS';
  actorKind: 'internal' | 'external' | 'bot' | 'unknown';
  authorId: string | null;
  authorUserId: string | null;
  recipientId: string | null;
  direction: 'incoming' | 'outgoing' | 'unverified';
  binding: { kind: 'exact_lead'; leadExternalId: string };
  bindingProof: CrmControlChatBindingProof;
  attachments: CrmControlSourceAttachment[];
  deliveryStatus: 'UNVERIFIED';
  eligibleAsSemanticSource: boolean;
  eligibleAsOutgoingEvidence: boolean;
  issues: string[];
}

export interface CrmControlChatMessageResult {
  status: 'NORMALIZED' | 'UNVERIFIED';
  message: CrmControlNormalizedChatMessage | null;
  reasonCodes: string[];
}

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const id = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const numericId = (value: unknown): string | null => { const valueId = id(value); return valueId && /^[1-9]\d{0,19}$/.test(valueId) ? valueId : null; };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const optionalText = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max ? value : null;
const rejected = (code: string): CrmControlChatMessageResult => ({ status: 'UNVERIFIED', message: null, reasonCodes: [code] });

function occurredAt(value: unknown, unit: 'SECONDS' | 'MILLISECONDS', auxiliary: unknown, proof: CrmControlChatBindingProof, issues: Set<string>): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) { issues.add('CHAT_TIMESTAMP_INVALID'); return null; }
  let milliseconds = unit === 'SECONDS' ? value * 1000 : value;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 253_402_300_799_999) { issues.add('CHAT_TIMESTAMP_INVALID'); return null; }
  if (auxiliary !== undefined && auxiliary !== null) {
    if (typeof auxiliary !== 'number' || !Number.isSafeInteger(auxiliary) || auxiliary <= 0
      || (unit === 'SECONDS' ? Math.floor(auxiliary / 1000) !== value : auxiliary !== value)) {
      issues.add('CHAT_TIMESTAMP_FIELDS_CONFLICT'); return null;
    }
    milliseconds = auxiliary;
  }
  const observedAt = Date.parse(proof.scope.observedAt), capturedAt = Date.parse(proof.messageCapturedAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(capturedAt) || milliseconds > observedAt || milliseconds > capturedAt) {
    issues.add('CHAT_TIMESTAMP_AFTER_CAPTURE'); return null;
  }
  return new Date(milliseconds).toISOString();
}

function attachments(content: Record<string, unknown>, issues: Set<string>): CrmControlSourceAttachment[] {
  const candidates: unknown[] = [];
  if (typeof content.media === 'string' && content.media.trim()) candidates.push({ link: content.media, type: content.type,
    file_name: content.file_name, file_uuid: content.file_uuid, version_uuid: content.version_uuid });
  else if (object(content.media)) candidates.push(content.media);
  if (content.attachment !== undefined && content.attachment !== null) candidates.push(content.attachment);
  if (Array.isArray(content.attachments)) candidates.push(...content.attachments.slice(0, 33));
  else if (content.attachments !== undefined && content.attachments !== null) issues.add('CHAT_ATTACHMENTS_SCHEMA_INVALID');
  if (candidates.length > 32) issues.add('CHAT_ATTACHMENT_LIMIT');
  const output: CrmControlSourceAttachment[] = [], seen = new Set<string>();
  for (const value of candidates.slice(0, 32)) {
    const item = object(value);
    if (!item) { issues.add('CHAT_ATTACHMENTS_SCHEMA_INVALID'); continue; }
    const rawUrl = item.link ?? item.url;
    const url = crmControlAttachmentUrl(rawUrl);
    if (!url) issues.add('CHAT_ATTACHMENT_URL_UNVERIFIED');
    const fileUuid = optionalText(item.file_uuid, 36), versionUuid = optionalText(item.version_uuid, 36);
    const attachment: CrmControlSourceAttachment = {
      name: optionalText(item.file_name, 1024), type: optionalText(item.type, 100), url, urlStatus: url ? 'HTTPS_CANDIDATE' : 'REJECTED',
      identifierHints: { fileUuid: fileUuid && UUID.test(fileUuid) ? fileUuid.toLowerCase() : null,
        versionUuid: versionUuid && UUID.test(versionUuid) ? versionUuid.toLowerCase() : null, urlUuidCandidates: [] },
      contentSha256: null,
    };
    const key = JSON.stringify(attachment);
    if (!seen.has(key)) { seen.add(key); output.push(attachment); }
  }
  // A declared media message without readable attachment metadata is an unresolved source, not an empty message.
  if (['file', 'picture', 'video', 'voice', 'audio', 'sticker'].includes(String(content.type)) && !output.length) issues.add('CHAT_ATTACHMENT_REFERENCE_MISSING');
  return output;
}

/** No account membership by exclusion, names, admin flag, origin string or chat-stat participant list. */
export function normalizeCrmControlChatMessage(input: CrmControlChatMessageInput): CrmControlChatMessageResult {
  if (input?.binding?.status !== 'BOUND' || !input.binding.proof) return rejected('CHAT_BINDING_REQUIRED');
  const proof = input.binding.proof, body = object(input.value), content = object(body?.message);
  if (!body || !content || id(body.id) !== proof.messageId || numericId(object(body.dialog)?.id) !== proof.talkId) return rejected('CHAT_MESSAGE_SCOPE_CONFLICT');
  try { if (crmControlChatSourceHash(input.value) !== proof.messageSourceHash) return rejected('CHAT_MESSAGE_SOURCE_CHANGED'); }
  catch { return rejected('CHAT_MESSAGE_SOURCE_INVALID'); }
  if (!Array.isArray(input.accountUsers) || input.accountUsers.length > 10_000) return rejected('CHAT_ACCOUNT_CATALOG_INVALID');
  if (input.createdAtUnit !== undefined && !['SECONDS', 'MILLISECONDS'].includes(input.createdAtUnit)) return rejected('CHAT_TIMESTAMP_UNIT_INVALID');
  if (input.accountUnknownActorIds !== undefined && (!Array.isArray(input.accountUnknownActorIds)
    || input.accountUnknownActorIds.length > 10_000 || input.accountUnknownActorIds.some(value => !id(value)))) return rejected('CHAT_ACCOUNT_CATALOG_INVALID');
  const issues = new Set<string>(), users = new Map<string, string>(), ambiguousUsers = new Set<string>(input.accountUnknownActorIds ?? []);
  for (const user of input.accountUsers) {
    if (!user || !id(user.amojoId) || !numericId(user.crmUserId)) { issues.add('CHAT_ACCOUNT_CATALOG_INVALID'); continue; }
    const previous = users.get(user.amojoId);
    if (previous && previous !== user.crmUserId) ambiguousUsers.add(user.amojoId);
    users.set(user.amojoId, user.crmUserId);
  }
  for (const userId of ambiguousUsers) users.delete(userId);
  if (ambiguousUsers.size) issues.add('CHAT_ACCOUNT_CATALOG_CONFLICT');
  const external = input.externalContact;
  const externalVerified = Boolean(external && external.chatId === proof.scope.chatId && external.contactId === proof.contactId && id(external.amojoId));
  if (!externalVerified) issues.add(external ? 'CHAT_EXTERNAL_CONTACT_CONFLICT' : 'CHAT_EXTERNAL_CONTACT_UNVERIFIED');
  const externalId = externalVerified ? external!.amojoId : null;
  const author = object(body.author), recipient = object(body.recipient), authorId = id(author?.id), recipientId = id(recipient?.id);
  const authorExternal = Boolean(authorId && externalId === authorId), recipientExternal = Boolean(recipientId && externalId === recipientId);
  const authorUserId = authorId ? users.get(authorId) ?? null : null;
  const roleConflict = Boolean(externalId && (users.has(externalId) || ambiguousUsers.has(externalId)))
    || Boolean(authorId && ambiguousUsers.has(authorId));
  if (roleConflict) issues.add('CHAT_PARTICIPANT_ROLE_CONFLICT');
  let actorKind: CrmControlNormalizedChatMessage['actorKind'] = 'unknown';
  if (!roleConflict) {
    if (author?.bot === true) actorKind = 'bot';
    else if (authorUserId) actorKind = 'internal';
    else if (authorExternal) actorKind = 'external';
  }
  if (!authorId) issues.add('CHAT_AUTHOR_ID_MISSING');
  if (actorKind === 'unknown') issues.add('CHAT_AUTHOR_UNVERIFIED');
  let direction: CrmControlNormalizedChatMessage['direction'] = 'unverified';
  if (!roleConflict && authorId && authorId !== recipientId) {
    // Matches the native frontend's exact external-target comparison; a missing user-catalog entry alone is not external proof.
    if (authorExternal) direction = 'incoming';
    else if (recipientExternal && ['internal', 'bot'].includes(actorKind)) direction = 'outgoing';
  }
  if (direction === 'unverified') issues.add('CHAT_DIRECTION_UNVERIFIED');
  const unit = input.createdAtUnit ?? 'SECONDS';
  const time = occurredAt(body.created_at, unit, body.msec_created_at, proof, issues);
  const text = optionalText(content.text, 50_000);
  if (content.text !== undefined && content.text !== null && text === null) issues.add('CHAT_TEXT_INVALID_OR_TOO_LARGE');
  const files = attachments(content, issues);
  const normalized: CrmControlNormalizedChatMessage = {
    messageId: proof.messageId, chatId: proof.scope.chatId, talkId: proof.talkId, contactId: proof.contactId,
    connectionId: proof.scope.connectionId, rawSha256: proof.messageSourceHash, text,
    textSha256: text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex'), occurredAt: time, timestampUnit: unit,
    actorKind, authorId, authorUserId: actorKind === 'internal' ? authorUserId : null, recipientId, direction,
    binding: { kind: 'exact_lead', leadExternalId: proof.scope.dealExternalId }, bindingProof: proof, attachments: files, deliveryStatus: 'UNVERIFIED',
    eligibleAsSemanticSource: Boolean(time && text?.trim() && ['incoming', 'outgoing'].includes(direction) && ['internal', 'external'].includes(actorKind)),
    eligibleAsOutgoingEvidence: Boolean(time && direction === 'outgoing' && ['internal', 'bot'].includes(actorKind)), issues: [...issues],
  };
  return { status: 'NORMALIZED', message: normalized, reasonCodes: normalized.issues };
}
