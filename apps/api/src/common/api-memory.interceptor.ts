import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { finalize } from 'rxjs/operators';

const MB = 1024 * 1024;

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
        const rssDeltaMb = Math.round((after.rss - before.rss) / MB);
        const rssMb = Math.round(after.rss / MB);
        const heapMb = Math.round(after.heapUsed / MB);
        const externalMb = Math.round(after.external / MB);
        const shouldLog =
          durationMs >= 1000 ||
          Math.abs(rssDeltaMb) >= 16 ||
          this.isTrackedRoute(url) ||
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
