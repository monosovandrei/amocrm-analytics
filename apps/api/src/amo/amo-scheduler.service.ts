import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { SyncJobType } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { AmoSyncService } from './amo-sync.service';

@Injectable()
export class AmoSchedulerService {
  private readonly logger = new Logger(AmoSchedulerService.name);
  private webhookBusy = false;
  private webhookSubscriptionBusy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: AmoSyncService,
    private readonly config: ConfigService,
  ) {}

  @Interval(60_000)
  async tick() {
    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection) return;
    const syncIntervalMinutes = this.getSyncIntervalMinutes();
    if (syncIntervalMinutes <= 0) return;
    await this.sync.expireStaleJobs(connection.id);

    const lastSync = connection.lastIncrementalSyncAt ?? connection.lastFullSyncAt;
    const syncType = lastSync ? SyncJobType.INCREMENTAL : SyncJobType.FULL;
    const due = !lastSync || Date.now() - lastSync.getTime() >= syncIntervalMinutes * 60_000;
    if (!due) return;

    const running = await this.prisma.syncJob.count({
      where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running > 0) return;

    try {
      await this.sync.trigger(syncType);
    } catch (error: any) {
      this.logger.warn(`Scheduled amoCRM sync failed: ${error.message}`);
    }
  }

  @Interval(5_000)
  async processWebhookQueue() {
    if (this.webhookBusy) return;
    this.webhookBusy = true;
    try {
      const connection = await this.prisma.amoConnection.findFirst({
        where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!connection) return;

      const pending = await this.prisma.webhookEvent.count({
        where: {
          connectionId: connection.id,
          processedAt: null,
          status: { in: ['received', 'error'] },
        },
      });
      if (pending === 0) return;

      await this.sync.triggerWebhookQueue();
    } catch (error: any) {
      this.logger.warn(`Webhook amoCRM queue processing failed: ${error.message}`);
    } finally {
      this.webhookBusy = false;
    }
  }

  @Interval(60_000)
  async ensureWebhookSubscription() {
    if (this.webhookSubscriptionBusy) return;
    const checkIntervalMinutes = this.getWebhookSubscriptionCheckMinutes();
    if (checkIntervalMinutes <= 0) return;

    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection) return;

    const lastEnsuredAt = this.getConfigDate(connection.config, 'webhookEnsuredAt');
    const due = !lastEnsuredAt || Date.now() - lastEnsuredAt.getTime() >= checkIntervalMinutes * 60_000;
    if (!due) return;

    this.webhookSubscriptionBusy = true;
    try {
      await this.sync.ensureWebhookRegistered();
    } catch (error: any) {
      this.logger.warn(`amoCRM webhook subscription check failed: ${error.message}`);
    } finally {
      this.webhookSubscriptionBusy = false;
    }
  }

  private getSyncIntervalMinutes() {
    const rawInterval = this.config.get<string>('AMOCRM_SYNC_INTERVAL_MINUTES');
    if (!rawInterval) return 0;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private getWebhookSubscriptionCheckMinutes() {
    const rawInterval = this.config.get<string>('AMOCRM_WEBHOOK_SUBSCRIPTION_CHECK_MINUTES');
    if (!rawInterval) return 10;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 10;
  }

  private getConfigDate(config: unknown, key: string) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const raw = (config as Record<string, unknown>)[key];
    if (typeof raw !== 'string') return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
