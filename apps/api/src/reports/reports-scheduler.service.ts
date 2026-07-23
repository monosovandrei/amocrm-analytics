import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ReportsService } from './reports.service';

@Injectable()
export class ReportsSchedulerService {
  private readonly logger = new Logger(ReportsSchedulerService.name);
  private exportBusy = false;
  private cacheRefreshBusy = false;

  constructor(private readonly reports: ReportsService) {}

  @Interval(10_000)
  async processExportJobs() {
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
    if (this.cacheRefreshBusy) return;
    this.cacheRefreshBusy = true;
    try {
      const stale = await this.reports.enqueueStaleReportCacheRefreshJobs(this.resolveStaleQueueBatchSize());
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
    const value = Number(process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
  }

  private resolveRefreshBatchSize() {
    const value = Number(process.env.REPORT_CACHE_REFRESH_BATCH_SIZE);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
  }
}
