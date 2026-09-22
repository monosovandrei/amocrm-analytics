import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  CrmControlMessageEvidence, CrmControlSourceAttachment, CrmControlSourceDealIndex,
  CrmControlTalkBindingProof, CrmControlWebhookSourceRow,
} from './crm-control-source.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_IN_URL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
const ref = (value: unknown): string | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && value.trim() && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
};
const entityId = (value: unknown): string | null => {
  const id = ref(value);
  return id && /^[1-9]\d*$/.test(id) ? id : null;
};
const validDate = (date: Date): boolean => date instanceof Date && Number.isFinite(date.getTime());

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = record(value);
  if (object) return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function timestamp(value: unknown): Date | null {
  if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 253402300799) return null;
  const date = new Date(seconds * 1000);
  return validDate(date) ? date : null;
}

function entityKind(value: unknown): 'lead' | 'contact' | 'other' | null {
  // amo entity codes: 1 = contact, 2 = lead (not the array order of entity names).
  const kind = String(value ?? '').toLowerCase();
  if (['lead', 'leads', '2'].includes(kind)) return 'lead';
  if (['contact', 'contacts', '1'].includes(kind)) return 'contact';
  return kind ? 'other' : null;
}

function binding(payload: Record<string, unknown>, talkId: string | null, contactId: string | null): CrmControlMessageEvidence['binding'] {
  const pairs = [
    { kind: entityKind(payload.entity_type), id: entityId(payload.entity_id) },
    { kind: entityKind(payload.element_type), id: entityId(payload.element_id) },
  ].filter((pair) => pair.kind && pair.id);
  if (pairs.length === 2 && (pairs[0].kind !== pairs[1].kind || pairs[0].id !== pairs[1].id)) {
    return { kind: 'conflict', leadExternalId: null };
  }
  const pair = pairs[0];
  if (pair?.kind === 'lead') return { kind: 'exact_lead', leadExternalId: pair.id };
  if (pair?.kind === 'other') return { kind: 'other_entity', leadExternalId: null };
  if (talkId) return { kind: 'talk_unresolved', leadExternalId: null };
  return { kind: pair?.kind === 'contact' || contactId ? 'contact_ambiguous' : 'unbound', leadExternalId: null };
}

export function crmControlAttachmentUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
    if (isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') || /\.(localhost|local|internal|test|invalid)$/.test(host)) return null;
    if (!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return url.href;
  } catch { return null; }
}

function attachment(value: unknown): CrmControlSourceAttachment {
  const item = record(value) ?? {};
  const url = crmControlAttachmentUrl(item.link);
  const fileUuid = text(item.file_uuid);
  const versionUuid = text(item.version_uuid);
  return {
    name: text(item.file_name), type: text(item.type), url, urlStatus: url ? 'HTTPS_CANDIDATE' : 'REJECTED',
    identifierHints: {
      fileUuid: fileUuid && UUID.test(fileUuid) ? fileUuid.toLowerCase() : null,
      versionUuid: versionUuid && UUID.test(versionUuid) ? versionUuid.toLowerCase() : null,
      urlUuidCandidates: url ? [...new Set((url.match(UUID_IN_URL) ?? []).map((id) => id.toLowerCase()))] : [],
    },
    contentSha256: null,
  };
}

export function normalizeCrmControlWebhook(row: CrmControlWebhookSourceRow): CrmControlMessageEvidence | null {
  if (!['message', 'outgoing_message'].includes(row.entity) || row.action !== 'add') return null;
  const payload = record(row.payload) ?? {};
  const author = record(payload.author) ?? {};
  const recipient = record(payload.recipient) ?? {};
  const actorKind = ['internal', 'external', 'bot'].includes(String(author.type))
    ? author.type as 'internal' | 'external' | 'bot' : 'unknown';
  const declaredDirection = payload.type;
  let direction: CrmControlMessageEvidence['direction'] = 'unverified';
  // Account webhooks include Salesbot sends. A bot is never attributed to a manager.
  // https://new.amocrm.ru/developers/content/crm_platform/webhooks-format
  if (row.entity === 'outgoing_message' && ['internal', 'bot'].includes(actorKind) && recipient.type === 'external'
    && (declaredDirection == null || declaredDirection === 'outgoing')) direction = 'outgoing';
  if (row.entity === 'message' && actorKind === 'external' && (recipient.type == null || recipient.type === 'internal')
    && (declaredDirection == null || declaredDirection === 'incoming')) direction = 'incoming';
  const messageId = ref(payload.id);
  const occurredAt = timestamp(payload.created_at);
  const authorId = ref(author.id);
  const recipientId = ref(recipient.id);
  const talkId = entityId(payload.talk_id);
  const contactId = entityId(payload.contact_id);
  const attachments = payload.attachment == null ? [] : [attachment(payload.attachment)];
  const resolvedBinding = binding(payload, talkId, contactId);
  const issues: string[] = [];
  if (!record(row.payload)) issues.push('INVALID_PAYLOAD');
  if (!messageId) issues.push('MISSING_MESSAGE_ID');
  if (!occurredAt) issues.push('INVALID_SOURCE_TIME');
  if (!validDate(row.receivedAt)) issues.push('INVALID_RECEIPT_TIME');
  if (occurredAt && validDate(row.receivedAt) && occurredAt > row.receivedAt) issues.push('SOURCE_TIME_AFTER_RECEIPT');
  if (direction === 'unverified') issues.push('UNVERIFIED_DIRECTION');
  if (!authorId || direction === 'outgoing' && !recipientId) issues.push('MISSING_PARTICIPANT_ID');
  if (resolvedBinding.kind === 'conflict') issues.push('CONFLICTING_ENTITY_BINDINGS');
  if (attachments.some((item) => item.urlStatus === 'REJECTED')) issues.push('REJECTED_ATTACHMENT_URL');
  return {
    connectionId: row.connectionId, messageId, sourceRefs: [{ inboxId: row.id, receivedAt: row.receivedAt }],
    rawSha256: createHash('sha256').update(canonicalJson({ entity: row.entity, action: row.action, payload: row.payload })).digest('hex'),
    direction, actorKind, authorId, authorUserId: actorKind === 'internal' ? entityId(author.user_id) : null,
    recipientId, occurredAt, text: text(payload.text), origin: text(payload.origin), chatId: ref(payload.chat_id), talkId, contactId,
    binding: resolvedBinding, attachments, deliveryStatus: 'UNVERIFIED', issues,
    eligibleAsOutgoingEvidence: direction === 'outgoing' && issues.every((issue) => issue === 'REJECTED_ATTACHMENT_URL'),
  };
}

