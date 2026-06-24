import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PlatformService } from './platform.service';
import { TelegramService } from './telegram.service';

@Injectable()
export class PlatformSchedulerService {
  private readonly logger = new Logger(PlatformSchedulerService.name);
  private telegramBusy = false;
  private jobsBusy = false;

  constructor(
    private readonly platform: PlatformService,
    private readonly telegram: TelegramService,
  ) {}

  @Interval(30_000)
  async syncTelegramUpdates() {
    if (this.telegramBusy) return;
    this.telegramBusy = true;
    try {
      await this.telegram.processUpdates();
    } catch (error: any) {
      this.logger.warn(`Telegram update processing failed: ${error.message}`);
    } finally {
      this.telegramBusy = false;
    }
  }

  @Interval(60_000)
  async processPlatformJobs() {
    if (this.jobsBusy) return;
    this.jobsBusy = true;
    try {
      await this.platform.runAlertChecks();
      await this.platform.processSchedules();
    } catch (error: any) {
      this.logger.warn(`Platform jobs failed: ${error.message}`);
    } finally {
      this.jobsBusy = false;
    }
  }
}
