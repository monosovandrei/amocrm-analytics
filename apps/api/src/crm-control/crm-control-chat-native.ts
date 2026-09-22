import type { Page } from 'playwright-core';
import type { CrmChatHistoryTransport, CrmChatJsonCapture } from './crm-control-chat-history';
import type { CrmControlChatAccountUser, CrmControlChatExternalContact } from './crm-control-chat-message';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';

export interface CrmChatNativeAccountMetadata {
  accountExternalId: string; amojoAccountId: string; amojoOrigin: string; capturedAt: string;
  accountUsers: CrmControlChatAccountUser[]; accountUserCatalogAvailable: boolean;
  /** Native account members whose CRM user ID cannot be resolved; never infer that they are customers. */
  unresolvedAccountActorIds?: string[];
}
export interface CrmControlChatNative {
  transport: CrmChatHistoryTransport;
  accountMetadata: CrmChatNativeAccountMetadata;
  readNativeExternalTargets(chatIds: readonly string[]): Promise<CrmControlChatExternalContact[]>;
}
type NativeOperation = 'metadata' | 'talks' | 'related' | 'messages' | 'count' | 'talk' | 'external';
interface NativeArgs {
  operation: NativeOperation; origin: string; accountId: string; dealId: string; deadline: number;
  amojoAccountId?: string; amojoOrigin?: string; chatId?: string; talkId?: string; page?: number; offset?: number; limit?: number;
}
type NativeReply = { ok: true; capture: CrmChatJsonCapture } | { ok: false; code: string };
const identifier = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
  : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
const numeric = (value: unknown) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as any : null;

