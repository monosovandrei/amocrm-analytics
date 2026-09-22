import { BrowserHistoryError, observeCrmBrowserHistory, parseBrowserMailPage, parseBrowserMailThread,
  parseBrowserTimelinePage, validateBrowserTimelineUrl } from './crm-control-browser-history';

const origin = 'https://test-account.amocrm.ru';
const time = 1_789_998_000;
const timelineUrl = `${origin}/ajax/v3/leads/123/events_timeline`;
const event = (overrides: Record<string, unknown> = {}) => ({ id: '01ABC-test', date_create: time, type: 16,
  element_id: 123, element_type: 2, object_type: { code: 'event' }, data: { text: 'Тестовое письмо', params: {
    sent: true, private: false, link_data: { thread_id: 7, message_id: 8 } } }, ...overrides });
const timeline = (items: unknown[] = [event()], links: unknown = {}) => ({ _links: links,
  _embedded: { items, too_much_linked_entities: false, types: [{ id: 16, name: 'UI filter, not an event type dictionary' }] } });
const mailMessage = (overrides: Record<string, unknown> = {}) => ({ id: 8, date: time, sent: true,
  subject: 'Тестовый оффер', content: '<p>Тестовый текст</p>', attachments: [], ...overrides });
const mailPage = (overrides: Record<string, unknown> = {}) => ({ items: [mailMessage()], total: 1, next_page_token: null, ...overrides });
const attachment = (overrides: Record<string, unknown> = {}) => ({ id: 91, name: 'Условный файл.pdf', size: '42',
  display_size: '42 bytes', url: 'https://not-a-download-allowlist.example/private', download_blocked: false, state: null, ...overrides });