/** Retain changed payloads under one message ID as conflicting revisions, never last-write-wins. */
export function normalizeCrmControlWebhookRows(rows: CrmControlWebhookSourceRow[]): CrmControlMessageEvidence[] {
  const groups = new Map<string, Map<string, CrmControlMessageEvidence>>();
  for (const row of rows) {
    const message = normalizeCrmControlWebhook(row);
    if (!message) continue;
    const key = JSON.stringify([message.connectionId, message.messageId ?? `inbox:${row.id}`]);
    const variants = groups.get(key) ?? new Map<string, CrmControlMessageEvidence>();
    const same = variants.get(message.rawSha256);
    if (same) same.sourceRefs.push(...message.sourceRefs);
    else variants.set(message.rawSha256, message);
    groups.set(key, variants);
  }
  return [...groups.values()].flatMap((variants) => [...variants.values()].map((message) => variants.size > 1 ? {
    ...message, eligibleAsOutgoingEvidence: false, issues: [...message.issues, 'MESSAGE_ID_CONFLICT'],
  } : message));
}

export function indexCrmControlSourcesForDeals(
  messages: CrmControlMessageEvidence[],
  options: { connectionId: string; dealExternalIds: readonly string[]; observedAt: Date; talkBindings?: readonly CrmControlTalkBindingProof[] },
): CrmControlSourceDealIndex {
  if (!validDate(options.observedAt)) throw new Error('Некорректное время проверки источников CRM.');
  const result: CrmControlSourceDealIndex = {
    byDeal: new Map(options.dealExternalIds.map((id) => [id, []])), unresolved: [],
    outOfScopeCount: 0, excludedAfterObservationCount: 0, sourceCoverage: 'UNVERIFIED',
  };
  const talks = new Map<string, CrmControlTalkBindingProof[]>();
  for (const proof of options.talkBindings ?? []) {
    if (proof.connectionId !== options.connectionId || !proof.sourceReference.trim() || !validDate(proof.validFrom)
      || !validDate(proof.validTo) || proof.validFrom >= proof.validTo) continue;
    talks.set(proof.talkId, [...(talks.get(proof.talkId) ?? []), proof]);
  }
  for (const message of messages) {
    if (message.connectionId !== options.connectionId) continue;
    if (message.occurredAt && message.occurredAt > options.observedAt) { result.excludedAfterObservationCount++; continue; }
    if (!message.occurredAt || ['conflict', 'other_entity'].includes(message.binding.kind) || message.issues.includes('MESSAGE_ID_CONFLICT')) {
      result.unresolved.push(message); continue;
    }
    const matches = (talks.get(message.talkId ?? '') ?? []).filter((proof) =>
      message.occurredAt! >= proof.validFrom && message.occurredAt! < proof.validTo);
    const leadIds = new Set(matches.map((proof) => proof.leadExternalId));
    if (message.binding.leadExternalId) leadIds.add(message.binding.leadExternalId);
    if (leadIds.size !== 1) { result.unresolved.push(message); continue; }
    const leadId = [...leadIds][0];
    const target = result.byDeal.get(leadId);
    if (!target) { result.outOfScopeCount++; continue; }
    target.push({ message, bindingProof: message.binding.leadExternalId
      ? { kind: 'webhook_entity', sourceReference: message.sourceRefs[0].inboxId }
      : { kind: 'talk', sourceReference: matches[0].sourceReference } });
  }
  for (const messagesForDeal of result.byDeal.values()) messagesForDeal.sort((left, right) =>
    left.message.occurredAt!.getTime() - right.message.occurredAt!.getTime() || String(left.message.messageId).localeCompare(String(right.message.messageId)));
  return result;
}
