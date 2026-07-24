import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs/operators';

const MB = 1024 * 1024;
const API_METRICS_WINDOW_MS = 5 * 60_000;
const API_METRICS_MAX_SAMPLES = 2_000;

type ApiRequestMetric = {
  at: number;
  durationMs: number;
  url: string;
};

export class ApiRuntimeMetrics {
  private static readonly requests: ApiRequestMetric[] = [];

  static record(durationMs: number, url: string) {
    const now = Date.now();
    this.requests.push({ at: now, durationMs, url });
    this.trim(now);
  }

  static snapshot() {
    const now = Date.now();
    this.trim(now);
    const durations = this.requests.map((item) => item.durationMs).sort((a, b) => a - b);
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
    const slow = this.requests
      .filter((item) => item.durationMs >= 3_000)
      .slice(-10)
      .map((item) => ({ url: item.url, durationMs: item.durationMs, at: new Date(item.at).toISOString() }));
    return {
      windowSeconds: Math.floor(API_METRICS_WINDOW_MS / 1000),
      requestCount: durations.length,
      p95Ms: p95,
      slow,
    };
  }

  private static trim(now: number) {
    while (this.requests.length && now - this.requests[0].at > API_METRICS_WINDOW_MS) {
      this.requests.shift();
    }
    if (this.requests.length > API_METRICS_MAX_SAMPLES) {
      this.requests.splice(0, this.requests.length - API_METRICS_MAX_SAMPLES);
    }
  }
}

@Injectable()
export class ApiMemoryInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ApiMemoryInterceptor.name);
  private lastHighRssLogAt = 0;

  intercept(context: ExecutionContext, next: CallHandler): any {
    const request = context.switchToHttp().getRequest<{ method?: string; url?: string; raw?: { url?: string } }>();
    const method = request.method ?? 'HTTP';
    const url = request.url ?? request.raw?.url ?? '';
    const startedAt = Date.now();
    const before = process.memoryUsage();

    return (next.handle() as any).pipe(
      finalize(() => {
        const durationMs = Date.now() - startedAt;
        const after = process.memoryUsage();
        ApiRuntimeMetrics.record(durationMs, url);
        const rssDeltaMb = Math.round((after.rss - before.rss) / MB);
        const rssMb = Math.round(after.rss / MB);
        const heapMb = Math.round(after.heapUsed / MB);
        const externalMb = Math.round(after.external / MB);
        const trackedRoute = this.isTrackedRoute(url);
        const shouldLog =
          durationMs >= 1000 ||
          Math.abs(rssDeltaMb) >= 16 ||
          (trackedRoute && (durationMs >= 250 || Math.abs(rssDeltaMb) >= 12)) ||
          this.shouldSampleHighRss(rssMb);

        if (shouldLog) {
          this.logger.warn(
            `${method} ${url} ${durationMs}ms rss=${rssMb}MB heap=${heapMb}MB external=${externalMb}MB rssDelta=${rssDeltaMb}MB`,
          );
        }

        if (this.shouldCompact(url, durationMs, rssMb, rssDeltaMb)) {
          setImmediate(() => {
            const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
            if (typeof gc === 'function') gc();
          });
        }
      }),
    );
  }

  private shouldCompact(url: string, durationMs: number, rssMb: number, rssDeltaMb: number) {
    if (process.env.API_FORCE_GC_AFTER_HEAVY_REQUESTS === '0') return false;
    return (
      rssDeltaMb >= 128 ||
      (durationMs >= 1000 && this.isTrackedRoute(url)) ||
      (rssMb >= 1200 && this.isTrackedRoute(url))
    );
  }

  private isTrackedRoute(url: string) {
    return (
      url.includes('/reports/') ||
      url.includes('/settings/options') ||
      url.includes('/platform/email-threads') ||
      url.includes('/platform/lead-sla')
    );
  }

  private shouldSampleHighRss(rssMb: number) {
    if (rssMb < 900) return false;
    const now = Date.now();
    if (now - this.lastHighRssLogAt < 60_000) return false;
    this.lastHighRssLogAt = now;
    return true;
  }
}