describe('browser history private parsers', () => {
  it('preserves stable timeline identity, time and exact lead binding without interpreting filter names', () => {
    const page = parseBrowserTimelinePage(timeline(), origin, '123');
    expect(page.entries[0]).toMatchObject({ id: '01ABC-test', binding: 'DEAL', entityId: '123', eventType: 16,
      occurredAt: new Date(time * 1000).toISOString(), mail: { threadId: '7', messageId: '8' } });
    expect(page.entries[0].sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page).toMatchObject({ serverReportedEnd: true, linkedEntitiesTruncated: false });
    expect(page).not.toHaveProperty('communicationsComplete');
  });

  it.each([{ element_type: 1, element_id: 123 }, { element_type: 2, element_id: 999 }])('does not attach related entity history to the lead: %j', change => {
    expect(parseBrowserTimelinePage(timeline([event(change)]), origin, '123').entries[0].binding).toBe('RELATED_ENTITY');
  });

  it('follows prev for older history, not next, and rejects cursors pointing to newer history', () => {
    const prev = '/ajax/v3/leads/123/events_timeline/?limit=100&filter%5Bcreated_at%5D%5Blt%5D=1789998000.1';
    expect(parseBrowserTimelinePage(timeline([], { prev, next: '/ignored' }), origin, '123').olderUrl).toBe(origin + prev);
    expect(() => parseBrowserTimelinePage(timeline([], { prev: prev.replace('%5Blt%5D', '%5Bgt%5D') }), origin, '123')).toThrow('TIMELINE_LINK_INVALID');
  });

  it.each(['https://evil.example/ajax/v3/leads/123/events_timeline', `${origin}/ajax/v3/leads/999/events_timeline`,
    `${timelineUrl}?limit=1&limit=2`, `${timelineUrl}?token=secret`, `${timelineUrl}?limit=10000`, `${timelineUrl}#fragment`,
    `https://user:secret@test-account.amocrm.ru/ajax/v3/leads/123/events_timeline`])('rejects a foreign or unsupported timeline target', url => {
    expect(() => validateBrowserTimelineUrl(url, origin, '123')).toThrow(BrowserHistoryError);
  });

  it.each([{ id: null }, { date_create: '2026-09-22' }, { date_create: NaN }, { element_id: 0 }, { data: null },
    { data: { params: { link_data: { thread_id: 7, message_id: 8 } } } }])('rejects malformed timeline records', change => {
    expect(() => parseBrowserTimelinePage(timeline([event(change)]), origin, '123')).toThrow(BrowserHistoryError);
  });

  it('does not silently drop duplicate timeline IDs or claim coverage when linked entity status is missing', () => {
    expect(() => parseBrowserTimelinePage(timeline([event(), event()]), origin, '123')).toThrow('TIMELINE_SCHEMA_INVALID');
    expect(parseBrowserTimelinePage({ _embedded: { items: [] } }, origin, '123').linkedEntitiesTruncated).toBe(true);
  });

  it('keeps contact-bound chat references explicitly separate from lead-bound history', () => {
    const page = parseBrowserTimelinePage(timeline([event({ element_type: 1, element_id: 44,
      data: { chat_id: 'chat-uuid', id: 'message-uuid', message: { text: 'Условное сообщение', type: 'text' } } })]), origin, '123');
    expect(page.entries[0]).toMatchObject({ binding: 'RELATED_ENTITY', chat: { chatId: 'chat-uuid', messageId: 'message-uuid' } });
  });

  it('requires the returned thread identity and an exact lead entity', () => {
    expect(parseBrowserMailThread({ id: 7, entity: { type: 'lead', id: 123 } }, '7', '123')).toBe('DEAL');
    expect(parseBrowserMailThread({ id: 7, entity: { type: 'contact', id: 123 } }, '7', '123')).toBe('RELATED_ENTITY');
    expect(parseBrowserMailThread({ id: 7 }, '7', '123')).toBe('RELATED_ENTITY');
    expect(() => parseBrowserMailThread({ id: 9 }, '7', '123')).toThrow('MAIL_THREAD_INVALID');
  });

  it('preserves verified attachment metadata but does not expose its arbitrary URL as a trusted download target', () => {
    const page = parseBrowserMailPage(mailPage({ items: [mailMessage({ attachments: [attachment()] })] }));
    expect(page.messages[0]).toMatchObject({ id: '8', sent: true, content: '<p>Тестовый текст</p>', attachmentCount: 1 });
    expect(page.messages[0].attachments[0]).toMatchObject({ id: '91', declaredSizeBytes: 42, downloadBlocked: false, state: null });
    expect(page.messages[0].attachments[0]).not.toHaveProperty('url');
  });

  it('requires valid attachment identity and preserves explicit blocking without guessing document contents', () => {
    expect(() => parseBrowserMailPage(mailPage({ items: [mailMessage({ attachments: [attachment({ id: 'opaque' })] })] }))).toThrow('MAIL_ATTACHMENT_INVALID');
    expect(() => parseBrowserMailPage(mailPage({ items: [mailMessage({ attachments: [attachment(), attachment()] })] }))).toThrow('MAIL_ATTACHMENT_INVALID');
    const page = parseBrowserMailPage(mailPage({ items: [mailMessage({ attachments: [attachment({ download_blocked: true, state: 'archived', size: 'unknown' })] })] }));
    expect(page.messages[0].attachments[0]).toMatchObject({ downloadBlocked: true, state: 'archived', declaredSizeBytes: null });
  });

  it.each([{ total: 0 }, { total: -1 }, { next_page_token: undefined }, { next_page_token: '' },
    { items: [mailMessage(), mailMessage()], total: 2 }, { items: [mailMessage({ sent: 'true' })] },
    { items: [mailMessage({ date: null })] }, { items: [mailMessage({ attachments: {} })] }])('rejects a malformed mail page', change => {
    expect(() => parseBrowserMailPage(mailPage(change))).toThrow('MAIL_PAGE_INVALID');
  });
});

function harness(payloads: unknown[], options: { account?: string; card?: string } = {}) {
  const get = jest.fn(), post = jest.fn();
  for (const payload of payloads) get.mockResolvedValueOnce({ status: () => 200, headers: () => ({}),
    body: async () => Buffer.from(JSON.stringify(payload)), dispose: jest.fn() });
  let listener: (response: any) => void = () => {};
  const page = { on: jest.fn((name: string, callback: (response: any) => void) => { listener = callback; }), off: jest.fn(),
    url: () => options.card ?? `${origin}/leads/detail/123`, context: () => ({ request: { get, post } }) };
  const observer = observeCrmBrowserHistory(page as any, { origin, dealExternalId: '123', discoveryWaitMs: 0 });
  const response = (url: string, status = 200) => listener({ status: () => status, request: () => ({ method: () => 'GET' }), url: () => url });
  response(timelineUrl);
  if (options.account !== '') response(`https://amomail.amocrm.ru/api/v2/${options.account ?? '42'}/leads/123/compose`);
  return { observer, get, post, page, response };
}

