import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CrmControlService } from './crm-control.service';

@Injectable()
export class CrmControlScheduler {
  private readonly logger = new Logger(CrmControlScheduler.name);
  private checksBusy = false;
  private evidenceBusy = false;
  constructor(private readonly service: CrmControlService) {}

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
}
