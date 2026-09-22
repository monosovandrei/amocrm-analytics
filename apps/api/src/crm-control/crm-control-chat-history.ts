import { createHash } from 'node:crypto';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';
import { bindCrmControlChatMessage, CrmControlChatBindingResult, CrmControlChatMessageCapture,
  CrmControlChatTalkCapture } from './crm-control-chat-binding';

export interface CrmChatJsonCapture { httpStatus: number; capturedAt: string; value: unknown }
/** All operations are reads through one leased amoCRM account session. */
export interface CrmChatHistoryTransport {
  listTalks(page: number, limit: number): Promise<CrmChatJsonCapture>;
  listRelatedChats(): Promise<CrmChatJsonCapture>;
  readMessages(chatId: string, offset: number, limit: number): Promise<CrmChatJsonCapture>;
  readCount(chatId: string): Promise<number>;
  readTalk(talkId: string): Promise<CrmChatJsonCapture>;
}
export interface CrmChatHistoryMessage {
  capture: CrmControlChatMessageCapture; binding: CrmControlChatBindingResult;
}
export interface CrmChatHistory {
  schemaVersion: 1; accountExternalId: string; dealExternalId: string; startedAt: string; finishedAt: string;
  /** Covers this channel's current inventory and pagination, not all CRM communication channels. */
  readComplete: boolean; reasonCodes: string[];
  inventory: { initial: CrmChatJsonCapture[]; confirmation: CrmChatJsonCapture[];
    relatedInitial: CrmChatJsonCapture | null; relatedConfirmation: CrmChatJsonCapture | null };
  chats: Array<{ chatId: string; readComplete: boolean; reasonCodes: string[]; totalBefore: number | null; totalAfter: number | null;
    messages: CrmChatHistoryMessage[]; talks: CrmControlChatTalkCapture[]; confirmations: CrmControlChatTalkCapture[] }>;
}
const object = (v: unknown): Record<string, any> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as any : null;
const id = (v: unknown): string | null => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v)
  : typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v) ? v : null;
const numeric = (v: unknown) => { const s = id(v); return s && /^[1-9]\d{0,19}$/.test(s) ? s : null; };
const canonical = (v: any): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : object(v)
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function fail(code: string): never { throw new Error(code); }
const code = (e: unknown) => e instanceof Error && /^CHAT_[A-Z_]+$/.test(e.message) ? e.message : 'CHAT_READ_FAILED';

