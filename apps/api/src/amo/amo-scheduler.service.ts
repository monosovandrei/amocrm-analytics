import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { SyncJobType } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { AmoSyncService } from './amo-sync.service';

@Injectable()
export class AmoSchedulerService {
  private readonly logger = new Logger(AmoSchedulerService.name);
  private pullSyncBusy = false;
  private webhookBusy = false;
  private webhookSubscriptionBusy = false;
  private emailNotesBusy = false;
  private recentReconcileBusy = false;
  private leadSlaReconcileBusy = false;
  private crmStateNotificationsBusy = false;
  private lastCrmStateNotificationsAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: AmoSyncService,
    private readonly config: ConfigService,
  ) {}

  @Interval(60_000)
  async tick() {
    if (!this.runsSyncWorker()) return;
    if (this.pullSyncBusy) return;
    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection) return;
    await this.sync.expireStaleJobs(connection.id);

    const queuedPullJob = await this.prisma.syncJob.findFirst({
      where: {
        connectionId: connection.id,
        type: { not: SyncJobType.WEBHOOK },
        status: 'QUEUED',
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, type: true },
    });
    if (queuedPullJob) {
      this.pullSyncBusy = true;
      try {
        await this.sync.run(queuedPullJob.id);
      } catch (error: any) {
        this.logger.warn(`Queued amoCRM ${queuedPullJob.type} sync failed: ${error.message}`);
      } finally {
        this.pullSyncBusy = false;
      }
      return;
    }

    const syncIntervalMinutes = this.getSyncIntervalMinutes();
    if (syncIntervalMinutes <= 0) return;

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
    if (!this.runsSyncWorker()) return;
    if (this.webhookBusy) return;
    this.webhookBusy = true;
    try {
      const connection = await this.prisma.amoConnection.findFirst({
        where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!connection) return;

      const pending = await this.prisma.rawAmoEventInbox.count({
        where: {
          connectionId: connection.id,
          appliedAt: null,
          status: { in: ['received', 'error'] },
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: new Date() } },
          ],
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
  async syncRecentEmailNotes() {
    if (!this.runsSyncWorker()) return;
    if (this.emailNotesBusy) return;
    const intervalSeconds = this.getEmailNotesSyncIntervalSeconds();
    if (intervalSeconds <= 0) return;

    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection?.lastFullSyncAt) return;

    const lastSyncedAt = this.getConfigDate(connection.config, 'emailNotesSyncedAt');
    const due = !lastSyncedAt || Date.now() - lastSyncedAt.getTime() >= intervalSeconds * 1000;
    if (!due) return;

    this.emailNotesBusy = true;
    try {
      await this.sync.syncRecentEmailNotes();
    } catch (error: any) {
      this.logger.warn(`Recent amoCRM email notes sync failed: ${error.message}`);
    } finally {
      this.emailNotesBusy = false;
    }
  }

  @Interval(60_000)
  async reconcileRecentAmoChanges() {
    if (!this.runsSyncWorker()) return;
    if (this.recentReconcileBusy) return;
    const intervalSeconds = this.getRecentReconcileIntervalSeconds();
    if (intervalSeconds <= 0) return;

    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection?.lastFullSyncAt) return;

    const lastReconciledAt = this.getConfigDate(connection.config, 'recentReconcileAt');
    const due = !lastReconciledAt || Date.now() - lastReconciledAt.getTime() >= intervalSeconds * 1000;
    if (!due) return;

    await this.sync.expireStaleJobs(connection.id);
    const running = await this.prisma.syncJob.count({
      where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running > 0) return;

    this.recentReconcileBusy = true;
    try {
      await this.sync.reconcileRecentChanges();
    } catch (error: any) {
      this.logger.warn(`Recent amoCRM reconcile failed: ${error.message}`);
    } finally {
      this.recentReconcileBusy = false;
    }
  }

  @Interval(60_000)
  async reconcileLeadSlaCandidates() {
    if (!this.runsSyncWorker()) return;
    if (this.leadSlaReconcileBusy) return;
    const intervalSeconds = this.getLeadSlaReconcileIntervalSeconds();
    if (intervalSeconds <= 0) return;

    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection?.lastFullSyncAt) return;

    const lastReconciledAt = this.getConfigDate(connection.config, 'leadSlaReconcileAt');
    const due = !lastReconciledAt || Date.now() - lastReconciledAt.getTime() >= intervalSeconds * 1000;
    if (!due) return;

    const running = await this.prisma.syncJob.count({
      where: { connectionId: connection.id, status: 'RUNNING' },
    });
    if (running > 0) return;

    this.leadSlaReconcileBusy = true;
    try {
      await this.sync.reconcileLeadSlaCandidates();
    } catch (error: any) {
      this.logger.warn(`Lead SLA amoCRM reconcile failed: ${error.message}`);
    } finally {
      this.leadSlaReconcileBusy = false;
    }
  }

  @Interval(60_000)
  async ensureWebhookSubscription() {
    if (!this.runsSyncWorker()) return;
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

  @Interval(60_000)
  async processCrmStateNotifications() {
    if (!this.runsNotificationWorker()) return;
    if (this.crmStateNotificationsBusy) return;
    const intervalSeconds = this.getCrmStateNotificationsIntervalSeconds();
    if (intervalSeconds <= 0) return;
    if (Date.now() - this.lastCrmStateNotificationsAt < intervalSeconds * 1000) return;

    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: { in: ['ACTIVE', 'ERROR', 'SYNCING'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection?.lastFullSyncAt) return;

    this.crmStateNotificationsBusy = true;
    try {
      await this.sync.processCrmStateNotifications();
      this.lastCrmStateNotificationsAt = Date.now();
    } catch (error: any) {
      this.logger.warn(`CRM state notifications failed: ${error.message}`);
    } finally {
      this.crmStateNotificationsBusy = false;
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

  private getEmailNotesSyncIntervalSeconds() {
    const rawInterval = this.config.get<string>('AMOCRM_EMAIL_NOTES_SYNC_INTERVAL_SECONDS');
    if (!rawInterval) return 0;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private getRecentReconcileIntervalSeconds() {
    const rawInterval = this.config.get<string>('AMOCRM_RECENT_RECONCILE_INTERVAL_SECONDS');
    if (!rawInterval) return 0;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private getLeadSlaReconcileIntervalSeconds() {
    const rawInterval = this.config.get<string>('AMOCRM_LEAD_SLA_RECONCILE_INTERVAL_SECONDS');
    if (!rawInterval) return 60;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 60;
  }

  private getCrmStateNotificationsIntervalSeconds() {
    const rawInterval = this.config.get<string>('AMOCRM_CRM_STATE_NOTIFICATIONS_INTERVAL_SECONDS');
    if (!rawInterval) return 300;

    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 300;
  }

  private getConfigDate(config: unknown, key: string) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
    const raw = (config as Record<string, unknown>)[key];
    if (typeof raw !== 'string') return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private workerRole() {
    return process.env.WORKER_ROLE || 'all';
  }

  private runsSyncWorker() {
    const role = this.workerRole();
    return role === 'all' || role === 'sync' || role === 'bootstrap';
  }

  private runsNotificationWorker() {
    const role = this.workerRole();
    return role === 'all' || role === 'notification';
  }
}
