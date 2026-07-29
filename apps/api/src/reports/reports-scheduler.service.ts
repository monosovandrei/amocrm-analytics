import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReportsService } from './reports.service';

const DEFAULT_STALE_QUEUE_BATCH_SIZE = 3;
const DEFAULT_REFRESH_BATCH_SIZE = 8;
const DEFAULT_REFRESH_INTERVAL_MS = 10_000;

@Injectable()
export class ReportsSchedulerService {
  private readonly logger = new Logger(ReportsSchedulerService.name);
  private exportBusy = false;
  private cacheRefreshBusy = false;
  private nextCacheRefreshAt = 0;

  constructor(private readonly reports: ReportsService) {}

  @Interval(10_000)
  async processExportJobs() {
    if (!this.runsWorkerRole('export')) return;
    if (this.exportBusy) return;
    this.exportBusy = true;
    try {
      await this.reports.processExportJobs(1);
    } catch (error: any) {
      this.logger.warn(`Report export jobs failed: ${error.message}`);
    } finally {
      this.exportBusy = false;
    }
  }

  @Interval(10_000)
  async processReportCacheRefreshJobs() {
    if (!this.runsWorkerRole('report')) return;
    const now = Date.now();
    if (now < this.nextCacheRefreshAt) return;
    if (this.cacheRefreshBusy) return;
    this.cacheRefreshBusy = true;
    this.nextCacheRefreshAt = now + this.resolveRefreshIntervalMs();
    try {
      const staleQueueBatchSize = this.resolveStaleQueueBatchSize();
      const stale =
        staleQueueBatchSize > 0
          ? await this.reports.enqueueStaleReportCacheRefreshJobs(staleQueueBatchSize)
          : { queued: 0 };
      const refreshed = await this.reports.processReportCacheRefreshJobs(this.resolveRefreshBatchSize());
      if (stale.queued || refreshed.processed) {
        this.logger.log(`Report cache refresh: queued=${stale.queued}, processed=${refreshed.processed}`);
      }
    } catch (error: any) {
      this.logger.warn(`Report cache refresh jobs failed: ${error.message}`);
    } finally {
      this.cacheRefreshBusy = false;
    }
  }

  private resolveStaleQueueBatchSize() {
    const raw = process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;
    if (raw === undefined || raw.trim() === '') return DEFAULT_STALE_QUEUE_BATCH_SIZE;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_STALE_QUEUE_BATCH_SIZE;
  }

  private resolveRefreshBatchSize() {
    const raw = process.env.REPORT_CACHE_REFRESH_BATCH_SIZE;
    if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_BATCH_SIZE;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_REFRESH_BATCH_SIZE;
  }

  private resolveRefreshIntervalMs() {
    const raw = process.env.REPORT_CACHE_REFRESH_INTERVAL_MS;
    if (raw === undefined || raw.trim() === '') return DEFAULT_REFRESH_INTERVAL_MS;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 10_000 ? Math.floor(value) : DEFAULT_REFRESH_INTERVAL_MS;
  }

  private runsWorkerRole(role: 'report' | 'export') {
    const current = process.env.WORKER_ROLE || 'all';
    return current === 'all' || current === role;
  }
}
