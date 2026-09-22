import { readEmptyCrmChatHistory } from './crm-control-chat-empty';
import { CrmSourceAuthExpiredError } from './crm-control-evidence.service';

const input = { origin: 'https://example.amocrm.ru', connectionId: 'connection', accountExternalId: '42', dealExternalId: '123' };
const response = (status = 204, value: unknown = null) => ({ status: () => status, headers: () => ({}),
  body: jest.fn().mockResolvedValue(Buffer.from(JSON.stringify(value))), dispose: jest.fn().mockResolvedValue(undefined) });
describe('fast empty chat inventory', () => {
  it('accepts only stable empty talk and related-chat inventories from fixed account endpoints', async () => {
    const replies = Array.from({ length: 4 }, () => response());
    const get = jest.fn(); replies.forEach(reply => get.mockResolvedValueOnce(reply));
    expect(await readEmptyCrmChatHistory({ request: { get } } as any, input)).toMatchObject({ readComplete: true, chats: [] });
    expect(get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/v4/talks', '/ajax/v4/leads/123/chats', '/api/v4/talks', '/ajax/v4/leads/123/chats']);
    const url = new URL(get.mock.calls[0][0]);
    expect(url.searchParams.get('filter[entity_type]')).toBe('lead');
    expect(url.searchParams.get('filter[entity_id]')).toBe('123');
    expect(url.searchParams.has('filter[only_in_work]')).toBe(false);
    expect(get.mock.calls.every(([, options]) => options.maxRedirects === 0)).toBe(true);
    expect(replies.every(reply => reply.dispose.mock.calls.length === 1)).toBe(true);
  });
  it('accepts explicit empty JSON collections too', async () => {
    const get = jest.fn().mockImplementation(async url => response(200, { _embedded: { [new URL(url).pathname.endsWith('talks') ? 'talks' : 'chats']: [] } }));
    expect((await readEmptyCrmChatHistory({ request: { get } } as any, input))?.readComplete).toBe(true);
  });
  it.each([301, 403, 429, 500])('falls back to the native reader after HTTP %s', async status => {
    const reply = response(status), get = jest.fn().mockResolvedValue(reply);
    expect(await readEmptyCrmChatHistory({ request: { get } } as any, input)).toBeNull();
    expect(get).toHaveBeenCalledTimes(1); expect(reply.dispose).toHaveBeenCalledTimes(1);
  });
  it('requests a whole-reader authentication refresh on 401', async () => {
    const reply = response(401);
    await expect(readEmptyCrmChatHistory({ request: { get: async () => reply } } as any, input)).rejects.toBeInstanceOf(CrmSourceAuthExpiredError);
    expect(reply.dispose).toHaveBeenCalledTimes(1);
  });
  it('does not call the inventory empty if a chat appears during confirmation', async () => {
    const get = jest.fn().mockResolvedValue(response());
    get.mockResolvedValueOnce(response()).mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response(200, { _embedded: { talks: [{ talk_id: 7 }] } }));
    expect(await readEmptyCrmChatHistory({ request: { get } } as any, input)).toBeNull();
  });
  it('does not infer empty from an unknown or paginated schema', async () => {
    for (const value of [{}, { _embedded: { talks: [] }, _links: { next: { href: 'https://example.amocrm.ru/api/v4/talks?page=2' } } }]) {
      expect(await readEmptyCrmChatHistory({ request: { get: async () => response(200, value) } } as any, input)).toBeNull();
    }
  });
});
