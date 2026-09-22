import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CrmControlEvidenceService, CrmSourceAuthExpiredError, isCrmCollectorChatMutation, sanitizeCrmCaptureHealth, validateCrmCaptureUrl } from './crm-control-evidence.service';
import { collectCrmEvidenceFrames } from './crm-control-evidence-frames';
import { crmBrowserNeedsRefresh, observeCrmBrowserAccess, refreshCrmBrowserAccess } from './crm-control-browser-auth';
import { acquireCrmBrowserSessionLease } from './crm-control-browser-session';

jest.mock('playwright-core', () => ({ chromium: { launch: jest.fn() } }));
jest.mock('./crm-control-evidence-frames', () => ({ collectCrmEvidenceFrames: jest.fn() }));
jest.mock('./crm-control-browser-auth', () => ({ crmBrowserNeedsRefresh: jest.fn(), observeCrmBrowserAccess: jest.fn(), refreshCrmBrowserAccess: jest.fn() }));

describe('CRM screenshot evidence', () => {
  const origin = 'https://example.amocrm.ru';
  const job = { dealExternalId: '123', sourceUrl: `${origin}/leads/detail/123`, observationId: 'observation-1', dealTitle: 'Test lead' };
  let directory: string;
  let oldEnv: NodeJS.ProcessEnv;
  let service: CrmControlEvidenceService;
  let browser: any;
  let contexts: any[];
  let page: any;
  let title: any;
  let access: any;
  let sessionState: any;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l5kAAAAASUVORK5CYII=', 'base64');

  beforeEach(async () => {
    oldEnv = { ...process.env };
    directory = await mkdtemp(path.join(os.tmpdir(), 'crm-evidence-test-'));
    process.env.CRM_CONTROL_AMO_ORIGIN = origin;
    process.env.CRM_CONTROL_BROWSER_STATE_FILE = path.join(directory, 'test-session.json');
    process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE = path.join(directory, 'test-browser');
    process.env.CRM_CONTROL_EVIDENCE_DIR = path.join(directory, 'evidence');
    sessionState = { cookies: [{ name: 'fixture-session', value: 'test-only',
      domain: 'example.amocrm.ru', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] };
    await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE, JSON.stringify(sessionState));
    await writeFile(process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE, 'mock');
    title = { waitFor: jest.fn(), getAttribute: jest.fn().mockResolvedValue('Сделка #123'), inputValue: jest.fn().mockResolvedValue('Test lead') };
    const responseListeners = new Set<(value: any) => void>();
    page = {
      setDefaultTimeout: jest.fn(), route: jest.fn(), mainFrame: jest.fn().mockReturnValue('main-frame'),
      goto: jest.fn().mockImplementation(async () => {
        for (const listener of responseListeners) listener({ status: () => 200, request: () => ({ method: () => 'GET' }),
          url: () => 'https://amomail.amocrm.ru/api/v2/42/leads/123/compose' });
        return { status: () => 200 };
      }), url: jest.fn().mockReturnValue(job.sourceUrl),
      on: jest.fn((_event: string, listener: (value: any) => void) => { responseListeners.add(listener); }),
      off: jest.fn((_event: string, listener: (value: any) => void) => { responseListeners.delete(listener); }),
      evaluate: jest.fn().mockResolvedValue({ accountCode: 'EUR', localeCode: 'EUR' }),
      locator: jest.fn().mockImplementation((selector: string) => selector.includes('lead[NAME]') ? title : { waitFor: jest.fn(), isVisible: jest.fn().mockResolvedValue(false) }),
      screenshot: jest.fn().mockResolvedValue(png),
      close: jest.fn().mockResolvedValue(undefined),
    };
    contexts = [];
    browser = { isConnected: jest.fn().mockReturnValue(true), newContext: jest.fn().mockImplementation(async () => {
      const context = { newPage: jest.fn().mockResolvedValue(page), close: jest.fn().mockResolvedValue(undefined),
        storageState: jest.fn().mockImplementation(async () => sessionState) };
      contexts.push(context);
      return context;
    }), close: jest.fn().mockResolvedValue(undefined) };
    (chromium.launch as jest.Mock).mockReset().mockResolvedValue(browser);
    access = { read: jest.fn().mockResolvedValue('READY'), reset: jest.fn(), dispose: jest.fn(), tokensRotated: false };
    (observeCrmBrowserAccess as jest.Mock).mockReset().mockReturnValue(access);
    (crmBrowserNeedsRefresh as jest.Mock).mockReset().mockResolvedValue(false);
    (refreshCrmBrowserAccess as jest.Mock).mockReset().mockResolvedValue('READY');
    (collectCrmEvidenceFrames as jest.Mock).mockReset().mockImplementation(async (page, _binding, store) => ({
      frames: [{ id: 'card', label: 'Карточка', kind: 'card', capturedAt: new Date().toISOString(),
        ...await store(await page.screenshot({ type: 'png' })), sourceIds: { tasks: [], notes: [] } }],
      records: new Map(), truncated: true,
    }));
    service = new CrmControlEvidenceService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
    process.env = oldEnv;
    const absolute = path.resolve(directory);
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(absolute) === tempRoot && path.basename(absolute).startsWith('crm-evidence-test-')) {
      await rm(absolute, { recursive: true, force: true });
    }
  });

  test.each([
    'http://example.amocrm.ru/leads/detail/123',
    'https://evil.example/leads/detail/123',
    'https://other.amocrm.ru/leads/detail/123',
    'https://example.amocrm.ru/leads/detail/456',
    'https://user:password@example.amocrm.ru/leads/detail/123',
    'https://example.amocrm.ru/leads/detail/123?token=secret',
    'https://example.amocrm.ru/leads/detail/123#secret',
    'https://example.amocrm.ru/settings/users',
  ])('rejects unintended capture destination %s', target => {
    expect(() => validateCrmCaptureUrl(target, '123', origin)).toThrow();
  });

  test('allows only a numeric lead in the configured official account', () => {
    expect(validateCrmCaptureUrl(job.sourceUrl, '123', origin).href).toBe(job.sourceUrl);
    expect(() => validateCrmCaptureUrl(job.sourceUrl, '../123', origin)).toThrow();
    expect(() => validateCrmCaptureUrl('https://example.amocrm.ru.evil.test/leads/detail/123', '123', 'https://example.amocrm.ru.evil.test')).toThrow();
  });

  test('source batches reuse one isolated context, serialize cards and dispose every reader/page', async () => {
    const events: string[] = [];
    const factories = [1, 2].map(index => jest.fn(() => ({ collect: jest.fn(async () => {
      events.push(`start${index}`); await Promise.resolve(); events.push(`end${index}`); return index;
    }), dispose: jest.fn(() => { events.push(`dispose${index}`); }) })));
    const result = await service.withSourceBatch(batch => Promise.all(factories.map(factory => batch.readCard(job, factory))));
    expect(result).toEqual({ ok: true, value: [{ ok: true, value: 1 }, { ok: true, value: 2 }] });
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['start1', 'end1', 'dispose1', 'start2', 'end2', 'dispose2']);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(factories[0].mock.invocationCallOrder[0]).toBeLessThan(page.goto.mock.invocationCallOrder[0]);
  });

  test('a native card401 discards the reader and page, persists a forced refresh and replays the whole read once', async () => {
    const pages = [0, 1].map(() => ({ ...page, goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      close: jest.fn().mockResolvedValue(undefined) }));
    const readers: Array<{ collect: jest.Mock; dispose: jest.Mock }> = [];
    const factory = jest.fn((_page: any) => {
      const attempt = readers.length, fragments: string[] = [];
      const reader = { collect: jest.fn(async () => {
        if (attempt === 0) { fragments.push('partial-old-history'); throw new CrmSourceAuthExpiredError(); }
        expect(fragments).toEqual([]);
        expect(JSON.parse(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).cookies[0].value).toBe('native-replay-rotation');
        fragments.push('fresh-history-page-1', 'fresh-history-page-2'); return fragments.slice();
      }), dispose: jest.fn(() => { fragments.length = 0; }) };
      readers.push(reader); return reader;
    });
    (refreshCrmBrowserAccess as jest.Mock).mockImplementation(async () => {
      sessionState.cookies[0].value = 'native-replay-rotation'; return 'READY';
    });
    const result = await service.withSourceBatch(async batch => {
      contexts[0].newPage.mockReset().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
      return batch.readCard(job, factory);
    });
    expect(result).toEqual({ ok: true, value: { ok: true, value: ['fresh-history-page-1', 'fresh-history-page-2'] } });
    expect(factory.mock.calls.map(([readerPage]) => readerPage)).toEqual(pages);
    expect(contexts[0].newPage).toHaveBeenCalledTimes(2);
    expect(readers.every(reader => reader.collect.mock.calls.length === 1 && reader.dispose.mock.calls.length === 1)).toBe(true);
    expect(readers[0].dispose.mock.invocationCallOrder[0]).toBeLessThan(pages[0].close.mock.invocationCallOrder[0]);
    expect(pages[0].close.mock.invocationCallOrder[0]).toBeLessThan(factory.mock.invocationCallOrder[1]);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledWith(pages[1]);
    expect(pages[0].goto).toHaveBeenCalledTimes(1);
    expect(pages[1].goto).toHaveBeenCalledTimes(2); // New page, then native refresh and navigation replay.
    expect(pages.every(readerPage => readerPage.close.mock.calls.length === 1)).toBe(true);
    expect(contexts[0].storageState.mock.invocationCallOrder.at(-1)).toBeGreaterThan(pages[1].close.mock.invocationCallOrder[0]);
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  test('a second native card401 invalidates the shared session and prevents further card reads', async () => {
    const pages = [0, 1].map(() => ({ ...page, goto: jest.fn().mockResolvedValue({ status: () => 200 }),
      close: jest.fn().mockResolvedValue(undefined) }));
    const disposals: jest.Mock[] = [];
    const factory = jest.fn(() => {
      const dispose = jest.fn(); disposals.push(dispose);
      return { collect: async () => { throw new CrmSourceAuthExpiredError(); }, dispose };
    });
    const result = await service.withSourceBatch(async batch => {
      contexts[0].newPage.mockReset().mockResolvedValueOnce(pages[0]).mockResolvedValueOnce(pages[1]);
      return [await batch.readCard(job, factory), await batch.readCard(job, factory)];
    });
    expect(result).toMatchObject({ ok: true, value: [
      { ok: false, errorCode: 'AUTH_REQUIRED', retryable: false },
      { ok: false, errorCode: 'AUTH_REQUIRED', retryable: false },
    ] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(contexts[0].newPage).toHaveBeenCalledTimes(2);
    expect(disposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true);
    expect(pages.every(readerPage => readerPage.close.mock.calls.length === 1)).toBe(true);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledWith(pages[1]);
    expect(service.capabilities().health).toMatchObject({ status: 'ERROR', errorCode: 'AUTH_REQUIRED' });
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  test('a source batch closes its context on action failure without returning secrets', async () => {
    const result = await service.withSourceBatch(async () => { throw new Error('cookie=secret'); });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  test('a changed session invalidates a later source read in the same batch', async () => {
    const result = await service.withSourceBatch(async batch => {
      await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ cookies: [{ name: 'fixture-session', value: 'replacement',
        domain: 'example.amocrm.ru', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] }));
      return batch.readCard(job, () => ({ collect: async () => 1, dispose: () => undefined }));
    });
    expect(result).toMatchObject({ ok: true, value: { ok: false, errorCode: 'SESSION_CONFLICT' } });
    expect(contexts[0].newPage).not.toHaveBeenCalled();
  });

  test('capture and source reads in one batch share the leased context and serial card queue', async () => {
    const result = await service.withSourceBatch(async batch => Promise.all([
      batch.readCard(job, () => ({ collect: async () => 1, dispose: () => undefined })),
      service.capture(job),
    ]));
    expect(result).toMatchObject({ ok: true, value: [{ ok: true }, { status: 'READY' }] });
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(page.close).toHaveBeenCalledTimes(2);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
  });

  test('direct source reads bootstrap once, keep the real currency check time and do not navigate subsequent deals', async () => {
    const references: any[] = [];
    const dispose = jest.fn();
    const result = await service.withSourceBatch(async batch => {
      const first = await batch.readSources(job, access => { references.push(access); return { collect: async () => 'first', dispose }; });
      const second = await batch.readSources({ dealExternalId: '456', sourceUrl: `${origin}/leads/detail/456` }, access => {
        references.push(access); return { collect: async () => 'second', dispose };
      });
      return [first, second];
    });
    expect(result).toMatchObject({ ok: true, value: [{ ok: true, value: 'first' }, { ok: true, value: 'second' }] });
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(references[0]).toMatchObject({ origin, mailAccountId: '42', currencyValues: { accountCode: 'EUR', localeCode: 'EUR' } });
    expect(references[1].context).toBe(references[0].context);
    expect(references[1].currencyObservedAt).toBe(references[0].currencyObservedAt);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  test('a direct source401 destroys its reader, refreshes natively and restarts the whole deal once', async () => {
    let attempts = 0;
    const dispose = jest.fn(), factory = jest.fn(() => ({ collect: async () => {
      if (++attempts === 1) throw new CrmSourceAuthExpiredError(); return ['fresh-page-1', 'fresh-page-2'];
    }, dispose }));
    const result = await service.withSourceBatch(batch => batch.readSources(job, factory));
    expect(result).toMatchObject({ ok: true, value: { ok: true, value: ['fresh-page-1', 'fresh-page-2'] } });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(3); // initial bootstrap; recovery page; reload after native refresh.
    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });

  test('a second direct401 blocks further source reads without repeated refreshes', async () => {
    const factory = jest.fn(() => ({ collect: async () => { throw new CrmSourceAuthExpiredError(); }, dispose: jest.fn() }));
    const result = await service.withSourceBatch(async batch => [await batch.readSources(job, factory), await batch.readSources(job, factory)]);
    expect(result).toMatchObject({ ok: true, value: [{ ok: false, errorCode: 'AUTH_REQUIRED' }, { ok: false, errorCode: 'AUTH_REQUIRED' }] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
  });

  test('a direct permission failure does not rotate the account login', async () => {
    const result = await service.withSourceBatch(batch => batch.readSources(job, () => ({
      collect: async () => ({ reasonCodes: ['HISTORY_ACCESS_DENIED'] }), dispose: jest.fn(),
    })));
    expect(result).toMatchObject({ ok: true, value: { ok: true, value: { reasonCodes: ['HISTORY_ACCESS_DENIED'] } } });
    expect(refreshCrmBrowserAccess).not.toHaveBeenCalled();
  });

  test('native source bootstrap is reverified after five minutes, without reusing old account metadata', async () => {
    const factory = () => ({ collect: async () => 1, dispose: jest.fn() });
    await service.withSourceBatch(async batch => {
      await batch.readSources(job, factory);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1);
      try { await batch.readSources(job, factory); } finally { clock.mockRestore(); }
    });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  test('source request optimization never substitutes API-rendered content for a screenshot', async () => {
    const result = await service.withSourceBatch(async batch => {
      await batch.readSources(job, () => ({ collect: async () => 1, dispose: jest.fn() }));
      return service.capture(job);
    });
    expect(result).toMatchObject({ ok: true, value: { status: 'READY' } });
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(collectCrmEvidenceFrames).toHaveBeenCalledWith(page, expect.objectContaining(job), expect.any(Function));
    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });

  test('a replaced session cannot be used for another direct read', async () => {
    const factory = jest.fn(() => ({ collect: async () => 1, dispose: jest.fn() }));
    const result = await service.withSourceBatch(async batch => {
      await batch.readSources(job, factory);
      await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ ...sessionState, origins: [{ origin, localStorage: [{ name: 'fresh', value: 'login' }] }] }));
      return batch.readSources(job, factory);
    });
    expect(result).toMatchObject({ ok: true, value: { ok: false, errorCode: 'SESSION_CONFLICT' } });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
  });

  test('direct source requests cannot guess a mailbox account when native discovery is missing', async () => {
    page.goto.mockResolvedValue({ status: () => 200 });
    const factory = jest.fn(() => ({ collect: async () => 1, dispose: jest.fn() }));
    const result = await service.withSourceBatch(batch => batch.readSources(job, factory));
    expect(result).toMatchObject({ ok: true, value: { ok: false, errorCode: 'SOURCE_NOT_READY' } });
    expect(factory).not.toHaveBeenCalled();
  });

  test('a bootstrap currency evaluation failure stays unknown without replacing it with a guess', async () => {
    page.evaluate.mockRejectedValueOnce(new Error('private browser details'));
    const result = await service.withSourceBatch(batch => batch.readSources(job, access => ({
      collect: async () => access.currencyValues, dispose: jest.fn(),
    })));
    expect(result).toMatchObject({ ok: true, value: { ok: true, value: { accountCode: null, localeCode: null } } });
    expect(JSON.stringify(result)).not.toContain('private');
  });

  test('shutdown drains direct requests and saves their final cookie state before releasing the context', async () => {
    let started!: () => void, finish!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const work = service.withSourceBatch(batch => batch.readSources(job, () => ({ collect: async () => {
      started(); await new Promise<void>(resolve => { finish = resolve; });
      sessionState.cookies[0].value = 'last-request-cookie'; return 1;
    }, dispose: jest.fn() })));
    await reading;
    const stopping = service.onModuleDestroy();
    await Promise.resolve(); await Promise.resolve();
    expect(contexts[0].close).not.toHaveBeenCalled();
    finish(); await Promise.all([work, stopping]);
    expect(JSON.parse(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).cookies[0].value).toBe('last-request-cookie');
    expect(contexts[0].close.mock.invocationCallOrder[0]).toBeGreaterThan(contexts[0].storageState.mock.invocationCallOrder.at(-1));
  });

  test('refresh persists new state immediately and again after page activity stops', async () => {
    (crmBrowserNeedsRefresh as jest.Mock).mockResolvedValue(true);
    (refreshCrmBrowserAccess as jest.Mock).mockImplementation(async () => {
      sessionState.cookies[0].value = 'new-test-rotation'; return 'READY';
    });
    expect((await service.capture(job)).status).toBe('READY');
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(contexts[0].storageState).toHaveBeenCalledTimes(2);
    expect(contexts[0].storageState.mock.invocationCallOrder[1]).toBeGreaterThan(page.close.mock.invocationCallOrder[0]);
    expect(JSON.parse(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).cookies[0].value).toBe('new-test-rotation');
  });

  test('a revoked refresh never overwrites state or produces a healthy screenshot', async () => {
    const before = await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!);
    (crmBrowserNeedsRefresh as jest.Mock).mockResolvedValue(true);
    (refreshCrmBrowserAccess as jest.Mock).mockResolvedValue('AUTH_REQUIRED');
    expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'AUTH_REQUIRED', retryable: false });
    expect(contexts[0].storageState).not.toHaveBeenCalled();
    expect(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!)).toEqual(before);
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(service.capabilities().health.status).toBe('ERROR');
  });

  test('a 200 card shell with unverified source APIs is not healthy', async () => {
    access.read.mockResolvedValue('SOURCE_NOT_READY');
    expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'SOURCE_NOT_READY', retryable: true });
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(service.capabilities().health.status).toBe('ERROR');
  });

  test('an unauthorized source read uses one refresh and retries native navigation once', async () => {
    access.read.mockResolvedValueOnce('AUTH_REQUIRED').mockResolvedValueOnce('READY');
    expect((await service.capture(job)).status).toBe('READY');
    expect(refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
    expect(access.reset).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  test('a concurrent fresh login is preserved when the old page finishes', async () => {
    (collectCrmEvidenceFrames as jest.Mock).mockImplementation(async () => {
      await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ ...sessionState, origins: [{ origin, localStorage: [{ name: 'fresh', value: 'login' }] }] }));
      throw new Error('Screenshot failure');
    });
    expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'SESSION_CONFLICT' });
    expect(JSON.parse(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).origins[0].localStorage[0].name).toBe('fresh');
  });

  test('transferred sessions cannot launch a local context or refresh', async () => {
    await writeFile(`${process.env.CRM_CONTROL_BROWSER_STATE_FILE}.transferred`, '{}');
    expect(await service.capture(job)).toMatchObject({ status: 'DISABLED', errorCode: 'SESSION_TRANSFERRED' });
    expect(chromium.launch).not.toHaveBeenCalled();
    expect(refreshCrmBrowserAccess).not.toHaveBeenCalled();
  });

  test('another live process lease prevents opening a second browser context', async () => {
    const lease = await acquireCrmBrowserSessionLease(process.env.CRM_CONTROL_BROWSER_STATE_FILE!);
    try {
      expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'SESSION_BUSY', retryable: true });
      expect(chromium.launch).not.toHaveBeenCalled();
    } finally { await lease.release(); }
  });

  test('shutdown waits for an in-flight token rotation to persist before closing the browser', async () => {
    let rotated!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { rotated = resolve; });
    (crmBrowserNeedsRefresh as jest.Mock).mockResolvedValue(true);
    (refreshCrmBrowserAccess as jest.Mock).mockImplementation(async () => {
      sessionState.cookies[0].value = 'new-rotation-during-shutdown';
      rotated(); await new Promise<void>(resolve => { finish = resolve; }); return 'READY';
    });
    const capture = service.capture(job);
    await started;
    const stopping = service.onModuleDestroy();
    await Promise.resolve(); await Promise.resolve();
    expect(browser.close).not.toHaveBeenCalled();
    expect(contexts[0].close).not.toHaveBeenCalled();
    finish();
    await Promise.all([capture, stopping]);
    expect(JSON.parse(await readFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).cookies[0].value).toBe('new-rotation-during-shutdown');
    expect(contexts[0].close.mock.invocationCallOrder[0]).toBeGreaterThan(contexts[0].storageState.mock.invocationCallOrder.at(-1));
    expect(browser.close.mock.invocationCallOrder[0]).toBeGreaterThan(contexts[0].close.mock.invocationCallOrder[0]);
    const lease = await acquireCrmBrowserSessionLease(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, { waitMs: 0 });
    await lease.release();
  });

  test('does not present unconfigured screenshots as available', async () => {
    delete process.env.CRM_CONTROL_BROWSER_STATE_FILE;
    expect(service.capabilities().screenshots).toBe(false);
    expect((await service.capture(job)).status).toBe('DISABLED');
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  test('a login redirect never becomes a screenshot or a cross-origin navigation', async () => {
    page.url.mockReturnValue('https://example.amocrm.ru/');
    expect((await service.capture(job)).status).toBe('ERROR');
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(contexts[0].close).toHaveBeenCalled();
    const handler = page.route.mock.calls[0][1];
    const route = {
      request: () => ({ method: () => 'GET', isNavigationRequest: () => true, frame: () => 'main-frame', url: () => 'https://evil.example/' }),
      abort: jest.fn(), continue: jest.fn(),
    };
    await handler(route);
    expect(route.abort).toHaveBeenCalled();
    expect(route.continue).not.toHaveBeenCalled();
  });

  test.each([
    ['https://amojo.amocrm.ru/v1/chats/chat/read', 'POST', true],
    ['https://amojo.amocrm.ru/v1/chats/chat/messages', 'POST', true],
    [`${origin}/ajax/v3/chats/chat/read`, 'POST', true],
    [`${origin}/api/v4/talks/42/read`, 'POST', true],
    [`${origin}/ajax/v1/chats/session`, 'POST', false],
    ['https://amojo.amocrm.ru/session/refresh_token', 'POST', false],
    [`${origin}/oauth2/access_token`, 'POST', false],
    ['https://amojo.amocrm.ru/v1/chats/chat/messages', 'GET', false],
  ])('allows native auth and reads while blocking chat writes: %s %s', (url, method, expected) => {
    expect(isCrmCollectorChatMutation(url as string, method as string, origin)).toBe(expected);
  });

  test('the page route blocks an automatic read receipt before any collector action', async () => {
    await service.capture(job);
    const handler = page.route.mock.calls[0][1];
    const route = { request: () => ({ method: () => 'POST', url: () => 'https://amojo.amocrm.ru/v1/chats/example/read' }),
      abort: jest.fn(), continue: jest.fn() };
    await handler(route);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
  });

  test('a different lead is not accepted just because the URL matches', async () => {
    title.getAttribute.mockResolvedValue('Сделка #456');
    expect((await service.capture(job)).status).toBe('ERROR');
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  test('stores source image bytes unchanged and verifies their integrity on read', async () => {
    const result = await service.capture(job);
    expect(result.status).toBe('READY');
    expect(result.capturedAt).toBeInstanceOf(Date);
    expect(result.message).toContain('Скрытые и свёрнутые');
    expect(result.sha256).toBe(createHash('sha256').update(png).digest('hex'));
    expect((await service.read(result.storageKey!, job)).buffer).toEqual(png);
    const manifest = (await service.readManifest(result.storageKey!, job))!;
    expect(await readFile(path.join(process.env.CRM_CONTROL_EVIDENCE_DIR!, manifest.frames[0].storageKey))).toEqual(png);
    await writeFile(path.join(process.env.CRM_CONTROL_EVIDENCE_DIR!, manifest.frames[0].storageKey), Buffer.concat([png, Buffer.from('tampered')]));
    await expect(service.read(result.storageKey!, job)).rejects.toThrow('повреждено');
  });

  test('does not expose capture session or arbitrary files through evidence keys', async () => {
    for (const key of ['../test-session.json', '..\\test-session.json', '/etc/passwd', 'C:\\secrets.png', 'a.png']) {
      await expect(service.read(key)).rejects.toThrow('не найдено');
    }
  });

  test('browser errors cannot leak paths or URL credentials to the API', async () => {
    page.goto.mockRejectedValue(new Error('https://private.test/?token=secret C:\\Users\\secret-session.json'));
    const result = await service.capture(job);
    expect(result.status).toBe('ERROR');
    expect(result.message).not.toContain('secret');
    expect(contexts[0].close).toHaveBeenCalled();
  });

  test('does not overwrite an existing source image when a job is retried', async () => {
    const first = await service.capture(job);
    const second = await service.capture(job);
    expect(first.status).toBe('READY');
    expect(second.status).toBe('READY');
    expect(second.sha256).toBe(first.sha256);
    expect((await service.read(first.storageKey!, job)).buffer).toEqual(png);
    expect((await service.read(second.storageKey!, job)).buffer).toEqual(png);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    for (const context of contexts) expect(context.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['{}', 'STATE_INVALID'],
    ['not-json', 'STATE_INVALID'],
    [JSON.stringify({ cookies: [], origins: [] }), 'STATE_EMPTY'],
    [JSON.stringify({ cookies: [{ name: 'expired', value: 'test', domain: 'example.amocrm.ru', path: '/', expires: 1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] }), 'STATE_EXPIRED'],
    [JSON.stringify({ cookies: [{ name: 'wrong-account', value: 'test', domain: 'other.amocrm.ru', path: '/', expires: -1, secure: true, httpOnly: true, sameSite: 'Lax' }], origins: [] }), 'STATE_EMPTY'],
  ])('rejects unusable session before launching the browser (%s)', async (state, errorCode) => {
    await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, state);
    expect(service.capabilities()).toMatchObject({ screenshots: false, errorCode });
    expect(await service.capture(job)).toMatchObject({ status: 'DISABLED', errorCode, retryable: false });
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  test('configuration alone never claims the login was checked; probe validates the actual card without saving an image', async () => {
    expect(service.capabilities().health).toEqual({ status: 'UNVERIFIED', checkedAt: null });
    expect(await service.probe(job)).toMatchObject({ status: 'READY', checkedAt: expect.any(String) });
    expect(service.capabilities().health.status).toBe('READY');
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(title.getAttribute).toHaveBeenCalledWith('placeholder');
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture-session', value: 'changed-test-only' }] }] }));
    expect(service.capabilities().health.status).toBe('UNVERIFIED');
  });

  test('login form is non-retryable and is never captured', async () => {
    const normalLocator = page.locator.getMockImplementation();
    page.locator.mockImplementation((selector: string) => selector === 'input[type="password"]'
      ? { isVisible: async () => true } : normalLocator(selector));
    expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'AUTH_REQUIRED', retryable: false });
    expect(service.capabilities().health).toMatchObject({ status: 'ERROR', errorCode: 'AUTH_REQUIRED' });
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  test('network failures retry, browser launch failures require configuration repair, and neither exposes raw errors', async () => {
    page.goto.mockRejectedValueOnce(new Error('network?session=secret'));
    expect(await service.capture(job)).toMatchObject({ status: 'ERROR', errorCode: 'CARD_NOT_READY', retryable: true });
    await service.onModuleDestroy();
    service = new CrmControlEvidenceService();
    (chromium.launch as jest.Mock).mockRejectedValueOnce(new Error('secret sandbox path'));
    const result = await service.capture(job);
    expect(result).toMatchObject({ status: 'ERROR', errorCode: 'BROWSER_START_FAILED', retryable: false });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  test('concurrent captures share one protected auth context; module shutdown closes the browser', async () => {
    const result = await Promise.all([service.capture(job), service.capture(job)]);
    expect(result.map(item => item.status)).toEqual(['READY', 'READY']);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ chromiumSandbox: true }));
    expect(contexts).toHaveLength(1);
    expect(contexts[0].newPage).toHaveBeenCalledTimes(2);
    for (const context of contexts) expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).not.toHaveBeenCalled();
    await service.onModuleDestroy();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('reconnects after a browser crash and expires old login health', async () => {
    await service.capture(job);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    expect(service.capabilities().health.status).toBe('UNVERIFIED');
    clock.mockRestore();
    browser.isConnected.mockReturnValueOnce(false);
    expect((await service.capture(job)).status).toBe('READY');
    expect(chromium.launch).toHaveBeenCalledTimes(2);
  });

  test('shared health rejects stale or malformed success and never relays arbitrary fields or messages', () => {
    const now = Date.now();
    const checkedAt = new Date(now).toISOString();
    expect(sanitizeCrmCaptureHealth({ status: 'READY', checkedAt, cookies: 'secret' }, now)).toEqual({ status: 'READY', checkedAt });
    expect(sanitizeCrmCaptureHealth({ status: 'READY', checkedAt: new Date(now - 6 * 60_000).toISOString() }, now).status).toBe('UNVERIFIED');
    expect(sanitizeCrmCaptureHealth({ status: 'READY', checkedAt: new Date(now + 60 * 60_000).toISOString() }, now).status).toBe('UNVERIFIED');
    expect(sanitizeCrmCaptureHealth({ status: 'READY', checkedAt: 'invalid' }, now)).toEqual({ status: 'UNVERIFIED', checkedAt: null });
    const safe = sanitizeCrmCaptureHealth({ status: 'ERROR', checkedAt, errorCode: '__proto__', message: 'token=secret' }, now);
    expect(safe.errorCode).toBe('CAPTURE_FAILED');
    expect(JSON.stringify(safe)).not.toContain('secret');
  });

  test('a probe started with an old session cannot mark a replacement session as verified', async () => {
    let finishNavigation!: () => void;
    let navigationStarted!: () => void;
    const started = new Promise<void>(resolve => { navigationStarted = resolve; });
    page.goto.mockImplementationOnce(async () => {
      navigationStarted();
      await new Promise<void>(resolve => { finishNavigation = resolve; });
      return { status: () => 200 };
    });
    const pending = service.probe(job);
    await started;
    await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'fixture-session', value: 'replacement-test-only' }] }] }));
    expect(service.capabilities().health.status).toBe('UNVERIFIED');
    finishNavigation();
    expect(await pending).toMatchObject({ status: 'ERROR', errorCode: 'SESSION_CONFLICT' });
    expect(service.capabilities().health.status).toBe('UNVERIFIED');
  });

  test('binds a bundle to its immutable observation and allows only its declared frames', async () => {
    const result = await service.capture(job);
    expect(result.storageKey).toMatch(/^[a-f0-9]{64}\.evidence\.json$/);
    expect((await service.readFrame(result.storageKey!, 'card', job)).buffer).toEqual(png);
    await expect(service.readFrame(result.storageKey!, '../test-session.json', job)).rejects.toThrow('Кадр не найден');
    for (const changed of [{ observationId: 'other' }, { dealExternalId: '456' }, { snapshotHash: 'a'.repeat(64) }]) {
      await expect(service.read(result.storageKey!, { ...job, ...changed })).rejects.toThrow('не соответствует');
    }
    await expect(service.read(result.storageKey!)).rejects.toThrow('не найдено');
    const manifestFile = path.join(process.env.CRM_CONTROL_EVIDENCE_DIR!, result.storageKey!);
    await writeFile(manifestFile, Buffer.from('{}'));
    await expect(service.readManifest(result.storageKey!, job)).rejects.toThrow('недоступно');
  });

  test('continues serving original legacy PNG keys without creating invented coverage', async () => {
    const result = await service.capture(job);
    const key = `${result.sha256}.png`;
    expect((await service.read(key)).buffer).toEqual(png);
    expect(await service.readManifest(key, job)).toBeNull();
  });
});
