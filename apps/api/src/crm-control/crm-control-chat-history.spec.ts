import { collectCrmChatHistory, CrmChatHistoryTransport } from './crm-control-chat-history';

const at = '2026-09-22T16:05:00.000Z';
const talk = (patch: Record<string, unknown> = {}) => ({ talk_id: 11, chat_id: 'chat-1', account_id: 42,
  entity_type: 'lead', entity_id: 123, contact_id: 55, created_at: 1700000000,
  _embedded: { leads: [{ id: 123 }], contacts: [{ id: 55 }], customers: [] }, ...patch });
const capture = (value: unknown, httpStatus = 200) => ({ value, httpStatus, capturedAt: at });
const message = (n: number) => ({ id: `message-${n}`, chat_id: 'chat-1', dialog: { id: 11 },
  created_at: 1700000000, text: 'Synthetic message', message: { type: 'text', text: 'Synthetic message' } });
function fixture(count = 70) {
  const messages = Array.from({ length: count }, (_, i) => message(i));
  const transport = {
    listTalks: jest.fn().mockResolvedValue(capture({ _embedded: { talks: [talk()] } })),
    listRelatedChats: jest.fn().mockResolvedValue(capture({ _embedded: { chats: [{ chat_id: 'chat-1', entity_id: 55, entity_type: 1 }] } })),
    readMessages: jest.fn().mockImplementation(async (_id, offset, limit) => capture(messages.slice(offset, offset + limit))),
    readCount: jest.fn().mockResolvedValue(count),
    readTalk: jest.fn().mockResolvedValue(capture(talk())),
  } satisfies CrmChatHistoryTransport;
  const run = (options = {}) => collectCrmChatHistory({ connectionId: 'connection-1', accountExternalId: '42', dealExternalId: '123',
    transport, now: () => new Date(at), ...options });
  return { transport, messages, run };
}

