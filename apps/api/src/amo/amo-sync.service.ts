import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmoConnection, Prisma, SyncJobType } from '../generated/prisma';
import { toDateFromAmoTimestamp } from '../common/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { AmoClient } from './amo-client';
import { AmoService } from './amo.service';
import { AmoSyncMaps } from './amo.types';
import { AuditService } from '../audit/audit.service';
import { CrmEventNotificationsService } from '../platform/crm-event-notifications.service';
import { PlatformService } from '../platform/platform.service';

type SyncJobWithConnection = Prisma.SyncJobGetPayload<{ include: { connection: true } }>;
type WebhookEventGroup = {
  ids: string[];
  entity: string;
  externalId: string | null;
  actions: string[];
  payloads: Prisma.JsonValue[];
};

const WEBHOOK_EVENT_BATCH_SIZE = 100;

@Injectable()
export class AmoSyncService {
  private static readonly DEFAULT_STALE_SYNC_JOB_MS = 6 * 60 * 60 * 1000;
  private readonly logger = new Logger(AmoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly amo: AmoService,
    private readonly audit: AuditService,
    private readonly crmEventNotifications: CrmEventNotificationsService,
    private readonly platform: PlatformService,
    private readonly config: ConfigService,
  ) {}

  async trigger(type: SyncJobType, actorUserId?: string) {
    if (type === SyncJobType.WEBHOOK) {
      return this.triggerWebhookQueue(actorUserId);
    }

    const connection = await this.amo.getActiveConnectionOrFail();
    const syncType = this.resolveRequestedSyncType(type, connection);
    await this.expireStaleJobs(connection.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.tryAdvisoryTransactionLock(tx, `amo-pull-sync:${connection.id}`);
      if (!locked) {
        return {
          job: null,
          shouldRun: false,
          response: { status: 'busy', type: syncType, requestedType: type },
        };
      }

      const runningJob = await tx.syncJob.findFirst({
        where: {
          connectionId: connection.id,
          type: { not: SyncJobType.WEBHOOK },
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (runningJob) {
        return {
          job: runningJob,
          shouldRun: false,
          response: { jobId: runningJob.id, status: runningJob.status, type: runningJob.type },
        };
      }

      const job = await tx.syncJob.create({
        data: { connectionId: connection.id, type: syncType, status: 'QUEUED', heartbeatAt: new Date() },
      });
      return {
        job,
        shouldRun: true,
        response: { jobId: job.id, status: job.status, type: job.type, requestedType: type },
      };
    }, { maxWait: 2_000, timeout: 5_000 });

    if (!result.shouldRun || !result.job) return result.response;

    const job = result.job;
    await this.audit.record({
      userId: actorUserId,
      action: 'amo.sync.trigger',
      entity: 'SyncJob',
      entityId: job.id,
      metadata: { type: syncType, requestedType: type, connectionId: connection.id },
    });

    this.run(job.id).catch((error) => {
      this.logger.error(`amoCRM sync job ${job.id} failed: ${error.message}`, error.stack);
    });

    return result.response;
  }

  async enqueuePullSync(type: SyncJobType, actorUserId?: string) {
    if (type === SyncJobType.WEBHOOK) {
      return { status: 'ignored', type: SyncJobType.WEBHOOK };
    }

    const connection = await this.amo.getActiveConnectionOrFail();
    const syncType = this.resolveRequestedSyncType(type, connection);
    await this.expireStaleJobs(connection.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.tryAdvisoryTransactionLock(tx, `amo-pull-sync:${connection.id}`);
      if (!locked) {
        return {
          job: null,
          shouldEnqueue: false,
          response: { status: 'busy', type: syncType, requestedType: type },
        };
      }

      const existingJob = await tx.syncJob.findFirst({
        where: {
          connectionId: connection.id,
          type: { not: SyncJobType.WEBHOOK },
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (existingJob) {
        return {
          job: existingJob,
          shouldEnqueue: false,
          response: { jobId: existingJob.id, status: existingJob.status, type: existingJob.type },
        };
      }

      const job = await tx.syncJob.create({
        data: { connectionId: connection.id, type: syncType, status: 'QUEUED', heartbeatAt: new Date() },
      });
      return {
        job,
        shouldEnqueue: true,
        response: { jobId: job.id, status: job.status, type: job.type, requestedType: type },
      };
    }, { maxWait: 2_000, timeout: 5_000 });

    if (result.job && result.shouldEnqueue) {
      await this.audit.record({
        userId: actorUserId,
        action: 'amo.sync.enqueue',
        entity: 'SyncJob',
        entityId: result.job.id,
        metadata: { type: syncType, requestedType: type, connectionId: connection.id },
      });
    }

    return result.response;
  }

  async triggerWebhookQueue(actorUserId?: string) {
    const connection = await this.amo.getActiveConnectionOrFail();
    await this.expireStaleJobs(connection.id);

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await this.tryAdvisoryTransactionLock(tx, `amo-webhook-sync:${connection.id}`);
      if (!locked) {
        return {
          job: null,
          shouldRun: false,
          response: { status: 'busy', type: SyncJobType.WEBHOOK },
        };
      }

      const pendingWebhooks = await tx.webhookEvent.count({
        where: {
          connectionId: connection.id,
          processedAt: null,
          status: { in: ['received', 'error'] },
        },
      });
      if (pendingWebhooks === 0) {
        return {
          job: null,
          shouldRun: false,
          response: { status: 'idle', type: SyncJobType.WEBHOOK, pendingWebhooks },
        };
      }

      const runningFullJob = await tx.syncJob.findFirst({
        where: {
          connectionId: connection.id,
          type: SyncJobType.FULL,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (runningFullJob || !connection.lastFullSyncAt) {
        return {
          job: null,
          shouldRun: false,
          response: {
            status: runningFullJob ? 'waiting_full_snapshot' : 'waiting_initial_snapshot',
            type: SyncJobType.WEBHOOK,
            pendingWebhooks,
            blockingJobId: runningFullJob?.id,
          },
        };
      }

      const runningWebhookJob = await tx.syncJob.findFirst({
        where: {
          connectionId: connection.id,
          type: SyncJobType.WEBHOOK,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (runningWebhookJob) {
        return {
          job: runningWebhookJob,
          shouldRun: false,
          response: {
            jobId: runningWebhookJob.id,
            status: runningWebhookJob.status,
            type: runningWebhookJob.type,
            pendingWebhooks,
          },
        };
      }

      const job = await tx.syncJob.create({
        data: { connectionId: connection.id, type: SyncJobType.WEBHOOK, status: 'QUEUED', heartbeatAt: new Date() },
      });
      return {
        job,
        shouldRun: true,
        response: { jobId: job.id, status: job.status, type: job.type, pendingWebhooks },
      };
    }, { maxWait: 2_000, timeout: 5_000 });

    if (!result.shouldRun || !result.job) return result.response;

    const job = result.job;
    await this.audit.record({
      userId: actorUserId,
      action: 'amo.webhook_queue.trigger',
      entity: 'SyncJob',
      entityId: job.id,
      metadata: { type: SyncJobType.WEBHOOK, connectionId: connection.id },
    });

    this.run(job.id).catch((error) => {
      this.logger.error(`amoCRM webhook job ${job.id} failed: ${error.message}`, error.stack);
    });

    return result.response;
  }

  private async tryAdvisoryTransactionLock(tx: Prisma.TransactionClient, key: string) {
    const rows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1::text)) AS locked',
      key,
    );
    return rows[0]?.locked === true;
  }

  async expireStaleJobs(connectionId: string) {
    const expired = await this.prisma.syncJob.updateMany({
      where: {
        connectionId,
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: this.staleSyncJobBranches(),
      },
      data: {
        status: 'ERROR',
        finishedAt: new Date(),
        error: 'Синхронизация была прервана и закрыта автоматически',
      },
    });

    if (expired.count > 0) {
      await this.prisma.amoConnection.update({
        where: { id: connectionId },
        data: { status: 'ACTIVE', lastError: null },
      });
      this.logger.warn(`Closed ${expired.count} stale amoCRM sync job(s)`);
    }

    return expired.count;
  }

  private staleSyncJobBranches(): Prisma.SyncJobWhereInput[] {
    return [
      this.staleSyncJobBranch(SyncJobType.FULL, new Date(Date.now() - this.getStaleSyncJobMs(SyncJobType.FULL))),
      this.staleSyncJobBranch(SyncJobType.WEBHOOK, new Date(Date.now() - this.getStaleSyncJobMs(SyncJobType.WEBHOOK))),
      this.staleSyncJobBranch(SyncJobType.INCREMENTAL, new Date(Date.now() - this.getStaleSyncJobMs(SyncJobType.INCREMENTAL))),
    ];
  }

  private staleSyncJobBranch(type: SyncJobType, cutoff: Date): Prisma.SyncJobWhereInput {
    return {
      type,
      OR: [
        { heartbeatAt: { lt: cutoff } },
        { heartbeatAt: null, startedAt: { lt: cutoff } },
        { heartbeatAt: null, startedAt: null, createdAt: { lt: cutoff } },
      ],
    };
  }

  private getStaleSyncJobMs(type?: SyncJobType) {
    if (type === SyncJobType.FULL) {
      const rawFullTimeout = this.config.get<string>('AMOCRM_FULL_SYNC_JOB_TIMEOUT_MINUTES');
      const parsedFull = rawFullTimeout ? Number(rawFullTimeout) : NaN;
      return Number.isFinite(parsedFull) && parsedFull > 0
        ? parsedFull * 60_000
        : AmoSyncService.DEFAULT_STALE_SYNC_JOB_MS;
    }

    if (type === SyncJobType.WEBHOOK) {
      const rawWebhookTimeout = this.config.get<string>('AMOCRM_WEBHOOK_SYNC_JOB_TIMEOUT_MINUTES');
      const parsedWebhook = rawWebhookTimeout ? Number(rawWebhookTimeout) : NaN;
      return Number.isFinite(parsedWebhook) && parsedWebhook > 0
        ? parsedWebhook * 60_000
        : 5 * 60_000;
    }

    const rawTimeout = this.config.get<string>('AMOCRM_SYNC_JOB_TIMEOUT_MINUTES');
    const parsed = rawTimeout ? Number(rawTimeout) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? parsed * 60_000
      : 30 * 60_000;
  }

  private resolveRequestedSyncType(type: SyncJobType, connection: AmoConnection) {
    if (type === SyncJobType.FULL) return SyncJobType.FULL;
    if (!connection.lastFullSyncAt && !connection.lastIncrementalSyncAt) return SyncJobType.FULL;
    return type;
  }

  async getJob(id: string) {
    return this.prisma.syncJob.findUnique({ where: { id } });
  }

  async ensureWebhookRegistered() {
    const connection = await this.amo.getActiveConnectionOrFail();
    const client = await this.amo.getClient(connection);
    const stats: Record<string, number> = {};
    try {
      await this.ensureWebhookSubscription(client, connection, stats);
    } catch (error: any) {
      await this.recordWebhookSubscriptionError(connection, error);
      throw error;
    }

    const updatedConnection = await this.amo.getConnection();
    return { status: stats.webhookSubscription ? 'ok' : 'skipped', stats, webhookUrl: updatedConnection?.webhookUrl ?? null };
  }

  async registerWebhook(actorUserId?: string) {
    const result = await this.ensureWebhookRegistered();
    const connection = await this.amo.getActiveConnectionOrFail();

    await this.audit.record({
      userId: actorUserId,
      action: 'amo.webhook.register',
      entity: 'AmoConnection',
      entityId: connection.id,
      metadata: { connectionId: connection.id, stats: result.stats },
    });

    return result;
  }

  async syncRecentEmailNotes() {
    const connection = await this.amo.getActiveConnectionOrFail();
    if (!connection.lastFullSyncAt) return { status: 'waiting_initial_snapshot' };

    const client = await this.amo.getClient(connection);
    const stats: Record<string, number> = {};
    const startedAt = new Date();
    const connectionConfig = this.connectionConfig(connection);
    const cursor =
      this.parseConfigDate(connectionConfig.emailNotesSyncedAt) ??
      new Date(Date.now() - this.getEmailNotesInitialLookbackDays() * 86_400_000);
    const updatedSince = Math.floor((cursor.getTime() - 5 * 60_000) / 1000);

    try {
      const affectedDealIds = await this.syncEmailNotes(client, stats, updatedSince);
      const state = affectedDealIds.length
        ? await this.platform.rebuildEmailThreadStatesForDeals(affectedDealIds)
        : { total: 0, pending: 0 };
      await this.updateConnectionConfig(connection.id, {
        emailNotesSyncedAt: startedAt.toISOString(),
        emailNotesSyncError: null,
        emailNotesSyncErrorAt: null,
      });
      return {
        status: 'ok',
        stats: {
          ...stats,
          ...(affectedDealIds.length
            ? { emailThreadStates: state.total, pendingEmailThreadStates: state.pending }
            : { emailThreadStateRebuildSkipped: 1 }),
        },
      };
    } catch (error: any) {
      await this.updateConnectionConfig(connection.id, {
        emailNotesSyncError: String(error?.message ?? error),
        emailNotesSyncErrorAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async reconcileRecentChanges() {
    const connection = await this.amo.getActiveConnectionOrFail();
    if (!connection.lastFullSyncAt) return { status: 'waiting_initial_snapshot' };

    const startedAt = new Date();
    const connectionConfig = this.connectionConfig(connection);
    const previousCursor = this.parseConfigDate(connectionConfig.recentReconcileAt);
    const lookbackMs = this.getRecentReconcileLookbackMinutes() * 60_000;
    const overlapMs = this.getRecentReconcileOverlapMinutes() * 60_000;
    const earliestAllowed = startedAt.getTime() - lookbackMs;
    const cursorFrom = previousCursor ? previousCursor.getTime() - overlapMs : earliestAllowed;
    const syncFrom = new Date(Math.max(earliestAllowed, cursorFrom));
    const updatedSince = Math.floor(syncFrom.getTime() / 1000);
    const stats: Record<string, number> = {};

    try {
      const client = await this.amo.getClient(connection);
      const maps = this.emptyMaps();
      await this.hydrateMetadataMaps(maps);
      await this.syncRecentDeals(client, maps, stats, updatedSince);
      await this.syncRecentStageEvents(client, maps, stats, updatedSince);

      await this.updateConnectionConfig(connection.id, {
        recentReconcileAt: startedAt.toISOString(),
        recentReconcileFrom: syncFrom.toISOString(),
        recentReconcileStats: stats,
        recentReconcileError: null,
        recentReconcileErrorAt: null,
      }, {
        status: 'ACTIVE',
        lastError: null,
      });

      return { status: 'ok', from: syncFrom, stats };
    } catch (error: any) {
      await this.updateConnectionConfig(connection.id, {
        recentReconcileError: String(error?.message ?? error),
        recentReconcileErrorAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      this.compactHeapAfterHeavySync();
    }
  }

  async reconcileLeadSlaCandidates() {
    const connection = await this.amo.getActiveConnectionOrFail();
    if (!connection.lastFullSyncAt) return { status: 'waiting_initial_snapshot' };

    const startedAt = new Date();
    const connectionConfig = this.connectionConfig(connection);
    const stats: Record<string, number> = {};

    try {
      const client = await this.amo.getClient(connection);
      const maps = this.emptyMaps();
      await this.hydrateMetadataMaps(maps);
      await this.reconcileLeadSlaDeals(client, maps, stats);

      await this.updateConnectionConfig(connection.id, {
        leadSlaReconcileAt: startedAt.toISOString(),
        leadSlaReconcileStats: stats,
        leadSlaReconcileError: null,
        leadSlaReconcileErrorAt: null,
      }, {
        status: 'ACTIVE',
        lastError: null,
      });

      return { status: 'ok', stats };
    } catch (error: any) {
      await this.updateConnectionConfig(connection.id, {
        leadSlaReconcileError: String(error?.message ?? error),
        leadSlaReconcileErrorAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      this.compactHeapAfterHeavySync();
    }
  }

  async processCrmStateNotifications() {
    const connection = await this.amo.getActiveConnectionOrFail();
    if (!connection.lastFullSyncAt) return { status: 'waiting_initial_snapshot' };

    const client = await this.amo.getClient(connection);
    const stats: Record<string, number> = {};
    await this.processCrmNotifications(
      stats,
      new Date(Date.now() - 15 * 60_000),
      client.domain,
      { includeEventDriven: false, includeStateScans: true },
    );
    this.compactHeapAfterHeavySync();
    return { status: 'ok', stats };
  }

  async getHealth() {
    const connection = await this.prisma.amoConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!connection) {
      return {
        healthy: false,
        message: 'amoCRM не подключена',
        connectionStatus: 'INACTIVE',
        pendingWebhooks: 0,
        runningJobs: 0,
        staleJobs: 0,
        lastSuccessfulSyncAt: null,
        lastDataUpdateAt: null,
        lastSnapshotAt: null,
        lastWebhookAt: null,
        lastProcessedWebhookAt: null,
        webhookLagSeconds: 0,
        webhookSubscriptionEnsuredAt: null,
        webhookSubscriptionLagSeconds: null,
        webhookSubscriptionStale: true,
        webhookSubscriptionError: null,
        webhookSubscriptionErrorAt: null,
        syncMode: 'WEBHOOK',
        hasReceivedWebhooks: false,
        lastError: null,
      };
    }

    await this.expireStaleJobs(connection.id);

    const [
      pendingWebhooks,
      runningJobs,
      staleJobs,
      lastSuccessJob,
      lastJob,
      lastWebhook,
      lastProcessedWebhook,
      oldestPendingWebhook,
    ] = await Promise.all([
      this.prisma.webhookEvent.count({
        where: {
          connectionId: connection.id,
          processedAt: null,
          status: { in: ['received', 'error'] },
        },
      }),
      this.prisma.syncJob.count({
        where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } },
      }),
      this.prisma.syncJob.count({
        where: {
          connectionId: connection.id,
          status: { in: ['QUEUED', 'RUNNING'] },
          OR: this.staleSyncJobBranches(),
        },
      }),
      this.prisma.syncJob.findFirst({
        where: { connectionId: connection.id, status: 'SUCCESS' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, type: true, stats: true },
      }),
      this.prisma.syncJob.findFirst({
        where: { connectionId: connection.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, type: true, error: true, finishedAt: true, heartbeatAt: true },
      }),
      this.prisma.webhookEvent.findFirst({
        where: { connectionId: connection.id },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, status: true },
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          connectionId: connection.id,
          processedAt: { not: null },
        },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true, receivedAt: true, status: true },
      }),
      this.prisma.webhookEvent.findFirst({
        where: {
          connectionId: connection.id,
          processedAt: null,
          status: { in: ['received', 'error'] },
        },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true, status: true },
      }),
    ]);

    const connectionConfig = this.connectionConfig(connection);
    const syncMode = this.getConfiguredSyncIntervalMinutes() > 0 ? 'POLLING' : 'WEBHOOK';
    const hasReceivedWebhooks = Boolean(lastWebhook);
    const lastSuccessfulSyncAt = lastSuccessJob?.finishedAt ?? connection.lastIncrementalSyncAt ?? connection.lastFullSyncAt;
    const recentReconcileAt = this.parseConfigDate(connectionConfig.recentReconcileAt);
    const recentReconcileErrorAt = this.parseConfigDate(connectionConfig.recentReconcileErrorAt);
    const recentReconcileError =
      typeof connectionConfig.recentReconcileError === 'string' ? connectionConfig.recentReconcileError : null;
    const lastDataUpdateAt = this.latestDate(lastProcessedWebhook?.processedAt, recentReconcileAt, lastSuccessfulSyncAt);
    const webhookSubscriptionEnsuredAt = this.parseConfigDate(connectionConfig.webhookEnsuredAt);
    const webhookSubscriptionErrorAt = this.parseConfigDate(connectionConfig.webhookEnsureErrorAt);
    const webhookSubscriptionError =
      typeof connectionConfig.webhookEnsureError === 'string' ? connectionConfig.webhookEnsureError : null;
    const webhookSubscriptionLagSeconds = webhookSubscriptionEnsuredAt
      ? Math.max(0, Math.floor((Date.now() - webhookSubscriptionEnsuredAt.getTime()) / 1000))
      : null;
    const lastWebhookLagSeconds = lastWebhook?.receivedAt
      ? Math.max(0, Math.floor((Date.now() - lastWebhook.receivedAt.getTime()) / 1000))
      : null;
    const hasRecentWebhook = lastWebhookLagSeconds !== null && lastWebhookLagSeconds < 30 * 60;
    const webhookSubscriptionStale =
      syncMode === 'WEBHOOK' &&
      !hasRecentWebhook &&
      (!webhookSubscriptionEnsuredAt || webhookSubscriptionLagSeconds === null || webhookSubscriptionLagSeconds > 30 * 60);
    const webhookArrivedAfterSubscriptionError =
      Boolean(lastWebhook?.receivedAt) &&
      Boolean(webhookSubscriptionErrorAt) &&
      lastWebhook!.receivedAt.getTime() >= webhookSubscriptionErrorAt!.getTime();
    const hasWebhookSubscriptionProblem =
      syncMode === 'WEBHOOK' &&
      (webhookSubscriptionStale || (Boolean(webhookSubscriptionError) && !webhookArrivedAfterSubscriptionError));
    const hasBlockingError = connection.status === 'ERROR' && lastJob?.status !== 'RUNNING';
    const webhookLagSeconds = oldestPendingWebhook
      ? Math.max(0, Math.floor((Date.now() - oldestPendingWebhook.receivedAt.getTime()) / 1000))
      : 0;
    const healthy =
      !hasBlockingError &&
      staleJobs === 0 &&
      pendingWebhooks < 1000 &&
      webhookLagSeconds < 120 &&
      !hasWebhookSubscriptionProblem;
    const message = healthy
      ? syncMode === 'WEBHOOK' && !hasReceivedWebhooks
        ? 'Realtime включён, ждём событие amoCRM'
        : 'Синхронизация работает'
      : staleJobs > 0
        ? 'Есть зависшая синхронизация'
        : pendingWebhooks >= 1000
          ? 'Копится очередь webhook'
          : hasWebhookSubscriptionProblem
            ? 'Webhook amoCRM не подтверждён'
            : 'Есть ошибка синхронизации';

    return {
      healthy,
      message,
      connectionStatus: connection.status,
      pendingWebhooks,
      runningJobs,
      staleJobs,
      lastSuccessfulSyncAt,
      lastDataUpdateAt,
      lastSnapshotAt: connection.lastFullSyncAt,
      recentReconcileAt,
      recentReconcileError,
      recentReconcileErrorAt,
      lastWebhookAt: lastWebhook?.receivedAt ?? null,
      lastProcessedWebhookAt: lastProcessedWebhook?.processedAt ?? null,
      webhookLagSeconds,
      webhookSubscriptionEnsuredAt,
      webhookSubscriptionLagSeconds,
      webhookSubscriptionStale,
      webhookSubscriptionError,
      webhookSubscriptionErrorAt,
      syncMode,
      hasReceivedWebhooks,
      lastJob,
      lastError: hasBlockingError ? connection.lastError : null,
    };
  }

  private getConfiguredSyncIntervalMinutes() {
    const rawInterval = this.config.get<string>('AMOCRM_SYNC_INTERVAL_MINUTES');
    if (!rawInterval) return 0;
    const parsed = Number(rawInterval);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  }

  private getEmailNotesInitialLookbackDays() {
    const rawDays = this.config.get<string>('AMOCRM_EMAIL_NOTES_INITIAL_LOOKBACK_DAYS');
    if (!rawDays) return 7;
    const parsed = Number(rawDays);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 7;
  }

  private getRecentReconcileLookbackMinutes() {
    const rawMinutes = this.config.get<string>('AMOCRM_RECENT_RECONCILE_LOOKBACK_MINUTES');
    if (!rawMinutes) return 30;
    const parsed = Number(rawMinutes);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
  }

  private getRecentReconcileOverlapMinutes() {
    const rawMinutes = this.config.get<string>('AMOCRM_RECENT_RECONCILE_OVERLAP_MINUTES');
    if (!rawMinutes) return 10;
    const parsed = Number(rawMinutes);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
  }

  private getRecentReconcileMaxDeals() {
    const rawLimit = this.config.get<string>('AMOCRM_RECENT_RECONCILE_MAX_DEALS');
    if (!rawLimit) return 500;
    const parsed = Number(rawLimit);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
  }

  private getRecentReconcileMaxEvents() {
    const rawLimit = this.config.get<string>('AMOCRM_RECENT_RECONCILE_MAX_EVENTS');
    if (!rawLimit) return 1000;
    const parsed = Number(rawLimit);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  }

  private connectionConfig(connection: AmoConnection) {
    return this.configObject(connection.config);
  }

  private configObject(config: unknown) {
    return config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  }

  private async updateConnectionConfig(
    connectionId: string,
    patch: Record<string, unknown>,
    data: Record<string, unknown> = {},
  ) {
    const connection = await this.prisma.amoConnection.findUnique({
      where: { id: connectionId },
      select: { config: true },
    });
    await this.prisma.amoConnection.update({
      where: { id: connectionId },
      data: {
        ...data,
        config: {
          ...this.configObject(connection?.config),
          ...patch,
        },
      } as any,
    });
  }

  private parseConfigDate(raw: unknown) {
    if (typeof raw !== 'string') return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private latestDate(...dates: Array<Date | null | undefined>) {
    const timestamps = dates
      .filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()))
      .map((date) => date.getTime());
    if (timestamps.length === 0) return null;
    return new Date(Math.max(...timestamps));
  }

  async run(jobId: string) {
    const job = await this.prisma.syncJob.findUnique({
      where: { id: jobId },
      include: { connection: true },
    });
    if (!job) return;

    if (job.type === SyncJobType.WEBHOOK) {
      await this.runWebhookJob(job);
      return;
    }

    await this.runPullJob(job);
  }

  private async runPullJob(job: SyncJobWithConnection) {
    const jobId = job.id;
    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt: new Date(), heartbeatAt: new Date() },
    });
    await this.prisma.amoConnection.update({
      where: { id: job.connectionId },
      data: { status: 'SYNCING', lastError: null },
    });

    const stats: Record<string, number> = {};

    try {
      const client = await this.amo.getClient(job.connection);
      const syncStartedAt = new Date();
      const updatedSince = this.getUpdatedSince(job.type, job.connection.lastIncrementalSyncAt);
      const notificationSince = job.connection.lastIncrementalSyncAt
        ? new Date(job.connection.lastIncrementalSyncAt.getTime() - 5 * 60_000)
        : syncStartedAt;
      const isFullSync = job.type === SyncJobType.FULL;

      await this.syncAccount(client, stats);
      await this.syncOptional('webhookSubscription', stats, () => this.ensureWebhookSubscription(client, job.connection, stats));
      const maps = this.emptyMaps();
      if (isFullSync) {
        const freshMaps = await this.syncMetadata(client, stats);
        this.mergeMaps(maps, freshMaps);
        await this.syncOptional('sources', stats, () => this.syncSources(client, maps, stats));
        await this.syncOptional('tags', stats, () => this.syncTags(client, stats));
        await this.syncOptional('catalogs', stats, () => this.syncCatalogs(client, stats));
        await this.syncOptional('customersMetadata', stats, () => this.syncCustomerMetadata(client, maps, stats));
        await this.syncCustomFieldDefinitions(client, stats);
      } else {
        await this.hydrateMetadataMaps(maps);
        stats.metadataFromCache = 1;
      }
      await this.hydrateExistingEntityMaps(maps);
      await this.touchJob(jobId, 'deals');
      this.logger.log(`amoCRM sync job ${jobId}: syncing deals`);
      await this.syncDeals(client, maps, stats, updatedSince, jobId);
      if (isFullSync) {
        await this.backfillLossReasonsFromRaw(stats);
      }
      await this.reconcileLeadSlaDeals(client, maps, stats);
      await this.touchJob(jobId, 'notes');
      this.logger.log(`amoCRM sync job ${jobId}: syncing notes`);
      await this.syncOptional('notes', stats, () => this.syncNotes(client, stats, updatedSince));
      await this.touchJob(jobId, 'events');
      this.logger.log(`amoCRM sync job ${jobId}: syncing events`);
      await this.syncOptional('events', stats, () => this.syncEvents(client, maps, stats, updatedSince));
      await this.touchJob(jobId, 'tasks');
      this.logger.log(`amoCRM sync job ${jobId}: syncing tasks`);
      await this.syncOptional('tasks', stats, () => this.syncTasks(client, maps, stats, updatedSince));
      await this.touchJob(jobId, 'contacts_companies');
      this.logger.log(`amoCRM sync job ${jobId}: syncing contacts and companies`);
      await this.syncContacts(client, maps, stats, updatedSince);
      await this.syncCompanies(client, maps, stats, updatedSince);
      await this.syncOptional('customers', stats, () => this.syncCustomers(client, maps, stats, updatedSince));
      await this.touchJob(jobId, 'email_thread_state');
      await this.rebuildEmailThreadStates(stats);
      if (isFullSync) {
        await this.syncOptional('entityLinks', stats, () => this.syncEntityLinks(client, stats));
        await this.recalculateStageProbabilities();
      }
      await this.touchJob(jobId, 'notifications');
      await this.processCrmNotifications(stats, notificationSince, client.domain);

      const syncFinishedAt = new Date();
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'SUCCESS', heartbeatAt: syncFinishedAt, finishedAt: syncFinishedAt, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: {
          status: 'ACTIVE',
          lastError: null,
          lastFullSyncAt: job.type === 'FULL' ? syncFinishedAt : job.connection.lastFullSyncAt,
          lastIncrementalSyncAt: syncStartedAt,
        },
      });
      if (isFullSync) {
        this.triggerWebhookQueue().catch((error) => {
          this.logger.warn(`Post-snapshot webhook queue processing failed: ${error.message}`);
        });
      }
    } catch (error: any) {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'ERROR', heartbeatAt: new Date(), finishedAt: new Date(), error: error.message, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: { status: 'ERROR', lastError: error.message },
      });
      throw error;
    } finally {
      this.compactHeapAfterHeavySync();
    }
  }

  private async runWebhookJob(job: SyncJobWithConnection) {
    const jobId = job.id;
    const startedAt = new Date();
    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { status: 'RUNNING', startedAt, heartbeatAt: startedAt, cursor: { step: 'webhook_queue' } },
    });
    await this.prisma.amoConnection.update({
      where: { id: job.connectionId },
      data: { status: 'SYNCING', lastError: null },
    });

    const stats: Record<string, number> = {};
    try {
      const events = await this.prisma.webhookEvent.findMany({
        where: {
          connectionId: job.connectionId,
          processedAt: null,
          status: { in: ['received', 'error'] },
        },
        orderBy: { receivedAt: 'asc' },
        take: WEBHOOK_EVENT_BATCH_SIZE,
      });

      const earliestEventAt = events[0]?.receivedAt ?? startedAt;
      const groups = this.groupWebhookEvents(events);
      const actionableGroups = groups.filter((group) => group.externalId);
      stats.webhookEvents = events.length;
      stats.webhookGroups = groups.length;

      let client: AmoClient | null = null;
      const maps = this.emptyMaps();
      if (actionableGroups.length > 0) {
        client = await this.amo.getClient(job.connection);
        await this.hydrateMetadataMaps(maps);
      }

      for (const group of groups) {
        await this.touchJob(jobId, `webhook:${group.entity}:${group.externalId ?? 'no-id'}`);
        try {
          if (!group.externalId) {
            stats.webhookSkippedNoId = (stats.webhookSkippedNoId ?? 0) + 1;
            await this.prisma.webhookEvent.updateMany({
              where: { id: { in: group.ids } },
              data: { processedAt: new Date(), status: 'processed', error: null },
            });
            continue;
          }

          if (!client) throw new Error('amoCRM client was not initialized for actionable webhook group');
          await this.processWebhookGroup(client, maps, group, stats);
          await this.prisma.webhookEvent.updateMany({
            where: { id: { in: group.ids } },
            data: { processedAt: new Date(), status: 'processed', error: null },
          });
        } catch (error: any) {
          stats.webhookErrors = (stats.webhookErrors ?? 0) + group.ids.length;
          await this.prisma.webhookEvent.updateMany({
            where: { id: { in: group.ids } },
            data: { status: 'error', error: error.message },
          });
          this.logger.warn(`Webhook group ${group.entity}:${group.externalId ?? 'no-id'} failed: ${error.message}`);
        }
      }

      const leadSideEffectGroups = actionableGroups.filter((group) => this.webhookGroupNeedsLeadSideEffects(group));
      const communicationGroups = actionableGroups.filter((group) => this.webhookGroupNeedsCommunicationSync(group));

      if (communicationGroups.length > 0) {
        stats.webhookRelatedNotesDeferred = communicationGroups.length;
        stats.emailThreadStateDeferred = 1;
      }

      if (leadSideEffectGroups.length > 0 && client) {
        const eventSyncFrom = Math.floor((earliestEventAt.getTime() - 5 * 60_000) / 1000);
        await this.touchJob(jobId, 'crm_notifications');
        await this.processCrmNotifications(
          stats,
          new Date(eventSyncFrom * 1000),
          client.domain,
          { includeStateScans: false },
        );
      }

      const finishedAt = new Date();
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'SUCCESS', heartbeatAt: finishedAt, finishedAt, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: {
          status: 'ACTIVE',
          lastError: null,
          lastFullSyncAt: job.connection.lastFullSyncAt,
          lastIncrementalSyncAt: groups.length > 0 ? finishedAt : job.connection.lastIncrementalSyncAt,
        },
      });
    } catch (error: any) {
      await this.prisma.syncJob.update({
        where: { id: jobId },
        data: { status: 'ERROR', heartbeatAt: new Date(), finishedAt: new Date(), error: error.message, stats },
      });
      await this.prisma.amoConnection.update({
        where: { id: job.connectionId },
        data: { status: 'ERROR', lastError: error.message },
      });
      throw error;
    } finally {
      this.compactHeapAfterHeavySync();
    }
  }

  private getUpdatedSince(type: SyncJobType, lastIncrementalSyncAt: Date | null): number | undefined {
    if (type === 'FULL') return undefined;
    if (!lastIncrementalSyncAt) return Math.floor((Date.now() - 5 * 60_000) / 1000);
    return Math.floor((lastIncrementalSyncAt.getTime() - 5 * 60_000) / 1000);
  }

  private emptyMaps(): AmoSyncMaps {
    return {
      pipelines: new Map(),
      stages: new Map(),
      users: new Map(),
      contacts: new Map(),
      companies: new Map(),
      lossReasons: new Map(),
      customerStatuses: new Map(),
      customers: new Map(),
    };
  }

  private mergeMaps(target: AmoSyncMaps, source: AmoSyncMaps) {
    for (const [key, value] of source.pipelines) target.pipelines.set(key, value);
    for (const [key, value] of source.stages) target.stages.set(key, value);
    for (const [key, value] of source.users) target.users.set(key, value);
    for (const [key, value] of source.contacts) target.contacts.set(key, value);
    for (const [key, value] of source.companies) target.companies.set(key, value);
    for (const [key, value] of source.lossReasons) target.lossReasons.set(key, value);
    for (const [key, value] of source.customerStatuses) target.customerStatuses.set(key, value);
    for (const [key, value] of source.customers) target.customers.set(key, value);
  }

  private async touchJob(jobId: string, step: string) {
    await this.prisma.syncJob.update({
      where: { id: jobId },
      data: { heartbeatAt: new Date(), cursor: { step } },
    });
  }

  private async rebuildEmailThreadStates(stats: Record<string, number>) {
    const result = await this.platform.rebuildEmailThreadStates();
    this.compactHeapAfterHeavySync();
    stats.emailThreadStates = result.total;
    stats.pendingEmailThreadStates = result.pending;
  }

  private compactHeapAfterHeavySync() {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gc === 'function') gc();
  }

  private async hydrateMetadataMaps(maps: AmoSyncMaps) {
    const [pipelines, stages, users, lossReasons, customerStatuses, customers] = await Promise.all([
      this.prisma.pipeline.findMany({ select: { id: true, externalId: true } }),
      this.prisma.pipelineStage.findMany({
        select: { id: true, externalId: true, pipeline: { select: { externalId: true } } },
      }),
      this.prisma.crmUser.findMany({ select: { id: true, externalId: true } }),
      this.prisma.lossReason.findMany({
        select: { id: true, externalId: true, pipeline: { select: { externalId: true } } },
      }),
      this.prisma.customerStatus.findMany({ select: { id: true, externalId: true } }),
      this.prisma.customer.findMany({ select: { id: true, externalId: true } }),
    ]);

    for (const pipeline of pipelines) maps.pipelines.set(pipeline.externalId, pipeline.id);
    for (const stage of stages) maps.stages.set(`${stage.pipeline.externalId}_${stage.externalId}`, stage.id);
    for (const user of users) maps.users.set(user.externalId, user.id);
    for (const reason of lossReasons) maps.lossReasons.set(`${reason.pipeline.externalId}_${reason.externalId}`, reason.id);
    for (const status of customerStatuses) maps.customerStatuses.set(status.externalId, status.id);
    for (const customer of customers) maps.customers.set(customer.externalId, customer.id);
  }

  private groupWebhookEvents(
    events: Array<{
      id: string;
      entity: string;
      action: string;
      externalId: string | null;
      payload: Prisma.JsonValue;
    }>,
  ) {
    const groups = new Map<
      string,
      {
        ids: string[];
        entity: string;
        externalId: string | null;
        actions: Set<string>;
        payloads: Prisma.JsonValue[];
      }
    >();

    for (const event of events) {
      const entity = this.normalizeWebhookEntity(event.entity);
      const externalId = event.externalId ?? this.webhookPayloadExternalId(event.action, event.payload);
      const key = `${entity}:${externalId ?? event.id}`;
      const group = groups.get(key) ?? {
        ids: [],
        entity,
        externalId,
        actions: new Set<string>(),
        payloads: [],
      };
      group.ids.push(event.id);
      group.actions.add(String(event.action ?? '').toLowerCase());
      group.payloads.push(event.payload);
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => ({
      ...group,
      actions: [...group.actions],
    }));
  }

  private normalizeWebhookEntity(entity: string) {
    const normalized = String(entity ?? '').toLowerCase();
    if (normalized.includes('lead')) return 'leads';
    if (normalized.includes('task')) return 'tasks';
    if (normalized.includes('contact')) return 'contacts';
    if (normalized.includes('message')) return 'contacts';
    if (normalized.includes('compan')) return 'companies';
    if (normalized.includes('customer')) return 'customers';
    return normalized;
  }

  private webhookPayloadExternalId(action: string, payload: Prisma.JsonValue) {
    const normalizedAction = String(action ?? '').toLowerCase();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const item = payload as Record<string, any>;
    if (item.contact_id != null) return String(item.contact_id);
    if (!normalizedAction.includes('note')) return null;
    const note = item.note && typeof item.note === 'object' && !Array.isArray(item.note)
      ? item.note as Record<string, any>
      : null;
    const id = note?.element_id ?? note?.entity_id ?? item.element_id ?? item.entity_id;
    return id == null ? null : String(id);
  }

  private async processWebhookGroup(
    client: AmoClient,
    maps: AmoSyncMaps,
    group: WebhookEventGroup,
    stats: Record<string, number>,
  ) {
    if (!group.externalId) {
      stats.webhookSkippedNoId = (stats.webhookSkippedNoId ?? 0) + 1;
      return;
    }

    if (group.actions.some((action) => action.includes('delete'))) {
      await this.markWebhookEntityDeleted(group.entity, group.externalId, stats);
      return;
    }

    if (group.entity === 'leads') {
      await this.syncSingleLead(client, maps, group.externalId, stats);
      return;
    }
    if (group.entity === 'tasks') {
      await this.syncSingleTask(client, maps, group.externalId, stats, group.payloads);
      return;
    }
    if (group.entity === 'contacts') {
      await this.syncSingleContact(client, maps, group.externalId, stats);
      return;
    }
    if (group.entity === 'companies') {
      await this.syncSingleCompany(client, maps, group.externalId, stats);
      return;
    }
    if (group.entity === 'customers') {
      await this.syncSingleCustomer(client, maps, group.externalId, stats);
      return;
    }

    stats.webhookSkippedUnsupported = (stats.webhookSkippedUnsupported ?? 0) + 1;
  }

  private webhookGroupNeedsLeadSideEffects(group: WebhookEventGroup) {
    return group.entity === 'leads' || group.entity === 'tasks';
  }

  private webhookGroupNeedsCommunicationSync(group: WebhookEventGroup) {
    if (group.entity !== 'leads' && group.entity !== 'contacts') return false;
    return group.actions.some((action) => {
      const clean = String(action ?? '').toLowerCase();
      return clean.includes('note') || clean.includes('message') || clean.includes('mail');
    });
  }

  private async markWebhookEntityDeleted(entity: string, externalId: string, stats: Record<string, number>) {
    if (entity === 'leads') {
      await this.prisma.deal.updateMany({
        where: { externalId },
        data: { deletedAt: new Date(), updatedAt: new Date() },
      });
      stats.webhookDealsDeleted = (stats.webhookDealsDeleted ?? 0) + 1;
    }
  }

  private async syncSingleLead(
    client: AmoClient,
    maps: AmoSyncMaps,
    externalId: string,
    stats: Record<string, number>,
  ) {
    try {
      const lead = await client.get<any>(`/leads/${externalId}`, { with: 'contacts,catalog_elements,loss_reason' });
      if (!lead?.id) {
        await this.markWebhookEntityDeleted('leads', externalId, stats);
        stats.webhookDealsEmpty = (stats.webhookDealsEmpty ?? 0) + 1;
        return;
      }
      await this.ensureLeadMetadata(client, maps, lead, stats);
      await this.syncLeadEmbeddedContacts(client, maps, lead, stats);
      await this.upsertDeal(lead, maps);
      stats.webhookDeals = (stats.webhookDeals ?? 0) + 1;
    } catch (error: any) {
      if (String(error?.message ?? '').includes('amoCRM API 404')) {
        await this.markWebhookEntityDeleted('leads', externalId, stats);
        return;
      }
      throw error;
    }
  }

  private async syncLeadEmbeddedContacts(
    client: AmoClient,
    maps: AmoSyncMaps,
    lead: any,
    stats: Record<string, number>,
  ) {
    const contacts = lead._embedded?.contacts ?? [];
    if (!Array.isArray(contacts) || contacts.length === 0) return;

    for (const contactRef of contacts) {
      const contactId = contactRef?.id;
      if (!contactId || maps.contacts.has(String(contactId))) continue;
      try {
        const contact = await client.get<any>(`/contacts/${contactId}`);
        if (!contact?.id) {
          stats.webhookLeadContactsSkipped = (stats.webhookLeadContactsSkipped ?? 0) + 1;
          continue;
        }
        const dbContact = await this.upsertContact(contact);
        maps.contacts.set(String(contactId), dbContact.id);
        stats.webhookLeadContacts = (stats.webhookLeadContacts ?? 0) + 1;
      } catch (error: any) {
        this.logger.warn(`Lead contact ${contactId} sync skipped: ${error.message}`);
      }
    }
  }

  private async ensureLeadMetadata(
    client: AmoClient,
    maps: AmoSyncMaps,
    lead: any,
    stats: Record<string, number>,
  ) {
    const pipelineKey = String(lead.pipeline_id);
    const stageKey = `${lead.pipeline_id}_${lead.status_id}`;
    const userKey = lead.responsible_user_id ? String(lead.responsible_user_id) : null;
    const hasMissingMetadata =
      !maps.pipelines.has(pipelineKey) ||
      !maps.stages.has(stageKey) ||
      (userKey ? !maps.users.has(userKey) : false);

    if (!hasMissingMetadata) return;

    const freshMaps = await this.syncMetadata(client, stats);
    this.mergeMaps(maps, freshMaps);
    stats.webhookMetadataRefreshed = (stats.webhookMetadataRefreshed ?? 0) + 1;
  }

  private async syncSingleTask(
    client: AmoClient,
    maps: AmoSyncMaps,
    externalId: string,
    stats: Record<string, number>,
    webhookPayloads: Prisma.JsonValue[] = [],
  ) {
    let task: any;
    try {
      task = await client.get<any>(`/tasks/${externalId}`);
    } catch (error: any) {
      if (String(error?.message ?? '').includes('amoCRM API 404')) {
        await this.prisma.task.deleteMany({ where: { externalId } });
        stats.webhookTasksDeleted = (stats.webhookTasksDeleted ?? 0) + 1;
        return;
      }
      throw error;
    }
    if (!task?.id) {
      await this.prisma.task.deleteMany({ where: { externalId } });
      stats.webhookTasksEmpty = (stats.webhookTasksEmpty ?? 0) + 1;
      const leadExternalId = this.webhookTaskLeadExternalId(webhookPayloads);
      if (leadExternalId) {
        await this.syncSingleLead(client, maps, leadExternalId, stats);
        stats.webhookTaskLeadFallbacks = (stats.webhookTaskLeadFallbacks ?? 0) + 1;
      }
      return;
    }
    await this.upsertTask(task, maps);
    stats.webhookTasks = (stats.webhookTasks ?? 0) + 1;

    const leadExternalId = this.taskLeadExternalId(task) ?? this.webhookTaskLeadExternalId(webhookPayloads);
    if (leadExternalId) {
      await this.syncSingleLead(client, maps, leadExternalId, stats);
    }
  }

  private async syncSingleContact(
    client: AmoClient,
    maps: AmoSyncMaps,
    externalId: string,
    stats: Record<string, number>,
  ) {
    let contact: any;
    try {
      contact = await client.get<any>(`/contacts/${externalId}`);
    } catch (error: any) {
      if (this.isAmoNotFoundError(error)) {
        await this.prisma.contact.deleteMany({ where: { externalId } });
        stats.webhookContactsDeleted = (stats.webhookContactsDeleted ?? 0) + 1;
        return;
      }
      throw error;
    }
    if (!contact?.id) {
      stats.webhookContactsSkipped = (stats.webhookContactsSkipped ?? 0) + 1;
      return;
    }
    const dbContact = await this.upsertContact(contact);
    maps.contacts.set(String(contact.id), dbContact.id);
    stats.webhookContacts = (stats.webhookContacts ?? 0) + 1;
  }

  private async syncSingleCompany(
    client: AmoClient,
    maps: AmoSyncMaps,
    externalId: string,
    stats: Record<string, number>,
  ) {
    let company: any;
    try {
      company = await client.get<any>(`/companies/${externalId}`);
    } catch (error: any) {
      if (this.isAmoNotFoundError(error)) {
        await this.prisma.crmCompany.deleteMany({ where: { externalId } });
        stats.webhookCompaniesDeleted = (stats.webhookCompaniesDeleted ?? 0) + 1;
        return;
      }
      throw error;
    }
    if (!company?.id) {
      stats.webhookCompaniesSkipped = (stats.webhookCompaniesSkipped ?? 0) + 1;
      return;
    }
    const dbCompany = await this.upsertCompany(company);
    maps.companies.set(String(company.id), dbCompany.id);
    stats.webhookCompanies = (stats.webhookCompanies ?? 0) + 1;
  }

  private async syncSingleCustomer(
    client: AmoClient,
    maps: AmoSyncMaps,
    externalId: string,
    stats: Record<string, number>,
  ) {
    let customer: any;
    try {
      customer = await client.get<any>(`/customers/${externalId}`);
    } catch (error: any) {
      if (this.isAmoNotFoundError(error)) {
        await this.prisma.customer.deleteMany({ where: { externalId } });
        stats.webhookCustomersDeleted = (stats.webhookCustomersDeleted ?? 0) + 1;
        return;
      }
      throw error;
    }
    if (!customer?.id) {
      stats.webhookCustomersSkipped = (stats.webhookCustomersSkipped ?? 0) + 1;
      return;
    }
    const dbCustomer = await this.upsertCustomer(client, maps, customer);
    maps.customers.set(String(customer.id), dbCustomer.id);
    stats.webhookCustomers = (stats.webhookCustomers ?? 0) + 1;
  }

  private isAmoNotFoundError(error: any) {
    return String(error?.message ?? '').includes('amoCRM API 404');
  }

  private async syncOptional(name: string, stats: Record<string, number>, action: () => Promise<void>) {
    try {
      await action();
    } catch (error: any) {
      stats[`${name}Skipped`] = 1;
      this.logger.warn(`${name} sync skipped: ${error.message}`);
    }
  }

  private async recordWebhookSubscriptionError(connection: AmoConnection, error: any) {
    await this.updateConnectionConfig(connection.id, {
      webhookEnsureError: String(error?.message ?? error),
      webhookEnsureErrorAt: new Date().toISOString(),
    });
  }

  private async ensureWebhookSubscription(client: AmoClient, connection: AmoConnection, stats: Record<string, number>) {
    const destination = this.webhookDestination(connection);
    if (!destination) {
      stats.webhookSubscriptionNoUrl = 1;
      return;
    }

    const settings = this.webhookSettings();
    await client.post('/webhooks', {
      destination,
      settings,
      sort: 10,
    });

    await this.updateConnectionConfig(connection.id, {
      webhookUrl: destination,
      webhookSettings: settings,
      webhookEnsuredAt: new Date().toISOString(),
      webhookEnsureError: null,
      webhookEnsureErrorAt: null,
    });
    stats.webhookSubscription = 1;
  }

  private webhookDestination(connection: AmoConnection) {
    const base = this.config.get<string>('WEBHOOK_BASE_URL', '').replace(/\/$/, '');
    if (base) return `${base}/webhooks/amocrm/${connection.webhookSecret}`;
    const stored = (connection.config as any)?.webhookUrl;
    return typeof stored === 'string' && /^https:\/\//i.test(stored) ? stored : null;
  }

  private webhookSettings() {
    return [
      'add_lead',
      'update_lead',
      'delete_lead',
      'restore_lead',
      'status_lead',
      'responsible_lead',
      'note_lead',
      'add_contact',
      'update_contact',
      'delete_contact',
      'restore_contact',
      'responsible_contact',
      'note_contact',
      'add_company',
      'update_company',
      'delete_company',
      'restore_company',
      'responsible_company',
      'note_company',
      'add_customer',
      'update_customer',
      'delete_customer',
      'responsible_customer',
      'note_customer',
      'add_message',
      'add_outgoing_message',
      'add_task',
      'update_task',
      'delete_task',
      'responsible_task',
    ];
  }

  private async processCrmNotifications(
    stats: Record<string, number>,
    since: Date,
    domain: string,
    options: { includeEventDriven?: boolean; includeStateScans?: boolean } = {},
  ) {
    try {
      const result = await this.crmEventNotifications.processRecentAmoEvents({ since, domain, ...options });
      stats.notificationsChecked = result.checked;
      stats.paymentNotifications = result.payment;
      stats.workAcceptedNotifications = result.workAccepted;
      stats.assignedLeadNewNotifications = result.assignedLeadNew;
      stats.assignedLeadReminderNotifications = result.assignedLeadReminder;
      stats.taskMassMoveNotifications = result.taskMassMove;
      stats.dealMassMoveNotifications = result.dealMassMove;
      stats.csmTaskMassMoveNotifications = result.csmTaskMassMove;
      stats.csmDealMassMoveNotifications = result.csmDealMassMove;
      stats.csmOverdueTaskNotifications = result.csmOverdueTasks;
      stats.csmZeroTakenToWorkNotifications = result.csmZeroTakenToWork;
      stats.csmZeroOfferMadeNotifications = result.csmZeroOfferMade;
      stats.invoiceNoPaymentNotifications = result.invoiceNoPayment;
      stats.proposalStaleNotifications = result.proposalStale;
      stats.highValueIdleNotifications = result.highValueIdle;
      stats.notificationSkips = result.skipped;
    } catch (error: any) {
      stats.notificationErrors = 1;
      this.logger.warn(`CRM notifications skipped: ${error.message}`);
    }
  }

  private async syncAccount(client: AmoClient, stats: Record<string, number>) {
    const account = await client.get<any>('/account');
    const externalId = account?.id ? String(account.id) : client.domain;
    await this.prisma.amoAccountSnapshot.upsert({
      where: { externalId },
      create: {
        externalId,
        name: account?.name ?? null,
        subdomain: account?.subdomain ?? client.domain,
        raw: account ?? {},
      },
      update: {
        name: account?.name ?? null,
        subdomain: account?.subdomain ?? client.domain,
        raw: account ?? {},
      },
    });
    stats.account = 1;
  }

  private async syncMetadata(client: AmoClient, stats: Record<string, number>): Promise<AmoSyncMaps> {
    const maps = this.emptyMaps();

    const pipelines = await client.paginate<any>('/leads/pipelines', 'pipelines');
    for (const pipeline of pipelines) {
      const dbPipeline = await this.prisma.pipeline.upsert({
        where: { externalId: String(pipeline.id) },
        create: {
          externalId: String(pipeline.id),
          name: pipeline.name,
          isArchived: Boolean(pipeline.is_archive),
          raw: pipeline,
        },
        update: {
          name: pipeline.name,
          isArchived: Boolean(pipeline.is_archive),
          raw: pipeline,
        },
      });
      maps.pipelines.set(String(pipeline.id), dbPipeline.id);

      for (const status of pipeline._embedded?.statuses ?? []) {
        const statusExternalId = String(status.id);
        const isWon = status.type === 'win' || statusExternalId === '142';
        const isLost = status.type === 'loss' || statusExternalId === '143';
        const dbStage = await this.prisma.pipelineStage.upsert({
          where: {
            pipelineId_externalId: {
              pipelineId: dbPipeline.id,
              externalId: statusExternalId,
            },
          },
          create: {
            pipelineId: dbPipeline.id,
            externalId: statusExternalId,
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon,
            isLost,
            raw: status,
          },
          update: {
            name: status.name,
            position: Number(status.sort ?? 0),
            color: status.color ?? null,
            isWon,
            isLost,
            raw: status,
          },
        });
        maps.stages.set(`${pipeline.id}_${status.id}`, dbStage.id);
      }

      await this.syncLossReasons(client, dbPipeline.id, String(pipeline.id), maps);
    }

    const accountWithGroups = await client.get<any>('/account', { with: 'users_groups' });
    const groupNames = new Map<string, string>();
    for (const group of accountWithGroups?._embedded?.users_groups ?? []) {
      const externalId = String(group.id);
      if (externalId === '0') continue;
      const dbGroup = await this.prisma.crmGroup.upsert({
        where: { externalId },
        create: { externalId, name: group.name || `Group ${externalId}`, raw: group },
        update: { name: group.name || `Group ${externalId}`, raw: group },
      });
      groupNames.set(externalId, dbGroup.name);
    }

    const users = await client.paginate<any>('/users', 'users', { with: 'group' });
    for (const user of users) {
      const groupExternalId = user.rights?.group_id ? String(user.rights.group_id) : null;
      let groupId: string | null = null;
      if (groupExternalId) {
        const groupName =
          groupNames.get(groupExternalId) ??
          user._embedded?.group?.name ??
          user.rights?.group_name ??
          `Group ${groupExternalId}`;
        const group = await this.prisma.crmGroup.upsert({
          where: { externalId: groupExternalId },
          create: { externalId: groupExternalId, name: groupName, raw: user._embedded?.group ?? user.rights ?? {} },
          update: { name: groupName, raw: user._embedded?.group ?? user.rights ?? {} },
        });
        groupId = group.id;
      }

      const isActive = user.rights?.is_active !== false && user.is_free !== true;
      const dbUser = await this.prisma.crmUser.upsert({
        where: { externalId: String(user.id) },
        create: {
          externalId: String(user.id),
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive,
          raw: user,
        },
        update: {
          groupId,
          name: user.name || user.email || `Менеджер ${user.id}`,
          email: user.email ?? null,
          isActive,
          raw: user,
        },
      });
      maps.users.set(String(user.id), dbUser.id);
    }

    await this.syncOptional('roles', stats, async () => {
      const roles = await client.paginate<any>('/roles', 'roles');
      for (const role of roles) {
        await this.prisma.crmRole.upsert({
          where: { externalId: String(role.id) },
          create: {
            externalId: String(role.id),
            name: role.name || `Роль ${role.id}`,
            raw: role,
          },
          update: {
            name: role.name || `Роль ${role.id}`,
            raw: role,
          },
        });
      }
      stats.roles = roles.length;
    });

    stats.pipelines = maps.pipelines.size;
    stats.stages = maps.stages.size;
    stats.users = maps.users.size;
    return maps;
  }

  private async syncSources(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    const sources = await client.paginate<any>('/sources', 'sources');
    for (const source of sources) {
      await this.prisma.crmSource.upsert({
        where: { externalId: String(source.id) },
        create: {
          externalId: String(source.id),
          name: source.name || `Источник ${source.id}`,
          pipelineId: source.pipeline_id ? maps.pipelines.get(String(source.pipeline_id)) ?? null : null,
          originCode: source.origin_code ?? null,
          isDefault: Boolean(source.default),
          raw: source,
        },
        update: {
          name: source.name || `Источник ${source.id}`,
          pipelineId: source.pipeline_id ? maps.pipelines.get(String(source.pipeline_id)) ?? null : null,
          originCode: source.origin_code ?? null,
          isDefault: Boolean(source.default),
          raw: source,
        },
      });
    }
    stats.sources = sources.length;
  }

  private async syncTags(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entityType: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entityType: 'LEAD', path: '/leads/tags', key: 'tags' },
      { entityType: 'CONTACT', path: '/contacts/tags', key: 'tags' },
      { entityType: 'COMPANY', path: '/companies/tags', key: 'tags' },
      { entityType: 'CUSTOMER', path: '/customers/tags', key: 'tags' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entityType.toLowerCase()}Tags`, stats, async () => {
        const tags = await client.paginate<any>(source.path, source.key);
        for (const tag of tags) {
          await this.prisma.crmTag.upsert({
            where: {
              entityType_externalId: {
                entityType: source.entityType,
                externalId: String(tag.id ?? tag.name),
              },
            },
            create: {
              entityType: source.entityType,
              externalId: String(tag.id ?? tag.name),
              name: tag.name || `Тег ${tag.id}`,
              color: tag.color ?? null,
              raw: tag,
            },
            update: {
              name: tag.name || `Тег ${tag.id}`,
              color: tag.color ?? null,
              raw: tag,
            },
          });
        }
        count += tags.length;
      });
    }
    stats.tags = count;
  }

  private async syncCatalogs(client: AmoClient, stats: Record<string, number>) {
    const catalogs = await client.paginate<any>('/catalogs', 'catalogs');
    let elementCount = 0;
    for (const catalog of catalogs) {
      const dbCatalog = await this.prisma.catalog.upsert({
        where: { externalId: String(catalog.id) },
        create: {
          externalId: String(catalog.id),
          name: catalog.name || `Список ${catalog.id}`,
          type: catalog.type ?? null,
          sort: Number(catalog.sort ?? 0),
          canAddElements: Boolean(catalog.can_add_elements),
          canShowInCards: Boolean(catalog.can_show_in_cards),
          canLinkMultiple: Boolean(catalog.can_link_multiple),
          raw: catalog,
        },
        update: {
          name: catalog.name || `Список ${catalog.id}`,
          type: catalog.type ?? null,
          sort: Number(catalog.sort ?? 0),
          canAddElements: Boolean(catalog.can_add_elements),
          canShowInCards: Boolean(catalog.can_show_in_cards),
          canLinkMultiple: Boolean(catalog.can_link_multiple),
          raw: catalog,
        },
      });

      const elements = await client.paginate<any>(`/catalogs/${catalog.id}/elements`, 'elements');
      for (const element of elements) {
        await this.prisma.catalogElement.upsert({
          where: {
            catalogId_externalId: {
              catalogId: dbCatalog.id,
              externalId: String(element.id),
            },
          },
          create: {
            catalogId: dbCatalog.id,
            externalId: String(element.id),
            name: element.name || `Элемент ${element.id}`,
            customFields: this.parseCustomFields(element.custom_fields_values),
            raw: element,
            createdAt: toDateFromAmoTimestamp(element.created_at) ?? new Date(),
          },
          update: {
            name: element.name || `Элемент ${element.id}`,
            customFields: this.parseCustomFields(element.custom_fields_values),
            raw: element,
          },
        });
      }
      elementCount += elements.length;
    }
    stats.catalogs = catalogs.length;
    stats.catalogElements = elementCount;
  }

  private async syncCustomerMetadata(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    await this.syncOptional('customerStatuses', stats, async () => {
      const statuses = await client.paginate<any>('/customers/statuses', 'statuses');
      for (const status of statuses) {
        const dbStatus = await this.prisma.customerStatus.upsert({
          where: { externalId: String(status.id) },
          create: {
            externalId: String(status.id),
            name: status.name || `Статус ${status.id}`,
            sort: Number(status.sort ?? 0),
            color: status.color ?? null,
            raw: status,
          },
          update: {
            name: status.name || `Статус ${status.id}`,
            sort: Number(status.sort ?? 0),
            color: status.color ?? null,
            raw: status,
          },
        });
        maps.customerStatuses.set(String(status.id), dbStatus.id);
      }
      stats.customerStatuses = statuses.length;
    });

    await this.syncOptional('customerSegments', stats, async () => {
      const segments = await client.paginate<any>('/customers/segments', 'segments');
      for (const segment of segments) {
        await this.prisma.customerSegment.upsert({
          where: { externalId: String(segment.id) },
          create: {
            externalId: String(segment.id),
            name: segment.name || `Сегмент ${segment.id}`,
            raw: segment,
          },
          update: {
            name: segment.name || `Сегмент ${segment.id}`,
            raw: segment,
          },
        });
      }
      stats.customerSegments = segments.length;
    });
  }

  private async syncLossReasons(_client: AmoClient, pipelineId: string, pipelineExternalId: string, maps: AmoSyncMaps) {
    const reasons = await this.prisma.lossReason.findMany({ where: { pipelineId }, select: { id: true, externalId: true } });
    for (const reason of reasons) {
      maps.lossReasons.set(`${pipelineExternalId}_${reason.externalId}`, reason.id);
    }
  }

  private async syncCustomFieldDefinitions(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entity: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entity: 'LEAD', path: '/leads/custom_fields', key: 'custom_fields' },
      { entity: 'CONTACT', path: '/contacts/custom_fields', key: 'custom_fields' },
      { entity: 'COMPANY', path: '/companies/custom_fields', key: 'custom_fields' },
      { entity: 'CUSTOMER', path: '/customers/custom_fields', key: 'custom_fields' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entity.toLowerCase()}CustomFields`, stats, async () => {
        const fields = await client.paginate<any>(source.path, source.key);
        for (const field of fields) {
          await this.prisma.customFieldDefinition.upsert({
            where: {
              entityType_externalId: {
                entityType: source.entity,
                externalId: String(field.id),
              },
            },
            create: {
              entityType: source.entity,
              externalId: String(field.id),
              code: field.code ?? null,
              name: field.name,
              type: field.type,
              enums: field.enums ?? [],
              raw: field,
            },
            update: {
              code: field.code ?? null,
              name: field.name,
              type: field.type,
              enums: field.enums ?? [],
              raw: field,
            },
          });
        }
        count += fields.length;
      });
    }
    stats.customFields = count;
  }

  private async syncCompanies(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    let total = 0;
    await client.paginateBatch<any>('/companies', 'companies', params, async (companies) => {
      for (const company of companies) {
        const dbCompany = await this.prisma.crmCompany.upsert({
          where: { externalId: String(company.id) },
          create: {
            externalId: String(company.id),
            name: company.name || `Компания ${company.id}`,
            customFields: this.parseCustomFields(company.custom_fields_values),
            raw: company,
          },
          update: {
            name: company.name || `Компания ${company.id}`,
            customFields: this.parseCustomFields(company.custom_fields_values),
            raw: company,
          },
        });
        maps.companies.set(String(company.id), dbCompany.id);
      }
      total += companies.length;
    });
    stats.companies = total;
  }

  private async upsertCompany(company: any) {
    return this.prisma.crmCompany.upsert({
      where: { externalId: String(company.id) },
      create: {
        externalId: String(company.id),
        name: company.name || `Компания ${company.id}`,
        customFields: this.parseCustomFields(company.custom_fields_values),
        raw: company,
      },
      update: {
        name: company.name || `Компания ${company.id}`,
        customFields: this.parseCustomFields(company.custom_fields_values),
        raw: company,
      },
    });
  }

  private async hydrateExistingEntityMaps(maps: AmoSyncMaps) {
    const [contacts, companies] = await Promise.all([
      this.prisma.contact.findMany({ select: { id: true, externalId: true } }),
      this.prisma.crmCompany.findMany({ select: { id: true, externalId: true } }),
    ]);
    for (const contact of contacts) maps.contacts.set(contact.externalId, contact.id);
    for (const company of companies) maps.companies.set(company.externalId, company.id);
  }

  private async syncContacts(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    let total = 0;
    await client.paginateBatch<any>('/contacts', 'contacts', params, async (contacts) => {
      for (const contact of contacts) {
        const fields = this.parseCustomFields(contact.custom_fields_values);
        const dbContact = await this.prisma.contact.upsert({
          where: { externalId: String(contact.id) },
          create: {
            externalId: String(contact.id),
            name: contact.name || `Контакт ${contact.id}`,
            phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
            email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
            customFields: fields,
            raw: contact,
            createdAt: toDateFromAmoTimestamp(contact.created_at) ?? new Date(),
          },
          update: {
            name: contact.name || `Контакт ${contact.id}`,
            phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
            email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
            customFields: fields,
            raw: contact,
          },
        });
        maps.contacts.set(String(contact.id), dbContact.id);
      }
      total += contacts.length;
    });
    stats.contacts = total;
  }

  private async upsertContact(contact: any) {
    const fields = this.parseCustomFields(contact.custom_fields_values);
    return this.prisma.contact.upsert({
      where: { externalId: String(contact.id) },
      create: {
        externalId: String(contact.id),
        name: contact.name || `Контакт ${contact.id}`,
        phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
        email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
        customFields: fields,
        raw: contact,
        createdAt: toDateFromAmoTimestamp(contact.created_at) ?? new Date(),
      },
      update: {
        name: contact.name || `Контакт ${contact.id}`,
        phone: this.findFieldValue(contact.custom_fields_values, 'PHONE'),
        email: this.findFieldValue(contact.custom_fields_values, 'EMAIL'),
        customFields: fields,
        raw: contact,
      },
    });
  }

  private async syncDeals(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
    jobId?: string,
  ) {
    const params: Record<string, string | number> = { with: 'contacts,catalog_elements,loss_reason' };
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    let totalDeals = 0;
    await client.paginateBatch<any>('/leads', 'leads', params, async (leads, page) => {
      for (const lead of leads) {
        await this.upsertDeal(lead, maps);
      }
      totalDeals += leads.length;
      if (page % 20 === 1) {
        this.logger.log(`syncDeals: processed page ${page} (${totalDeals} deals so far)`);
        if (jobId) await this.touchJob(jobId, `deals:page${page}`);
      }
    });
    stats.deals = totalDeals;
  }

  private async syncRecentDeals(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince: number,
  ) {
    const maxDeals = this.getRecentReconcileMaxDeals();
    const pageLimit = Math.min(250, maxDeals);
    const params: Record<string, string | number> = {
      with: 'contacts,catalog_elements,loss_reason',
      'filter[updated_at][from]': updatedSince,
    };
    let page = 1;
    let totalDeals = 0;
    let hasNextPage = false;

    while (totalDeals < maxDeals) {
      const limit = Math.min(pageLimit, maxDeals - totalDeals);
      const data = await client.get<any>('/leads', { ...params, page, limit });
      const leads = data?._embedded?.leads ?? [];
      if (!Array.isArray(leads) || leads.length === 0) break;

      for (const lead of leads) {
        await this.upsertDeal(lead, maps);
      }

      totalDeals += leads.length;
      hasNextPage = Boolean(data?._links?.next?.href);
      if (!hasNextPage) break;
      page += 1;
    }

    stats.deals = totalDeals;
    stats.dealPages = page;
    if (hasNextPage && totalDeals >= maxDeals) stats.dealsTruncated = 1;
  }

  private async syncRecentStageEvents(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince: number,
  ) {
    const maxEvents = this.getRecentReconcileMaxEvents();
    const pageLimit = Math.min(250, maxEvents);
    const params: Record<string, string | number> = {
      'filter[created_at][from]': updatedSince,
      'filter[type]': 'lead_status_changed',
    };
    const eventsById = new Map<string, any>();
    let page = 1;
    let hasNextPage = false;

    while (eventsById.size < maxEvents) {
      const limit = Math.min(pageLimit, maxEvents - eventsById.size);
      const data = await client.get<any>('/events', { ...params, page, limit });
      const events = data?._embedded?.events ?? [];
      if (!Array.isArray(events) || events.length === 0) break;

      for (const event of events) {
        eventsById.set(String(event.id), event);
      }

      hasNextPage = Boolean(data?._links?.next?.href);
      if (!hasNextPage) break;
      page += 1;
    }

    for (const event of eventsById.values()) {
      await this.upsertCrmEvent(event, maps);
    }

    stats.events = eventsById.size;
    stats.eventPages = page;
    if (hasNextPage && eventsById.size >= maxEvents) stats.eventsTruncated = 1;
    await this.backfillStageHistoryFromStoredEvents(maps, stats, updatedSince);
  }

  private async reconcileLeadSlaDeals(client: AmoClient, maps: AmoSyncMaps, stats: Record<string, number>) {
    const candidates = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        pipeline: { isArchived: false, name: { contains: '\u043f\u0440\u043e\u0434\u0430\u0436', mode: 'insensitive' } },
        stage: { isWon: false, isLost: false, name: { contains: '\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d', mode: 'insensitive' } },
      },
      include: {
        pipeline: true,
        stage: true,
      },
      take: 1000,
    });

    const slaCandidates = candidates.filter((deal) =>
      this.isSalesPipelineName(deal.pipeline?.name) && this.isAssignedResponsibleStageName(deal.stage?.name),
    );

    let checked = 0;
    let removed = 0;
    let refreshed = 0;
    for (const deal of slaCandidates) {
      checked += 1;
      try {
        const lead = await client.get<any>(`/leads/${deal.externalId}`, { with: 'contacts,catalog_elements,loss_reason' });
        if (!lead) {
          await this.prisma.deal.update({
            where: { id: deal.id },
            data: { deletedAt: new Date(), updatedAt: new Date() },
          });
          removed += 1;
          continue;
        }

        await this.upsertDeal(lead, maps);
        refreshed += 1;
      } catch (error: any) {
        if (String(error?.message ?? '').includes('amoCRM API 404')) {
          await this.prisma.deal.update({
            where: { id: deal.id },
            data: { deletedAt: new Date(), updatedAt: new Date() },
          });
          removed += 1;
        } else {
          this.logger.warn(`Lead SLA reconcile skipped for ${deal.externalId}: ${error.message}`);
        }
      }
    }

    stats.leadSlaReconcileChecked = checked;
    stats.leadSlaReconcileRemoved = removed;
    stats.leadSlaReconcileRefreshed = refreshed;
  }

  private async syncCustomers(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    const customers = await client.paginate<any>('/customers', 'customers', params);
    let transactionCount = 0;

    for (const customer of customers) {
      const statusId = customer.status_id ? maps.customerStatuses.get(String(customer.status_id)) ?? null : null;
      const dbCustomer = await this.prisma.customer.upsert({
        where: { externalId: String(customer.id) },
        create: {
          externalId: String(customer.id),
          statusId,
          name: customer.name || `Покупатель ${customer.id}`,
          nextPrice: Number(customer.next_price ?? 0),
          periodicity: customer.periodicity ? Number(customer.periodicity) : null,
          responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
          customFields: this.parseCustomFields(customer.custom_fields_values),
          raw: customer,
          createdAt: toDateFromAmoTimestamp(customer.created_at) ?? new Date(),
        },
        update: {
          statusId,
          name: customer.name || `Покупатель ${customer.id}`,
          nextPrice: Number(customer.next_price ?? 0),
          periodicity: customer.periodicity ? Number(customer.periodicity) : null,
          responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
          customFields: this.parseCustomFields(customer.custom_fields_values),
          raw: customer,
        },
      });
      maps.customers.set(String(customer.id), dbCustomer.id);

      transactionCount += await this.syncCustomerTransactions(client, dbCustomer.id, String(customer.id));
    }

    stats.customers = customers.length;
    stats.customerTransactions = transactionCount;
  }

  private async upsertCustomer(client: AmoClient, maps: AmoSyncMaps, customer: any) {
    const statusId = customer.status_id ? maps.customerStatuses.get(String(customer.status_id)) ?? null : null;
    const dbCustomer = await this.prisma.customer.upsert({
      where: { externalId: String(customer.id) },
      create: {
        externalId: String(customer.id),
        statusId,
        name: customer.name || `Покупатель ${customer.id}`,
        nextPrice: Number(customer.next_price ?? 0),
        periodicity: customer.periodicity ? Number(customer.periodicity) : null,
        responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
        customFields: this.parseCustomFields(customer.custom_fields_values),
        raw: customer,
        createdAt: toDateFromAmoTimestamp(customer.created_at) ?? new Date(),
      },
      update: {
        statusId,
        name: customer.name || `Покупатель ${customer.id}`,
        nextPrice: Number(customer.next_price ?? 0),
        periodicity: customer.periodicity ? Number(customer.periodicity) : null,
        responsibleId: customer.responsible_user_id ? maps.users.get(String(customer.responsible_user_id)) ?? null : null,
        customFields: this.parseCustomFields(customer.custom_fields_values),
        raw: customer,
      },
    });
    await this.syncCustomerTransactions(client, dbCustomer.id, String(customer.id));
    return dbCustomer;
  }

  private isSalesPipelineName(name?: string | null) {
    return this.normalizeText(name).includes(this.normalizeText('\u043f\u0440\u043e\u0434\u0430\u0436'));
  }

  private isAssignedResponsibleStageName(name?: string | null) {
    const normalized = this.normalizeText(name);
    return normalized.includes(this.normalizeText('\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d')) &&
      normalized.includes(this.normalizeText('\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439'));
  }

  private normalizeText(value?: string | null) {
    return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  }

  private async syncCustomerTransactions(client: AmoClient, customerId: string, customerExternalId: string) {
    const transactions = await client.paginate<any>(`/customers/${customerExternalId}/transactions`, 'transactions');
    for (const transaction of transactions) {
      await this.prisma.customerTransaction.upsert({
        where: { externalId: String(transaction.id) },
        create: {
          externalId: String(transaction.id),
          customerId,
          amount: Number(transaction.price ?? transaction.amount ?? 0),
          comment: transaction.comment ?? null,
          raw: transaction,
          createdAt: toDateFromAmoTimestamp(transaction.created_at) ?? new Date(),
        },
        update: {
          customerId,
          amount: Number(transaction.price ?? transaction.amount ?? 0),
          comment: transaction.comment ?? null,
          raw: transaction,
        },
      });
    }
    return transactions.length;
  }

  private async syncEntityLinks(client: AmoClient, stats: Record<string, number>) {
    const sources: Array<{ entityType: 'LEAD' | 'CONTACT' | 'COMPANY' | 'CUSTOMER'; path: string; key: string }> = [
      { entityType: 'LEAD', path: '/leads/links', key: 'links' },
      { entityType: 'CONTACT', path: '/contacts/links', key: 'links' },
      { entityType: 'COMPANY', path: '/companies/links', key: 'links' },
      { entityType: 'CUSTOMER', path: '/customers/links', key: 'links' },
    ];

    let count = 0;
    for (const source of sources) {
      await this.syncOptional(`${source.entityType.toLowerCase()}Links`, stats, async () => {
        const links = await client.paginate<any>(source.path, source.key);
        for (const link of links) {
          const entityExternalId = this.extractLinkEntityId(link);
          const linkedEntityExternalId = this.extractLinkedEntityId(link);
          const linkedEntityType = this.extractLinkedEntityType(link);
          if (!entityExternalId || !linkedEntityExternalId || !linkedEntityType) continue;

          await this.prisma.entityLink.upsert({
            where: {
              entityType_entityExternalId_linkedEntityType_linkedEntityExternalId: {
                entityType: source.entityType,
                entityExternalId,
                linkedEntityType,
                linkedEntityExternalId,
              },
            },
            create: {
              entityType: source.entityType,
              entityExternalId,
              linkedEntityType,
              linkedEntityExternalId,
              metadata: link.metadata ?? {},
              raw: link,
            },
            update: {
              metadata: link.metadata ?? {},
              raw: link,
            },
          });
          count += 1;
        }
      });
    }
    stats.entityLinks = count;
  }

  private async upsertDeal(lead: any, maps: AmoSyncMaps) {
    const pipelineId = maps.pipelines.get(String(lead.pipeline_id));
    const stageId = maps.stages.get(`${lead.pipeline_id}_${lead.status_id}`);
    if (!pipelineId || !stageId) return;

    const stage = await this.prisma.pipelineStage.findUnique({ where: { id: stageId } });
    const contactExternalId = lead._embedded?.contacts?.[0]?.id ? String(lead._embedded.contacts[0].id) : null;
    const contactId = contactExternalId ? maps.contacts.get(contactExternalId) ?? null : null;
    const responsibleId = lead.responsible_user_id ? maps.users.get(String(lead.responsible_user_id)) ?? null : null;
    const lossReasonId = lead.loss_reason_id
      ? await this.resolveLeadLossReasonId(lead, pipelineId, maps)
      : null;
    const closedAt =
      toDateFromAmoTimestamp(lead.closed_at) ??
      (stage?.isWon ? toDateFromAmoTimestamp(lead.updated_at) : null);

    const existing = await this.prisma.deal.findUnique({
      where: { externalId: String(lead.id) },
      select: { id: true, stageId: true, responsibleId: true },
    });

    const data = {
      pipelineId,
      stageId,
      responsibleId,
      contactId,
      lossReasonId,
      title: lead.name || `Сделка ${lead.id}`,
      amount: Number(lead.price ?? 0),
      currency: 'RUB',
      source: this.extractSource(lead),
      tags: (lead._embedded?.tags ?? []).map((tag: any) => tag.name).filter(Boolean),
      customFields: this.parseCustomFields(lead.custom_fields_values),
      raw: lead,
      closedAt,
      expectedCloseAt: toDateFromAmoTimestamp(lead.closest_task_at),
      createdAt: toDateFromAmoTimestamp(lead.created_at) ?? new Date(),
      updatedAt: toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
    };

    const deal = existing
      ? await this.prisma.deal.update({ where: { id: existing.id }, data })
      : await this.prisma.deal.create({ data: { externalId: String(lead.id), ...data } });

    if (!existing) {
      await this.createStageHistoryIfMissing(deal.id, null, stageId, data.createdAt, 'initial_sync', lead);
    } else {
      if (existing.stageId !== stageId) {
        await this.createStageHistoryIfMissing(
          existing.id,
          existing.stageId,
          stageId,
          toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
          'sync',
          lead,
        );
      }
      if (existing.responsibleId !== responsibleId) {
        await this.prisma.dealResponsibleHistory.create({
          data: {
            dealId: existing.id,
            fromUserId: existing.responsibleId,
            toUserId: responsibleId,
            changedAt: toDateFromAmoTimestamp(lead.updated_at) ?? new Date(),
            raw: lead,
          },
        }).catch(() => undefined);
      }
    }

    await this.syncDealProducts(deal.id, lead);
  }

  private async resolveLeadLossReasonId(lead: any, pipelineId: string, maps: AmoSyncMaps) {
    const externalId = String(lead.loss_reason_id);
    const mapKey = `${lead.pipeline_id}_${externalId}`;
    const mapped = maps.lossReasons.get(mapKey);
    if (mapped) return mapped;

    const embeddedReason = this.extractLeadLossReason(lead);
    const name = embeddedReason?.name || `Причина ${externalId}`;
    const dbReason = await this.prisma.lossReason.upsert({
      where: {
        pipelineId_externalId: {
          pipelineId,
          externalId,
        },
      },
      create: {
        pipelineId,
        externalId,
        name,
        raw: embeddedReason ?? { id: externalId, name },
      },
      update: {
        name,
        raw: embeddedReason ?? { id: externalId, name },
      },
    });
    maps.lossReasons.set(mapKey, dbReason.id);
    return dbReason.id;
  }

  private extractLeadLossReason(lead: any) {
    const reason = lead._embedded?.loss_reason;
    if (Array.isArray(reason)) return reason[0] ?? null;
    return reason ?? null;
  }

  private async backfillLossReasonsFromRaw(stats: Record<string, number>) {
    let total = 0;
    while (true) {
      const deals = await this.prisma.deal.findMany({
        where: {
          lossReasonId: null,
          raw: { path: ['loss_reason_id'], not: Prisma.JsonNull } as any,
        },
        select: { id: true, pipelineId: true, raw: true },
        take: 50_000,
      });
      if (!deals.length) break;

      const grouped = new Map<
        string,
        { pipelineId: string; externalId: string; name: string; raw: any; dealIds: string[] }
      >();
      for (const deal of deals) {
        const raw = deal.raw as any;
        const externalId = raw?.loss_reason_id ? String(raw.loss_reason_id) : null;
        if (!externalId) continue;
        const embeddedReason = this.extractLeadLossReason(raw);
        const name = embeddedReason?.name || `Причина ${externalId}`;
        const key = `${deal.pipelineId}_${externalId}`;
        if (!grouped.has(key)) {
          grouped.set(key, {
            pipelineId: deal.pipelineId,
            externalId,
            name,
            raw: embeddedReason ?? { id: externalId, name },
            dealIds: [],
          });
        }
        grouped.get(key)!.dealIds.push(deal.id);
      }

      let changed = 0;
      for (const group of grouped.values()) {
        const dbReason = await this.prisma.lossReason.upsert({
          where: {
            pipelineId_externalId: {
              pipelineId: group.pipelineId,
              externalId: group.externalId,
            },
          },
          create: {
            pipelineId: group.pipelineId,
            externalId: group.externalId,
            name: group.name,
            raw: group.raw,
          },
          update: {
            name: group.name,
            raw: group.raw,
          },
        });
        const result = await this.prisma.deal.updateMany({
          where: {
            id: { in: group.dealIds },
            lossReasonId: null,
          },
          data: { lossReasonId: dbReason.id },
        });
        changed += result.count;
      }
      total += changed;
      if (!changed) break;
    }
    stats.lossReasonsBackfilled = total;
  }

  private async syncTasks(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params = updatedSince ? { 'filter[updated_at][from]': updatedSince } : {};
    let total = 0;
    await client.paginateBatch<any>('/tasks', 'tasks', params, async (tasks) => {
      for (const task of tasks) {
        await this.upsertTask(task, maps);
      }
      total += tasks.length;
    });
    stats.tasks = total;
  }

  private async upsertTask(task: any, maps: AmoSyncMaps) {
    if (!task?.id) return null;

    let dealId: string | null = null;
    const leadExternalId = this.taskLeadExternalId(task);
    if (leadExternalId) {
      const deal = await this.prisma.deal.findUnique({
        where: { externalId: leadExternalId },
        select: { id: true },
      });
      dealId = deal?.id ?? null;
    }

    return this.prisma.task.upsert({
      where: { externalId: String(task.id) },
      create: {
        externalId: String(task.id),
        dealId,
        responsibleId: task.responsible_user_id ? maps.users.get(String(task.responsible_user_id)) ?? null : null,
        title: task.text || `Задача ${task.id}`,
        typeId: task.task_type_id ?? null,
        typeName: task.task_type ?? null,
        dueAt: toDateFromAmoTimestamp(task.complete_till),
        completedAt: task.is_completed ? toDateFromAmoTimestamp(task.updated_at) ?? new Date() : null,
        isCompleted: Boolean(task.is_completed),
        createdAt: toDateFromAmoTimestamp(task.created_at) ?? new Date(),
        updatedAt: toDateFromAmoTimestamp(task.updated_at) ?? new Date(),
        raw: task,
      },
      update: {
        dealId,
        responsibleId: task.responsible_user_id ? maps.users.get(String(task.responsible_user_id)) ?? null : null,
        title: task.text || `Задача ${task.id}`,
        typeId: task.task_type_id ?? null,
        typeName: task.task_type ?? null,
        dueAt: toDateFromAmoTimestamp(task.complete_till),
        completedAt: task.is_completed ? toDateFromAmoTimestamp(task.updated_at) ?? new Date() : null,
        isCompleted: Boolean(task.is_completed),
        createdAt: toDateFromAmoTimestamp(task.created_at) ?? undefined,
        updatedAt: toDateFromAmoTimestamp(task.updated_at) ?? undefined,
        raw: task,
      },
    });
  }

  private taskLeadExternalId(task: any) {
    if (!task || typeof task !== 'object') return null;
    const directLeadId = task.lead_id ?? task.leadId;
    if (directLeadId != null) return String(directLeadId);

    const entityId = task.entity_id ?? task.element_id;
    if (entityId == null) return null;
    const entityType = task.entity_type ?? task.element_type ?? task.entity;
    return this.isLeadEntityType(entityType) ? String(entityId) : null;
  }

  private webhookTaskLeadExternalId(payloads: Prisma.JsonValue[]) {
    for (const payload of payloads) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
      const item = payload as Record<string, any>;
      const leadExternalId = this.taskLeadExternalId(item);
      if (leadExternalId) return leadExternalId;
    }
    return null;
  }

  private isLeadEntityType(value: unknown) {
    const normalized = String(value ?? '').toLowerCase();
    return normalized === '2' || normalized.includes('lead');
  }

  private async syncNotes(client: AmoClient, stats: Record<string, number>, updatedSince?: number) {
    const params: Record<string, string | number> = {};
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    let total = 0;
    for (const source of ['leads', 'contacts', 'companies']) {
      try {
        await client.paginateBatch<any>(`/${source}/notes`, 'notes', params, async (notes) => {
          for (const note of notes) {
            await this.upsertNote(source, note);
          }
          total += notes.length;
        });
      } catch (error: any) {
        if (source === 'leads') throw error;
        stats[`${source}NotesSkipped`] = 1;
        this.logger.warn(`${source} notes sync skipped: ${error.message}`);
        continue;
      }
    }
    stats.notes = total;
  }

  private async syncEmailNotes(client: AmoClient, stats: Record<string, number>, updatedSince?: number) {
    const params: Record<string, string | number> = {};
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    let total = 0;
    let emailTotal = 0;
    const affectedDealIds = new Set<string>();
    for (const source of ['leads', 'contacts']) {
      try {
        await client.paginateBatch<any>(`/${source}/notes`, 'notes', params, async (notes) => {
          for (const note of notes) {
            total += 1;
            if (note.note_type !== 'amomail_message') continue;
            for (const dealId of await this.upsertNote(source, note)) affectedDealIds.add(dealId);
            emailTotal += 1;
          }
        });
      } catch (error: any) {
        stats[`${source}EmailNotesErrors`] = (stats[`${source}EmailNotesErrors`] ?? 0) + 1;
        this.logger.warn(`${source} email notes sync skipped: ${error.message}`);
      }
    }
    stats.emailNotesScanned = total;
    stats.emailNotes = emailTotal;
    stats.emailNotesAffectedDeals = affectedDealIds.size;
    return [...affectedDealIds];
  }

  private async syncWebhookRelatedNotes(
    client: AmoClient,
    groups: WebhookEventGroup[],
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const leadExternalIds = this.webhookLeadExternalIds(groups);
    const contactExternalIds = this.webhookExternalIds(groups, 'contacts');
    if (leadExternalIds.length === 0 && contactExternalIds.length === 0) return;

    const params: Record<string, string | number> = {};
    if (updatedSince) params['filter[updated_at][from]'] = updatedSince;

    let total = 0;
    let emailTotal = 0;
    for (const leadExternalId of leadExternalIds) {
      try {
        await client.paginateBatch<any>(`/leads/${leadExternalId}/notes`, 'notes', params, async (notes) => {
          for (const note of notes) {
            await this.upsertNote('leads', note);
            if (note.note_type === 'amomail_message') emailTotal += 1;
          }
          total += notes.length;
        });
      } catch (error: any) {
        stats.webhookNotesErrors = (stats.webhookNotesErrors ?? 0) + 1;
        this.logger.warn(`Lead ${leadExternalId} notes webhook sync skipped: ${error.message}`);
      }
    }
    for (const contactExternalId of contactExternalIds) {
      try {
        await client.paginateBatch<any>(`/contacts/${contactExternalId}/notes`, 'notes', params, async (notes) => {
          for (const note of notes) {
            await this.upsertNote('contacts', note);
            if (note.note_type === 'amomail_message') emailTotal += 1;
          }
          total += notes.length;
        });
      } catch (error: any) {
        stats.webhookNotesErrors = (stats.webhookNotesErrors ?? 0) + 1;
        this.logger.warn(`Contact ${contactExternalId} notes webhook sync skipped: ${error.message}`);
      }
    }

    stats.webhookNotes = total;
    stats.webhookEmailNotes = emailTotal;
  }

  private async upsertNote(source: string, note: any) {
    const deal = source === 'leads' && note.entity_id
      ? await this.prisma.deal.findUnique({ where: { externalId: String(note.entity_id) }, select: { id: true } })
      : null;
    const noteType = note.note_type ?? 'unknown';
    await this.prisma.note.upsert({
      where: { externalId: String(note.id) },
      create: {
        externalId: String(note.id),
        dealId: deal?.id ?? null,
        type: noteType,
        text: note.params?.text ?? null,
        createdAt: toDateFromAmoTimestamp(note.created_at) ?? new Date(),
        raw: note,
      },
      update: {
        dealId: deal?.id ?? null,
        type: noteType,
        text: note.params?.text ?? null,
        raw: note,
      },
    });

    if (noteType !== 'amomail_message') return deal?.id ? [deal.id] : [];
    if (deal?.id) return [deal.id];
    if (source !== 'contacts' || !note.entity_id) return [];

    const deals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        stage: { isWon: false, isLost: false },
        contact: { externalId: String(note.entity_id) },
      },
      select: { id: true },
    });
    return deals.map((item) => item.id);
  }

  private async syncEvents(
    client: AmoClient,
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const params: Record<string, string | number> = {};
    if (updatedSince) {
      params['filter[created_at][from]'] = updatedSince;
    } else {
      params['filter[created_at][from]'] = Math.floor(Date.now() / 1000) - 90 * 86400;
    }

    const eventsById = new Map<string, any>();
    const ingest = async (eventParams: Record<string, string | number>) => {
      await client.paginateBatch<any>('/events', 'events', eventParams, async (events) => {
        for (const event of events) eventsById.set(String(event.id), event);
      });
    };

    await ingest(params);
    for (const type of this.extraEventTypes()) {
      await ingest({ ...params, 'filter[type]': type });
    }

    const events = [...eventsById.values()];
    for (const event of events) {
      await this.upsertCrmEvent(event, maps);
    }
    stats.events = events.length;
    await this.backfillStageHistoryFromStoredEvents(maps, stats, updatedSince);
  }

  private async syncWebhookRelatedEvents(
    client: AmoClient,
    maps: AmoSyncMaps,
    groups: WebhookEventGroup[],
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const entityGroups = [
      { entity: 'lead', ids: this.webhookLeadExternalIds(groups) },
      { entity: 'contact', ids: this.webhookExternalIds(groups, 'contacts') },
    ];
    if (entityGroups.every((group) => group.ids.length === 0)) return;

    let total = 0;
    let mailTotal = 0;
    for (const group of entityGroups) {
      for (const externalId of group.ids) {
        const params: Record<string, string | number> = {
          'filter[entity]': group.entity,
          'filter[entity_id][]': externalId,
        };
        if (updatedSince) params['filter[created_at][from]'] = updatedSince;

        const eventsById = new Map<string, any>();
        const ingest = async (eventParams: Record<string, string | number>) => {
          await client.paginateBatch<any>('/events', 'events', eventParams, async (events) => {
            for (const event of events) eventsById.set(String(event.id), event);
          });
        };

        try {
          await ingest(params);
          for (const type of this.extraEventTypes()) {
            await ingest({ ...params, 'filter[type]': type });
          }
        } catch (error: any) {
          stats.webhookEventSyncErrors = (stats.webhookEventSyncErrors ?? 0) + 1;
          this.logger.warn(`${group.entity} ${externalId} events webhook sync skipped: ${error.message}`);
          continue;
        }

        for (const event of eventsById.values()) {
          await this.upsertCrmEvent(event, maps);
          if (this.isEmailCrmEvent(event)) mailTotal += 1;
        }
        total += eventsById.size;
      }
    }

    stats.webhookEventsSynced = total;
    stats.webhookMailEvents = mailTotal;
  }

  private async upsertCrmEvent(event: any, maps: AmoSyncMaps) {
    const dealExternalId = this.getEventDealExternalId(event);
    const deal = dealExternalId
      ? await this.prisma.deal.findUnique({ where: { externalId: dealExternalId }, select: { id: true } })
      : null;
    await this.prisma.crmEvent.upsert({
      where: { externalId: String(event.id) },
      create: {
        externalId: String(event.id),
        dealId: deal?.id ?? null,
        type: event.type ?? 'unknown',
        valueBefore: event.value_before ?? undefined,
        valueAfter: event.value_after ?? undefined,
        createdAt: toDateFromAmoTimestamp(event.created_at) ?? new Date(),
        raw: event,
      },
      update: {
        dealId: deal?.id ?? null,
        type: event.type ?? 'unknown',
        valueBefore: event.value_before ?? undefined,
        valueAfter: event.value_after ?? undefined,
        raw: event,
      },
    });
    if (deal?.id) {
      await this.applyEventToStageHistory(event, deal.id, maps);
    }
  }

  private webhookLeadExternalIds(groups: WebhookEventGroup[]) {
    return this.webhookExternalIds(groups, 'leads');
  }

  private webhookExternalIds(groups: WebhookEventGroup[], entity: string) {
    return [...new Set(groups
      .filter((group) => group.entity === entity && group.externalId)
      .map((group) => group.externalId as string))];
  }

  private extraEventTypes() {
    const configured = this.config.get<string>('AMOCRM_EXTRA_EVENT_TYPES');
    const eventTypes = new Set(['custom_field_809047_value_changed', 'incoming_mail', 'outgoing_mail']);
    for (const type of configured?.split(',') ?? []) {
      const clean = type.trim();
      if (clean) eventTypes.add(clean);
    }
    return [...eventTypes];
  }

  private isEmailCrmEvent(event: any) {
    return event?.type === 'incoming_mail' || event?.type === 'outgoing_mail';
  }

  private async backfillStageHistoryFromStoredEvents(
    maps: AmoSyncMaps,
    stats: Record<string, number>,
    updatedSince?: number,
  ) {
    const where: Record<string, any> = {
      type: 'lead_status_changed',
      dealId: { not: null },
    };
    if (updatedSince) {
      where.createdAt = { gte: new Date(updatedSince * 1000) };
    }

    const events = await this.prisma.crmEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      select: {
        externalId: true,
        dealId: true,
        valueBefore: true,
        valueAfter: true,
        createdAt: true,
        raw: true,
      },
    });

    for (const event of events) {
      if (!event.dealId) continue;
      await this.applyEventToStageHistory(
        {
          ...(event.raw as Record<string, any>),
          id: event.externalId,
          value_before: event.valueBefore,
          value_after: event.valueAfter,
          created_at: Math.floor(event.createdAt.getTime() / 1000),
        },
        event.dealId,
        maps,
      );
    }
    stats.stageHistoryBackfilled = events.length;
  }

  private async applyEventToStageHistory(event: any, dealId: string, maps: AmoSyncMaps) {
    const after = this.extractStatusFromEvent(event.value_after);
    if (!after?.statusId || !after?.pipelineId) return;

    const before = this.extractStatusFromEvent(event.value_before);
    const toStageId = maps.stages.get(`${after.pipelineId}_${after.statusId}`);
    const fromStageId = before?.statusId && before.pipelineId
      ? maps.stages.get(`${before.pipelineId}_${before.statusId}`) ?? null
      : null;
    if (!toStageId) return;
    if (fromStageId && fromStageId === toStageId) return;

    await this.createStageHistoryIfMissing(
      dealId,
      fromStageId,
      toStageId,
      toDateFromAmoTimestamp(event.created_at) ?? new Date(),
      'crm_event',
      event,
    );
  }

  private extractStatusFromEvent(value: any): { pipelineId?: string; statusId?: string } | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const status = raw?.lead_status ?? raw?.status ?? raw;
    const statusId = status?.id ?? status?.status_id;
    const pipelineId = status?.pipeline_id ?? status?.pipeline?.id;
    if (!statusId) return null;
    return { statusId: String(statusId), pipelineId: pipelineId ? String(pipelineId) : undefined };
  }

  private async createStageHistoryIfMissing(
    dealId: string,
    fromStageId: string | null,
    toStageId: string,
    movedAt: Date,
    source: string,
    raw: any,
  ) {
    const existing = await this.prisma.dealStageHistory.findFirst({
      where: { dealId, fromStageId, toStageId, movedAt },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.dealStageHistory.create({
      data: {
        dealId,
        fromStageId,
        toStageId,
        movedAt,
        source,
        raw,
      },
    });
  }

  private async syncDealProducts(dealId: string, lead: any) {
    const catalogElements = lead._embedded?.catalog_elements ?? [];
    await this.prisma.dealProduct.deleteMany({ where: { dealId } });
    if (!Array.isArray(catalogElements) || catalogElements.length === 0) return;

    await this.prisma.dealProduct.createMany({
      data: catalogElements.map((item: any) => ({
        dealId,
        externalId: item.id ? String(item.id) : null,
        name: item.metadata?.catalog_element_name ?? item.name ?? 'Товар',
        sku: item.metadata?.sku ?? null,
        quantity: Number(item.metadata?.quantity ?? 1),
        price: Number(item.metadata?.unit_price ?? item.metadata?.price ?? 0),
        raw: item,
      })),
    });
  }

  private async recalculateStageProbabilities() {
    const stages = await this.prisma.pipelineStage.findMany({
      where: { isWon: false, isLost: false },
      include: { pipeline: true },
    });
    const wonStages = await this.prisma.pipelineStage.findMany({
      where: { isWon: true },
      select: { id: true },
    });
    const wonStageIds = new Set(wonStages.map((stage) => stage.id));

    for (const stage of stages) {
      const dealIdsInStage = await this.prisma.dealStageHistory.findMany({
        where: {
          toStageId: stage.id,
          NOT: [{ fromStageId: stage.id }],
        },
        distinct: ['dealId'],
        select: { dealId: true },
      });
      const sampleSize = dealIdsInStage.length;
      let wonCount = 0;
      if (sampleSize > 0) {
        wonCount = await this.prisma.dealStageHistory.count({
          where: {
            dealId: { in: dealIdsInStage.map((item) => item.dealId) },
            toStageId: { in: [...wonStageIds] },
            NOT: [{ fromStageId: { in: [...wonStageIds] } }],
          },
        });
      }

      const autoPercent = sampleSize <= 2 ? 0 : (wonCount / sampleSize) * 100;
      const confidence = sampleSize <= 2 ? 0 : Math.min(1, sampleSize / 30);

      await this.prisma.stageProbability.upsert({
        where: { stageId: stage.id },
        create: { stageId: stage.id, autoPercent, sampleSize, confidence },
        update: { autoPercent, sampleSize, confidence },
      });
    }
  }

  private parseCustomFields(fields: any[] | null | undefined): Record<string, any> {
    const result: Record<string, any> = {};
    for (const field of fields ?? []) {
      const key = String(field.field_id);
      const values = (field.values ?? []).map((value: any) => value.value ?? value.enum_id ?? null);
      result[key] = {
        name: field.field_name,
        code: field.field_code,
        values,
        value: values.length <= 1 ? values[0] ?? null : values,
      };
    }
    return result;
  }

  private findFieldValue(fields: any[] | null | undefined, code: string): string | null {
    const field = (fields ?? []).find((item) => item.field_code === code || item.field_name === code);
    return field?.values?.[0]?.value ?? null;
  }

  private extractSource(lead: any): string | null {
    const fields = this.parseCustomFields(lead.custom_fields_values);
    for (const field of Object.values(fields)) {
      if (typeof field === 'object' && (field as any).code === 'SOURCE_ID') {
        return String((field as any).value ?? '') || null;
      }
    }
    return null;
  }

  private getEventDealExternalId(event: any): string | null {
    const entityId = event.entity_id ?? event.entity?.id;
    const entityType = event.entity_type ?? event.entity;
    if (!entityId) return null;
    if (String(entityType).includes('lead')) return String(entityId);
    return null;
  }

  private extractLinkEntityId(link: any): string | null {
    const value = link.entity_id ?? link.from_entity_id ?? link.from_entity?.id ?? link._embedded?.entity?.id;
    return value === null || value === undefined ? null : String(value);
  }

  private extractLinkedEntityId(link: any): string | null {
    const value = link.to_entity_id ?? link.linked_entity_id ?? link.to_entity?.id ?? link._embedded?.to_entity?.id;
    return value === null || value === undefined ? null : String(value);
  }

  private extractLinkedEntityType(link: any): string | null {
    const value = link.to_entity_type ?? link.linked_entity_type ?? link.to_entity?.type ?? link._embedded?.to_entity?.type;
    return value === null || value === undefined ? null : String(value);
  }
}
