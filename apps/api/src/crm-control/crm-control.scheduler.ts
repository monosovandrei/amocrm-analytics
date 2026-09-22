import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CrmControlService } from './crm-control.service';
import { CrmControlAnalysisService } from './crm-control-analysis.service';
import { CrmControlAnalysisBatchService } from './crm-control-analysis-batch.service';

@Injectable()
export class CrmControlScheduler {
  private readonly logger = new Logger(CrmControlScheduler.name);
  private checksBusy = false;
  private evidenceBusy = false;
  private analysisBusy = false;
  constructor(private readonly service: CrmControlService, private readonly analysisService: CrmControlAnalysisService,
    private readonly batches?: CrmControlAnalysisBatchService) {}

  @Interval(5_000)
  async enqueueAnalysis() {
    if (!this.enabledWorker()) return;
    try { await this.batches?.processQueue(); }
    catch { this.logger.warn('CRM analysis enqueue interrupted; saved cursor is retained'); }
  }

  private enabledWorker() { return ['all', 'crm-control'].includes(process.env.WORKER_ROLE || 'all'); }

  @Interval(30_000)
  async check() {
    if (!this.enabledWorker() || this.checksBusy) return;
    this.checksBusy = true;
    try { await this.service.schedule(); await this.service.processQueue(); }
    catch { this.logger.warn('CRM control scheduler failed; the persistent queue is retained'); }
    finally { this.checksBusy = false; }
  }

  @Interval(5_000)
  async capture() {
    if (!this.enabledWorker() || this.evidenceBusy) return;
    this.evidenceBusy = true;
    try { await this.service.processEvidenceQueue(); }
    catch { this.logger.warn('CRM evidence scheduler failed; the persistent queue is retained'); }
    finally { this.evidenceBusy = false; }
  }

  @Interval(5_000)
  async analyze() {
    if (!this.enabledWorker() || this.analysisBusy) return;
    this.analysisBusy = true;
    try { await this.analysisService.processQueue(); }
    catch { this.logger.warn('CRM analysis scheduler failed; the persistent queue is retained'); }
    finally { this.analysisBusy = false; }
  }
}
