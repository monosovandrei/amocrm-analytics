import type { BrowserContext } from 'playwright-core';
import { CrmSourceAuthExpiredError, validateCrmCaptureUrl } from './crm-control-evidence.service';
import { CrmChatHistory, CrmChatJsonCapture } from './crm-control-chat-history';

/** Avoid rendering a card only when both independent inventories twice confirm that it has no chats. */
export async function readEmptyCrmChatHistory(context: BrowserContext, input: {
  origin: string; connectionId: string; accountExternalId: string; dealExternalId: string;
}): Promise<CrmChatHistory | null> {
  validateCrmCaptureUrl(`${input.origin}/leads/detail/${input.dealExternalId}`, input.dealExternalId, input.origin);
  if (!input.connectionId || !/^[1-9]\d{0,19}$/.test(input.accountExternalId)) return null;
  const startedAt = new Date().toISOString();
  const read = async (kind: 'talks' | 'chats'): Promise<CrmChatJsonCapture | null> => {
    const url = new URL(kind === 'talks' ? '/api/v4/talks' : `/ajax/v4/leads/${input.dealExternalId}/chats`, input.origin);
    if (kind === 'talks') {
      url.searchParams.set('filter[entity_type]', 'lead'); url.searchParams.set('filter[entity_id]', input.dealExternalId);
      url.searchParams.set('page', '1'); url.searchParams.set('limit', '250');
    }
    const response = await context.request.get(url.href, { timeout: 15_000, maxRedirects: 0,
      headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: input.origin, Referer: `${input.origin}/` } });
    try {
      const httpStatus = response.status();
      if (httpStatus === 401) throw new CrmSourceAuthExpiredError();
      if (httpStatus === 204) return { httpStatus, capturedAt: new Date().toISOString(), value: null };
      if (httpStatus !== 200 || Number(response.headers()['content-length'] || 0) > 64 * 1024) return null;
      const bytes = await response.body(); if (bytes.length > 64 * 1024) return null;
      let value: any; try { value = JSON.parse(bytes.toString('utf8')); } catch { return null; }
      if (!Array.isArray(value?._embedded?.[kind]) || value._embedded[kind].length || value?._links?.next) return null;
      return { httpStatus, capturedAt: new Date().toISOString(), value };
    } finally { await response.dispose(); }
  };
  const initial = await read('talks'); if (!initial) return null;
  const relatedInitial = await read('chats'); if (!relatedInitial) return null;
  const confirmation = await read('talks'); if (!confirmation) return null;
  const relatedConfirmation = await read('chats'); if (!relatedConfirmation) return null;
  return { schemaVersion: 1, accountExternalId: input.accountExternalId, dealExternalId: input.dealExternalId,
    startedAt, finishedAt: new Date().toISOString(), readComplete: true, reasonCodes: [], chats: [],
    inventory: { initial: [initial], confirmation: [confirmation], relatedInitial, relatedConfirmation } };
}
