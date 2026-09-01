import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataQualityService } from './data-quality.service';

@Injectable()
export class DataQualitySchedulerService implements OnModuleInit {
  private readonly logger = new Logger(DataQualitySchedulerService.name);
  private busy = false;

  constructor(private readonly quality: DataQualityService) {}

  onModuleInit() {
    setTimeout(() => void this.evaluate(), 15_000);
  }

  @Interval(60_000)
  async evaluate() {
    const role = process.env.WORKER_ROLE || 'all';
    if (role !== 'all' && role !== 'sync') return;
    if (this.busy) return;
    this.busy = true;
    try {
      await this.quality.evaluate();
    } catch (error: any) {
      this.logger.error(`Data quality evaluation failed: ${error.message}`, error.stack);
    } finally {
      this.busy = false;
    }
  }
}
