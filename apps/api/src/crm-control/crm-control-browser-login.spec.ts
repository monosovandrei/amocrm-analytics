import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireCrmBrowserSessionLease } from './crm-control-browser-session';

const { main } = require('../../../../scripts/crm-control-browser-login.cjs');

describe('collector login and exclusive server handoff', () => {
  let directory: string, env: NodeJS.ProcessEnv, dependencies: any, page: any, browser: any, context: any, access: any;
  const fixture = { cookies: [], origins: [{ origin: 'https://example.amocrm.ru', localStorage: [{ name: 'fixture', value: 'test-only' }] }] };
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'crm-login-test-'));
    env = { CRM_CONTROL_AMO_ORIGIN: 'https://example.amocrm.ru', CRM_CONTROL_BROWSER_STATE_FILE: path.join(directory, 'state.json'),
      CRM_CONTROL_CHROMIUM_EXECUTABLE: 'test-chrome', CRM_CONTROL_SESSION_PROBE_LEAD_ID: '123' };
    let currentUrl = env.CRM_CONTROL_AMO_ORIGIN!;
    page = { goto: jest.fn(async (url: string) => { currentUrl = url; return { status: () => 200 }; }),
      waitForURL: jest.fn(async () => { currentUrl += '/leads/list/'; }), url: () => currentUrl,
      locator: jest.fn(() => ({ waitFor: jest.fn(), isVisible: async () => true, count: async () => 0 })), close: jest.fn(async () => undefined) };
    context = { newPage: async () => page, storageState: jest.fn(async () => fixture) };
    browser = { newContext: jest.fn(async () => context), close: jest.fn() };
    access = { read: jest.fn(async () => 'READY'), reset: jest.fn(), dispose: jest.fn(), tokensRotated: false };
    dependencies = { acquireCrmBrowserSessionLease, chromium: { launch: jest.fn(async () => browser) },
      observeCrmBrowserAccess: jest.fn(() => access), refreshCrmBrowserAccess: jest.fn(async () => 'READY') };
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('crm-login-test-')) await rm(directory, { recursive: true, force: true });
  });

  test('saves only verified source access and rotation, then blocks local reuse before transfer', async () => {
    await main(dependencies, env, []);
    expect(await readFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8')).toBe(JSON.stringify(fixture));
    expect(context.storageState).toHaveBeenCalledTimes(2);
    expect(context.storageState.mock.invocationCallOrder[1]).toBeGreaterThan(page.close.mock.invocationCallOrder[0]);
    expect(dependencies.refreshCrmBrowserAccess).toHaveBeenCalledTimes(1);
    expect(dependencies.chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: false, chromiumSandbox: true }));
    expect(browser.newContext).toHaveBeenCalledWith({ locale: 'ru-RU' }); // Never imports transferred/old cookies.
    await main(dependencies, env, ['--mark-transferred']);
    expect(JSON.parse(await readFile(`${env.CRM_CONTROL_BROWSER_STATE_FILE}.transferred`, 'utf8')).version).toBe(1);
    expect(dependencies.chromium.launch).toHaveBeenCalledTimes(1);
  });

  test('keeps a private fresh checkpoint on refresh failure and refuses handoff', async () => {
    dependencies.refreshCrmBrowserAccess.mockResolvedValue('AUTH_REQUIRED');
    await expect(main(dependencies, env, [])).rejects.toMatchObject({ code: 'CRM_BROWSER_REFRESH_NOT_VERIFIED' });
    expect(JSON.parse(await readFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8'))).toEqual(fixture);
    await expect(main(dependencies, env, ['--mark-transferred'])).rejects.toThrow();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  test('never overwrites an external fresh replacement with an older interactive login', async () => {
    dependencies.refreshCrmBrowserAccess.mockImplementation(async () => {
      await writeFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ cookies: [], origins: [] }));
      return 'READY';
    });
    await expect(main(dependencies, env, [])).rejects.toMatchObject({ code: 'CRM_BROWSER_SESSION_CONFLICT' });
    expect(JSON.parse(await readFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8'))).toEqual({ cookies: [], origins: [] });
  });

  test('a failed source verification never replaces the previous saved state', async () => {
    await writeFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, JSON.stringify({ cookies: [], origins: [] }));
    access.read.mockResolvedValue('SOURCE_NOT_READY');
    await expect(main(dependencies, env, [])).rejects.toThrow();
    expect(context.storageState).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(env.CRM_CONTROL_BROWSER_STATE_FILE!, 'utf8'))).toEqual({ cookies: [], origins: [] });
  });
});
