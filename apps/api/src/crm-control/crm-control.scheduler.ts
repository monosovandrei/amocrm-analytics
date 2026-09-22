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
  private stopping = false;
  private readonly active = new Set<Promise<void>>();
  private draining?: Promise<void>;
  constructor(private readonly service: CrmControlService, private readonly analysisService: CrmControlAnalysisService,
    private readonly batches?: CrmControlAnalysisBatchService) {}

  @Interval(5_000)
  async enqueueAnalysis() {
    if (!this.enabledWorker()) return;
    await this.track(async () => { await this.batches?.processQueue(); }, 'CRM analysis enqueue interrupted; saved cursor is retained');
  }

  private enabledWorker() { return !this.stopping && ['all', 'crm-control'].includes(process.env.WORKER_ROLE || 'all'); }

  /** Called before Nest closes Prisma/browser providers. New interval callbacks become no-ops immediately. */
  drain(): Promise<void> {
    this.stopping = true;
    return this.draining ??= Promise.all([...this.active]).then(() => undefined);
  }

  private async track(action: () => Promise<void>, failure: string) {
    const pending = (async () => {
      try { await action(); } catch { this.logger.warn(failure); }
    })();
    this.active.add(pending);
    try { await pending; } finally { this.active.delete(pending); }
  }

  @Interval(30_000)
  async check() {
    if (!this.enabledWorker() || this.checksBusy) return;
    this.checksBusy = true;
    try { await this.track(async () => {
      await this.service.schedule();
      if (!this.stopping) await this.service.processQueue();
    }, 'CRM control scheduler failed; the persistent queue is retained'); }
    finally { this.checksBusy = false; }
  }

  @Interval(5_000)
  async capture() {
    if (!this.enabledWorker() || this.evidenceBusy) return;
    this.evidenceBusy = true;
    try { await this.track(() => this.service.processEvidenceQueue(), 'CRM evidence scheduler failed; the persistent queue is retained'); }
    finally { this.evidenceBusy = false; }
  }

  @Interval(5_000)
  async analyze() {
    if (!this.enabledWorker() || this.analysisBusy) return;
    this.analysisBusy = true;
    try { await this.track(() => this.analysisService.processQueue(), 'CRM analysis scheduler failed; the persistent queue is retained'); }
    finally { this.analysisBusy = false; }
  }
}
