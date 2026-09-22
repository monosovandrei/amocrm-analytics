import { Injectable, Logger } from '@nestjs/common';
import { AmoCredentials } from './amo.types';

interface AmoClientOptions {
  domain: string;
  credentials: AmoCredentials;
  onCredentialsChanged?: (credentials: AmoCredentials) => Promise<void>;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  minRequestIntervalMs?: number;
}

export class AmoRequestError extends Error {
  constructor(message: string, readonly transient: boolean, readonly status?: number) { super(message); }
}

@Injectable()
export class AmoClientFactory {
  create(options: AmoClientOptions) {
    return new AmoClient(options);
  }
}

export class AmoClient {
  private readonly logger = new Logger(AmoClient.name);
  private lastRequestAt = 0;
  private rateLimitQueue: Promise<void> = Promise.resolve();
  private refreshInFlight: Promise<void> | null = null;
  private pausedUntil = 0;

  constructor(private readonly options: AmoClientOptions) {}

  get domain() {
    return this.options.domain;
  }

  async get<T = any>(path: string, params?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('GET', path, undefined, params);
  }

  async getDrive<T = any>(driveOrigin: string, path: string, options: { signal?: AbortSignal } = {}) {
    const origin = new URL(driveOrigin);
    if (!/^https:\/\/drive(?:-[a-z0-9]+)?\.(?:amocrm\.ru|amocrm\.com|kommo\.com)\/?$/i.test(driveOrigin)
      || origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/'
      || origin.search || origin.hash || !/^drive(?:-[a-z0-9]+)?\.(?:amocrm\.ru|amocrm\.com|kommo\.com)$/.test(origin.hostname)) {
      throw new Error('Недопустимый адрес файлового API amoCRM');
    }
    const url = new URL(path, origin);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== origin.origin || url.username || url.password || url.hash
      || !/^\/v1\.0\/files(?:\/|$)/.test(url.pathname)) throw new Error('Недопустимый путь файлового API amoCRM');
    return this.request<T>('GET', path, undefined, undefined, url.toString(), options.signal);
  }

  async post<T = any>(path: string, body: unknown) {
    return this.request<T>('POST', path, body);
  }

  async paginate<T = any>(
    path: string,
    embeddedKey: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const result: T[] = [];
    let page = 1;
    const limit = params.limit ?? 250;

    while (true) {
      const data = await this.get<any>(path, { ...params, page, limit });
      const items = data?._embedded?.[embeddedKey] ?? [];
      if (!Array.isArray(items) || items.length === 0) break;
      result.push(...items);
      if (!data?._links?.next?.href) break;
      page += 1;
    }

    return result;
  }

  async paginateBatch<T = any>(
    path: string,
    embeddedKey: string,
    params: Record<string, string | number | boolean | undefined>,
    onBatch: (items: T[], page: number) => Promise<void>,
  ): Promise<void> {
    let page = 1;
    const limit = params.limit ?? 250;

    while (true) {
      const data = await this.get<any>(path, { ...params, page, limit });
      const items = data?._embedded?.[embeddedKey] ?? [];
      if (!Array.isArray(items) || items.length === 0) break;
      await onBatch(items as T[], page);
      if (!data?._links?.next?.href) break;
      page += 1;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    params?: Record<string, string | number | boolean | undefined>,
    driveUrl?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const url = driveUrl ?? this.buildUrl(path, params);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      await this.waitForRateLimit(signal);
      signal?.throwIfAborted();
      const controller = new AbortController();
      const abortRequest = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abortRequest, { once: true });
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let res: Awaited<ReturnType<typeof fetch>>;
      let responseText: string;
      const usedAccessToken = this.options.credentials.accessToken;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${usedAccessToken}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          ...(driveUrl ? { redirect: 'error' as const } : {}),
        });
        // Keep the timeout active while reading the response body as well as its headers.
        responseText = await res.text();
      } catch (error: any) {
        signal?.throwIfAborted();
        if (attempt < 3) {
          await this.sleep(1000 * Math.pow(2, attempt), signal);
          continue;
        }
        throw new AmoRequestError(`amoCRM API request timed out or failed: ${method} ${path}`, true);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortRequest);
      }

      signal?.throwIfAborted();
      if (res.status === 204) return null as T;
      if (res.status === 401 && attempt === 0) {
        if (usedAccessToken === this.options.credentials.accessToken) await this.abortable(this.refreshToken(), signal);
        signal?.throwIfAborted();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after');
        const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
        const serverDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter ?? '') - Date.now();
        const delay = Math.min(60_000, Math.max(1000 * 2 ** attempt, Number.isFinite(serverDelay) ? serverDelay : 0));
        if (res.status === 429) this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay);
        if (attempt === 3) break;
        await this.sleep(delay, signal);
        continue;
      }
      if (!res.ok) {
        throw new AmoRequestError(`amoCRM API ${res.status}: ${responseText}`, false, res.status);
      }

      return responseText ? (JSON.parse(responseText) as T) : (null as T);
    }

    throw new AmoRequestError(`amoCRM API request failed after retries: ${method} ${path}`, true);
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>) {
    const url = new URL(path.startsWith('/api/v4') ? path : `/api/v4${path}`, `https://${this.options.domain}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async ensureFreshToken() {
    if (Date.now() < this.options.credentials.expiresAt - 60_000) return;
    await this.refreshToken();
  }

  private async refreshToken() {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.performTokenRefresh().finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  private async performTokenRefresh() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Awaited<ReturnType<typeof fetch>>;
    let responseText: string;
    try {
      res = await fetch(`https://${this.options.domain}/oauth2/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: this.options.credentials.refreshToken,
          redirect_uri: this.options.redirectUri,
        }),
        signal: controller.signal,
      });
      responseText = await res.text();
    } catch (error: any) {
      throw new Error(`Не удалось обновить amoCRM token: request timed out or failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      throw new Error(`Не удалось обновить amoCRM token: ${res.status} ${responseText}`);
    }
    const tokens = JSON.parse(responseText);
    this.options.credentials.accessToken = tokens.access_token;
    this.options.credentials.refreshToken = tokens.refresh_token;
    this.options.credentials.expiresAt = Date.now() + Number(tokens.expires_in) * 1000;
    await this.options.onCredentialsChanged?.(this.options.credentials);
  }

  private waitForRateLimit(signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Reserving a slot must itself be serial: concurrent requests cannot wake on the same slot.
    const interval = this.options.minRequestIntervalMs ?? 160;
    const minDelayMs = Number.isFinite(interval) ? Math.max(160, interval) : 160;
    const slot = this.rateLimitQueue.then(async () => {
      while (true) {
        signal?.throwIfAborted();
        const delay = Math.max(this.lastRequestAt + minDelayMs, this.pausedUntil) - Date.now();
        if (delay > 0) await this.sleep(delay, signal);
        else {
          // Refresh after any cooldown; a slow refresh must not release a burst of requests.
          await this.abortable(this.ensureFreshToken(), signal);
          signal?.throwIfAborted();
          if (this.pausedUntil <= Date.now()) break;
        }
      }
      this.lastRequestAt = Date.now();
    });
    this.rateLimitQueue = slot.catch(() => undefined);
    return this.abortable(slot, signal);
  }

  private abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return pending;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private sleep(ms: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
