import { AmoClient, AmoRequestError } from './amo-client';

describe('AmoClient concurrent reads', () => {
  const now = new Date('2026-09-22T16:05:00Z');
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  const client = (extra: Record<string, unknown> = {}) => new AmoClient({ domain: 'example.amocrm.ru',
    credentials: { accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: now.getTime() + 3600_000 },
    clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://example.test/callback',
    minRequestIntervalMs: 250, ...extra });
  const ok = (body: unknown = { id: 1 }) => new Response(JSON.stringify(body), { status: 200 });

  it('reserves distinct rate slots for parallel requests', async () => {
    const started: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => { started.push(Date.now()); return ok(); });
    const source = client();
    const result = Promise.all([1, 2, 3, 4].map((id) => source.get(`/leads/${id}`)));
    await jest.runAllTimersAsync();
    expect(await result).toHaveLength(4);
    expect(started.map((time) => time - started[0])).toEqual([0, 250, 500, 750]);
  });

  it('refreshes an expired token once for concurrent source reads', async () => {
    const changed = jest.fn();
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (url) => String(url).includes('/oauth2/')
      ? ok({ access_token: 'new-test-access', refresh_token: 'new-test-refresh', expires_in: 3600 }) : ok());
    const source = client({ credentials: { accessToken: 'old-test', refreshToken: 'old-refresh', expiresAt: 0 }, onCredentialsChanged: changed });
    const result = Promise.all([source.get('/leads/1'), source.get('/leads/2'), source.get('/tasks')]);
    await jest.runAllTimersAsync();
    await result;
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/oauth2/'))).toHaveLength(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls.filter(([url]) => !String(url).includes('/oauth2/')).every(([, args]) =>
      (args?.headers as Record<string, string>).Authorization === 'Bearer new-test-access')).toBe(true);
  });

  it('does not release a burst of requests when a slow token refresh finishes', async () => {
    const started: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (String(url).includes('/oauth2/')) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return ok({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600 });
      }
      started.push(Date.now()); return ok();
    });
    const source = client({ credentials: { accessToken: 'old-test', refreshToken: 'old-refresh', expiresAt: 0 } });
    const result = Promise.all([source.get('/leads/1'), source.get('/leads/2'), source.get('/leads/3')]);
    await jest.runAllTimersAsync();
    await result;
    expect(started.map((time) => time - now.getTime())).toEqual([500, 750, 1000]);
  });

  it('honours HTTP-date Retry-After and stops after a successful GET', async () => {
    const started: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      started.push(Date.now());
      return started.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': new Date(now.getTime() + 2000).toUTCString() } }) : ok();
    });
    const result = client().get('/tasks');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ id: 1 });
    expect(started).toEqual([now.getTime(), now.getTime() + 2000]);
  });

  it('bounds transient server retries and does not wait again after the last response', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('', { status: 503 }));
    const result = client().get('/leads').catch((error) => error);
    await jest.runAllTimersAsync();
    expect(await result).toBeInstanceOf(AmoRequestError);
    expect((await result).transient).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(Date.now() - now.getTime()).toBe(7000);
  });

  it('applies a 429 cooldown to queued parallel reads as well as the failed request', async () => {
    const started: number[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      started.push(Date.now());
      return started.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '2' } }) : ok();
    });
    const source = client();
    const result = Promise.all([source.get('/leads/1'), source.get('/leads/2')]);
    await jest.runAllTimersAsync();
    await result;
    expect(started.map((time) => time - started[0])).toEqual([0, 2000, 2250]);
  });

  it('checks token freshness again after a long Retry-After delay', async () => {
    const authorization: string[] = [];
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (url, args) => {
      if (String(url).includes('/oauth2/')) return ok({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600 });
      authorization.push((args?.headers as Record<string, string>).Authorization);
      return authorization.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '60' } }) : ok();
    });
    const result = client({ credentials: { accessToken: 'expiring', refreshToken: 'test-refresh', expiresAt: now.getTime() + 90_000 } }).get('/leads');
    await jest.runAllTimersAsync();
    await result;
    expect(authorization).toEqual(['Bearer expiring', 'Bearer fresh']);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/oauth2/'))).toHaveLength(1);
  });

  it('keeps the timeout active for a stalled response body and bounds retries', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => ({
      text: () => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    } as unknown as Response));
    const result = client().get('/leads').catch((error) => error);
    await jest.runAllTimersAsync();
    expect((await result).transient).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(Date.now() - now.getTime()).toBe(127000);
  });

  it('does not retry a permanent permission error', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('Denied', { status: 403 }));
    const result = client().get('/leads').catch((error) => error);
    await jest.runAllTimersAsync();
    expect(await result).toMatchObject({ transient: false, status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses OAuth only on a validated drive origin and refuses redirects', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => ok({ files: [] }));
    const result = client().getDrive('https://drive-b.amocrm.ru', '/v1.0/files?limit=10');
    await jest.runAllTimersAsync();
    await expect(result).resolves.toEqual({ files: [] });
    expect(fetch).toHaveBeenCalledWith('https://drive-b.amocrm.ru/v1.0/files?limit=10', expect.objectContaining({
      redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer test-access' }),
    }));
  });

  it('does not fetch drive metadata when its collection deadline has already expired', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    const controller = new AbortController();
    const reason = new Error('collection deadline');
    controller.abort(reason);
    await expect(client().getDrive('https://drive.amocrm.ru', '/v1.0/files', { signal: controller.signal })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts a drive response body and does not retry that request', async () => {
    const controller = new AbortController();
    const reason = new Error('collection deadline');
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_url, options) => ({
      text: () => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(options.signal?.reason))),
    } as unknown as Response));
    const result = client().getDrive('https://drive.amocrm.ru', '/v1.0/files', { signal: controller.signal }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    expect(await result).toBe(reason);
    await jest.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(now.getTime());
  });

  it.each(['server', 'network'])('cancels an abortable %s retry delay without another fetch', async (failure) => {
    const controller = new AbortController();
    const reason = new Error('collection deadline');
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      if (failure === 'network') throw new Error('temporary network failure');
      return new Response('', { status: 429, headers: { 'retry-after': '60' } });
    });
    const result = client().getDrive('https://drive.amocrm.ru', '/v1.0/files', { signal: controller.signal }).catch((error) => error);
    await jest.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    expect(await result).toBe(reason);
    await jest.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBe(now.getTime() + 100);
  });

  it('cancels a rate-limited drive read without delaying unrelated CRM reads', async () => {
    const controller = new AbortController();
    const reason = new Error('collection deadline');
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async () => ok());
    const source = client();
    const first = source.get('/leads/1');
    await jest.advanceTimersByTimeAsync(0); await first;
    const cancelled = source.getDrive('https://drive.amocrm.ru', '/v1.0/files', { signal: controller.signal }).catch((error) => error);
    const unrelated = source.get('/leads/2');
    await jest.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    await jest.runAllTimersAsync(); await unrelated;
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://example.amocrm.ru/api/v4/leads/1', 'https://example.amocrm.ru/api/v4/leads/2']);
    expect(Date.now()).toBe(now.getTime() + 250);
  });

  it('cancels waiting for shared token refresh without cancelling refresh for other reads', async () => {
    const controller = new AbortController();
    const reason = new Error('collection deadline');
    let refreshSignal: AbortSignal | null | undefined;
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
      if (String(url).includes('/oauth2/')) {
        refreshSignal = options?.signal;
        await new Promise((resolve) => setTimeout(resolve, 500));
        return ok({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600 });
      }
      return ok();
    });
    const source = client({ credentials: { accessToken: 'expired', refreshToken: 'test-refresh', expiresAt: 0 } });
    const cancelled = source.getDrive('https://drive.amocrm.ru', '/v1.0/files', { signal: controller.signal }).catch((error) => error);
    const unrelated = source.get('/leads/1');
    await jest.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect(refreshSignal?.aborted).toBe(false);
    await jest.runAllTimersAsync(); await unrelated;
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://example.amocrm.ru/oauth2/access_token', 'https://example.amocrm.ru/api/v4/leads/1']);
    expect((fetch.mock.calls[1][1]?.headers as Record<string, string>).Authorization).toBe('Bearer fresh');
  });

  it.each([
    ['http://drive.amocrm.ru', '/v1.0/files'], ['https://drive.amocrm.ru.evil.test', '/v1.0/files'],
    ['https://user@drive.amocrm.ru', '/v1.0/files'], ['https://drive.amocrm.ru:444', '/v1.0/files'],
    ['https://drive.amocrm.ru:443', '/v1.0/files'],
    ['https://drive.amocrm.ru/path', '/v1.0/files'], ['https://drive.amocrm.ru', '//evil.test/v1.0/files'],
    ['https://drive.amocrm.ru', '/v1.0/files/../../oauth'], ['https://drive.amocrm.ru', '/download/file'],
  ])('rejects unsafe drive requests before sending credentials: %s %s', async (origin, path) => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(client().getDrive(origin, path)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
