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

  @Interval(15_000)
  async processReportCacheRefreshJobs() {
    if (this.cacheRefreshBusy) return;
    this.cacheRefreshBusy = true;
    try {
      await this.reports.processReportCacheRefreshJobs(1);
    } catch (error: any) {
      this.logger.warn(`Report cache refresh jobs failed: ${error.message}`);
    } finally {
      this.cacheRefreshBusy = false;
    }
  }
}
