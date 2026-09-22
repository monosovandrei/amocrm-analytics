import type { CrmBrowserPrivateManifest } from './crm-control-browser-source.service';
import type { CrmControlSemanticObservation } from './crm-control-semantic.request';
import { CrmControlSemanticRequest, CrmControlSemanticSource } from './crm-control-semantic.validation';
import { normalizeCrmControlMailText } from './crm-control-mail-text';

/** Only immutable, checksum-verified private manifests reach this function. Addresses never enter model requests. */
export function appendCrmControlArchivedMailSources(observation: CrmControlSemanticObservation, request: CrmControlSemanticRequest,
  manifest: CrmBrowserPrivateManifest, connection: { id: string; accountId: string | null }): CrmControlSemanticRequest {
  if (!['deadline_agreement','price_delay'].includes(request.check)) return request;
  const snapshot = observation.snapshot as any, browser = snapshot?.browserSources, raw = snapshot?.deal?.raw;
  const observed = observation.observedAt.getTime(), stage = Date.parse(request.stageEnteredAt ?? '');
  const start = Date.parse(manifest.startedAt), finish = Date.parse(manifest.finishedAt);
  if (!browser || !raw || !observation.dealExternalId || snapshot.sourceCompleteness?.deal !== true
    || snapshot.deal.id !== observation.dealId || snapshot.deal.responsibleId !== observation.managerId
    || String(raw.id) !== observation.dealExternalId || request.dealId !== observation.dealId || request.ownerId !== observation.managerId
    || Date.parse(request.observedAt) !== observed || !Number.isFinite(stage)
    || connection.id !== browser.connectionId || !connection.accountId || connection.accountId !== browser.accountExternalId
    || manifest.connectionId !== connection.id || manifest.accountExternalId !== connection.accountId
    || raw.account_id != null && String(raw.account_id) !== connection.accountId
    || manifest.dealExternalId !== observation.dealExternalId || manifest.history?.dealExternalId !== observation.dealExternalId
    || !Number.isFinite(start) || !Number.isFinite(finish) || start > finish || finish > observed
    || browser.startedAt !== manifest.startedAt || browser.finishedAt !== manifest.finishedAt
    || !Array.isArray(manifest.history.entries) || !Array.isArray(manifest.history.threads) || manifest.history.threads.length > 32) return request;
  const contacts = new Set((Array.isArray(raw._embedded?.contacts) ? raw._embedded.contacts : []).map((contact: any) => String(contact.id)));
  const appended: CrmControlSemanticSource[] = [], seen = new Set(request.sources.map(source => source.id));
  for (const thread of manifest.history.threads) {
    if (!/^[1-9]\d*$/.test(thread.id) || !Array.isArray(thread.messages) || thread.messages.length > 1000) return request;
    for (const message of thread.messages) {
      const at = Date.parse(message.occurredAt), participants = message.participants;
      if (message.sent !== false || !Number.isFinite(at) || at < stage || at > observed
        || !/^[1-9]\d*$/.test(message.id) || !participants || participants.reasonCodes.length || participants.from?.length !== 1) continue;
      const sender = participants.from[0];
      if (sender.type !== 'contact' || !sender.id || !contacts.has(sender.id)) continue;
      // The native contact identity must belong to this deal; an email or display name alone is not enough.
      const bound = thread.binding === 'DEAL' || manifest.history.entries.some(entry => entry.binding === 'DEAL'
        && entry.entityId === observation.dealExternalId && entry.mail?.threadId === thread.id
        && entry.mail.messageId === message.id && entry.mail.sent === false);
      if (!bound || typeof message.content !== 'string') continue;
      const text = normalizeCrmControlMailText(message.content);
      if (!text.eligibleAsSemanticText) continue;
      const sourceId = `mail:${thread.id}:${message.id}`;
      if (seen.has(sourceId)) return request;
      seen.add(sourceId);
      appended.push({ id: sourceId, sourceHash: text.textSha256, dealId: observation.dealId, ownerId: observation.managerId!,
        subjectId: null, kind: 'customer_message', actor: 'customer', actorId: `contact:${sender.id}`, direction: 'incoming',
        text: text.text, createdAt: new Date(at).toISOString() });
    }
  }
  return appended.length ? { ...request, sources: [...request.sources, ...appended] } : request;
}
