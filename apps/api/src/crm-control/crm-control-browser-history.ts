import { createHash } from 'node:crypto';
import type { BrowserContext, Page, Response } from 'playwright-core';
import { validateMailAttachmentDownload } from './crm-control-browser-files';

/** Private collector output. Message bodies must stay on the local analysis host, never in API responses or logs. */
export interface BrowserTimelineEntry {
  id: string;
  sourceHash: string;
  occurredAt: string;
  eventType: number;
  entityId: string;
  entityType: number;
  binding: 'DEAL' | 'RELATED_ENTITY';
  objectType: string;
  noteId: string | null;
  text: string | null;
  mail: { threadId: string; messageId: string; sent: boolean; private: boolean } | null;
  chat: { chatId: string; messageId: string; text: string | null } | null;
}

export interface BrowserMailMessage {
  id: string;
  occurredAt: string;
  sent: boolean;
  subject: string;
  content: string;
  /** Metadata only. A filename or attachment ID is not a content hash or document version. */
  attachments: Array<{ id: string; name: string; declaredSizeBytes: number | null; downloadBlocked: boolean; state: string | null; sourceHash: string }>;
  attachmentCount: number;
  sourceHash: string;
}

export interface BrowserMailThread {
  id: string;
  binding: 'DEAL' | 'RELATED_ENTITY';
  messages: BrowserMailMessage[];
  messageListComplete: boolean;
  attachmentContentComplete: boolean;
  expectedMessages: number | null;
  reasonCodes: string[];
}

export interface CrmBrowserHistory {
  dealExternalId: string;
  startedAt: string;
  finishedAt: string;
  entries: BrowserTimelineEntry[];
  threads: BrowserMailThread[];
  timelineServerReportedEnd: boolean;
  /** A terminal UI feed page does not prove coverage of all messages, calls or linked entities. */
  communicationsComplete: false;
  reasonCodes: string[];
}

type Json = Record<string, any>;
const object = (value: unknown): Json | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
const numericId = (value: unknown): string | null => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  || (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) ? String(value) : null;
const sourceId = (value: unknown): string | null => numericId(value)
  ?? (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : null);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const date = (value: unknown): string | null => typeof value === 'number' && Number.isFinite(value) && value > 0
  && value < 100_000_000_000 ? new Date(value * 1000).toISOString() : null;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAIL_ORIGIN = 'https://amomail.amocrm.ru';
const MAX_TIMELINE_PAGES = 5;
const MAX_THREADS = 32;
const MAX_ENTRIES = 5000;
const MAX_MESSAGES = 1000;
const MAX_MAIL_PAGES = 20;

export class BrowserHistoryError extends Error {
  constructor(readonly code: string) { super(code); }
}

function accountOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new BrowserHistoryError('ACCOUNT_INVALID'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9][a-z0-9-]*\.(?:amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(url.hostname)
    || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new BrowserHistoryError('ACCOUNT_INVALID');
  return url.origin;
}

/** Follow only the actual older-page link; `next` in this API means newer events. */
export function validateBrowserTimelineUrl(value: string, origin: string, dealId: string): string {
  const account = accountOrigin(origin);
  if (!numericId(dealId)) throw new BrowserHistoryError('DEAL_INVALID');
  let url: URL;
  try { url = new URL(value, account); } catch { throw new BrowserHistoryError('TIMELINE_LINK_INVALID'); }
  if (url.origin !== account || url.username || url.password || url.hash
    || ![`/ajax/v3/leads/${dealId}/events_timeline`, `/ajax/v3/leads/${dealId}/events_timeline/`].includes(url.pathname)) {
    throw new BrowserHistoryError('TIMELINE_LINK_INVALID');
  }
  const keys = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    if (keys.has(key) || !['limit', 'filter[created_at][lt]', 'filter[created_at][gt]'].includes(key)
      || !/^\d+(?:\.\d+)?$/.test(parameter) || !Number.isFinite(Number(parameter))) throw new BrowserHistoryError('TIMELINE_LINK_INVALID');
    if (key === 'limit' && (!/^\d+$/.test(parameter) || Number(parameter) < 1 || Number(parameter) > MAX_ENTRIES)) throw new BrowserHistoryError('TIMELINE_LINK_INVALID');
    keys.add(key);
  }
  return url.href;
}

