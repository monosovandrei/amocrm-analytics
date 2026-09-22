import { EventEmitter } from 'node:events';
import { crmBrowserNeedsRefresh, observeCrmBrowserAccess, refreshCrmBrowserAccess } from './crm-control-browser-auth';

describe('dedicated CRM browser authentication', () => {
  const origin = 'https://example.amocrm.ru';
  function response(url: string, status = 200, body: unknown = {}, method = 'GET') {
    return { url: () => url, status: () => status, request: () => ({ method: () => method }), body: async () => Buffer.from(JSON.stringify(body)) };
  }
  test('refresh is based on access-token expiry, not unrelated active analytics cookies', async () => {
    const now = 2_000_000_000_000;
    const context: any = { cookies: jest.fn().mockResolvedValue([{ name: 'analytics', value: 'x', expires: now / 1000 + 10000 }]) };
    expect(await crmBrowserNeedsRefresh(context, origin, now)).toBe(true);
    context.cookies.mockResolvedValue([{ name: 'access_token', value: 'fixture', expires: now / 1000 + 301 }]);
    expect(await crmBrowserNeedsRefresh(context, origin, now)).toBe(false);
    context.cookies.mockResolvedValue([{ name: 'access_token', value: 'fixture', expires: -1 }, { name: 'access_token_expires_at', value: String(now / 1000 + 60) }]);
    expect(await crmBrowserNeedsRefresh(context, origin, now)).toBe(true);
  });

  test.each([[200, 'READY'], [401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [500, 'SOURCE_NOT_READY'], [302, 'SOURCE_NOT_READY']])('refresh status %s is classified without exposing a body', async (status, expected) => {
    expect(await refreshCrmBrowserAccess({ evaluate: async () => status } as any)).toBe(expected);
  });

  test('native refresh is a bounded same-origin implicit POST and never follows redirects', async () => {
    const original = global.fetch;
    const fetch = jest.fn().mockResolvedValue({ status: 200 });
    global.fetch = fetch;
    try {
      expect(await refreshCrmBrowserAccess({ evaluate: async (fn: any) => fn() } as any)).toBe('READY');
      expect(fetch).toHaveBeenCalledWith('/oauth2/access_token', expect.objectContaining({ method: 'POST', credentials: 'include',
        redirect: 'error', body: 'grant_type=implicit', signal: expect.any(AbortSignal) }));
    } finally { global.fetch = original; }
  });

  test('HTML 200 is insufficient; both actual source schemas are required', async () => {
    const page = new EventEmitter() as any;
    const observer = observeCrmBrowserAccess(page, origin, '123');
    page.emit('response', response(`${origin}/leads/detail/123`));
    expect(await observer.read(0)).toBe('SOURCE_NOT_READY');
    page.emit('response', response(`${origin}/ajax/v3/leads/123/events_timeline`, 200, { _embedded: { items: [] } }));
    await Promise.resolve();
    expect(await observer.read(0)).toBe('SOURCE_NOT_READY');
    page.emit('response', response('https://amomail.amocrm.ru/api/v2/42/leads/123/compose', 200, []));
    expect(await observer.read(50)).toBe('READY');
    observer.dispose();
    expect(page.listenerCount('response')).toBe(0);
  });

  test('another deal/account, invalid JSON shape and failed source requests cannot verify the session', async () => {
    const page = new EventEmitter() as any;
    const observer = observeCrmBrowserAccess(page, origin, '123');
    page.emit('response', response(`${origin}/ajax/v3/leads/456/events_timeline`, 200, { _embedded: { items: [] } }));
    page.emit('response', response('https://amomail.amocrm.ru/api/v2/42/leads/123/compose', 200, {}));
    await Promise.resolve();
    expect(await observer.read(0)).toBe('SOURCE_NOT_READY');
    page.emit('response', response(`${origin}/ajax/v3/leads/123/events_timeline`, 401));
    expect(await observer.read(0)).toBe('AUTH_REQUIRED');
    observer.dispose();
  });

  test('refresh reset discards older responses and retains only the fact of successful token rotation', async () => {
    const page = new EventEmitter() as any;
    const observer = observeCrmBrowserAccess(page, origin, '123');
    let resolve!: (bytes: Buffer) => void;
    page.emit('response', { ...response(`${origin}/ajax/v3/leads/123/events_timeline`), body: () => new Promise(r => { resolve = r; }) });
    observer.reset();
    resolve(Buffer.from(JSON.stringify({ _embedded: { items: [] } })));
    page.emit('response', response('https://amomail.amocrm.ru/api/v2/42/leads/123/compose', 200, []));
    page.emit('response', response(`${origin}/oauth2/access_token`, 200, {}, 'POST'));
    await Promise.resolve();
    expect(await observer.read(0)).toBe('SOURCE_NOT_READY');
    expect(observer.tokensRotated).toBe(true);
    observer.dispose();
  });
});
