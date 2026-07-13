import { Injectable, Logger } from '@nestjs/common';
import { AmoCredentials } from './amo.types';

interface AmoClientOptions {
  domain: string;
  credentials: AmoCredentials;
  onCredentialsChanged?: (credentials: AmoCredentials) => Promise<void>;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
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

  constructor(private readonly options: AmoClientOptions) {}

  get domain() {
    return this.options.domain;
  }

  async get<T = any>(path: string, params?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('GET', path, undefined, params);
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
  ): Promise<T> {
    await this.ensureFreshToken();

    const url = this.buildUrl(path, params);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.waitForRateLimit();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.options.credentials.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error: any) {
        if (attempt < 3) {
          await this.sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        throw new Error(`amoCRM API request timed out or failed: ${method} ${path}: ${error.message}`);
      } finally {
        clearTimeout(timeout);
      }

      if (res.status === 204) return null as T;
      if (res.status === 401 && attempt === 0) {
        await this.refreshToken();
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after') || 0);
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, attempt));
        continue;
      }
      if (!res.ok) {
        throw new Error(`amoCRM API ${res.status}: ${await res.text()}`);
      }

      const text = await res.text();
      return text ? (JSON.parse(text) as T) : (null as T);
    }

    throw new Error(`amoCRM API request failed after retries: ${method} ${path}`);
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let res: Awaited<ReturnType<typeof fetch>>;
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
    } catch (error: any) {
      throw new Error(`Не удалось обновить amoCRM token: request timed out or failed: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      throw new Error(`Не удалось обновить amoCRM token: ${res.status} ${await res.text()}`);
    }
    const tokens = await res.json();
    this.options.credentials.accessToken = tokens.access_token;
    this.options.credentials.refreshToken = tokens.refresh_token;
    this.options.credentials.expiresAt = Date.now() + Number(tokens.expires_in) * 1000;
    await this.options.onCredentialsChanged?.(this.options.credentials);
  }

  private async waitForRateLimit() {
    const minDelayMs = 160;
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < minDelayMs) {
      await this.sleep(minDelayMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