describe('browser history bounded collector', () => {
  it('reads only observed account paths and certifies only a concrete complete mail message list', async () => {
    const { observer, get } = harness([timeline(), { id: 7, entity: { type: 'lead', id: 123 } }, mailPage()]);
    const output = await observer.collect();
    expect(output.communicationsComplete).toBe(false);
    expect(output.threads[0]).toMatchObject({ binding: 'DEAL', messageListComplete: true, attachmentContentComplete: true });
    expect(output.reasonCodes).toContain('ALL_CHANNEL_COVERAGE_UNPROVEN');
    expect(get.mock.calls[1][0]).toBe('https://amomail.amocrm.ru/api/v2/42/threads/7');
    expect(get.mock.calls.every((call: any[]) => call[1].maxRedirects === 0)).toBe(true);
    observer.dispose();
  });

  it.each([
    { page: mailPage({ total: 2 }), reason: 'MAIL_MESSAGE_COUNT_MISMATCH' },
    { page: mailPage({ items: [], total: 0 }), reason: 'MAIL_REFERENCE_NOT_RETURNED' },
  ])('fails closed on incomplete messages: $reason', async ({ page, reason }) => {
    const { observer } = harness([timeline(), { id: 7 }, page]);
    const output = await observer.collect();
    expect(output.threads[0].messageListComplete).toBe(false);
    expect(output.threads[0].reasonCodes).toContain(reason);
  });

  it('follows the verified opaque mail cursor on the same endpoint without opened_at or mutation requests', async () => {
    const token = 'opaque/with+characters?and=value';
    const { observer, get } = harness([timeline(), { id: 7, entity: { type: 'lead', id: 123 } },
      mailPage({ total: 2, next_page_token: token }), mailPage({ items: [mailMessage({ id: 9 })], total: 2 })]);
    const output = await observer.collect();
    expect(output.threads[0]).toMatchObject({ messageListComplete: true, expectedMessages: 2 });
    const nextUrl = new URL(get.mock.calls[3][0]);
    expect(nextUrl.searchParams.get('next_page_token')).toBe(token);
    expect(nextUrl.pathname).toBe('/api/v2.1/42/threads/7/messages');
    expect(nextUrl.searchParams.has('opened_at')).toBe(false);
  });

  it.each(['changed-total', 'duplicate-message', 'repeated-token'])('refuses inconsistent mail pagination: %s', change => {
    const first = mailPage({ total: 3, next_page_token: 'opaque' });
    const second = mailPage({ items: [mailMessage({ id: change === 'duplicate-message' ? 8 : 9 })],
      total: change === 'changed-total' ? 4 : 3, next_page_token: 'opaque' });
    const { observer } = harness([timeline(), { id: 7 }, first, second]);
    return observer.collect().then(output => {
      expect(output.threads[0].messageListComplete).toBe(false);
      expect(output.threads[0].reasonCodes).toContain({ 'changed-total': 'MAIL_TOTAL_CHANGED',
        'duplicate-message': 'MAIL_MESSAGE_REPEATED', 'repeated-token': 'MAIL_CURSOR_REPEATED' }[change]);
    });
  });

  it('does not turn unknown attachment contents into verified documents or treat a contact thread as a deal thread', async () => {
    const { observer } = harness([timeline(), { id: 7, entity: { type: 'contact', id: 123 } },
      mailPage({ items: [mailMessage({ attachments: [attachment()] })] })]);
    const output = await observer.collect();
    expect(output.threads[0]).toMatchObject({ binding: 'RELATED_ENTITY', messageListComplete: true, attachmentContentComplete: false });
    expect(output.threads[0].reasonCodes).toEqual(expect.arrayContaining(['ATTACHMENT_CONTENT_UNVERIFIED', 'MAIL_NOT_BOUND_TO_DEAL']));
  });

  it('does not select mailbox account IDs from configuration guesses or conflicting browser responses', async () => {
    for (const account of ['', '42']) {
      const { observer, response, get } = harness([timeline()], { account });
      if (account) response('https://amomail.amocrm.ru/api/v2/43/leads/123/compose');
      expect((await observer.collect()).reasonCodes).toContain('MAIL_ACCOUNT_UNVERIFIED');
      expect(get).toHaveBeenCalledTimes(1);
    }
  });

  it('detects cursor loops and changed records between pages without pretending the timeline ended', async () => {
    const prev = `${timelineUrl}/?limit=100&filter%5Bcreated_at%5D%5Blt%5D=1789998000`;
    for (const changed of [false, true]) {
      const second = changed ? event({ data: { text: 'Другой тестовый текст' } }) : event();
      const { observer } = harness([timeline([event()], { prev }), timeline([second], { prev }), { id: 7 }, mailPage()]);
      const output = await observer.collect();
      expect(output.timelineServerReportedEnd).toBe(false);
      expect(output.reasonCodes).toContain(changed ? 'TIMELINE_CHANGED_DURING_READ' : 'TIMELINE_CURSOR_REPEATED');
    }
  });

  it('carries a private reveal token only to validated timeline continuations and never returns it', async () => {
    const prev = `${timelineUrl}/?limit=100&filter%5Bcreated_at%5D%5Blt%5D=1789998000`;
    const { observer, get } = harness([{ ...timeline([event()], { prev }), reveal_token: 'private-reveal-token' },
      timeline([]), { id: 7 }, mailPage()]);
    const output = await observer.collect();
    expect(get.mock.calls[1][1].headers['X-Reveal-Token']).toBe('private-reveal-token');
    expect(get.mock.calls[2][1].headers).not.toHaveProperty('X-Reveal-Token');
    expect(JSON.stringify(output)).not.toContain('private-reveal-token');
  });

  it('refuses a wrong card and a disposed observer before reading any data', async () => {
    const wrong = harness([], { card: `${origin}/leads/detail/999` });
    await expect(wrong.observer.collect()).rejects.toThrow('WRONG_CARD');
    expect(wrong.get).not.toHaveBeenCalled();
    const disposed = harness([]);
    disposed.observer.dispose();
    await expect(disposed.observer.collect()).rejects.toThrow('WRONG_CARD');
    expect(disposed.page.off).toHaveBeenCalledWith('response', expect.any(Function));
  });

  it('reports response failures with fixed codes, never server body or transport credentials', async () => {
    const { observer, get } = harness([]);
    get.mockRejectedValueOnce(new Error('cookie=secret; customer text'));
    const output = await observer.collect();
    expect(output.reasonCodes).toContain('HISTORY_READ_FAILED');
    expect(JSON.stringify(output)).not.toContain('secret');
  });

  it('reports expired history access even when the outer card HTML still opens', async () => {
    const { observer, response, get } = harness([]);
    response(timelineUrl, 401);
    const output = await observer.collect();
    expect(output.reasonCodes).toContain('HISTORY_ACCESS_DENIED');
    expect(output.entries).toEqual([]); expect(get).not.toHaveBeenCalled();
  });

  it('prepares only an attachment observed in the exact returned thread/message', async () => {
    const { observer, get, post } = harness([timeline(), { id: 7 }, mailPage({ items: [mailMessage({ attachments: [attachment()] })] })]);
    await observer.collect();
    await expect(observer.prepareAttachment({ threadId: '999', messageId: '8', attachmentId: '91' }, new AbortController().signal)).rejects.toThrow('MAIL_ATTACHMENT_NOT_OBSERVED');
    expect(get).toHaveBeenCalledTimes(3); expect(post).not.toHaveBeenCalled();
  });

  it('does not send preparation POST if cancellation occurred while awaiting its preceding GET', async () => {
    const { observer, get, post } = harness([timeline(), { id: 7 }, mailPage({ items: [mailMessage({ attachments: [attachment()] })] })]);
    await observer.collect();
    const controller = new AbortController();
    get.mockResolvedValueOnce({ status: () => 200, headers: () => ({}), dispose: jest.fn(), body: async () => {
      controller.abort(); return Buffer.from(JSON.stringify({ status: 'not_downloaded' }));
    } });
    await expect(observer.prepareAttachment({ threadId: '7', messageId: '8', attachmentId: '91' }, controller.signal)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });
});
