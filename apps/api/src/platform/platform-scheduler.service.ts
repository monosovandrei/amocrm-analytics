import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PlatformService } from './platform.service';
import { TelegramService } from './telegram.service';
import { DataQualityService } from '../quality/data-quality.service';

@Injectable()
export class PlatformSchedulerService {
  private readonly logger = new Logger(PlatformSchedulerService.name);
  private telegramBusy = false;
  private jobsBusy = false;
  private qualityNotificationsBusy = false;

  constructor(
    private readonly platform: PlatformService,
    private readonly telegram: TelegramService,
    private readonly quality: DataQualityService,
  ) {}

  @Interval(30_000)
  async syncTelegramUpdates() {
    if (!this.runsNotificationWorker()) return;
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
  async processQualityNotifications() {
    if (!this.runsNotificationWorker() || this.qualityNotificationsBusy) return;
    this.qualityNotificationsBusy = true;
    try {
      const due = await this.quality.notificationsDue();
      for (const incident of due.incidents) {
        const deliveries = await this.telegram.sendMessageToUsers(
          due.ownerUserIds,
          this.quality.notificationText(incident),
          { type: 'data-quality-incident', incidentId: incident.id, status: incident.status },
          undefined,
          `data-quality:${incident.id}:${incident.status}:${incident.notificationCount}`,
        );
        if (deliveries.some((delivery) => delivery.status === 'SENT')) {
          await this.quality.markNotified(incident.id, incident.status === 'RESOLVED');
        }
      }
    } catch (error: any) {
      this.logger.warn(`Data quality notifications failed: ${error.message}`);
    } finally {
      this.qualityNotificationsBusy = false;
    }
  }

  @Interval(60_000)
  async processPlatformJobs() {
    if (!this.runsNotificationWorker()) return;
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

  private runsNotificationWorker() {
    const role = process.env.WORKER_ROLE || 'all';
    return role === 'all' || role === 'notification';
  }
}