export function parseBrowserTimelinePage(value: unknown, origin: string, dealId: string): {
  entries: BrowserTimelineEntry[]; olderUrl: string | null; serverReportedEnd: boolean; linkedEntitiesTruncated: boolean;
} {
  const root = object(value), embedded = object(root?._embedded), links = object(root?._links);
  if (!embedded || !Array.isArray(embedded.items) || embedded.items.length > MAX_ENTRIES) throw new BrowserHistoryError('TIMELINE_SCHEMA_INVALID');
  if (root?._links !== undefined && !links) throw new BrowserHistoryError('TIMELINE_SCHEMA_INVALID');
  const seen = new Set<string>();
  const entries = embedded.items.map((item: unknown): BrowserTimelineEntry => {
    const entry = object(item), data = object(entry?.data), id = sourceId(entry?.id), occurredAt = date(entry?.date_create);
    const entityId = numericId(entry?.element_id), objectType = entry?.object_type?.code;
    if (!entry || !id || !occurredAt || !entityId || !Number.isInteger(entry.element_type) || !Number.isInteger(entry.type)
      || typeof objectType !== 'string' || !data || seen.has(id)) throw new BrowserHistoryError('TIMELINE_SCHEMA_INVALID');
    seen.add(id);
    const params = object(data.params), reference = object(params?.link_data);
    let mail: BrowserTimelineEntry['mail'] = null;
    if (reference) {
      const threadId = numericId(reference.thread_id), messageId = numericId(reference.message_id);
      if (!threadId || !messageId || typeof params?.sent !== 'boolean' || typeof params?.private !== 'boolean') throw new BrowserHistoryError('MAIL_REFERENCE_INVALID');
      mail = { threadId, messageId, sent: params.sent, private: params.private };
    }
    let chat: BrowserTimelineEntry['chat'] = null;
    if (data.chat_id !== undefined || data.message !== undefined) {
      const chatId = sourceId(data.chat_id), messageId = sourceId(data.id), message = object(data.message);
      if (!chatId || !messageId || !message) throw new BrowserHistoryError('CHAT_REFERENCE_INVALID');
      chat = { chatId, messageId, text: typeof message.text === 'string' ? message.text : null };
    }
    const noteId = entry.note_id == null ? null : numericId(entry.note_id);
    if (entry.note_id != null && !noteId) throw new BrowserHistoryError('NOTE_REFERENCE_INVALID');
    return { id, sourceHash: hash(entry), occurredAt, eventType: entry.type, entityId, entityType: entry.element_type,
      binding: entry.element_type === 2 && entityId === dealId ? 'DEAL' : 'RELATED_ENTITY', objectType, noteId,
      text: typeof data.text === 'string' ? data.text : null, mail, chat };
  });
  const older = links?.prev;
  if (older !== undefined && typeof older !== 'string') throw new BrowserHistoryError('TIMELINE_LINK_INVALID');
  const olderUrl = typeof older === 'string' ? validateBrowserTimelineUrl(older, origin, dealId) : null;
  if (olderUrl && (!new URL(olderUrl).searchParams.has('filter[created_at][lt]') || new URL(olderUrl).searchParams.has('filter[created_at][gt]'))) {
    throw new BrowserHistoryError('TIMELINE_LINK_INVALID');
  }
  // The API mixes tasks and linked-contact events; absence of prev is not proof of complete communications.
  return { entries, olderUrl, serverReportedEnd: !olderUrl, linkedEntitiesTruncated: embedded.too_much_linked_entities !== false };
}

export function parseBrowserMailThread(value: unknown, threadId: string, dealId: string): BrowserMailThread['binding'] {
  const thread = object(value), entity = object(thread?.entity);
  if (numericId(thread?.id) !== threadId) throw new BrowserHistoryError('MAIL_THREAD_INVALID');
  return entity?.type === 'lead' && numericId(entity.id) === dealId ? 'DEAL' : 'RELATED_ENTITY';
}