/** Bounded, reproducible capture. A limit, changing inventory or duplicate page cannot become complete. */
export async function collectCrmChatHistory(input: {
  connectionId: string; accountExternalId: string; dealExternalId: string; transport: CrmChatHistoryTransport;
  now?: () => Date; maxChats?: number; maxPages?: number; maxTalkPages?: number; deadlineMs?: number;
}): Promise<CrmChatHistory> {
  if (!input.connectionId || !numeric(input.accountExternalId) || !numeric(input.dealExternalId)) fail('CHAT_SCOPE_INVALID');
  const now = input.now ?? (() => new Date());
  const maxChats = Math.min(32, Math.max(1, input.maxChats ?? 32)), maxPages = Math.min(100, Math.max(1, input.maxPages ?? 100));
  const maxTalkPages = Math.min(20, Math.max(1, input.maxTalkPages ?? 20)), deadline = Date.now() + Math.min(180_000, input.deadlineMs ?? 120_000);
  const startedAt = now().toISOString();
  const output: CrmChatHistory = { schemaVersion: 1, accountExternalId: input.accountExternalId, dealExternalId: input.dealExternalId,
    startedAt, finishedAt: startedAt, readComplete: false, reasonCodes: [],
    inventory: { initial: [], confirmation: [], relatedInitial: null, relatedConfirmation: null }, chats: [] };
  const check = () => { if (Date.now() >= deadline) fail('CHAT_TIME_LIMIT'); };
  let capturedBytes = 0;
  const validCapture = (capture: CrmChatJsonCapture) => {
    const bytes = Buffer.byteLength(JSON.stringify(capture?.value ?? null), 'utf8');
    if (!capture || !Number.isFinite(Date.parse(capture.capturedAt)) || Date.parse(capture.capturedAt) < Date.parse(startedAt)
      || bytes > 8 * 1024 * 1024) fail('CHAT_CAPTURE_INVALID');
    capturedBytes += bytes;
    if (capturedBytes > 12 * 1024 * 1024) fail('CHAT_ARCHIVE_LIMIT');
    return capture;
  };
  const inventory = async (captures: CrmChatJsonCapture[]) => {
    const talks = new Map<string, { chatId: string; relation: string }>();
    for (let page = 1; page <= maxTalkPages; page++) {
      check(); const capture = validCapture(await input.transport.listTalks(page, 250)); captures.push(capture);
      if (capture.httpStatus === 204) return talks;
      const body = object(capture.value), rows = body?._embedded?.talks;
      if (capture.httpStatus !== 200 || !Array.isArray(rows) || rows.length > 250) fail('CHAT_TALK_INVENTORY_INVALID');
      for (const value of rows) {
        const talk = object(value), talkId = numeric(talk?.talk_id), chatId = id(talk?.chat_id);
        if (!talkId || !chatId || numeric(talk?.account_id) !== input.accountExternalId || talk?.entity_type !== 'lead'
          || numeric(talk?.entity_id) !== input.dealExternalId || !numeric(talk?.contact_id)) fail('CHAT_TALK_INVENTORY_SCOPE');
        if (talks.has(talkId)) fail('CHAT_TALK_INVENTORY_DUPLICATE');
        talks.set(talkId, { chatId, relation: digest([talkId, chatId, talk!.entity_type, String(talk!.entity_id), String(talk!.contact_id), String(talk!.account_id)]) });
      }
      const next = body?._links?.next;
      if (!next) return talks;
      if (!rows.length || !object(next) || typeof next.href !== 'string') fail('CHAT_TALK_PAGINATION_INVALID');
      // Never follow arbitrary source URLs: the transport always constructs its fixed GET endpoint and filter.
      let url: URL; try { url = new URL(next.href); } catch { fail('CHAT_TALK_PAGINATION_INVALID'); }
      if (url!.pathname !== '/api/v4/talks' || Number(url!.searchParams.get('page')) !== page + 1) fail('CHAT_TALK_PAGINATION_INVALID');
    }
    return fail('CHAT_TALK_INVENTORY_LIMIT');
  };
  const relatedIds = (capture: CrmChatJsonCapture) => {
    validCapture(capture); if (capture.httpStatus === 204) return [];
    const body = object(capture.value), rows = body?._embedded?.chats;
    if (capture.httpStatus !== 200 || !Array.isArray(rows) || rows.length > 1000 || body?._links?.next) fail('CHAT_RELATED_INVENTORY_INVALID');
    const ids = (rows as unknown[]).map(value => id(object(value)?.chat_id));
    if (ids.some(value => !value) || new Set(ids).size !== ids.length) fail('CHAT_RELATED_INVENTORY_INVALID');
    return (ids as string[]).sort();
  };
  try {
    const initial = await inventory(output.inventory.initial);
    output.inventory.relatedInitial = await input.transport.listRelatedChats();
    const related = relatedIds(output.inventory.relatedInitial);
    const chatIds = [...new Set([...initial.values()].map(t => t.chatId).concat(related))].sort();
    if (chatIds.length > maxChats) output.reasonCodes.push('CHAT_INVENTORY_LIMIT');
    for (const chatId of chatIds.slice(0, maxChats)) {
      const chat: CrmChatHistory['chats'][number] = { chatId, readComplete: false, reasonCodes: [], totalBefore: null, totalAfter: null,
        messages: [], talks: [], confirmations: [] };
      output.chats.push(chat);
      try {
        check(); chat.totalBefore = await input.transport.readCount(chatId);
        if (!Number.isSafeInteger(chat.totalBefore) || chat.totalBefore! < 0) fail('CHAT_COUNT_INVALID');
        const seen = new Map<string, CrmControlChatMessageCapture>(); let firstHash = '', terminal = false;
        for (let page = 0, offset = 0; page < maxPages; page++) {
          check(); const capture = validCapture(await input.transport.readMessages(chatId, offset, 50));
          if (capture.httpStatus !== 200 || !Array.isArray(capture.value) || capture.value.length > 50) fail('CHAT_MESSAGES_INVALID');
          if (!page) firstHash = digest(capture.value);
          for (const value of capture.value) {
            const messageId = id(object(value)?.id);
            if (!messageId || seen.has(messageId)) fail('CHAT_MESSAGE_DUPLICATE_OR_INVALID');
            seen.set(messageId, { requestedChatId: chatId, capturedAt: capture.capturedAt, value });
          }
          if (capture.value.length < 50) { terminal = true; break; }
          offset += capture.value.length;
        }
        if (!terminal) fail('CHAT_MESSAGES_LIMIT');
        check(); chat.totalAfter = await input.transport.readCount(chatId);
        if (chat.totalBefore !== chat.totalAfter || seen.size !== chat.totalAfter) fail('CHAT_COUNT_CHANGED_OR_INCOMPLETE');
        const repeated = validCapture(await input.transport.readMessages(chatId, 0, 50));
        if (repeated.httpStatus !== 200 || digest(repeated.value) !== firstHash) fail('CHAT_MESSAGES_CHANGED');
        const talkIds = [...new Set([...seen.values()].map(m => numeric(object(object(m.value)?.dialog)?.id)).filter((v): v is string => !!v))];
        if (talkIds.length > 100) fail('CHAT_TALK_LIMIT');
        for (const talkId of talkIds) {
          check(); chat.talks.push({ ...validCapture(await input.transport.readTalk(talkId)), requestedTalkId: talkId });
        }
        for (const talkId of talkIds) {
          check(); chat.confirmations.push({ ...validCapture(await input.transport.readTalk(talkId)), requestedTalkId: talkId });
        }
        const finishedAt = now().toISOString();
        for (const capture of seen.values()) {
          const talkId = numeric(object(object(capture.value)?.dialog)?.id);
          const absent: CrmControlChatTalkCapture = { requestedTalkId: talkId ?? '', capturedAt: finishedAt, httpStatus: 0, value: null };
          const binding = bindCrmControlChatMessage({ scope: { connectionId: input.connectionId, accountExternalId: input.accountExternalId,
            dealExternalId: input.dealExternalId, chatId, observedAt: finishedAt }, collectionStartedAt: startedAt, collectionFinishedAt: finishedAt,
            message: capture, talk: chat.talks.find(t => t.requestedTalkId === talkId) ?? absent,
            confirmation: chat.confirmations.find(t => t.requestedTalkId === talkId) ?? absent });
          // The per-message proof repeats scope and capture references. Include
          // that derived material in the budget, not just incoming HTTP bodies.
          capturedBytes += Buffer.byteLength(JSON.stringify({ capture, binding }), 'utf8');
          if (capturedBytes > 12 * 1024 * 1024) fail('CHAT_ARCHIVE_LIMIT');
          chat.messages.push({ capture, binding });
        }
        chat.readComplete = true;
      } catch (error) {
        if (error instanceof CrmSourceAuthExpiredError) throw error;
        chat.reasonCodes.push(code(error));
      }
      if (chat.reasonCodes.includes('CHAT_ARCHIVE_LIMIT')) { output.reasonCodes.push('CHAT_ARCHIVE_LIMIT'); break; }
    }
    check(); const confirmed = await inventory(output.inventory.confirmation);
    output.inventory.relatedConfirmation = await input.transport.listRelatedChats();
    if (canonical([...initial].sort()) !== canonical([...confirmed].sort())
      || canonical(related) !== canonical(relatedIds(output.inventory.relatedConfirmation))) output.reasonCodes.push('CHAT_INVENTORY_CHANGED');
    output.readComplete = !output.reasonCodes.length && output.chats.every(chat => chat.readComplete);
  } catch (error) {
    if (error instanceof CrmSourceAuthExpiredError) throw error;
    output.reasonCodes.push(code(error));
  }
  output.finishedAt = now().toISOString();
  return output;
}
