import { Controller, Get } from '@nestjs/common';
import { ApiRuntimeMetrics } from '../common/api-memory.interceptor';
import { PrismaService } from '../prisma/prisma.service';

const MB = 1024 * 1024;
const PROCESS_STARTED_AT = new Date();

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    const now = Date.now();
    const connection = await this.prisma.amoConnection.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, lastError: true, lastFullSyncAt: true, lastIncrementalSyncAt: true },
    });

    const [
      pendingRawAmoEvents,
      readyRawAmoEvents,
      failedRawAmoEvents,
      oldestPendingRawAmoEvent,
      lastAppliedRawAmoEvent,
      reportJobCounts,
      oldestReportJob,
      staleSnapshots,
      workers,
    ] = await Promise.all([
      connection
        ? this.prisma.rawAmoEventInbox.count({
            where: { connectionId: connection.id, appliedAt: null, status: { in: ['received', 'error'] } },
          })
        : 0,
      connection
        ? this.prisma.rawAmoEventInbox.count({
            where: {
              connectionId: connection.id,
              appliedAt: null,
              status: { in: ['received', 'error'] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
            },
          })
        : 0,
      connection ? this.prisma.rawAmoEventInbox.count({ where: { connectionId: connection.id, status: 'error' } }) : 0,
      connection
        ? this.prisma.rawAmoEventInbox.findFirst({
            where: { connectionId: connection.id, appliedAt: null, status: { in: ['received', 'error'] } },
            orderBy: { receivedAt: 'asc' },
            select: { receivedAt: true },
          })
        : null,
      connection
        ? this.prisma.rawAmoEventInbox.findFirst({
            where: { connectionId: connection.id, appliedAt: { not: null } },
            orderBy: { appliedAt: 'desc' },
            select: { receivedAt: true, appliedAt: true, amoUpdatedAt: true },
          })
        : null,
      this.prisma.reportSnapshotJob.groupBy({
        by: ['status'],
        _count: { _all: true },
        where: { status: { in: ['QUEUED', 'RUNNING', 'ERROR'] } },
      }),
      this.prisma.reportSnapshotJob.findFirst({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { requestedAt: 'asc' },
        select: { requestedAt: true, status: true, snapshotCacheKey: true },
      }),
      this.prisma.reportSnapshot.count({
        where: {
          refreshStatus: { in: ['QUEUED', 'RUNNING', 'ERROR'] },
          refreshRequestedAt: { lt: new Date(Date.now() - 120_000) },
        },
      }),
      this.prisma.workerRuntime.findMany({
        orderBy: { role: 'asc' },
      }),
    ]);

    const api = ApiRuntimeMetrics.snapshot();
    const memoryUsage = process.memoryUsage();
    const memory = {
      rssMb: Math.round(memoryUsage.rss / MB),
      heapUsedMb: Math.round(memoryUsage.heapUsed / MB),
      externalMb: Math.round(memoryUsage.external / MB),
    };
    const syncLagSeconds = oldestPendingRawAmoEvent
      ? Math.max(0, Math.floor((now - oldestPendingRawAmoEvent.receivedAt.getTime()) / 1000))
      : 0;
    const reportLagSeconds = oldestReportJob
      ? Math.max(0, Math.floor((now - oldestReportJob.requestedAt.getTime()) / 1000))
      : 0;
    const reportQueue = {
      queued: reportJobCounts.find((item) => item.status === 'QUEUED')?._count._all ?? 0,
      running: reportJobCounts.find((item) => item.status === 'RUNNING')?._count._all ?? 0,
      failed: reportJobCounts.find((item) => item.status === 'ERROR')?._count._all ?? 0,
      staleSnapshots,
      oldest: oldestReportJob,
    };
    const workerRestartedRecently = workers.some((worker) => now - worker.startedAt.getTime() <= 10 * 60_000);
    const staleWorkerHeartbeat = workers.some((worker) => now - worker.heartbeatAt.getTime() > 60_000);
    const redConditions = {
      syncLag: syncLagSeconds > 120,
      reportLag: reportLagSeconds > 120,
      apiP95: api.p95Ms > 3_000,
      workerRestarted: workerRestartedRecently,
      workerHeartbeatStale: staleWorkerHeartbeat,
      reportFailures: reportQueue.failed > 0,
      syncFailures: failedRawAmoEvents > 0,
    };
    const healthy = !Object.values(redConditions).some(Boolean);

    return {
      status: healthy ? 'ok' : 'degraded',
      service: 'amocrm-analytics-api',
      process: {
        startedAt: PROCESS_STARTED_AT.toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
      },
      memory,
      api,
      amo: {
        connectionStatus: connection?.status ?? 'INACTIVE',
        lastError: connection?.lastError ?? null,
        lastFullSyncAt: connection?.lastFullSyncAt ?? null,
        lastIncrementalSyncAt: connection?.lastIncrementalSyncAt ?? null,
        syncLagSeconds,
        pendingRawAmoEvents,
        readyRawAmoEvents,
        failedRawAmoEvents,
        lastAppliedRawAmoEvent,
      },
      reports: {
        reportLagSeconds,
        queue: reportQueue,
      },
      workers: {
        restartedLast10Minutes: workerRestartedRecently,
        staleHeartbeat: staleWorkerHeartbeat,
        items: workers.map((worker) => ({
          role: worker.role,
          pid: worker.processId,
          startedAt: worker.startedAt,
          heartbeatAt: worker.heartbeatAt,
          rssMb: worker.rssMb,
          heapUsedMb: worker.heapUsedMb,
        })),
      },
      redConditions,
    };
  }
}
