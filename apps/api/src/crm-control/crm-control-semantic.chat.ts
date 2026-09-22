import type { CrmBrowserPrivateManifest } from './crm-control-browser-source.service';
import type { CrmControlSemanticObservation } from './crm-control-semantic.request';
import { CrmControlSemanticRequest, CrmControlSemanticSource, crmControlSemanticTextHash } from './crm-control-semantic.validation';
import { bindCrmControlChatMessage } from './crm-control-chat-binding';
import { normalizeCrmControlChatMessage } from './crm-control-chat-message';

const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const numeric = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const time = (value: unknown): number => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;

/**
 * Called only after readManifest verifies immutable SHA/size, and after the connection is loaded from the server DB.
 * Rebuild both relation and actor proof from archived raw captures. Stored normalized flags are not authority.
 */
export function appendCrmControlArchivedChatSources(observation: CrmControlSemanticObservation, request: CrmControlSemanticRequest,
  manifest: CrmBrowserPrivateManifest, connection: { id: string; accountId: string | null }): CrmControlSemanticRequest {
  if (!['deadline_agreement', 'price_delay'].includes(request.check)) return request;
  const snapshot = record(observation.snapshot), browser = record(snapshot.browserSources), raw = record(snapshot.deal?.raw);
  const accountId = browser.accountExternalId, connectionId = browser.connectionId, dealId = observation.dealExternalId;
  const observed = observation.observedAt.getTime(), stageEntered = time(request.stageEnteredAt), start = time(manifest?.startedAt), finish = time(manifest?.finishedAt);
  const chatHistory = manifest?.chatHistory, chatAccount = manifest?.chatAccount;
  if (!numeric(dealId) || !numeric(accountId) || !id(connectionId) || connection.id !== connectionId || connection.accountId !== accountId
    || manifest?.connectionId !== connectionId || manifest.accountExternalId !== accountId || manifest.dealExternalId !== dealId
    || chatHistory?.accountExternalId !== accountId || chatHistory.dealExternalId !== dealId || chatAccount?.accountExternalId !== accountId
    || snapshot.deal?.id !== observation.dealId || snapshot.deal?.responsibleId !== observation.managerId
    || String(raw.id) !== dealId || (raw.account_id != null && String(raw.account_id) !== accountId)
    || request.dealId !== observation.dealId || request.ownerId !== observation.managerId || time(request.observedAt) !== observed
    || snapshot.sourceCompleteness?.deal !== true || !Number.isFinite(stageEntered)
    || !Number.isFinite(start) || !Number.isFinite(finish) || start > finish || finish > observed
    || time(browser.startedAt) !== start || time(browser.finishedAt) !== finish
    || !Number.isFinite(time(chatHistory.startedAt)) || !Number.isFinite(time(chatHistory.finishedAt))
    || time(chatHistory.startedAt) < start || time(chatHistory.finishedAt) > finish || time(chatHistory.startedAt) > time(chatHistory.finishedAt)
    || !Number.isFinite(time(chatAccount.capturedAt)) || time(chatAccount.capturedAt) < start || time(chatAccount.capturedAt) > finish
    || !Array.isArray(chatHistory.chats) || chatHistory.chats.length > 32 || !Array.isArray(chatAccount.accountUsers)
    || !Array.isArray(manifest.chatExternalContacts)) return request;
  const contacts = new Set((Array.isArray(raw._embedded?.contacts) ? raw._embedded.contacts : []).map((item: any) => String(item?.id)));
  const appended: CrmControlSemanticSource[] = [], seen = new Set(request.sources.map(source => source.id));
  const chats = new Set<string>();
  for (const chat of chatHistory.chats) {
    if (!id(chat?.chatId) || chats.has(chat.chatId) || !Array.isArray(chat.messages) || !Array.isArray(chat.talks) || !Array.isArray(chat.confirmations)) return request;
    chats.add(chat.chatId);
    const targets = manifest.chatExternalContacts.filter(target => target.chatId === chat.chatId);
    for (const entry of chat.messages) {
      const message = record(entry.capture?.value), talkId = String(record(message.dialog).id ?? '');
      const first = chat.talks.filter(talk => talk.requestedTalkId === talkId), last = chat.confirmations.filter(talk => talk.requestedTalkId === talkId);
      if (first.length !== 1 || last.length !== 1) continue;
      const binding = bindCrmControlChatMessage({ scope: { connectionId, accountExternalId: accountId, dealExternalId: dealId,
        chatId: chat.chatId, observedAt: observation.observedAt.toISOString() }, collectionStartedAt: chatHistory.startedAt,
        collectionFinishedAt: chatHistory.finishedAt, message: entry.capture, talk: first[0], confirmation: last[0] });
      if (binding.status !== 'BOUND') continue;
      const normalized = normalizeCrmControlChatMessage({ value: entry.capture.value, binding, accountUsers: chatAccount.accountUsers,
        accountUnknownActorIds: chatAccount.unresolvedAccountActorIds,
        externalContact: targets.length === 1 ? targets[0] : null }).message;
      if (!normalized || !normalized.eligibleAsSemanticSource || !normalized.text || !normalized.occurredAt
        || time(normalized.occurredAt) < stageEntered || time(normalized.occurredAt) > observed || !contacts.has(normalized.contactId)) continue;
      const customer = normalized.direction === 'incoming' && normalized.actorKind === 'external';
      const manager = normalized.direction === 'outgoing' && normalized.actorKind === 'internal'
        && normalized.authorUserId === String(raw.responsible_user_id ?? '');
      if (!customer && !manager) continue;
      const sourceId = `chat:${chat.chatId}:${normalized.messageId}`;
      if (seen.has(sourceId)) return request; // An ambiguous duplicate cannot silently select one payload.
      seen.add(sourceId);
      appended.push({ id: sourceId, sourceHash: crmControlSemanticTextHash(normalized.text), dealId: observation.dealId,
        ownerId: observation.managerId!, subjectId: null, kind: customer ? 'customer_message' : 'message',
        actor: customer ? 'customer' : 'manager', actorId: customer ? normalized.authorId : normalized.authorUserId,
        direction: normalized.direction as 'incoming' | 'outgoing', text: normalized.text, createdAt: normalized.occurredAt });
    }
  }
  // The chat inventory covers one channel only. Never infer email/call completeness from it.
  return appended.length ? { ...request, coverage: { ...request.coverage }, sources: [...request.sources, ...appended] } : request;
}
