import { Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { collectCrmEvidenceFrames } from './crm-control-evidence-frames';
import { buildRuleCoverage, EVIDENCE_MANIFEST_KEY, EVIDENCE_PNG_KEY, EvidenceBinding, EvidenceManifest, MAX_MANIFEST_BYTES, validateEvidenceManifest } from './crm-control-evidence-manifest';
import { acquireCrmBrowserSessionLease, CrmBrowserSessionError, CrmBrowserSessionLease } from './crm-control-browser-session';
import { crmBrowserNeedsRefresh, observeCrmBrowserAccess, refreshCrmBrowserAccess } from './crm-control-browser-auth';

export interface CrmControlCaptureJob extends EvidenceBinding {
  sourceUrl: string;
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

export type CrmSourceCardJob = Pick<CrmControlCaptureJob, 'sourceUrl' | 'dealExternalId'> & {
  connectionId?: string; accountExternalId?: string;
};
export type CrmSourceReadResult<T> = { ok: true; value: T } | { ok: false; errorCode: string; message: string; retryable: boolean };
export interface CrmSourceRequestSession {
  context: BrowserContext; origin: string; mailAccountId: string;
  accountExternalId?: string | null;
  currencyValues: { accountCode: string | null; localeCode: string | null }; currencyObservedAt: string;
}
export class CrmSourceAuthExpiredError extends Error { constructor() { super('SOURCE_AUTH_EXPIRED'); } }
export interface CrmSourceBrowserBatch {
  readCard<T>(job: CrmSourceCardJob, reader: (page: Page) => { collect(): Promise<T>; dispose(): void }): Promise<CrmSourceReadResult<T>>;
  readSources<T>(job: CrmSourceCardJob, reader: (session: CrmSourceRequestSession) => { collect(): Promise<T>; dispose(): void }): Promise<CrmSourceReadResult<T>>;
}

const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_SESSION_BYTES = 4 * 1024 * 1024;
const HEALTH_MAX_AGE_MS = 5 * 60_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type StorageState = Exclude<NonNullable<Parameters<Browser['newContext']>[0]>['storageState'], string | undefined>;
export type CaptureHealth = { status: 'UNVERIFIED' | 'READY' | 'ERROR'; checkedAt: string | null; errorCode?: string; message?: string };
type CaptureConfiguration = { origin: string; executable: string; statePath: string; rawHash: string; state: StorageState; fingerprint: string };
type AuthSession = { config: CaptureConfiguration; context: BrowserContext; lease: CrmBrowserSessionLease;
  rawHash: string; tail: Promise<void>; closing?: Promise<void>; invalid?: CaptureFailure;
  sourceAccess?: { mailAccountId: string; accountExternalId: string | null; currencyValues: CrmSourceRequestSession['currencyValues']; currencyObservedAt: string; verifiedAt: number } };

/** Loading a CRM card must not acknowledge messages or invoke chat write actions. */
export function isCrmCollectorChatMutation(target: string, method: string, origin: string): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  let url: URL; try { url = new URL(target); } catch { return false; }
  const chatHost = /(^|\.)amocrm\.ru$/.test(url.hostname) && url.origin !== origin && /amojo/.test(url.hostname);
  const crmChat = url.origin === origin && /^\/ajax\/v\d+\/chats\//.test(url.pathname);
  const authorizationOnly = chatHost && url.pathname === '/session/refresh_token'
    || url.origin === origin && /^\/ajax\/v1\/chats\/session\/?$/.test(url.pathname);
  return !authorizationOnly && (chatHost || crmChat || /\/(?:read|read_all|mark_read)\/?$/.test(url.pathname));
}

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
  SESSION_BUSY: 'Сессия занята другим процессом сборщика. Запрос будет повторён.',
  SESSION_TRANSFERRED: 'Владение этой сессией передано серверу. Локальный сборщик её больше не использует.',
  SESSION_CONFLICT: 'Сессия изменилась во время чтения. Старые данные входа не сохранены; запустите новый пакет.',
  SOURCE_NOT_READY: 'Не подтверждён доступ к ленте и почте amoCRM. Запрос будет повторён.',
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
  private authSession?: Promise<AuthSession>;
  private authSessionUsers = 0;
  private authSessionClosing?: Promise<void>;

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
    if (existsSync(`${path.resolve(state)}.transferred`)) throw new CaptureFailure('SESSION_TRANSFERRED', HEALTH_ERRORS.SESSION_TRANSFERRED);
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
    return { origin: account.origin, executable, statePath: path.resolve(state), rawHash: createHash('sha256').update(raw).digest('hex'), state: parsed,
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

  /** One leased auth context is shared by source batches and captures; each card still gets a fresh page. */
  async withSourceBatch<T>(action: (batch: CrmSourceBrowserBatch) => Promise<T>): Promise<CrmSourceReadResult<T>> {
    let accepting = true;
    try {
      return await this.withAuthSession(async session => {
        const batch: CrmSourceBrowserBatch = { readCard: async (job, createReader) => {
          try {
            if (!accepting) throw new CaptureFailure('WORKER_STOPPING', HEALTH_ERRORS.WORKER_STOPPING, true);
            return { ok: true, value: await this.queueCard(session, job, createReader) };
          } catch (error) {
            const failure = this.failure(error, 'CAPTURE_FAILED', 'Не удалось прочитать источники карточки.', true);
            return { ok: false, errorCode: failure.code, message: failure.message, retryable: failure.retryable };
          }
        }, readSources: async (job, createReader) => {
          try {
            if (!accepting) throw new CaptureFailure('WORKER_STOPPING', HEALTH_ERRORS.WORKER_STOPPING, true);
            const result = session.tail.then(() => this.readSessionSources(session, job, createReader));
            session.tail = result.then(() => undefined, () => undefined);
            return { ok: true, value: await result };
          } catch (error) {
            const failure = this.failure(error, 'CAPTURE_FAILED', 'Не удалось прочитать источники карточки.', true);
            return { ok: false, errorCode: failure.code, message: failure.message, retryable: failure.retryable };
          }
        } };
        try { return { ok: true as const, value: await action(batch) }; }
        finally { accepting = false; await session.tail; }
      });
    } catch (error) {
      const failure = this.failure(error, 'BROWSER_UNAVAILABLE', 'Браузер сборщика источников недоступен.', true);
      return { ok: false, errorCode: failure.code, message: failure.message, retryable: failure.retryable };
    }
  }

  private async withCard<T>(job: CrmControlCaptureJob, action: (page: Page, title: string) => Promise<T>): Promise<
    { ok: true; value: T } | { ok: false; disabled: boolean; failure: CaptureFailure }> {
    let configured = false;
    try {
      const config = this.configuration();
      this.useConfiguration(config);
      configured = true;
      return { ok: true, value: await this.withAuthSession(session => this.queueCard(session, job,
        page => ({ collect: title => action(page, title), dispose: () => undefined }))) };
    } catch (error) {
      const failure = this.failure(error, 'BROWSER_UNAVAILABLE', HEALTH_ERRORS.BROWSER_UNAVAILABLE, true);
      return { ok: false, disabled: !configured, failure };
    }
  }

  private async openAuthSession(): Promise<AuthSession> {
    const initial = this.configuration();
    const lease = await acquireCrmBrowserSessionLease(initial.statePath);
    try {
      const leased = await lease.readState();
      const config = this.configuration();
      if (leased.rawHash !== config.rawHash) throw new CaptureFailure('SESSION_CONFLICT', HEALTH_ERRORS.SESSION_CONFLICT);
      this.useConfiguration(config);
      const browser = await this.getBrowser(config);
      const context = await browser.newContext({ storageState: config.state, viewport: { width: 1600, height: 1200 },
        deviceScaleFactor: 1, locale: 'ru-RU', acceptDownloads: false });
      return { config, context, lease, rawHash: config.rawHash, tail: Promise.resolve() };
    } catch (error) { await lease.release(); throw error; }
  }

  private async withAuthSession<T>(action: (session: AuthSession) => Promise<T>): Promise<T> {
    if (this.authSessionClosing) await this.authSessionClosing;
    if (this.destroyed) throw new CaptureFailure('WORKER_STOPPING', HEALTH_ERRORS.WORKER_STOPPING, true);
    this.authSessionUsers++;
    const pending = this.authSession ??= this.openAuthSession();
    try { return await action(await pending); }
    finally {
      this.authSessionUsers--;
      if (this.authSessionUsers === 0 && this.authSession === pending) {
        this.authSession = undefined;
        const closing = (async () => {
          const session = await pending.catch(() => undefined);
          if (!session) return;
          await this.closeAuthSession(session);
        })();
        this.authSessionClosing = closing;
        try { await closing; } finally { if (this.authSessionClosing === closing) this.authSessionClosing = undefined; }
      }
    }
  }

  private closeAuthSession(session: AuthSession): Promise<void> {
    return session.closing ??= (async () => {
      // Card finalizers persist rotated cookies before the context is closed or another process acquires the lease.
      try { await session.tail; await session.context.close(); }
      finally { await session.lease.release(); }
    })();
  }

  private async persistSession(session: AuthSession) {
    try {
      const state = await session.context.storageState();
      const saved = await session.lease.saveState(state, session.rawHash);
      session.rawHash = saved.rawHash;
      const current = this.configuration();
      if (current.rawHash !== saved.rawHash || current.origin !== session.config.origin || current.executable !== session.config.executable) {
        throw new CaptureFailure('SESSION_CONFLICT', HEALTH_ERRORS.SESSION_CONFLICT);
      }
      session.config = current;
      this.useConfiguration(current);
    } catch (error) {
      session.invalid = this.failure(error, 'SESSION_CONFLICT', HEALTH_ERRORS.SESSION_CONFLICT);
      throw session.invalid;
    }
  }

  private queueCard<T>(session: AuthSession, job: CrmSourceCardJob,
    createReader: (page: Page) => { collect(title: string): Promise<T>; dispose(): void }): Promise<T> {
    const result = session.tail.then(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await this.readSessionCard(session, job, createReader, attempt === 1); }
        catch (error) {
          if (!(error instanceof CrmSourceAuthExpiredError)) throw error;
          session.sourceAccess = undefined;
          if (attempt === 1) {
            session.invalid = new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED);
            this.health = { status: 'ERROR', checkedAt: new Date().toISOString(), errorCode: 'AUTH_REQUIRED', message: HEALTH_ERRORS.AUTH_REQUIRED };
            throw session.invalid;
          }
        }
      }
      throw new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED);
    });
    session.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async ensureSourceAccess(session: AuthSession, job: CrmSourceCardJob, forceRefresh = false) {
    if (!forceRefresh && session.sourceAccess && Date.now() - session.sourceAccess.verifiedAt < HEALTH_MAX_AGE_MS
      && !await crmBrowserNeedsRefresh(session.context, session.config.origin)) return session.sourceAccess;
    session.sourceAccess = undefined;
    const access = await this.readSessionCard(session, job, page => {
      let mailAccountId: string | null = null, conflict = false;
      const listener = (response: import('playwright-core').Response) => {
        if (response.status() !== 200 || response.request().method() !== 'GET') return;
        let url: URL; try { url = new URL(response.url()); } catch { return; }
        const match = url.pathname.match(/^\/api\/v2\/([1-9]\d{0,19})\/leads\/([1-9]\d{0,19})\/compose$/);
        if (url.origin !== 'https://amomail.amocrm.ru' || url.username || url.password || url.hash || match?.[2] !== job.dealExternalId) return;
        if (mailAccountId && mailAccountId !== match[1]) conflict = true; else mailAccountId = match[1];
      };
      page.on('response', listener);
      return { dispose: () => page.off('response', listener), collect: async () => {
        // readSessionCard has already verified real timeline and compose response schemas for this exact card.
        if (!mailAccountId || conflict) throw new CaptureFailure('SOURCE_NOT_READY', HEALTH_ERRORS.SOURCE_NOT_READY, true);
        const accountValues = await page.evaluate(() => {
          const amo = (window as any).AMOCRM;
          const code = (value: unknown) => typeof value === 'string' && /^[a-zA-Z]{3}$/.test(value) ? value : null;
          let accountCode: unknown = null;
          try { accountCode = amo?.constant?.('account')?.currency; } catch { /* Account authority remains unknown. */ }
          const accountId = amo?.constant?.('account')?.id;
          return { accountCode: code(accountCode), localeCode: code(amo?.system?.locale?.currency),
            accountExternalId: (typeof accountId === 'number' && Number.isSafeInteger(accountId) || typeof accountId === 'string')
              && /^[1-9]\d{0,19}$/.test(String(accountId)) ? String(accountId) : null };
        }).catch(() => ({ accountCode: null, localeCode: null, accountExternalId: null }));
        return { mailAccountId, accountExternalId: accountValues.accountExternalId ?? null,
          currencyValues: { accountCode: accountValues.accountCode, localeCode: accountValues.localeCode },
          currencyObservedAt: new Date().toISOString(), verifiedAt: Date.now() };
      } };
    }, forceRefresh);
    session.sourceAccess = access;
    return access;
  }

  private async readSessionSources<T>(session: AuthSession, job: CrmSourceCardJob,
    createReader: (access: CrmSourceRequestSession) => { collect(): Promise<T>; dispose(): void }): Promise<T> {
    if (this.destroyed) throw new CaptureFailure('WORKER_STOPPING', HEALTH_ERRORS.WORKER_STOPPING, true);
    if (session.invalid) throw session.invalid;
    if (this.configuration().fingerprint !== session.config.fingerprint) throw new CaptureFailure('SESSION_CONFLICT', HEALTH_ERRORS.SESSION_CONFLICT);
    try { validateCrmCaptureUrl(job.sourceUrl, job.dealExternalId, session.config.origin); }
    catch { throw new CaptureFailure('TARGET_INVALID', HEALTH_ERRORS.TARGET_INVALID); }
    for (let attempt = 0; attempt < 2; attempt++) {
      const access = await this.ensureSourceAccess(session, job, attempt === 1);
      let reader: ReturnType<typeof createReader> | undefined, authorized = true;
      try {
        reader = createReader({ context: session.context, origin: session.config.origin, mailAccountId: access.mailAccountId,
          accountExternalId: access.accountExternalId,
          currencyValues: { ...access.currencyValues }, currencyObservedAt: access.currencyObservedAt });
        return await reader.collect();
      } catch (error) {
        if (!(error instanceof CrmSourceAuthExpiredError)) throw error;
        authorized = false;
        session.sourceAccess = undefined;
        if (attempt === 1) {
          session.invalid = new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED);
          this.health = { status: 'ERROR', checkedAt: new Date().toISOString(), errorCode: 'AUTH_REQUIRED', message: HEALTH_ERRORS.AUTH_REQUIRED };
          throw session.invalid;
        }
        // Discard the whole reader: no pagination or message state crosses the native refresh boundary.
      } finally {
        reader?.dispose();
        if (authorized && !session.invalid) {
          const previousHealth = this.currentHealth();
          await this.persistSession(session);
          // Preserve the time of the real native access check; direct reads do not invent a later browser probe.
          this.health = previousHealth.status === 'READY' && previousHealth.checkedAt && Date.parse(previousHealth.checkedAt) > access.verifiedAt
            ? previousHealth : { status: 'READY', checkedAt: new Date(access.verifiedAt).toISOString() };
        }
      }
    }
    throw new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED);
  }

  private async readSessionCard<T>(session: AuthSession, job: CrmSourceCardJob,
    createReader: (page: Page) => { collect(title: string): Promise<T>; dispose(): void }, forceRefresh = false): Promise<T> {
    let page: Page | undefined, reader: ReturnType<typeof createReader> | undefined;
    let access: ReturnType<typeof observeCrmBrowserAccess> | undefined;
    let stage: 'card' | 'action' = 'card', navigationBlocked = false, verified = false;
    try {
      if (this.destroyed) throw new CaptureFailure('WORKER_STOPPING', HEALTH_ERRORS.WORKER_STOPPING, true);
      if (session.invalid) throw session.invalid;
      if (this.configuration().fingerprint !== session.config.fingerprint) throw new CaptureFailure('SESSION_CONFLICT', HEALTH_ERRORS.SESSION_CONFLICT);
      let url: URL;
      try { url = validateCrmCaptureUrl(job.sourceUrl, job.dealExternalId, session.config.origin); }
      catch { throw new CaptureFailure('TARGET_INVALID', HEALTH_ERRORS.TARGET_INVALID); }
      page = await session.context.newPage();
      page.setDefaultTimeout(20_000);
      await page.route('**/*', async route => {
        const request = route.request();
        if (isCrmCollectorChatMutation(request.url(), request.method(), session.config.origin)) {
          await route.abort('blockedbyclient'); return;
        }
        if (request.isNavigationRequest() && request.frame() === page!.mainFrame()) {
          try { validateCrmCaptureUrl(request.url(), job.dealExternalId, session.config.origin); }
          catch { navigationBlocked = true; await route.abort('blockedbyclient'); return; }
        }
        await route.continue();
      });
      reader = createReader(page);
      access = observeCrmBrowserAccess(page, session.config.origin, job.dealExternalId);
      const navigate = async () => {
        const response = await page!.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 35_000 });
        if (!response) throw new CaptureFailure('CARD_UNAVAILABLE', HEALTH_ERRORS.CARD_UNAVAILABLE, true);
        if ([401, 403].includes(response.status())) throw new CaptureFailure('CARD_ACCESS_DENIED', HEALTH_ERRORS.CARD_ACCESS_DENIED);
        if (response.status() >= 400) throw new CaptureFailure('CARD_UNAVAILABLE', HEALTH_ERRORS.CARD_UNAVAILABLE, response.status() === 429 || response.status() >= 500);
        try { validateCrmCaptureUrl(page!.url(), job.dealExternalId, session.config.origin); }
        catch { throw new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED); }
        if (await page!.locator('input[type="password"]').isVisible()) throw new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED);
      };
      await navigate();
      let refreshed = false;
      const refresh = async () => {
        const result = await refreshCrmBrowserAccess(page!);
        if (result !== 'READY') throw new CaptureFailure(result, HEALTH_ERRORS[result], result !== 'AUTH_REQUIRED');
        // Persist rotation immediately even if a subsequent source request is temporarily unavailable.
        await this.persistSession(session);
        session.sourceAccess = undefined;
        refreshed = true;
        access!.reset();
        await navigate();
      };
      if (forceRefresh || await crmBrowserNeedsRefresh(session.context, session.config.origin)) await refresh();
      let sourceAccess = await access.read();
      if (sourceAccess === 'AUTH_REQUIRED' && !refreshed) { await refresh(); sourceAccess = await access.read(); }
      if (sourceAccess !== 'READY') throw new CaptureFailure(sourceAccess, HEALTH_ERRORS[sourceAccess], sourceAccess !== 'AUTH_REQUIRED');

      const title = page.locator('textarea[name="lead[NAME]"]');
      await title.waitFor({ state: 'visible' });
      if (await title.getAttribute('placeholder') !== `Сделка #${job.dealExternalId}` || !(await title.inputValue()).trim()) {
        throw new CaptureFailure('WRONG_CARD', HEALTH_ERRORS.WRONG_CARD);
      }
      await page.locator('#card_holder .js-card-feed').waitFor({ state: 'visible' });
      await page.locator('#card_holder .js-notes').waitFor({ state: 'attached' });
      await page.locator('#lead_card_budget').waitFor({ state: 'visible' });
      verified = true;
      stage = 'action';
      return await reader.collect(await title.inputValue());
    } catch (error) {
      if (error instanceof CrmSourceAuthExpiredError) throw error;
      const failure = navigationBlocked ? new CaptureFailure('AUTH_REQUIRED', HEALTH_ERRORS.AUTH_REQUIRED)
        : this.failure(error, stage === 'card' ? 'CARD_NOT_READY' : 'CAPTURE_FAILED', stage === 'card' ? HEALTH_ERRORS.CARD_NOT_READY : HEALTH_ERRORS.CAPTURE_FAILED, true);
      if (['AUTH_REQUIRED', 'SESSION_CONFLICT', 'SESSION_TRANSFERRED'].includes(failure.code)) session.invalid = failure;
      if (stage !== 'action' && this.fingerprint === session.config.fingerprint) {
        this.health = { status: 'ERROR', checkedAt: new Date().toISOString(), errorCode: failure.code, message: failure.message };
      }
      throw failure;
    } finally {
      reader?.dispose();
      await page?.close().catch(() => undefined);
      const rotated = access?.tokensRotated;
      access?.dispose();
      if (!session.invalid && (verified || rotated)) {
        await this.persistSession(session);
        if (verified && this.fingerprint === session.config.fingerprint) this.health = { status: 'READY', checkedAt: new Date().toISOString() };
      }
    }
  }

  async capture(job: CrmControlCaptureJob): Promise<CrmControlCaptureResult> {
    const result = await this.withCard(job, async (page, currentTitle) => {
      const capturedAt = new Date();
      const capture = await collectCrmEvidenceFrames(page, job, buffer => this.storePng(buffer));
      const limitation = 'Снимки показывают видимые области amoCRM на момент съёмки. Скрытые и свёрнутые записи в кадр не входят; полная история ленты не подтверждена. Исходные данные проверки сохранены отдельно.';
      const manifest: EvidenceManifest = { version: 1, kind: 'crm-control-evidence', observationId: job.observationId, dealExternalId: job.dealExternalId,
        observedAt: job.observedAt ? new Date(job.observedAt).toISOString() : null, snapshotHash: job.snapshotHash ?? null,
        capturedAt: capturedAt.toISOString(), finishedAt: new Date().toISOString(), truncated: capture.truncated,
        limitation, frames: capture.frames, coverage: buildRuleCoverage(job, capture.frames, capture.records) };
      validateEvidenceManifest(manifest, job);
      const buffer = Buffer.from(JSON.stringify(manifest));
      if (buffer.length > MAX_MANIFEST_BYTES) throw new CaptureFailure('INVALID_IMAGE', 'Описание кадров превышает допустимый размер.');
      const manifestHash = createHash('sha256').update(buffer).digest('hex');
      const storageKey = `${manifestHash}.evidence.json`;
      await this.storeBytes(storageKey, buffer);
      return {
        status: 'READY' as const, storageKey, mimeType: 'image/png', sha256: manifest.frames[0].sha256, capturedAt,
        message: `Сохранено кадров: ${manifest.frames.length}. ${limitation}`
          + (job.dealTitle && currentTitle !== job.dealTitle ? ' Название сделки изменилось после проверки.' : ''),
      };
    });
    return result.ok ? result.value : { status: result.disabled ? 'DISABLED' : 'ERROR', errorCode: result.failure.code,
      retryable: result.failure.retryable, message: result.failure.message };
  }

  private failure(error: unknown, code: string, message: string, retryable = false): CaptureFailure {
    if (error instanceof CrmBrowserSessionError) {
      const mapped = error.code === 'CRM_BROWSER_SESSION_BUSY' ? 'SESSION_BUSY' : 'SESSION_CONFLICT';
      return new CaptureFailure(mapped, HEALTH_ERRORS[mapped], mapped === 'SESSION_BUSY');
    }
    return error instanceof CaptureFailure ? error : new CaptureFailure(code, message, retryable);
  }

  async onModuleDestroy() {
    this.destroyed = true;
    const session = await this.authSession?.catch(() => undefined);
    if (session) await this.closeAuthSession(session).catch(() => undefined);
    await this.authSessionClosing?.catch(() => undefined);
    const launching = await this.browserLaunch?.catch(() => undefined);
    await (this.browser ?? launching)?.close().catch(() => undefined);
    this.browser = undefined;
  }

  private async storePng(buffer: Buffer) {
    if (buffer.length < 24 || buffer.length > MAX_EVIDENCE_BYTES || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
      || buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.readUInt32BE(16) < 1 || buffer.readUInt32BE(16) > 4000
      || buffer.readUInt32BE(20) < 1 || buffer.readUInt32BE(20) > 4000) {
      throw new CaptureFailure('INVALID_IMAGE', 'Файл снимка не прошёл проверку целостности.');
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    const storageKey = `${sha256}.png`;
    await this.storeBytes(storageKey, buffer);
    return { storageKey, sha256, width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  private async storeBytes(storageKey: string, buffer: Buffer) {
    await mkdir(this.directory(), { recursive: true, mode: 0o700 });
    try { await writeFile(path.join(this.directory(), storageKey), buffer, { flag: 'wx', mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.readStoredBytes(storageKey);
      if (!existing.equals(buffer)) throw new CaptureFailure('INVALID_IMAGE', 'Файл подтверждения не прошёл проверку целостности.');
    }
  }

  private async readStoredBytes(storageKey: string): Promise<Buffer> {
    const png = EVIDENCE_PNG_KEY.test(storageKey), manifest = EVIDENCE_MANIFEST_KEY.test(storageKey);
    if (!png && !manifest) throw new NotFoundException('Подтверждение не найдено');
    try {
      const filePath = path.join(this.directory(), storageKey);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > (png ? MAX_EVIDENCE_BYTES : MAX_MANIFEST_BYTES)) throw new Error('Invalid file');
      const buffer = await readFile(filePath);
      if ((png && !buffer.subarray(0, 8).equals(PNG_SIGNATURE))
        || createHash('sha256').update(buffer).digest('hex') !== storageKey.slice(0, 64)) throw new Error('Invalid file');
      return buffer;
    } catch {
      throw new NotFoundException('Подтверждение недоступно или повреждено');
    }
  }

  async readManifest(storageKey: string, binding: EvidenceBinding): Promise<EvidenceManifest | null> {
    if (EVIDENCE_PNG_KEY.test(storageKey)) return null;
    try { return validateEvidenceManifest(JSON.parse((await this.readStoredBytes(storageKey)).toString('utf8')), binding); }
    catch { throw new NotFoundException('Описание кадров недоступно или не соответствует проверке'); }
  }

  async read(storageKey: string, binding?: EvidenceBinding): Promise<{ buffer: Buffer; contentType: string }> {
    if (EVIDENCE_PNG_KEY.test(storageKey)) return { buffer: await this.readStoredBytes(storageKey), contentType: 'image/png' };
    if (!binding) throw new NotFoundException('Подтверждение не найдено');
    const manifest = await this.readManifest(storageKey, binding);
    if (!manifest) throw new NotFoundException('Подтверждение не найдено');
    return { buffer: await this.readStoredBytes(manifest.frames[0].storageKey), contentType: 'image/png' };
  }

  async readFrame(storageKey: string, frameId: string, binding: EvidenceBinding): Promise<{ buffer: Buffer; contentType: string }> {
    const manifest = await this.readManifest(storageKey, binding);
    const frame = manifest?.frames.find(item => item.id === frameId);
    if (!frame) throw new NotFoundException('Кадр не найден');
    return { buffer: await this.readStoredBytes(frame.storageKey), contentType: 'image/png' };
  }

  private directory(): string {
    return path.resolve(process.env.CRM_CONTROL_EVIDENCE_DIR || 'outputs/crm-control-evidence');
  }
}
