import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';

export interface CrmControlCaptureJob {
  dealExternalId: string;
  sourceUrl: string;
  observationId: string;
  dealTitle?: string;
}

export interface CrmControlCaptureResult {
  status: 'READY' | 'ERROR' | 'DISABLED';
  storageKey?: string;
  mimeType?: string;
  sha256?: string;
  capturedAt?: Date;
  message?: string;
  errorCode?: string;
  retryable?: boolean;
}

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const HEALTH_MAX_AGE_MS = 5 * 60_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type StorageState = Exclude<NonNullable<Parameters<Browser['newContext']>[0]>['storageState'], string | undefined>;
export type CaptureHealth = { status: 'UNVERIFIED' | 'READY' | 'ERROR'; checkedAt: string | null; errorCode?: string; message?: string };
type CaptureConfiguration = { origin: string; executable: string; state: StorageState; fingerprint: string };

class CaptureFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); }
}

const HEALTH_ERRORS: Record<string, string> = {
  NOT_CONFIGURED: 'Отдельная сессия сборщика не настроена.',
  CONFIG_INVALID: 'Настройки аккаунта сборщика заданы неверно.',
  BROWSER_UNAVAILABLE: 'Браузер сборщика недоступен.',
  BROWSER_START_FAILED: 'Защищённый браузер не запустился. Проверьте установку и разрешения запуска.',
  STATE_UNAVAILABLE: 'Файл отдельной сессии недоступен.',
  STATE_INVALID: 'Файл отдельной сессии повреждён. Сохраните новую сессию.',
  STATE_EMPTY: 'В файле нет сессии настроенного аккаунта amoCRM.',
  STATE_EXPIRED: 'Сессия amoCRM истекла. Войдите заново через отдельный браузер сборщика.',
  AUTH_REQUIRED: 'amoCRM требует вход. Обновите отдельную сессию сборщика.',
  TARGET_INVALID: 'Адрес снимка не соответствует настроенному аккаунту и сделке.',
  WRONG_CARD: 'Открылась другая карточка сделки. Снимок не сохранён.',
  CARD_ACCESS_DENIED: 'amoCRM отказала в доступе к карточке. Проверьте вход и права сборщика.',
  CARD_UNAVAILABLE: 'Карточка amoCRM недоступна.',
  CARD_NOT_READY: 'Карточка amoCRM не загрузилась полностью.',
  WORKER_STOPPING: 'Сборщик завершает работу.',
  INVALID_IMAGE: 'Файл снимка не прошёл проверку целостности.',
  CAPTURE_FAILED: 'Не удалось получить и сохранить снимок amoCRM.',
};

/** Safe shared status: neither stored text nor extra browser fields cross the API boundary. */
export function sanitizeCrmCaptureHealth(value: unknown, now = Date.now()): CaptureHealth {
  if (!value || typeof value !== 'object') return { status: 'UNVERIFIED', checkedAt: null };
  const item = value as Record<string, unknown>;
  const timestamp = typeof item.checkedAt === 'string' ? Date.parse(item.checkedAt) : NaN;
  const checkedAt = Number.isFinite(timestamp) && timestamp <= now + 60_000 ? new Date(timestamp).toISOString() : null;
  if (item.status === 'UNVERIFIED' || (checkedAt && now - timestamp > HEALTH_MAX_AGE_MS)) return { status: 'UNVERIFIED', checkedAt };
  if (item.status === 'READY' && checkedAt) return { status: 'READY', checkedAt };
  if (item.status === 'ERROR') {
    const errorCode = typeof item.errorCode === 'string' && Object.hasOwn(HEALTH_ERRORS, item.errorCode) ? item.errorCode : 'CAPTURE_FAILED';
    return { status: 'ERROR', checkedAt, errorCode, message: HEALTH_ERRORS[errorCode] };
  }
  return { status: 'UNVERIFIED', checkedAt: null };
}

