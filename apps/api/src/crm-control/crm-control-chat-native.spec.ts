import { createCrmControlChatNative } from './crm-control-chat-native';
import { collectCrmChatHistory } from './crm-control-chat-history';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';

const origin = 'https://example.amocrm.ru';
const scope = { origin, connectionId: 'connection-1', accountExternalId: '42', dealExternalId: '123' };
const message = (n = 1) => ({ id: `message-${n}`, chat_id: 'chat-1', dialog: { id: 11 }, text: 'Synthetic message' });
const talk = () => ({ talk_id: 11, account_id: 42, chat_id: 'chat-1', entity_type: 'lead', entity_id: 123, contact_id: 55,
  _embedded: { contacts: [{ id: 55 }], leads: [{ id: 123 }], customers: [] } });
function fixture() {
  const unsubscribe = jest.fn(), abort = jest.fn();
  const observable = (value: unknown) => ({ subscribe: ({ next }: any) => { next(value); return { unsubscribe }; } });
  const account = { id: 42, amojo_id: 'account-chat-42', amojo_server: 'https://amojo.amocrm.ru' };
  const catalog: Record<string, unknown> = { 'staff-1': { id: 101, amojo_id: 'staff-1', active: false, name: 'Never exported', token: 'Never exported' } };
  const api = { fetchMessages: jest.fn().mockImplementation(() => observable([message()])),
    getChatsStat: jest.fn().mockImplementation(() => observable([{ id: 'chat-1', count: 1, users: [{ id: 'not-account-user' }] }])),
    getChat: jest.fn().mockImplementation(() => observable({ response: { chats: { 'chat-1': {} } } })) };
  const nativeChat = { id: 'chat-1' };
  const modules: Record<string, any> = {
    '../build/transpiled/interface/amojo/api': api,
    '../build/transpiled/account/users': { getByAmoJoId: jest.fn(() => catalog) },
    '../build/transpiled/amojo/mediator': { AmoJoMediator: { get: jest.fn(() => ({ 'chat-1': nativeChat })) } },
    '../build/transpiled/amojo/target': { ExistingExternalChatTarget: { createFromChat: jest.fn(() => ({
      getAmojoUserId: () => 'customer-1', getContactId: () => 55 })) } },
  };
  let handler = (url: string): { status: number; value?: unknown; pending?: boolean } => url.startsWith('/api/v4/talks?')
    ? { status: 200, value: { _embedded: { talks: [talk()] } } } : url === '/api/v4/talks/11'
      ? { status: 200, value: talk() } : { status: 200, value: { _embedded: { chats: [{ chat_id: 'chat-1', entity_id: 55, entity_type: 1 }] } } };
  const ajax = jest.fn((options: any) => {
    const response = handler(options.url);
    const request = { abort, done: (fn: any) => { if (!response.pending && response.status < 400) fn(response.value, 'success', { status: response.status }); return request; },
      fail: (fn: any) => { if (!response.pending && response.status >= 400) fn({ status: response.status, responseText: 'Private error contents' }); return request; } };
    return request;
  });
  const win = { location: { origin, pathname: '/leads/detail/123' }, AMOCRM: { constant: jest.fn(() => account) }, jQuery: { ajax },
    webpackChunk: [[[], {
      128199: function () { return '../build/transpiled/account/users'; },
      794653: function () { return '../build/transpiled/amojo/mediator'; },
      337587: function () { return '../build/transpiled/amojo/target'; },
    }]], require: jest.fn((name: string) => { if (!modules[name]) throw new Error('Private module detail'); return modules[name]; }) };
  (globalThis as any).window = win;
  const page: any = { evaluate: jest.fn(async (fn: Function, args: unknown) => {
    // Execute the serialized function, as the browser does. Accidental Node-side closures fail this test.
    const isolated = new Function(`return (${fn.toString()})`)(); return isolated(args);
  }) };
  const create = (extra = {}) => createCrmControlChatNative(page, { ...scope, ...extra });
  return { create, page, win, account, modules, api, catalog, ajax, abort, unsubscribe, observable,
    handle: (next: typeof handler) => { handler = next; } };
}