describe('complete read of current CRM chat history', () => {
  it('paginates 70 messages and proves exact deal relations without treating contact membership as a deal proof', async () => {
    const { run, transport } = fixture(); const result = await run();
    expect(result.readComplete).toBe(true);
    expect(result.chats[0].messages).toHaveLength(70);
    expect(result.chats[0].messages.every(m => m.binding.status === 'BOUND')).toBe(true);
    expect(transport.readMessages.mock.calls.map(c => c.slice(1))).toEqual([[0, 50], [50, 50], [0, 50]]);
    expect(transport.readTalk).toHaveBeenCalledTimes(2);
    expect(transport.listTalks).toHaveBeenCalledTimes(2);
    expect(result.chats[0].messages[0].binding.proof?.historicalBindingIntervalProven).toBe(false);
  });
  it('checks a terminal empty page when the count is a multiple of 50', async () => {
    const { run, transport } = fixture(50);
    expect((await run()).readComplete).toBe(true);
    expect(transport.readMessages.mock.calls.map(c => c[1])).toEqual([0, 50, 0]);
  });
  it('recognizes two stable empty inventories', async () => {
    const { run, transport } = fixture(0);
    transport.listTalks.mockResolvedValue(capture(null, 204));
    transport.listRelatedChats.mockResolvedValue(capture(null, 204));
    expect(await run()).toMatchObject({ readComplete: true, chats: [], reasonCodes: [] });
    expect(transport.readMessages).not.toHaveBeenCalled();
  });
  it('does not call a failed inventory empty', async () => {
    const { run, transport } = fixture(); transport.listTalks.mockResolvedValue(capture(null, 403));
    expect(await run()).toMatchObject({ readComplete: false, reasonCodes: ['CHAT_TALK_INVENTORY_INVALID'] });
  });
  it('excludes a conversation explicitly belonging to another deal from this deal proof', async () => {
    const { run, transport } = fixture(1);
    transport.readTalk.mockResolvedValue(capture(talk({ entity_id: 999, _embedded: { leads: [{ id: 999 }], contacts: [{ id: 55 }], customers: [] } })));
    const result = await run();
    expect(result.readComplete).toBe(true); // Reading every message is separate from its eligibility.
    expect(result.chats[0].messages[0].binding.status).toBe('OTHER_DEAL');
  });
  it('does not invent a relation for a message without a dialog', async () => {
    const { run, messages } = fixture(1); delete (messages[0] as any).dialog;
    expect((await run()).chats[0].messages[0].binding.status).toBe('NOT_BOUND');
  });
  it('detects an API ignoring the offset even when it repeats a full page', async () => {
    const { run, transport, messages } = fixture();
    transport.readMessages.mockResolvedValue(capture(messages.slice(0, 50)));
    const result = await run();
    expect(result.readComplete).toBe(false);
    expect(result.chats[0].reasonCodes).toContain('CHAT_MESSAGE_DUPLICATE_OR_INVALID');
  });
  it('detects a new message during collection', async () => {
    const { run, transport } = fixture(); transport.readCount.mockResolvedValueOnce(70).mockResolvedValue(71);
    expect((await run()).chats[0]).toMatchObject({ readComplete: false, reasonCodes: ['CHAT_COUNT_CHANGED_OR_INCOMPLETE'] });
  });
  it('rejects a short page whose count does not reconcile', async () => {
    const { run, transport } = fixture(20); transport.readCount.mockResolvedValue(70);
    expect((await run()).readComplete).toBe(false);
  });
  it('detects replacement or editing even when the first-page IDs and count stay unchanged', async () => {
    const { run, transport, messages } = fixture(1);
    transport.readMessages.mockResolvedValueOnce(capture(messages)).mockResolvedValue(capture([{ ...messages[0], text: 'Edited' }]));
    expect((await run()).chats[0].reasonCodes).toContain('CHAT_MESSAGES_CHANGED');
  });
  it('keeps capped pagination incomplete', async () => {
    const { run } = fixture(70);
    expect((await run({ maxPages: 1 })).chats[0].reasonCodes).toContain('CHAT_MESSAGES_LIMIT');
  });
  it('bounds the saved archive when many tiny messages expand into per-message relation proofs', async () => {
    const talks = Array.from({ length: 16 }, (_, index) => talk({ talk_id: index + 1, chat_id: `chat-${index}` }));
    let sourceBytes = 0;
    const measured = (value: unknown) => {
      sourceBytes += Buffer.byteLength(JSON.stringify(value), 'utf8');
      return capture(value);
    };
    const transport: CrmChatHistoryTransport = {
      listTalks: async () => measured({ _embedded: { talks } }),
      listRelatedChats: async () => measured({ _embedded: { chats: [] } }),
      readCount: async () => 1000,
      readTalk: async talkId => measured(talks[Number(talkId) - 1]),
      readMessages: async (chatId, offset, limit) => measured(Array.from({ length: Math.max(0, Math.min(limit, 1000 - offset)) }, (_, index) => ({
        id: `msg-${chatId}-${offset + index}`, dialog: { id: Number(chatId.slice(5)) + 1 },
        message: { type: 'text', text: 'ok' }, created_at: 1700000000,
      }))),
    };
    const result = await collectCrmChatHistory({ connectionId: 'connection-1', accountExternalId: '42', dealExternalId: '123',
      transport, now: () => new Date(at) });
    // The source bodies alone fit easily; the bound must include the derived proof and capture wrappers.
    expect(sourceBytes).toBeLessThan(2 * 1024 * 1024);
    expect(result.readComplete).toBe(false);
    expect(result.reasonCodes).toContain('CHAT_ARCHIVE_LIMIT');
    expect(result.chats.length).toBeLessThan(16);
    expect(result.chats.at(-1)?.readComplete).toBe(false);
    expect(result.chats.at(-1)?.reasonCodes).toContain('CHAT_ARCHIVE_LIMIT');
    expect(result.chats.reduce((total, chat) => total + chat.messages.length, 0)).toBeLessThan(16_000);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(12 * 1024 * 1024);
  });
  it('detects a changed official talk inventory', async () => {
    const { run, transport } = fixture(1);
    transport.listTalks.mockResolvedValueOnce(capture({ _embedded: { talks: [talk()] } })).mockResolvedValue(capture(null, 204));
    expect((await run()).reasonCodes).toContain('CHAT_INVENTORY_CHANGED');
  });
  it('detects an added related chat', async () => {
    const { run, transport } = fixture(1);
    transport.listRelatedChats.mockResolvedValueOnce(capture({ _embedded: { chats: [{ chat_id: 'chat-1' }] } }))
      .mockResolvedValue(capture({ _embedded: { chats: [{ chat_id: 'chat-1' }, { chat_id: 'chat-2' }] } }));
    expect((await run()).reasonCodes).toContain('CHAT_INVENTORY_CHANGED');
  });
  it('does not certify a message after its talk was reassigned', async () => {
    const { run, transport } = fixture(1);
    transport.readTalk.mockResolvedValueOnce(capture(talk())).mockResolvedValue(capture(talk({ entity_id: 999,
      _embedded: { leads: [{ id: 999 }], contacts: [{ id: 55 }], customers: [] } })));
    expect((await run()).chats[0].messages[0].binding.reasonCodes).toContain('TALK_RELATION_CHANGED');
  });
  it('ignores status/read changes while verifying the stable relation', async () => {
    const { run, transport } = fixture(1);
    transport.readTalk.mockResolvedValueOnce(capture(talk({ status: 'in_work', is_read: false })))
      .mockResolvedValue(capture(talk({ status: 'closed', is_read: true })));
    expect((await run()).chats[0].messages[0].binding.status).toBe('BOUND');
  });
  it.each([{ entity_id: 999 }, { account_id: 99 }, { entity_type: 'customer' }])('rejects inventory outside the requested scope: %j', async patch => {
    const { run, transport } = fixture(1); transport.listTalks.mockResolvedValue(capture({ _embedded: { talks: [talk(patch)] } }));
    expect((await run()).reasonCodes).toContain('CHAT_TALK_INVENTORY_SCOPE');
  });
  it('keeps unknown related-chat pagination incomplete', async () => {
    const { run, transport } = fixture(1); transport.listRelatedChats.mockResolvedValue(capture({ _embedded: { chats: [] }, _links: { next: {} } }));
    expect((await run()).readComplete).toBe(false);
  });
  it('uses the bounded next numeric page and never asks transport to follow an arbitrary URL', async () => {
    const { run, transport } = fixture(1);
    const page1 = capture({ _embedded: { talks: [talk()] }, _links: { next: { href: 'https://wrong.example/api/v4/talks?page=2' } } });
    transport.listTalks.mockImplementation(async page => page === 1 ? page1 : capture(null, 204));
    expect((await run()).readComplete).toBe(true);
    expect(transport.listTalks.mock.calls).toEqual([[1, 250], [2, 250], [1, 250], [2, 250]]);
  });
  it('refuses a nonadvancing page marker', async () => {
    const { run, transport } = fixture(1);
    transport.listTalks.mockResolvedValue(capture({ _embedded: { talks: [talk()] }, _links: { next: { href: 'https://crm.amocrm.ru/api/v4/talks?page=1' } } }));
    expect((await run()).reasonCodes).toContain('CHAT_TALK_PAGINATION_INVALID');
  });
});
