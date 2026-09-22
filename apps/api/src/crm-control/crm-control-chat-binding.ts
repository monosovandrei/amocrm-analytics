import { createHash } from 'node:crypto';

export interface CrmControlChatScope {
  connectionId: string;
  accountExternalId: string;
  dealExternalId: string;
  chatId: string;
  observedAt: string;
}

/** Trusted transport metadata. These fields are supplied by the collector, not by message JSON. */
export interface CrmControlChatMessageCapture {
  requestedChatId: string;
  capturedAt: string;
  value: unknown;
}

/** Official GET /api/v4/talks/{requestedTalkId}, captured in the same authorized account. */
export interface CrmControlChatTalkCapture {
  requestedTalkId: string;
  capturedAt: string;
  httpStatus: number;
  value: unknown;
}

export interface CrmControlChatBindingInput {
  scope: CrmControlChatScope;
  collectionStartedAt: string;
  collectionFinishedAt: string;
  message: CrmControlChatMessageCapture;
  talk: CrmControlChatTalkCapture;
  confirmation: CrmControlChatTalkCapture;
}

export interface CrmControlChatBindingProof {
  kind: 'TALK_EXPLICIT_CURRENT_SNAPSHOT';
  scope: CrmControlChatScope;
  messageId: string;
  talkId: string;
  contactId: string;
  collectionStartedAt: string;
  collectionFinishedAt: string;
  messageCapturedAt: string;
  talkCapturedAt: string;
  confirmedAt: string;
  /** Canonical JSON hashes of the captures, not attachment bytes or an invented historical state. */
  messageSourceHash: string;
  talkSourceHash: string;
  confirmationSourceHash: string;
  historicalBindingIntervalProven: false;
}

export interface CrmControlChatBindingResult {
  status: 'BOUND' | 'OTHER_DEAL' | 'OTHER_ENTITY' | 'NOT_BOUND' | 'UNVERIFIED';
  reasonCodes: string[];
  proof: CrmControlChatBindingProof | null;
  /** This parser proves one relation. Inventory, pagination, message time and direction are separate checks. */
  communicationsComplete: false;
  sourceCoverage: 'UNVERIFIED';
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : null;
const id = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  ? String(value) : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const numericId = (value: unknown): string | null => {
  const parsed = id(value);
  return parsed && /^[1-9]\d{0,19}$/.test(parsed) ? parsed : null;
};
const instant = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  return new Date(parsed).toISOString() === canonical ? parsed : null;
};
export function crmControlChatSourceHash(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 1_048_576) throw new Error('CHAT_SOURCE_LIMIT');
  const canonical = (item: unknown): string => Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
    : item !== null && typeof item === 'object' ? `{${Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}` : JSON.stringify(item);
  return createHash('sha256').update(canonical(JSON.parse(serialized))).digest('hex');
}
const result = (status: CrmControlChatBindingResult['status'], code: string, proof: CrmControlChatBindingProof | null = null): CrmControlChatBindingResult => ({
  status, reasonCodes: code ? [code] : [], proof, communicationsComplete: false, sourceCoverage: 'UNVERIFIED',
});

interface TalkRelation {
  talkId: string;
  accountId: string;
  chatId: string;
  contactId: string;
  entityType: 'lead' | 'customer' | null;
  entityId: string | null;
}

function parseTalk(value: unknown): TalkRelation | string {
  const body = object(value), embedded = object(body?._embedded);
  const talkId = numericId(body?.talk_id), accountId = numericId(body?.account_id), chatId = id(body?.chat_id), contactId = numericId(body?.contact_id);
  if (!body || !embedded || !talkId || !accountId || !chatId || !contactId
    || ![null, 'lead', 'customer'].includes(body.entity_type as null | string)
    || !(body.entity_id === null || numericId(body.entity_id))) return 'TALK_SCHEMA_INVALID';
  const entityType = body.entity_type as TalkRelation['entityType'], entityId = numericId(body.entity_id);
  if ((entityType === null) !== (entityId === null)) return 'TALK_ENTITY_CONFLICT';
  const arrays = ['contacts', 'leads', 'customers'].map(key => embedded[key]);
  if (arrays.some(value => !Array.isArray(value) || value.length > 1)) return 'TALK_EMBEDDED_INVALID';
  const [contacts, leads, customers] = arrays as unknown[][];
  if (contacts.length !== 1 || numericId(object(contacts[0])?.id) !== contactId) return 'TALK_CONTACT_CONFLICT';
  const expectedLead = entityType === 'lead' ? entityId : null;
  const expectedCustomer = entityType === 'customer' ? entityId : null;
  if (leads.length !== (expectedLead ? 1 : 0) || (expectedLead && numericId(object(leads[0])?.id) !== expectedLead)
    || customers.length !== (expectedCustomer ? 1 : 0) || (expectedCustomer && numericId(object(customers[0])?.id) !== expectedCustomer)) return 'TALK_EMBEDDED_ENTITY_CONFLICT';
  return { talkId, accountId, chatId, contactId, entityType, entityId };
}

