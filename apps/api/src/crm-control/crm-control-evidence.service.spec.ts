import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CrmControlEvidenceService, validateCrmCaptureUrl } from './crm-control-evidence.service';

jest.mock('playwright-core', () => ({ chromium: { launch: jest.fn() } }));

describe('CRM screenshot evidence', () => {
  const origin = 'https://example.amocrm.ru';
  const job = { dealExternalId: '123', sourceUrl: `${origin}/leads/detail/123`, observationId: 'observation-1', dealTitle: 'Test lead' };
  let directory: string;
  let oldEnv: NodeJS.ProcessEnv;
  let service: CrmControlEvidenceService;
  let browser: any;
  let page: any;
  let title: any;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2l5kAAAAASUVORK5CYII=', 'base64');

  beforeEach(async () => {
    oldEnv = { ...process.env };
    directory = await mkdtemp(path.join(os.tmpdir(), 'crm-evidence-test-'));
    process.env.CRM_CONTROL_AMO_ORIGIN = origin;
    process.env.CRM_CONTROL_BROWSER_STATE_FILE = path.join(directory, 'test-session.json');
    process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE = path.join(directory, 'test-browser');
    process.env.CRM_CONTROL_EVIDENCE_DIR = path.join(directory, 'evidence');
    await writeFile(process.env.CRM_CONTROL_BROWSER_STATE_FILE, '{}');
    await writeFile(process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE, 'mock');
    title = { waitFor: jest.fn(), getAttribute: jest.fn().mockResolvedValue('Сделка #123'), inputValue: jest.fn().mockResolvedValue('Test lead') };
    page = {
      setDefaultTimeout: jest.fn(), route: jest.fn(), mainFrame: jest.fn().mockReturnValue('main-frame'),
      goto: jest.fn().mockResolvedValue({ status: () => 200 }), url: jest.fn().mockReturnValue(job.sourceUrl),
      locator: jest.fn().mockImplementation((selector: string) => selector.includes('lead[NAME]') ? title : { waitFor: jest.fn(), isVisible: jest.fn().mockResolvedValue(false) }),
      screenshot: jest.fn().mockResolvedValue(png),
    };
    browser = { newContext: jest.fn().mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page) }), close: jest.fn().mockResolvedValue(undefined) };
    (chromium.launch as jest.Mock).mockReset().mockResolvedValue(browser);
    service = new CrmControlEvidenceService();
  });

  afterEach(async () => {
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
    expect(browser.close).toHaveBeenCalled();
    const handler = page.route.mock.calls[0][1];
    const route = {
      request: () => ({ isNavigationRequest: () => true, frame: () => 'main-frame', url: () => 'https://evil.example/' }),
      abort: jest.fn(), continue: jest.fn(),
    };
    await handler(route);
    expect(route.abort).toHaveBeenCalled();
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
    expect((await service.read(result.storageKey!)).buffer).toEqual(png);
    expect(await readFile(path.join(process.env.CRM_CONTROL_EVIDENCE_DIR!, result.storageKey!))).toEqual(png);
    await writeFile(path.join(process.env.CRM_CONTROL_EVIDENCE_DIR!, result.storageKey!), Buffer.concat([png, Buffer.from('tampered')]));
    await expect(service.read(result.storageKey!)).rejects.toThrow('повреждено');
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
    expect(browser.close).toHaveBeenCalled();
  });

  test('does not overwrite an existing source image when a job is retried', async () => {
    const first = await service.capture(job);
    const second = await service.capture(job);
    expect(first.status).toBe('READY');
    expect(second.status).toBe('READY');
    expect(second.storageKey).toBe(first.storageKey);
  });
});