describe('leased native CRM chat transport', () => {
  const previous = (globalThis as any).window;
  afterEach(() => { (globalThis as any).window = previous; jest.useRealTimers(); });
  it('captures only account user identity and keeps inactive historical authors', async () => {
    const f = fixture(), adapter = await f.create();
    expect(adapter.accountMetadata).toMatchObject({ accountExternalId: '42', amojoAccountId: 'account-chat-42', amojoOrigin: 'https://amojo.amocrm.ru',
      accountUserCatalogAvailable: true, accountUsers: [{ amojoId: 'staff-1', crmUserId: '101' }] });
    expect(JSON.stringify(adapter.accountMetadata)).not.toContain('Never exported');
    expect(f.ajax).not.toHaveBeenCalled(); expect(f.api.getChatsStat).not.toHaveBeenCalled();
  });
  it('uses exact lead GET filters including closed talks, related chats and observed dialog only', async () => {
    const f = fixture(), { transport } = await f.create();
    await transport.listTalks(2, 250); await transport.listRelatedChats();
    await transport.readMessages('chat-1', 50, 50); await transport.readTalk('11');
    expect(f.ajax.mock.calls.map(([options]) => options.url)).toEqual([
      '/api/v4/talks?filter[entity_type]=lead&filter[entity_id]=123&page=2&limit=250', '/ajax/v4/leads/123/chats', '/api/v4/talks/11',
    ]);
    for (const [options] of f.ajax.mock.calls) expect(options).toMatchObject({ method: 'GET', dataType: 'json', timeout: expect.any(Number) });
    expect(f.api.fetchMessages).toHaveBeenCalledWith('chat-1', 50, 50);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('runs the real collector across multiple pages and binds messages through repeated exact talks', async () => {
    const f = fixture(), messages = Array.from({ length: 70 }, (_, i) => message(i));
    f.api.fetchMessages.mockImplementation((_chat, offset, limit) => f.observable(messages.slice(offset, offset + limit)));
    f.api.getChatsStat.mockImplementation(() => f.observable([{ id: 'chat-1', count: 70 }]));
    const adapter = await f.create();
    const history = await collectCrmChatHistory({ ...scope, transport: adapter.transport });
    expect(history.readComplete).toBe(true); expect(history.chats[0].messages).toHaveLength(70);
    expect(history.chats[0].messages.every(m => m.binding.status === 'BOUND')).toBe(true);
    expect(f.api.fetchMessages.mock.calls.map(c => c.slice(1))).toEqual([[0, 50], [50, 50], [0, 50]]);
  });
  it('does not promote participants from chat stats into account membership', async () => {
    const f = fixture(), adapter = await f.create(); await adapter.transport.listTalks(1, 250);
    expect(await adapter.transport.readCount('chat-1')).toBe(1);
    expect(adapter.accountMetadata.accountUsers).toEqual([{ amojoId: 'staff-1', crmUserId: '101' }]);
  });
  it('reads native external target getters for observed chats only', async () => {
    const f = fixture(), adapter = await f.create(); await adapter.transport.listRelatedChats();
    expect(await adapter.readNativeExternalTargets(['chat-1'])).toEqual([{ chatId: 'chat-1', contactId: '55', amojoId: 'customer-1' }]);
    expect(f.api.getChat).toHaveBeenCalledWith('chat-1');
    expect(f.modules['../build/transpiled/amojo/target'].ExistingExternalChatTarget.createFromChat).toHaveBeenCalledWith({ id: 'chat-1' });
    await expect(adapter.readNativeExternalTargets(['other-chat'])).rejects.toThrow('CHAT_NOT_OBSERVED');
  });
  it('unavailable native target is unknown, with no contact/author fallback', async () => {
    const f = fixture(), adapter = await f.create(); await adapter.transport.listRelatedChats();
    delete f.modules['../build/transpiled/amojo/target'];
    expect(await adapter.readNativeExternalTargets(['chat-1'])).toEqual([]);
  });
  it.each(['missing', 'mismatch'])('does not publish guessed account mappings: %s', async mode => {
    const f = fixture();
    if (mode === 'missing') delete f.modules['../build/transpiled/account/users'];
    else if (mode === 'mismatch') f.catalog['staff-1'] = { id: 101, amojo_id: 'someone-else' };
    expect((await f.create()).accountMetadata).toMatchObject({ accountUsers: [], accountUserCatalogAvailable: false });
  });
  it('keeps independently verified CRM users when native account contains service identities without CRM IDs', async () => {
    const f = fixture();
    f.catalog['service-1'] = { id: '-1', amojo_id: 'service-1' };
    f.catalog['service-2'] = { id: null, amojo_id: 'service-2' };
    expect((await f.create()).accountMetadata).toMatchObject({ accountUsers: [{ amojoId: 'staff-1', crmUserId: '101' }],
      accountUserCatalogAvailable: false, unresolvedAccountActorIds: ['service-1','service-2'] });
  });
  it('quarantines both sides of conflicting native identity without discarding unrelated staff', async () => {
    const f = fixture(); f.catalog.other = { id: '102', amojo_id: 'staff-1' };
    f.catalog.valid = { id: '103', amojo_id: 'valid' };
    expect((await f.create()).accountMetadata).toMatchObject({ accountUsers: [{ amojoId: 'valid', crmUserId: '103' }],
      unresolvedAccountActorIds: ['other','staff-1'], accountUserCatalogAvailable: false });
  });
  it.each([{ origin: 'https://other.test' }, { origin: `${origin}/` }, { dealExternalId: '../456' }, { accountExternalId: '0' },
    { connectionId: '' }, { deadlineMs: NaN }])('rejects invalid caller scope before browser execution %o', async patch => {
    const f = fixture(); await expect(f.create(patch)).rejects.toThrow('CHAT_SCOPE_INVALID'); expect(f.page.evaluate).not.toHaveBeenCalled();
  });
  it.each(['origin', 'card', 'account', 'amojoAccount', 'amojoOrigin'])('revalidates browser scope on each request: %s', async change => {
    const f = fixture(), adapter = await f.create();
    if (change === 'origin') f.win.location.origin = 'https://other.amocrm.ru';
    if (change === 'card') f.win.location.pathname = '/leads/detail/999';
    if (change === 'account') f.account.id = 999;
    if (change === 'amojoAccount') f.account.amojo_id = 'account-else';
    if (change === 'amojoOrigin') f.account.amojo_server = 'https://amojo-other.amocrm.ru';
    await expect(adapter.transport.listTalks(1, 250)).rejects.toThrow(/CHAT_(?:SCOPE_CHANGED|ACCOUNT_CONFLICT)/);
    expect(f.ajax).not.toHaveBeenCalled();
  });
  it('detects account changes while a read is in flight', async () => {
    const f = fixture(), adapter = await f.create();
    f.handle(() => { f.account.id = 999; return { status: 200, value: {} }; });
    await expect(adapter.transport.listTalks(1, 250)).rejects.toThrow('CHAT_ACCOUNT_CONFLICT');
  });
  it.each(['https://evil.test', 'http://amojo.amocrm.ru', 'https://amojo.amocrm.ru/x', 'https://u:p@amojo.amocrm.ru',
    'https://amojo.amocrm.ru?token=secret', 'https://amojo.amocrm.ru:8443'])('rejects an unapproved native chat server %s', async server => {
    const f = fixture(); f.account.amojo_server = server; await expect(f.create()).rejects.toThrow('CHAT_NATIVE_ACCOUNT_INVALID');
  });
  it('prevents arbitrary chat/dialog reads and invalid pagination without browser execution', async () => {
    const f = fixture(), { transport } = await f.create(); const calls = f.page.evaluate.mock.calls.length;
    await expect(transport.readMessages('chat-1', 0, 50)).rejects.toThrow('CHAT_NOT_OBSERVED');
    await expect(transport.readTalk('11')).rejects.toThrow('CHAT_TALK_NOT_OBSERVED');
    await expect(transport.listTalks(0, 250)).rejects.toThrow('CHAT_ARGUMENT_INVALID');
    await expect(transport.listTalks(1, 251)).rejects.toThrow('CHAT_ARGUMENT_INVALID');
    expect(f.page.evaluate).toHaveBeenCalledTimes(calls);
    await transport.listRelatedChats();
    await expect(transport.readMessages('chat-1', -1, 50)).rejects.toThrow('CHAT_ARGUMENT_INVALID');
  });
  it('foreign-deal inventory does not authorize a native chat read', async () => {
    const f = fixture(), { transport } = await f.create();
    f.handle(() => ({ status: 200, value: { _embedded: { talks: [{ ...talk(), entity_id: 999 }] } } }));
    await transport.listTalks(1, 250); await expect(transport.readCount('chat-1')).rejects.toThrow('CHAT_NOT_OBSERVED');
  });
  it.each([401, 403, 500])('handles HTTP %s without returning error bodies or calling mutations', async status => {
    const f = fixture(), { transport } = await f.create(); f.handle(() => ({ status, value: 'Private error contents' }));
    await expect(transport.listTalks(1, 250)).rejects.toThrow(status === 401 ? CrmSourceAuthExpiredError
      : status === 403 ? 'CHAT_ACCESS_DENIED' : 'CHAT_NATIVE_READ_FAILED');
    expect(f.ajax.mock.calls.every(([options]) => options.method === 'GET')).toBe(true);
  });
  it('native observable 401 triggers the same authentication restart signal', async () => {
    const f = fixture(), { transport } = await f.create(); await transport.listRelatedChats();
    f.api.fetchMessages.mockReturnValue({ subscribe: ({ error }: any) => { error({ status: 401, message: 'Private data' }); return { unsubscribe: f.unsubscribe }; } });
    await expect(transport.readMessages('chat-1', 0, 50)).rejects.toThrow(CrmSourceAuthExpiredError);
  });
  it('accepts 204 as no content but never turns 200 with missing body into an invented list', async () => {
    const f = fixture(), { transport } = await f.create(); f.handle(() => ({ status: 204 }));
    expect(await transport.listTalks(1, 250)).toMatchObject({ httpStatus: 204, value: null });
    f.handle(() => ({ status: 200 })); expect(await transport.listTalks(1, 250)).toMatchObject({ httpStatus: 200, value: null });
  });
  it('rejects oversized private response before returning it to the server', async () => {
    const f = fixture(), { transport } = await f.create(); f.handle(() => ({ status: 200, value: 'я'.repeat(4 * 1024 * 1024 + 1) }));
    await expect(transport.listTalks(1, 250)).rejects.toThrow('CHAT_NATIVE_BODY_LIMIT');
  });
  it('unsubscribes a stalled native observable on the bounded timeout', async () => {
    jest.useFakeTimers(); const f = fixture(), { transport } = await f.create(); await transport.listRelatedChats();
    f.api.fetchMessages.mockReturnValue({ subscribe: () => ({ unsubscribe: f.unsubscribe }) });
    const result = expect(transport.readMessages('chat-1', 0, 50)).rejects.toThrow('CHAT_NATIVE_TIMEOUT');
    await jest.advanceTimersByTimeAsync(10_000); await result; expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('aborts a stalled jQuery GET at the overall deadline and starts no later request', async () => {
    jest.useFakeTimers(); const f = fixture(), { transport } = await f.create({ deadlineMs: 20 }); f.handle(() => ({ status: 200, pending: true }));
    const result = expect(transport.listTalks(1, 250)).rejects.toThrow('CHAT_NATIVE_TIMEOUT');
    await jest.advanceTimersByTimeAsync(20); await result; expect(f.abort).toHaveBeenCalledTimes(1);
    await expect(transport.listTalks(2, 250)).rejects.toThrow('CHAT_TIME_LIMIT'); expect(f.ajax).toHaveBeenCalledTimes(1);
  });
  it('maps unexpected browser execution failures to a fixed error code', async () => {
    const f = fixture(); f.page.evaluate.mockRejectedValue(new Error('Private customer data in browser error'));
    await expect(f.create()).rejects.toThrow(/^CHAT_NATIVE_READ_FAILED$/);
  });
});