export function parseBrowserMailPage(value: unknown): { messages: BrowserMailMessage[]; total: number; nextPageToken: string | null } {
  const root = object(value);
  if (!root || !Array.isArray(root.items) || root.items.length > MAX_MESSAGES || !Number.isSafeInteger(root.total) || root.total < 0
    || root.items.length > root.total || !(root.next_page_token === null || (typeof root.next_page_token === 'string'
      && root.next_page_token.length > 0 && root.next_page_token.length <= 4096))) throw new BrowserHistoryError('MAIL_PAGE_INVALID');
  const seen = new Set<string>();
  const messages = root.items.map((value: unknown): BrowserMailMessage => {
    const message = object(value), id = numericId(message?.id), occurredAt = date(message?.date);
    if (!message || !id || !occurredAt || seen.has(id) || typeof message.sent !== 'boolean' || typeof message.subject !== 'string'
      || typeof message.content !== 'string' || !Array.isArray(message.attachments)) throw new BrowserHistoryError('MAIL_PAGE_INVALID');
    seen.add(id);
    const attachmentIds = new Set<string>();
    const attachments = message.attachments.map((value: unknown): BrowserMailMessage['attachments'][number] => {
      const attachment = object(value), attachmentId = numericId(attachment?.id);
      if (!attachment || !attachmentId || attachmentIds.has(attachmentId) || typeof attachment.name !== 'string'
        || typeof attachment.size !== 'string' || typeof attachment.download_blocked !== 'boolean'
        || !(attachment.state === null || typeof attachment.state === 'string')) throw new BrowserHistoryError('MAIL_ATTACHMENT_INVALID');
      attachmentIds.add(attachmentId);
      const size = /^\d+$/.test(attachment.size) ? Number(attachment.size) : NaN;
      // Never replay the arbitrary metadata URL. The downloader resolves this exact ID through the mail API.
      return { id: attachmentId, name: attachment.name, declaredSizeBytes: Number.isSafeInteger(size) ? size : null,
        downloadBlocked: attachment.download_blocked, state: attachment.state, sourceHash: hash(attachment) };
    });
    return { id, occurredAt, sent: message.sent, subject: message.subject, content: message.content,
      attachments, attachmentCount: attachments.length, sourceHash: hash(message) };
  });
  return { messages, total: root.total, nextPageToken: root.next_page_token };
}

async function readJson(context: BrowserContext, url: string, origin: string, deadline: number, revealToken?: string): Promise<unknown> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BrowserHistoryError('COLLECTION_LIMIT');
  const response = await context.request.get(url, { timeout: Math.min(15_000, remaining), maxRedirects: 0,
    headers: { 'X-Requested-With': 'XMLHttpRequest', Origin: origin, Referer: `${origin}/`, ...(revealToken ? { 'X-Reveal-Token': revealToken } : {}) } });
  try {
    if (response.status() !== 200) throw new BrowserHistoryError(response.status() === 401 ? 'HISTORY_AUTH_EXPIRED'
      : response.status() === 403 ? 'HISTORY_ACCESS_DENIED' : 'HISTORY_RESPONSE_ERROR');
    const length = Number(response.headers()['content-length']);
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new BrowserHistoryError('HISTORY_RESPONSE_TOO_LARGE');
    const body = await response.body();
    if (body.length > MAX_BODY_BYTES) throw new BrowserHistoryError('HISTORY_RESPONSE_TOO_LARGE');
    try { return JSON.parse(body.toString('utf8')); } catch { throw new BrowserHistoryError('HISTORY_JSON_INVALID'); }
  } finally { await response.dispose(); }
}

export interface CrmBrowserHistoryReader {
  collect: () => Promise<CrmBrowserHistory>; dispose: () => void;
  prepareAttachment: (reference: { threadId: string; messageId: string; attachmentId: string }, signal: AbortSignal) => Promise<{ downloadUrl: string }>;
}