/** Only the account origin and the observed lead ID may select a capture target. */
export function validateCrmCaptureUrl(sourceUrl: string, dealExternalId: string, origin: string): URL {
  let url: URL;
  let account: URL;
  try {
    url = new URL(sourceUrl);
    account = new URL(origin);
  } catch {
    throw new Error('Некорректный адрес amoCRM для снимка.');
  }
  if (!/^\d+$/.test(dealExternalId)
    || account.protocol !== 'https:'
    || !/^[a-z0-9][a-z0-9-]*\.(amocrm\.ru|amocrm\.com|kommo\.com)$/i.test(account.hostname)
    || account.username || account.password || account.port || account.search || account.hash
    || account.pathname !== '/'
    || url.origin !== account.origin || url.username || url.password || url.search || url.hash
    || ![ `/leads/detail/${dealExternalId}`, `/leads/detail/${dealExternalId}/` ].includes(url.pathname)) {
    throw new Error('Адрес снимка не соответствует настроенному аккаунту и сделке.');
  }
  return url;
}

@Injectable()
export class CrmControlEvidenceService implements OnModuleDestroy {
  private browser?: Browser;
  private browserLaunch?: Promise<Browser>;
  private browserExecutable?: string;
  private fingerprint?: string;
  private health: CaptureHealth = { status: 'UNVERIFIED', checkedAt: null };
  private destroyed = false;

  /** Configuration is not proof of a live login. Only probe/capture can set health.READY. */
  capabilities(): { screenshots: boolean; message?: string; errorCode?: string; health: CaptureHealth } {
    try {
      const config = this.configuration();
      this.useConfiguration(config);
      const health = this.currentHealth();
      return { screenshots: true, health,
        message: health.status === 'READY' ? 'Вход сборщика проверен на карточке amoCRM. Доступ проверяется при каждом снимке.'
          : health.status === 'ERROR' ? health.message : 'Файл сессии подготовлен. Вход в amoCRM ещё не проверен сборщиком.' };
    } catch (error) {
      const failure = this.failure(error, 'CONFIG_INVALID', 'Настройки сборщика скриншотов недоступны.');
      this.health = { status: 'ERROR', checkedAt: null, errorCode: failure.code, message: failure.message };
      return { screenshots: false, errorCode: failure.code, message: failure.message, health: { ...this.health } };
    }
  }

  /** Server-internal envelope. Never return the fingerprint through a controller or logs. */
  runtimeHealth(): { configurationFingerprint: string | null; health: CaptureHealth } {
    const capability = this.capabilities();
    return { configurationFingerprint: capability.screenshots ? this.fingerprint ?? null : null,
      health: sanitizeCrmCaptureHealth(capability.health) };
  }