/**
 * A native message explicitly names its dialog; the official talk record explicitly
 * names its lead. Two consistent captures prove that relation for this observation.
 * A contact merely appearing on a deal does not qualify. The proof does not backdate
 * the relation, infer a speaker, or claim that every message/channel was collected.
 *
 * created_at on a talk is intentionally not used as a lower message-time boundary:
 * it is not documented as such. Message timestamps require their own unit validation.
 */
export function bindCrmControlChatMessage(input: CrmControlChatBindingInput): CrmControlChatBindingResult {
  const scope = input?.scope;
  if (!scope || typeof scope.connectionId !== 'string' || !scope.connectionId.trim() || scope.connectionId.length > 200
    || !numericId(scope.accountExternalId) || !numericId(scope.dealExternalId) || !id(scope.chatId)) return result('UNVERIFIED', 'CHAT_SCOPE_INVALID');
  const started = instant(input.collectionStartedAt), finished = instant(input.collectionFinishedAt), observed = instant(scope.observedAt);
  const messageAt = instant(input.message?.capturedAt), talkAt = instant(input.talk?.capturedAt), confirmationAt = instant(input.confirmation?.capturedAt);
  if ([started, finished, observed, messageAt, talkAt, confirmationAt].some(value => value === null)
    || started! > messageAt! || messageAt! > confirmationAt! || messageAt! > finished! || started! > talkAt! || talkAt! > confirmationAt!
    || confirmationAt! > finished! || finished! > observed!) return result('UNVERIFIED', 'CHAT_CAPTURE_TIME_INVALID');
  if (input.message.requestedChatId !== scope.chatId) return result('UNVERIFIED', 'CHAT_REQUEST_SCOPE_CONFLICT');
  const message = object(input.message.value), messageId = id(message?.id), dialogId = numericId(object(message?.dialog)?.id);
  if (!message || !messageId) return result('UNVERIFIED', 'CHAT_MESSAGE_INVALID');
  if (message.chat_id !== undefined && id(message.chat_id) !== scope.chatId) return result('UNVERIFIED', 'CHAT_MESSAGE_CHAT_CONFLICT');
  if (!dialogId) return result('NOT_BOUND', 'CHAT_MESSAGE_DIALOG_MISSING');
  if (input.talk.httpStatus !== 200 || input.confirmation.httpStatus !== 200) return result('UNVERIFIED', 'TALK_LOOKUP_UNAVAILABLE');
  if (input.talk.requestedTalkId !== dialogId || input.confirmation.requestedTalkId !== dialogId) return result('UNVERIFIED', 'TALK_REQUEST_ID_CONFLICT');
  const first = parseTalk(input.talk.value), last = parseTalk(input.confirmation.value);
  if (typeof first === 'string' || typeof last === 'string') return result('UNVERIFIED', typeof first === 'string' ? first : last as string);
  if (first.talkId !== dialogId || last.talkId !== dialogId) return result('UNVERIFIED', 'TALK_MESSAGE_ID_CONFLICT');
  if (first.accountId !== scope.accountExternalId || last.accountId !== scope.accountExternalId) return result('UNVERIFIED', 'TALK_ACCOUNT_CONFLICT');
  if (first.chatId !== scope.chatId || last.chatId !== scope.chatId) return result('UNVERIFIED', 'TALK_CHAT_CONFLICT');
  // Status/read/activity changes do not reassign a talk. Compare only the explicit relation.
  if (JSON.stringify(first) !== JSON.stringify(last)) return result('UNVERIFIED', 'TALK_RELATION_CHANGED');
  if (first.entityType === null) return result('NOT_BOUND', 'TALK_ENTITY_MISSING');
  if (first.entityType !== 'lead') return result('OTHER_ENTITY', 'TALK_CUSTOMER_ENTITY');
  if (first.entityId !== scope.dealExternalId) return result('OTHER_DEAL', 'TALK_OTHER_DEAL');
  try {
    return result('BOUND', '', {
      kind: 'TALK_EXPLICIT_CURRENT_SNAPSHOT', scope: { ...scope }, messageId, talkId: dialogId, contactId: first.contactId,
      collectionStartedAt: input.collectionStartedAt, collectionFinishedAt: input.collectionFinishedAt,
      messageCapturedAt: input.message.capturedAt, talkCapturedAt: input.talk.capturedAt, confirmedAt: input.confirmation.capturedAt,
      messageSourceHash: crmControlChatSourceHash(input.message.value), talkSourceHash: crmControlChatSourceHash(input.talk.value),
      confirmationSourceHash: crmControlChatSourceHash(input.confirmation.value),
      historicalBindingIntervalProven: false,
    });
  } catch { return result('UNVERIFIED', 'CHAT_SOURCE_UNSERIALIZABLE_OR_TOO_LARGE'); }
}