/** Self-contained because Playwright serializes the function into the leased first-party page. */
async function readNative(args: NativeArgs): Promise<NativeReply> {
  const win = (globalThis as any).window;
  const fail = (code: string): never => { throw new Error(code); };
  const id = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null;
  const numericId = (value: unknown) => { const parsed = id(value); return parsed && /^[1-9]\d{0,19}$/.test(parsed) ? parsed : null; };
  const remaining = () => { const ms = args.deadline - Date.now(); if (ms <= 0) fail('CHAT_TIME_LIMIT'); return Math.min(10_000, ms); };
  const body = (value: unknown) => {
    let serialized: string;
    try { serialized = JSON.stringify(value ?? null); } catch { return fail('CHAT_NATIVE_BODY_INVALID'); }
    if (new TextEncoder().encode(serialized).length > 8 * 1024 * 1024) fail('CHAT_NATIVE_BODY_LIMIT');
    return JSON.parse(serialized);
  };
  const account = () => {
    if (win?.location?.origin !== args.origin || win.location.pathname.replace(/\/$/, '') !== `/leads/detail/${args.dealId}`) fail('CHAT_SCOPE_CHANGED');
    const value = win.AMOCRM?.constant?.('account');
    if (numericId(value?.id) !== args.accountId) fail('CHAT_ACCOUNT_CONFLICT');
    let server: URL;
    try { server = new URL(value?.amojo_server); } catch { return fail('CHAT_NATIVE_ACCOUNT_INVALID'); }
    if (server.protocol !== 'https:' || server.username || server.password || server.port || server.search || server.hash
      || server.pathname !== '/' || !/^amojo(?:-[a-z0-9]+)?\.amocrm\.ru$/.test(server.hostname) || !id(value?.amojo_id)) fail('CHAT_NATIVE_ACCOUNT_INVALID');
    if ((args.amojoAccountId && id(value.amojo_id) !== args.amojoAccountId)
      || (args.amojoOrigin && server.origin !== args.amojoOrigin)) fail('CHAT_ACCOUNT_CONFLICT');
    return { value, origin: server.origin };
  };
  // Fixed IDs were observed in the first-party history client. Require only already loaded AMD modules.
  const moduleById = (moduleId: number): any => {
    let factory: Function | undefined;
    for (const chunk of Array.isArray(win.webpackChunk) ? win.webpackChunk.slice(0, 300) : []) {
      if (typeof chunk?.[1]?.[moduleId] === 'function') { factory = chunk[1][moduleId]; break; }
    }
    if (!factory) return null;
    const source = Function.prototype.toString.call(factory);
    if (source.length > 500_000) return null;
    const names = [...source.matchAll(/["'](\.\.\/build\/transpiled\/[a-zA-Z0-9_/-]+)["']/g)];
    const name = names.at(-1)?.[1];
    if (!name || typeof win.require !== 'function') return null;
    try { return win.require(name); } catch { return null; }
  };
  const errorStatus = (error: any) => error?.status === 401 || error?.xhr?.status === 401 ? 'CHAT_AUTH_EXPIRED'
    : error?.status === 403 || error?.xhr?.status === 403 ? 'CHAT_ACCESS_DENIED' : 'CHAT_NATIVE_READ_FAILED';
  const invoke = (observable: any): Promise<unknown> => new Promise((resolve, reject) => {
    let subscription: any, settled = false;
    const done = (error: string | null, value?: unknown) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { subscription?.unsubscribe(); } catch { /* Cleanup never changes the result. */ }
      if (error) reject(new Error(error)); else resolve(value);
    };
    const timer = setTimeout(() => done('CHAT_NATIVE_TIMEOUT'), remaining());
    try {
      if (typeof observable?.subscribe !== 'function') { done('CHAT_NATIVE_CONTRACT_CHANGED'); return; }
      subscription = observable.subscribe({ next: (value: unknown) => {
        try { done(null, body(value)); } catch { done('CHAT_NATIVE_BODY_LIMIT'); }
      }, error: (error: unknown) => done(errorStatus(error)), complete: () => done('CHAT_NATIVE_EMPTY_RESPONSE') });
      if (settled) subscription?.unsubscribe();
    } catch { done('CHAT_NATIVE_READ_FAILED'); }
  });
  const get = (url: string): Promise<{ status: number; value: unknown }> => new Promise((resolve, reject) => {
    const jq = win.jQuery ?? win.$;
    if (typeof jq?.ajax !== 'function') { reject(new Error('CHAT_NATIVE_TRANSPORT_UNAVAILABLE')); return; }
    let request: any, settled = false;
    const done = (error: string | null, status = 0, value: unknown = null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(new Error(error)); else resolve({ status, value });
    };
    const timeout = remaining(), timer = setTimeout(() => {
      done('CHAT_NATIVE_TIMEOUT'); try { request?.abort(); } catch { /* No browser error text is returned. */ }
    }, timeout);
    try {
      request = jq.ajax({ url, method: 'GET', dataType: 'json', timeout });
      request.done((value: unknown, _status: unknown, xhr: any) => {
        const status = xhr?.status;
        if (status === 401) { done('CHAT_AUTH_EXPIRED'); return; }
        if (status === 403) { done('CHAT_ACCESS_DENIED'); return; }
        if (status === 204) { done(null, 204); return; }
        if (status !== 200) { done('CHAT_NATIVE_READ_FAILED'); return; }
        try { done(null, status, body(value)); } catch { done('CHAT_NATIVE_BODY_LIMIT'); }
      }).fail((xhr: unknown) => done(errorStatus(xhr)));
    } catch { done('CHAT_NATIVE_READ_FAILED'); }
  });
  try {
    remaining(); const initial = account();
    let value: unknown, status = 200;
    if (args.operation === 'metadata') {
      const users = moduleById(128199);
      let catalog: unknown;
      try { catalog = users?.getByAmoJoId?.(); } catch { catalog = null; }
      let available = catalog !== null && typeof catalog === 'object' && !Array.isArray(catalog);
      const accountUsers: CrmControlChatAccountUser[] = [], seen = new Set<string>(), unresolved = new Set<string>();
      if (available) {
        const entries = Object.entries(catalog as Record<string, any>);
        if (entries.length > 10_000) available = false;
        else for (const [key, user] of entries) {
          const amojoId = id(user?.amojo_id), crmUserId = numericId(user?.id);
          if (!amojoId || !crmUserId || key !== amojoId || seen.has(amojoId)) {
            available = false;
            if (id(key)) unresolved.add(key);
            if (amojoId) unresolved.add(amojoId);
            continue;
          }
          seen.add(amojoId); accountUsers.push({ amojoId, crmUserId });
        }
      }
      value = { accountExternalId: args.accountId, amojoAccountId: id(initial.value.amojo_id), amojoOrigin: initial.origin,
        accountUsers: accountUsers.filter(user => !unresolved.has(user.amojoId)), unresolvedAccountActorIds: [...unresolved],
        accountUserCatalogAvailable: available, capturedAt: new Date().toISOString() };
    } else if (args.operation === 'talks' || args.operation === 'related' || args.operation === 'talk') {
      // Official talks uses singular "lead". Omitting only_in_work includes closed conversations.
      const url = args.operation === 'talks' ? `/api/v4/talks?filter[entity_type]=lead&filter[entity_id]=${args.dealId}&page=${args.page}&limit=${args.limit}`
        : args.operation === 'related' ? `/ajax/v4/leads/${args.dealId}/chats` : `/api/v4/talks/${args.talkId}`;
      const read = await get(url); value = read.value; status = read.status;
    } else {
      let api: any;
      try { api = win.require('../build/transpiled/interface/amojo/api'); } catch { fail('CHAT_NATIVE_MODULE_UNAVAILABLE'); }
      if (args.operation === 'messages') {
        if (typeof api?.fetchMessages !== 'function') fail('CHAT_NATIVE_CONTRACT_CHANGED');
        value = await invoke(api.fetchMessages(args.chatId, args.offset, args.limit));
      } else if (args.operation === 'count') {
        if (typeof api?.getChatsStat !== 'function') fail('CHAT_NATIVE_CONTRACT_CHANGED');
        const rows = await invoke(api.getChatsStat([args.chatId]));
        if (!Array.isArray(rows) || rows.length !== 1 || id(rows[0]?.id) !== args.chatId
          || !Number.isSafeInteger(rows[0]?.count) || rows[0].count < 0) fail('CHAT_COUNT_INVALID');
        value = (rows as Array<{ count: number }>)[0].count;
      } else {
        if (typeof api?.getChat !== 'function') fail('CHAT_NATIVE_CONTRACT_CHANGED');
        await invoke(api.getChat(args.chatId));
        const mediator = moduleById(794653), targetModule = moduleById(337587);
        let target: any;
        try {
          const nativeChat = mediator?.AmoJoMediator?.get?.()?.[args.chatId!];
          target = nativeChat && targetModule?.ExistingExternalChatTarget?.createFromChat?.(nativeChat);
          const amojoId = id(target?.getAmojoUserId?.()), contactId = numericId(target?.getContactId?.());
          value = amojoId && contactId ? { chatId: args.chatId, amojoId, contactId } : null;
        } catch { value = null; }
      }
    }
    remaining(); const final = account();
    if (id(final.value.amojo_id) !== id(initial.value.amojo_id) || final.origin !== initial.origin) fail('CHAT_ACCOUNT_CONFLICT');
    return { ok: true, capture: { httpStatus: status, capturedAt: new Date().toISOString(), value } };
  } catch (error) {
    const allowed = new Set(['CHAT_TIME_LIMIT', 'CHAT_SCOPE_CHANGED', 'CHAT_ACCOUNT_CONFLICT', 'CHAT_NATIVE_ACCOUNT_INVALID',
      'CHAT_NATIVE_BODY_INVALID', 'CHAT_NATIVE_BODY_LIMIT', 'CHAT_AUTH_EXPIRED', 'CHAT_ACCESS_DENIED', 'CHAT_NATIVE_READ_FAILED',
      'CHAT_NATIVE_TIMEOUT', 'CHAT_NATIVE_CONTRACT_CHANGED', 'CHAT_NATIVE_EMPTY_RESPONSE', 'CHAT_NATIVE_TRANSPORT_UNAVAILABLE',
      'CHAT_NATIVE_MODULE_UNAVAILABLE', 'CHAT_COUNT_INVALID']);
    return { ok: false, code: error instanceof Error && allowed.has(error.message) ? error.message : 'CHAT_NATIVE_READ_FAILED' };
  }
}

/** Use only inside the provider's leased, serialized readCard callback with its read-receipt guard active. */
export async function createCrmControlChatNative(page: Page, input: {
  origin: string; connectionId: string; accountExternalId: string; dealExternalId: string; deadlineMs?: number;
}): Promise<CrmControlChatNative> {
  let url: URL;
  try { url = new URL(input.origin); } catch { throw new Error('CHAT_SCOPE_INVALID'); }
  if (url.protocol !== 'https:' || url.origin !== input.origin || !/^[a-z0-9-]+\.amocrm\.ru$/.test(url.hostname)
    || url.port || url.username || url.password || !numeric(input.accountExternalId) || !numeric(input.dealExternalId)
    || typeof input.connectionId !== 'string' || !input.connectionId.trim() || input.connectionId.length > 200
    || (input.deadlineMs !== undefined && (!Number.isFinite(input.deadlineMs) || input.deadlineMs < 1))) throw new Error('CHAT_SCOPE_INVALID');
  const deadline = Date.now() + Math.min(180_000, input.deadlineMs ?? 120_000);
  let metadata: CrmChatNativeAccountMetadata | undefined;
  const run = async (operation: NativeOperation, extra: Partial<NativeArgs> = {}) => {
    if (Date.now() >= deadline) throw new Error('CHAT_TIME_LIMIT');
    let result: NativeReply;
    try { result = await page.evaluate(readNative, { operation, origin: input.origin, accountId: input.accountExternalId,
      dealId: input.dealExternalId, deadline, amojoAccountId: metadata?.amojoAccountId, amojoOrigin: metadata?.amojoOrigin, ...extra }); }
    catch { throw new Error('CHAT_NATIVE_READ_FAILED'); }
    if (!result.ok) {
      if (result.code === 'CHAT_AUTH_EXPIRED') throw new CrmSourceAuthExpiredError();
      throw new Error(/^CHAT_[A-Z_]+$/.test(result.code) ? result.code : 'CHAT_NATIVE_READ_FAILED');
    }
    return result.capture;
  };
  metadata = (await run('metadata')).value as CrmChatNativeAccountMetadata;
  const chats = new Set<string>(), talks = new Set<string>();
  const observeChats = (capture: CrmChatJsonCapture, key: 'talks' | 'chats') => {
    const rows = object(object(capture.value)?._embedded)?.[key];
    if (capture.httpStatus === 200 && Array.isArray(rows)) for (const row of rows) {
      const chatId = identifier(row?.chat_id);
      if (chatId && (key === 'chats' || (String(row?.account_id) === input.accountExternalId
        && row?.entity_type === 'lead' && String(row?.entity_id) === input.dealExternalId))) chats.add(chatId);
    }
    return capture;
  };
  const requireChat = (chatId: string) => { if (!identifier(chatId) || !chats.has(chatId)) throw new Error('CHAT_NOT_OBSERVED'); };
  const positive = (value: number, max: number) => { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('CHAT_ARGUMENT_INVALID'); };
  const transport: CrmChatHistoryTransport = {
    listTalks: async (pageNumber, limit) => { positive(pageNumber, 20); positive(limit, 250); return observeChats(await run('talks', { page: pageNumber, limit }), 'talks'); },
    listRelatedChats: async () => observeChats(await run('related'), 'chats'),
    readMessages: async (chatId, offset, limit) => {
      requireChat(chatId); positive(limit, 50);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 5000) throw new Error('CHAT_ARGUMENT_INVALID');
      const capture = await run('messages', { chatId, offset, limit });
      if (Array.isArray(capture.value)) for (const row of capture.value) {
        const talkId = identifier(object(object(row)?.dialog)?.id);
        if (talkId && numeric(talkId) && (object(row)?.chat_id === undefined || object(row)?.chat_id === chatId)) talks.add(talkId);
      }
      return capture;
    },
    readCount: async chatId => { requireChat(chatId); return (await run('count', { chatId })).value as number; },
    readTalk: async talkId => {
      if (!numeric(talkId) || !talks.has(talkId)) throw new Error('CHAT_TALK_NOT_OBSERVED');
      return run('talk', { talkId });
    },
  };
  return { transport, accountMetadata: metadata, readNativeExternalTargets: async chatIds => {
    if (!Array.isArray(chatIds) || chatIds.length > 32 || new Set(chatIds).size !== chatIds.length) throw new Error('CHAT_ARGUMENT_INVALID');
    chatIds.forEach(requireChat);
    const result: CrmControlChatExternalContact[] = [];
    for (const chatId of chatIds) {
      const value = (await run('external', { chatId })).value;
      if (value) result.push(value as CrmControlChatExternalContact);
    }
    return result;
  } };
}