  private configuration(): CaptureConfiguration {
    const state = process.env.CRM_CONTROL_BROWSER_STATE_FILE;
    const executable = process.env.CRM_CONTROL_CHROMIUM_EXECUTABLE;
    const origin = process.env.CRM_CONTROL_AMO_ORIGIN;
    if (!state || !executable || !origin) {
      throw new CaptureFailure('NOT_CONFIGURED', 'Скриншоты не подключены: настройте отдельную сессию amoCRM для сборщика. Архивные данные сохраняются независимо.');
    }
    try {
      validateCrmCaptureUrl(`${new URL(origin).origin}/leads/detail/1`, '1', origin);
    } catch {
      throw new CaptureFailure('CONFIG_INVALID', 'Адрес аккаунта для сборщика скриншотов задан неверно.');
    }
    try {
      if (!statSync(executable).isFile()) throw new Error();
    } catch { throw new CaptureFailure('BROWSER_UNAVAILABLE', 'Сборщику недоступен настроенный браузер.'); }
    let raw: string;
    try {
      const stat = lstatSync(state);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SESSION_BYTES) throw new Error();
      raw = readFileSync(state, 'utf8');
      if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) throw new Error();
    } catch { throw new CaptureFailure('STATE_UNAVAILABLE', 'Файл отдельной сессии amoCRM недоступен или имеет недопустимый размер.'); }
    let parsed: StorageState;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)
        || parsed.cookies.some(cookie => !cookie || typeof cookie.name !== 'string' || typeof cookie.value !== 'string'
          || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string' || !Number.isFinite(cookie.expires)
          || typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean' || !['Strict', 'Lax', 'None'].includes(cookie.sameSite))
        || parsed.origins.some(item => !item || typeof item.origin !== 'string' || !Array.isArray(item.localStorage)
          || item.localStorage.some(value => !value || typeof value.name !== 'string' || typeof value.value !== 'string'))) throw new Error();
    } catch { throw new CaptureFailure('STATE_INVALID', 'Файл сессии amoCRM повреждён. Сохраните новую отдельную сессию сборщика.'); }
    const account = new URL(origin);
    const relevantCookies = parsed.cookies.filter(cookie => {
      const domain = cookie.domain.replace(/^\./, '').toLowerCase();
      return domain && (account.hostname === domain || (cookie.domain.startsWith('.') && account.hostname.endsWith(`.${domain}`)));
    });
    const activeCookies = relevantCookies.some(cookie => cookie.value && (cookie.expires === -1 || cookie.expires > Date.now() / 1000));
    const localState = parsed.origins.some(item => item.origin === account.origin && item.localStorage.some(value => value.value));
    if (!activeCookies && !localState) {
      throw new CaptureFailure(relevantCookies.length ? 'STATE_EXPIRED' : 'STATE_EMPTY',
        relevantCookies.length ? 'Сохранённая сессия amoCRM истекла. Войдите заново через отдельный браузер сборщика.'
          : 'В файле нет сессии настроенного аккаунта amoCRM. Сохраните её после входа сборщика.');
    }
    return { origin: account.origin, executable, state: parsed,
      fingerprint: createHash('sha256').update(`${origin}\n${executable}\n${raw}`).digest('hex') };
  }

  private useConfiguration(config: CaptureConfiguration) {
    if (this.fingerprint !== config.fingerprint) {
      this.fingerprint = config.fingerprint;
      this.health = { status: 'UNVERIFIED', checkedAt: null };
    }
  }

  private currentHealth(): CaptureHealth {
    if (this.health.checkedAt && Date.now() - Date.parse(this.health.checkedAt) > HEALTH_MAX_AGE_MS) {
      return { status: 'UNVERIFIED', checkedAt: this.health.checkedAt };
    }
    return { ...this.health };
  }

  private async getBrowser(config: CaptureConfiguration): Promise<Browser> {
    if (this.destroyed) throw new CaptureFailure('WORKER_STOPPING', 'Сборщик завершает работу. Снимок будет повторён.', true);
    if (this.browserLaunch) {
      try { await this.browserLaunch; }
      catch (error) { throw this.failure(error, 'BROWSER_START_FAILED', 'Не удалось запустить защищённый браузер сборщика. Проверьте его установку и разрешения запуска.'); }
      return this.getBrowser(config);
    }
    if (this.browser?.isConnected() && this.browserExecutable === config.executable) return this.browser;
    this.browserExecutable = config.executable;
    this.browserLaunch = (async () => {
      await this.browser?.close().catch(() => undefined);
      this.browser = undefined;
      return chromium.launch({ executablePath: config.executable, headless: true, chromiumSandbox: true, timeout: 25_000 });
    })();
    try {
      const browser = await this.browserLaunch;
      if (this.destroyed) { await browser.close(); throw new CaptureFailure('WORKER_STOPPING', 'Сборщик завершает работу. Снимок будет повторён.', true); }
      this.browser = browser;
      return browser;
    } catch (error) {
      throw this.failure(error, 'BROWSER_START_FAILED', 'Не удалось запустить защищённый браузер сборщика. Проверьте его установку и разрешения запуска.');
    } finally { this.browserLaunch = undefined; }
  }

  /** Read-only login/card probe: no screenshot, no session contents in the response. */
  async probe(job: CrmControlCaptureJob): Promise<CaptureHealth> {
    const result = await this.withCard(job, async () => undefined);
    if (!result.ok) return { status: 'ERROR', checkedAt: new Date().toISOString(), errorCode: result.failure.code, message: result.failure.message };
    return this.capabilities().health;
  }

  private async withCard<T>(job: CrmControlCaptureJob, action: (page: Page, title: string) => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false; disabled: boolean; failure: CaptureFailure }> {
    let context: BrowserContext | undefined;
    let configured = false;
    let configurationFingerprint: string | undefined;
    let stage: 'browser' | 'card' | 'action' = 'browser';
    let navigationBlocked = false;
    try {
      const config = this.configuration();
      this.useConfiguration(config);
      configurationFingerprint = config.fingerprint;
      configured = true;
      let url: URL;
      try { url = validateCrmCaptureUrl(job.sourceUrl, job.dealExternalId, config.origin); }
      catch { throw new CaptureFailure('TARGET_INVALID', 'Адрес снимка не соответствует настроенному аккаунту и сделке.'); }
      const browser = await this.getBrowser(config);
      context = await browser.newContext({
        storageState: config.state,
        viewport: { width: 1600, height: 1200 },
        deviceScaleFactor: 1,
        locale: 'ru-RU',
        acceptDownloads: false,
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      // Never follow a document redirect to another account, login provider or arbitrary URL.
      await page.route('**/*', async route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          try {
            validateCrmCaptureUrl(request.url(), job.dealExternalId, config.origin);
          } catch {
            navigationBlocked = true;
            await route.abort('blockedbyclient');
            return;
          }
        }
        await route.continue();
      });
      stage = 'card';
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 35_000 });
      if (!response) throw new CaptureFailure('CARD_UNAVAILABLE', 'Карточка amoCRM не загрузилась. Сборщик повторит запрос.', true);
      if ([401, 403].includes(response.status())) throw new CaptureFailure('CARD_ACCESS_DENIED', 'amoCRM отказала в доступе. Проверьте вход и права отдельного пользователя сборщика.');
      if (response.status() >= 400) throw new CaptureFailure('CARD_UNAVAILABLE', 'amoCRM не вернула доступную карточку сделки.', response.status() === 429 || response.status() >= 500);
      try { validateCrmCaptureUrl(page.url(), job.dealExternalId, config.origin); }
      catch { throw new CaptureFailure('AUTH_REQUIRED', 'amoCRM перенаправила сборщик с карточки. Проверьте отдельную сессию; страница входа не сохраняется.'); }
      if (await page.locator('input[type="password"]').isVisible()) throw new CaptureFailure('AUTH_REQUIRED', 'amoCRM требует вход. Обновите отдельную сессию сборщика; страница входа не сохраняется.');

      // These selectors were verified in the actual amoCRM lead card on 2026-09-18.
      const title = page.locator('textarea[name="lead[NAME]"]');
      await title.waitFor({ state: 'visible' });
      const placeholder = await title.getAttribute('placeholder');
      if (placeholder !== `Сделка #${job.dealExternalId}` || !(await title.inputValue()).trim()) {
        throw new CaptureFailure('WRONG_CARD', 'Открылась другая карточка сделки. Снимок не сохранён.');
      }
      await page.locator('#card_holder .js-card-feed').waitFor({ state: 'visible' });
      await page.locator('#card_holder .js-notes').waitFor({ state: 'attached' });
      await page.locator('#lead_card_budget').waitFor({ state: 'visible' });
      if (await page.locator('input[type="password"]').isVisible()) throw new CaptureFailure('AUTH_REQUIRED', 'amoCRM требует вход. Обновите отдельную сессию сборщика; страница входа не сохраняется.');
      const currentTitle = await title.inputValue();
      if (this.fingerprint === configurationFingerprint) this.health = { status: 'READY', checkedAt: new Date().toISOString() };
      stage = 'action';
      return { ok: true, value: await action(page, currentTitle) };
    } catch (error) {
      // Browser errors may contain session paths, page fragments and credential-bearing URLs.
      const failure = navigationBlocked
        ? new CaptureFailure('AUTH_REQUIRED', 'amoCRM перенаправила сборщик с карточки. Проверьте отдельную сессию; страница входа не сохраняется.')
        : this.failure(error, stage === 'card' ? 'CARD_NOT_READY' : stage === 'action' ? 'CAPTURE_FAILED' : 'BROWSER_UNAVAILABLE',
          stage === 'card' ? 'Карточка amoCRM не загрузилась полностью. Сборщик повторит попытку.'
            : stage === 'action' ? 'Не удалось получить и сохранить снимок amoCRM. Сборщик повторит попытку.'
              : 'Браузер сборщика недоступен. Сборщик повторит попытку.', true);
      if (stage !== 'action' && (!configurationFingerprint || this.fingerprint === configurationFingerprint)) {
        this.health = { status: 'ERROR', checkedAt: configured ? new Date().toISOString() : null, errorCode: failure.code, message: failure.message };
      }
      return { ok: false, disabled: !configured, failure };
    } finally { await context?.close().catch(() => undefined); }
  }

  async capture(job: CrmControlCaptureJob): Promise<CrmControlCaptureResult> {
    const result = await this.withCard(job, async (page, currentTitle) => {
      const capturedAt = new Date();
      const buffer = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 15_000 });
      if (buffer.length > MAX_EVIDENCE_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new CaptureFailure('INVALID_IMAGE', 'Файл снимка не прошёл проверку целостности.');
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const storageKey = `${sha256}.png`;
      const directory = this.directory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Content-addressed, append-only evidence. An existing identical image is reused.
      try {
        await writeFile(path.join(directory, storageKey), buffer, { flag: 'wx', mode: 0o600 });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await this.read(storageKey);
        if (!existing.buffer.equals(buffer)) throw new CaptureFailure('INVALID_IMAGE', 'Файл снимка не прошёл проверку целостности.');
      }
      return {
        status: 'READY' as const, storageKey, mimeType: 'image/png', sha256, capturedAt,
        message: 'Снимок видимой области amoCRM на момент съёмки. Скрытые и свёрнутые записи в кадр не входят; исходные данные проверки сохранены отдельно.'
          + (job.dealTitle && currentTitle !== job.dealTitle ? ' Название сделки изменилось после проверки.' : ''),
      };
    });
    return result.ok ? result.value : { status: result.disabled ? 'DISABLED' : 'ERROR', errorCode: result.failure.code,
      retryable: result.failure.retryable, message: result.failure.message };
  }

  private failure(error: unknown, code: string, message: string, retryable = false): CaptureFailure {
    return error instanceof CaptureFailure ? error : new CaptureFailure(code, message, retryable);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    const launching = await this.browserLaunch?.catch(() => undefined);
    await (this.browser ?? launching)?.close().catch(() => undefined);
    this.browser = undefined;
  }

  async read(storageKey: string): Promise<{ buffer: Buffer; contentType: string }> {
    if (!/^[a-f0-9]{64}\.png$/.test(storageKey)) throw new NotFoundException('Подтверждение не найдено');
    try {
      const filePath = path.join(this.directory(), storageKey);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_EVIDENCE_BYTES) throw new Error('Invalid file');
      const buffer = await readFile(filePath);
      if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)
        || `${createHash('sha256').update(buffer).digest('hex')}.png` !== storageKey) throw new Error('Invalid file');
      return { buffer, contentType: 'image/png' };
    } catch {
      throw new NotFoundException('Подтверждение недоступно или повреждено');
    }
  }

  private directory(): string {
    return path.resolve(process.env.CRM_CONTROL_EVIDENCE_DIR || 'outputs/crm-control-evidence');
  }
}