/** Same verified endpoints and parsers, without rendering another card. The provider supplies the account observed in its leased browser session. */
export function createCrmBrowserHistoryReader(context: BrowserContext, input: {
  origin: string; dealExternalId: string; mailAccountId: string | null; initialTimelineUrl?: string;
}): CrmBrowserHistoryReader {
  const origin = accountOrigin(input.origin), dealId = numericId(input.dealExternalId);
  if (!dealId) throw new BrowserHistoryError('DEAL_INVALID');
  const timelineUrl = validateBrowserTimelineUrl(input.initialTimelineUrl ?? `${origin}/ajax/v3/leads/${dealId}/events_timeline`, origin, dealId);
  const mailAccountId = input.mailAccountId === null ? null : numericId(input.mailAccountId);
  if (input.mailAccountId !== null && !mailAccountId) throw new BrowserHistoryError('MAIL_ACCOUNT_UNVERIFIED');
  let disposed = false;
  let collectedAccountId: string | null = null;
  const attachments = new Map<string, BrowserMailMessage['attachments'][number]>();
  return {
    dispose: () => { disposed = true; attachments.clear(); },
    prepareAttachment: async (reference, signal) => {
      const key = `${reference.threadId}:${reference.messageId}:${reference.attachmentId}`;
      const attachment = attachments.get(key);
      if (disposed || !collectedAccountId || !attachment) throw new BrowserHistoryError('MAIL_ATTACHMENT_NOT_OBSERVED');
      if (attachment.downloadBlocked || attachment.state === 'archived') throw new BrowserHistoryError('MAIL_ATTACHMENT_BLOCKED');
      const endpoint = `${MAIL_ORIGIN}/api/v2/${collectedAccountId}/attachments/${attachment.id}`;
      const headers = { 'X-Requested-With': 'XMLHttpRequest', Origin: origin, Referer: `${origin}/` };
      let requested = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        signal.throwIfAborted();
        const value = object(await readJson(context, endpoint, origin, Date.now() + 15_000));
        signal.throwIfAborted();
        if (value?.status === 'complete' && typeof value.url === 'string') {
          return { downloadUrl: validateMailAttachmentDownload(value.url, attachment.id) };
        }
        if (value?.status === 'not_downloaded' && !requested) {
          // The user's collector authorization includes preparation of this exact observed attachment only.
          signal.throwIfAborted();
          const response = await context.request.post(endpoint, { maxRedirects: 0, timeout: 15_000, headers });
          try {
            if (response.status() === 401) throw new BrowserHistoryError('HISTORY_AUTH_EXPIRED');
            if (response.status() === 403) throw new BrowserHistoryError('HISTORY_ACCESS_DENIED');
            if (![200, 202, 204].includes(response.status())) throw new BrowserHistoryError('MAIL_ATTACHMENT_PREPARATION_FAILED');
          }
          finally { await response.dispose(); }
          requested = true;
        } else if (!['not_downloaded', 'processing'].includes(value?.status)) throw new BrowserHistoryError('MAIL_ATTACHMENT_PREPARATION_FAILED');
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) { reject(new BrowserHistoryError('COLLECTION_LIMIT')); return; }
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1500);
          const abort = () => { clearTimeout(timer); reject(new BrowserHistoryError('COLLECTION_LIMIT')); };
          signal.addEventListener('abort', abort, { once: true });
        });
      }
      throw new BrowserHistoryError('MAIL_ATTACHMENT_PREPARATION_PENDING');
    },
    collect: async () => {
      const startedAt = new Date().toISOString(), deadline = Date.now() + 60_000;
      const result: CrmBrowserHistory = { dealExternalId: dealId, startedAt, finishedAt: startedAt, entries: [], threads: [],
        timelineServerReportedEnd: false, communicationsComplete: false, reasonCodes: ['ALL_CHANNEL_COVERAGE_UNPROVEN'] };
      const reasons = new Set(result.reasonCodes);
      const finish = () => ({ ...result, reasonCodes: [...reasons], finishedAt: new Date().toISOString() });
      if (disposed) throw new BrowserHistoryError('HISTORY_READER_DISPOSED');
      const seenUrls = new Set<string>(), seenEntries = new Map<string, BrowserTimelineEntry>();
      try {
        let url: string | null = timelineUrl, revealToken: string | undefined;
        for (let index = 0; url && index < MAX_TIMELINE_PAGES; index++) {
          if (seenUrls.has(url)) throw new BrowserHistoryError('TIMELINE_CURSOR_REPEATED');
          seenUrls.add(url);
          const payload = await readJson(context, validateBrowserTimelineUrl(url, origin, dealId), origin, deadline, revealToken);
          const nextRevealToken = object(payload)?.reveal_token;
          if (nextRevealToken != null) {
            if (typeof nextRevealToken !== 'string' || !nextRevealToken || nextRevealToken.length > 8192 || /[\r\n]/.test(nextRevealToken)) {
              throw new BrowserHistoryError('TIMELINE_REVEAL_TOKEN_INVALID');
            }
            revealToken = nextRevealToken; // Actual client carries it only between account timeline requests; never stored in result.
          }
          const parsed = parseBrowserTimelinePage(payload, origin, dealId);
          if (parsed.linkedEntitiesTruncated) reasons.add('LINKED_ENTITY_COVERAGE_UNPROVEN');
          for (const entry of parsed.entries) {
            const previous = seenEntries.get(entry.id);
            if (previous && previous.sourceHash !== entry.sourceHash) throw new BrowserHistoryError('TIMELINE_CHANGED_DURING_READ');
            if (!previous) { seenEntries.set(entry.id, entry); result.entries.push(entry); }
            if (seenEntries.size > MAX_ENTRIES) throw new BrowserHistoryError('COLLECTION_LIMIT');
          }
          result.timelineServerReportedEnd = parsed.serverReportedEnd;
          url = parsed.olderUrl;
        }
        if (!result.timelineServerReportedEnd) reasons.add('TIMELINE_PAGE_LIMIT');
      } catch (error) {
        if (error instanceof BrowserHistoryError && error.code === 'HISTORY_AUTH_EXPIRED') throw error;
        reasons.add(error instanceof BrowserHistoryError ? error.code : 'HISTORY_READ_FAILED');
      }
      if (result.entries.some(entry => entry.binding === 'RELATED_ENTITY')) reasons.add('RELATED_ENTITY_HISTORY_PRESENT');
      const refs = new Map<string, string[]>();
      for (const entry of result.entries) if (entry.mail) refs.set(entry.mail.threadId, [...(refs.get(entry.mail.threadId) ?? []), entry.mail.messageId]);
      if (refs.size && !mailAccountId) { reasons.add('MAIL_ACCOUNT_UNVERIFIED'); return finish(); }
      const verifiedMailAccount = mailAccountId;
      collectedAccountId = verifiedMailAccount;
      if (refs.size > MAX_THREADS) reasons.add('MAIL_THREAD_LIMIT');
      for (const [threadId, expectedIds] of [...refs.entries()].slice(0, MAX_THREADS)) {
        const thread: BrowserMailThread = { id: threadId, binding: 'RELATED_ENTITY', messages: [], messageListComplete: false,
          attachmentContentComplete: false, expectedMessages: null, reasonCodes: [] };
        result.threads.push(thread);
        try {
          const metadata = await readJson(context, `${MAIL_ORIGIN}/api/v2/${verifiedMailAccount}/threads/${threadId}`, origin, deadline);
          thread.binding = parseBrowserMailThread(metadata, threadId, dealId);
          let nextToken: string | null = null, terminal = false;
          const tokens = new Set<string>(), messageIds = new Set<string>();
          // Verified in amoCRM's static mail client: getMessages passes next_page_token to this same endpoint.
          // opened_at and the separate readThread POST are deliberately absent: collection must not mark mail read.
          for (let pageIndex = 0; pageIndex < MAX_MAIL_PAGES; pageIndex++) {
            const url = new URL(`${MAIL_ORIGIN}/api/v2.1/${verifiedMailAccount}/threads/${threadId}/messages`);
            url.searchParams.set('limit', '100');
            if (nextToken) url.searchParams.set('next_page_token', nextToken);
            const parsed = parseBrowserMailPage(await readJson(context, url.href, origin, deadline));
            if (thread.expectedMessages !== null && thread.expectedMessages !== parsed.total) throw new BrowserHistoryError('MAIL_TOTAL_CHANGED');
            thread.expectedMessages = parsed.total;
            for (const message of parsed.messages) {
              if (messageIds.has(message.id)) throw new BrowserHistoryError('MAIL_MESSAGE_REPEATED');
              messageIds.add(message.id); thread.messages.push(message);
              for (const attachment of message.attachments) attachments.set(`${threadId}:${message.id}:${attachment.id}`, attachment);
              if (messageIds.size > MAX_MESSAGES) throw new BrowserHistoryError('COLLECTION_LIMIT');
            }
            nextToken = parsed.nextPageToken;
            if (!nextToken) { terminal = true; break; }
            if (tokens.has(nextToken)) throw new BrowserHistoryError('MAIL_CURSOR_REPEATED');
            tokens.add(nextToken);
          }
          if (!terminal) thread.reasonCodes.push('MAIL_PAGE_LIMIT');
          if (thread.messages.length !== thread.expectedMessages) thread.reasonCodes.push('MAIL_MESSAGE_COUNT_MISMATCH');
          if (expectedIds.some(id => !thread.messages.some(message => message.id === id))) thread.reasonCodes.push('MAIL_REFERENCE_NOT_RETURNED');
          thread.messageListComplete = !thread.reasonCodes.length;
          thread.attachmentContentComplete = thread.messages.every(message => message.attachmentCount === 0) && thread.messageListComplete;
          if (!thread.attachmentContentComplete) thread.reasonCodes.push('ATTACHMENT_CONTENT_UNVERIFIED');
          if (thread.binding !== 'DEAL') thread.reasonCodes.push('MAIL_NOT_BOUND_TO_DEAL');
        } catch (error) {
          if (error instanceof BrowserHistoryError && error.code === 'HISTORY_AUTH_EXPIRED') throw error;
          thread.reasonCodes.push(error instanceof BrowserHistoryError ? error.code : 'HISTORY_READ_FAILED');
        }
      }
      return finish();
    },
  };
}

/** Compatibility/native discovery adapter. It never guesses a mailbox account from the deal ID. */
export function observeCrmBrowserHistory(page: Page, input: { origin: string; dealExternalId: string; discoveryWaitMs?: number }): CrmBrowserHistoryReader {
  const origin = accountOrigin(input.origin), dealId = numericId(input.dealExternalId);
  if (!dealId) throw new BrowserHistoryError('DEAL_INVALID');
  let timelineUrl: string | null = null, timelineFailure: string | null = null, mailAccountId: string | null = null;
  let accountConflict = false, disposed = false, reader: CrmBrowserHistoryReader | undefined;
  const discoveryWaitMs = Math.max(0, Math.min(10_000, input.discoveryWaitMs ?? 5000));
  const listeners = new Set<() => void>();
  const waitForDiscovery = async (ready: () => boolean) => {
    if (ready() || !discoveryWaitMs || disposed) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); listeners.delete(check); resolve(); };
      const check = () => { if (ready() || disposed) finish(); };
      const timer = setTimeout(finish, discoveryWaitMs); listeners.add(check); check();
    });
  };
  const listener = (response: Response) => {
    if (response.request().method() !== 'GET') return;
    let url: URL; try { url = new URL(response.url()); } catch { return; }
    if (url.origin === origin && url.pathname.replace(/\/$/, '') === `/ajax/v3/leads/${dealId}/events_timeline`) {
      try {
        const target = validateBrowserTimelineUrl(url.href, origin, dealId);
        if (response.status() === 200) { timelineUrl ??= target; timelineFailure = null; }
        else timelineFailure = [401, 403].includes(response.status()) ? 'HISTORY_ACCESS_DENIED' : 'HISTORY_RESPONSE_ERROR';
      } catch { /* Rejected URLs never select a request target. */ }
    }
    const match = url.pathname.match(/^\/api\/v2\/(\d+)\/leads\/(\d+)\/compose$/);
    if (response.status() === 200 && url.origin === MAIL_ORIGIN && !url.username && !url.password && !url.hash
      && match?.[2] === dealId && numericId(match[1])) {
      if (mailAccountId && mailAccountId !== match[1]) accountConflict = true; else mailAccountId = match[1];
    }
    for (const notify of listeners) notify();
  };
  page.on('response', listener);
  return {
    dispose: () => { disposed = true; reader?.dispose(); page.off('response', listener); for (const notify of listeners) notify(); },
    prepareAttachment: (reference, signal) => {
      if (disposed || !reader || accountConflict) return Promise.reject(new BrowserHistoryError('MAIL_ATTACHMENT_NOT_OBSERVED'));
      return reader.prepareAttachment(reference, signal);
    },
    collect: async () => {
      const startedAt = new Date().toISOString(), card = new URL(page.url());
      if (disposed || card.origin !== origin || ![`/leads/detail/${dealId}`, `/leads/detail/${dealId}/`].includes(card.pathname)
        || card.username || card.password || card.search || card.hash) throw new BrowserHistoryError('WRONG_CARD');
      await waitForDiscovery(() => !!timelineUrl || !!timelineFailure);
      if (!timelineUrl || timelineFailure) return { dealExternalId: dealId, startedAt, finishedAt: new Date().toISOString(),
        entries: [], threads: [], timelineServerReportedEnd: false, communicationsComplete: false,
        reasonCodes: ['ALL_CHANNEL_COVERAGE_UNPROVEN', timelineFailure ?? 'TIMELINE_NOT_OBSERVED'] };
      await waitForDiscovery(() => !!mailAccountId || accountConflict);
      reader?.dispose();
      reader = createCrmBrowserHistoryReader(page.context(), { origin, dealExternalId: dealId,
        mailAccountId: accountConflict ? null : mailAccountId, initialTimelineUrl: timelineUrl });
      return reader.collect();
    },
  };
}
