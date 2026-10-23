import { Injectable, Logger } from '@nestjs/common';
import { DataQualityStatus, Prisma, QualitySeverity } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { METRIC_VERSION, RELEASE_BUILD_ID } from './release-info';

type QualityScope = {
  global?: boolean;
  pipelineIds?: string[];
  managerIds?: string[];
  reportNames?: string[];
  periodFrom?: string;
  periodTo?: string;
};

type QualityFinding = {
  code: string;
  message: string;
  severity: QualitySeverity;
  immediate?: boolean;
  scope?: QualityScope;
  details?: Record<string, unknown>;
};

type ReportQualityInput = {
  name?: string;
  filters?: Record<string, unknown>;
};

const CERTIFICATION_MAX_AGE_MS = 2 * 60_000;
const REPORT_SOURCE_TOLERANCE_MS = 90_000;
const FRESHNESS_WARNING_MS = 3 * 60_000;
const FRESHNESS_BLOCK_MS = 10 * 60_000;
const CONFIRMATION_WINDOW_MS = 10 * 60_000;
const REQUIRED_WORKER_ROLES = ['sync', 'report', 'notification', 'export', 'bootstrap'];

@Injectable()
export class DataQualityService {
  private readonly logger = new Logger(DataQualityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async evaluate() {
    const startedAt = new Date();
    const connection = await this.prisma.amoConnection.findFirst({ orderBy: { createdAt: 'desc' } });
    const findings: QualityFinding[] = [];

    if (!connection) {
      findings.push({
        code: 'AMO_CONNECTION_MISSING',
        message: 'amoCRM не подключена',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
      });
    }

    const now = Date.now();
    const latestSourceAt = this.latestDate(
      connection?.lastPullSyncAt,
      connection?.lastReconcileAt,
      connection?.lastWebhookAppliedAt,
      connection?.lastFullSyncAt,
    );
    const freshnessLagMs = latestSourceAt ? Math.max(0, now - latestSourceAt.getTime()) : Number.POSITIVE_INFINITY;

    const [workers, pendingRaw, failedRaw, oldestRaw, reportFailureSnapshots, oldestReportJob, activeDeals, factDeals, factCoverage] = await Promise.all([
      this.prisma.workerRuntime.findMany({ orderBy: { role: 'asc' } }),
      connection
        ? this.prisma.rawAmoEventInbox.count({
            where: { connectionId: connection.id, appliedAt: null, status: { in: ['received', 'error'] } },
          })
        : 0,
      connection
        ? this.prisma.rawAmoEventInbox.count({ where: { connectionId: connection.id, status: 'error' } })
        : 0,
      connection
        ? this.prisma.rawAmoEventInbox.findFirst({
            where: { connectionId: connection.id, appliedAt: null, status: { in: ['received', 'error'] } },
            orderBy: { receivedAt: 'asc' },
            select: { receivedAt: true },
          })
        : null,
      this.prisma.reportSnapshot.findMany({
        where: {
          refreshStatus: 'ERROR',
          OR: [
            { refreshRequestedAt: { gte: new Date(now - 60 * 60_000) } },
            { lastAccessedAt: { gte: new Date(now - 60 * 60_000) } },
          ],
        },
        select: { name: true },
        distinct: ['name'],
      }),
      this.prisma.reportSnapshotJob.findFirst({
        where: { status: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { requestedAt: 'asc' },
        select: { requestedAt: true },
      }),
      this.prisma.deal.count({ where: { deletedAt: null } }),
      this.prisma.factDealCurrent.count({ where: { deletedAt: null } }),
      this.prisma.$queryRaw<Array<{ deal_mismatches: bigint; history_rows: bigint; transition_rows: bigint }>>`
        SELECT
          (
            SELECT COUNT(*)
            FROM "Deal" deal
            LEFT JOIN fact_deal_current fact ON fact.deal_id = deal.id
            WHERE deal."deletedAt" IS NULL
              AND (
                fact.deal_id IS NULL
                OR fact.deal_external_id IS DISTINCT FROM deal."externalId"
                OR fact.pipeline_id IS DISTINCT FROM deal."pipelineId"
                OR fact.stage_id IS DISTINCT FROM deal."stageId"
                OR fact.responsible_id IS DISTINCT FROM deal."responsibleId"
                OR fact.amount IS DISTINCT FROM deal.amount
                OR fact.updated_at IS DISTINCT FROM deal."updatedAt"
              )
          ) + (
            SELECT COUNT(*)
            FROM fact_deal_current fact
            LEFT JOIN "Deal" deal ON deal.id = fact.deal_id
            WHERE fact.deleted_at IS NULL AND (deal.id IS NULL OR deal."deletedAt" IS NOT NULL)
          ) AS deal_mismatches,
          (SELECT COUNT(*) FROM "DealStageHistory") AS history_rows,
          (SELECT COUNT(*) FROM fact_stage_transition) AS transition_rows
      `,
    ]);

    const dealMismatches = Number(factCoverage[0]?.deal_mismatches ?? 0);
    const historyRows = Number(factCoverage[0]?.history_rows ?? 0);
    const transitionRows = Number(factCoverage[0]?.transition_rows ?? 0);
    const reportFailures = reportFailureSnapshots.length;
    const failedReportNames = reportFailureSnapshots
      .map((snapshot) => snapshot.name)
      .filter((name): name is string => Boolean(name));

    const rawLagMs = oldestRaw ? now - oldestRaw.receivedAt.getTime() : 0;
    const reportLagMs = oldestReportJob ? now - oldestReportJob.requestedAt.getTime() : 0;
    const requiredWorkers = workers.filter((worker) => REQUIRED_WORKER_ROLES.includes(worker.role));
    const staleWorkers = requiredWorkers.filter((worker) => now - worker.heartbeatAt.getTime() > 60_000);
    const runningWorkerRoles = new Set(workers.filter((worker) => now - worker.heartbeatAt.getTime() <= 60_000).map((worker) => worker.role));
    const missingWorkerRoles = REQUIRED_WORKER_ROLES.filter((role) => !runningWorkerRoles.has(role));
    const versionMismatch = requiredWorkers.filter(
      (worker) => now - worker.heartbeatAt.getTime() <= 60_000
        && (worker.buildId !== RELEASE_BUILD_ID || worker.metricVersion !== METRIC_VERSION),
    );

    if (connection?.status === 'ERROR' && freshnessLagMs >= FRESHNESS_BLOCK_MS) {
      findings.push({
        code: 'AMO_CONNECTION_ERROR',
        message: connection.lastError || 'amoCRM недоступна',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
        details: { freshnessLagSeconds: Math.floor(freshnessLagMs / 1000) },
      });
    }
    if (connection?.lastFullSyncAt && (!connection.lastReconcileAt || now - connection.lastReconcileAt.getTime() >= FRESHNESS_BLOCK_MS)) {
      findings.push({
        code: 'AMO_RECONCILE_STALE',
        message: 'Контрольная сверка с amoCRM не выполнялась больше 10 минут',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
        details: { lastReconcileAt: connection.lastReconcileAt?.toISOString() ?? null },
      });
    }
    if (rawLagMs >= FRESHNESS_BLOCK_MS || failedRaw > 0) {
      findings.push({
        code: 'RAW_EVENT_BACKLOG',
        message: 'Очередь событий amoCRM не обработана вовремя',
        severity: 'CRITICAL',
        immediate: rawLagMs >= FRESHNESS_BLOCK_MS,
        scope: { global: true },
        details: { pendingRaw, failedRaw, lagSeconds: Math.floor(rawLagMs / 1000) },
      });
    }
    if (reportLagMs >= FRESHNESS_BLOCK_MS || reportFailures > 0) {
      findings.push({
        code: 'REPORT_REFRESH_FAILURE',
        message: 'Снимки отчётов не обновляются вовремя',
        severity: 'CRITICAL',
        immediate: reportLagMs >= FRESHNESS_BLOCK_MS,
        scope: failedReportNames.length ? { reportNames: failedReportNames } : { global: true },
        details: { reportFailures, reportNames: failedReportNames, lagSeconds: Math.floor(reportLagMs / 1000) },
      });
    }
    if (staleWorkers.length > 0) {
      findings.push({
        code: 'WORKER_HEARTBEAT_STALE',
        message: 'Один или несколько воркеров остановились',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
        details: { roles: staleWorkers.map((worker) => worker.role) },
      });
    }
    if (connection?.lastFullSyncAt && missingWorkerRoles.length > 0) {
      findings.push({
        code: 'WORKER_MISSING',
        message: 'Один или несколько обязательных воркеров не запущены',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
        details: { roles: missingWorkerRoles },
      });
    }
    if (versionMismatch.length > 0) {
      findings.push({
        code: 'RUNTIME_VERSION_MISMATCH',
        message: 'API и воркеры запущены из разных версий',
        severity: 'CRITICAL',
        immediate: true,
        scope: { global: true },
        details: {
          expectedBuildId: RELEASE_BUILD_ID,
          expectedMetricVersion: METRIC_VERSION,
          workers: versionMismatch.map((worker) => ({
            role: worker.role,
            buildId: worker.buildId,
            metricVersion: worker.metricVersion,
          })),
        },
      });
    }
    if (connection?.lastFullSyncAt && (activeDeals !== factDeals || dealMismatches > 0)) {
      findings.push({
        code: 'FACT_DEAL_COVERAGE_MISMATCH',
        message: 'Количество действующих сделок не совпадает с витриной отчётов',
        severity: 'CRITICAL',
        scope: { global: true },
        details: { activeDeals, factDeals, difference: activeDeals - factDeals, dealMismatches },
      });
    }
    if (connection?.lastFullSyncAt && historyRows !== transitionRows) {
      findings.push({
        code: 'FACT_STAGE_HISTORY_COVERAGE_MISMATCH',
        message: 'История этапов не совпадает с витриной отчётов',
        severity: 'CRITICAL',
        scope: { global: true },
        details: { historyRows, transitionRows, difference: historyRows - transitionRows },
      });
    }

    await this.synchronizeIncidents(connection?.id ?? null, findings, startedAt);
    const openIncidents = await this.prisma.dataQualityIncident.findMany({
      where: {
        status: 'OPEN',
        connectionId: connection?.id ?? null,
      },
      orderBy: [{ confirmedAt: 'desc' }, { firstDetectedAt: 'desc' }],
    });
    const confirmed = openIncidents.filter((incident) => incident.confirmedAt);
    const status: DataQualityStatus = confirmed.length
      ? 'BLOCKED'
      : findings.length || freshnessLagMs > FRESHNESS_WARNING_MS
        ? 'CHECKING'
        : 'CERTIFIED';
    const finishedAt = new Date();
    const check = await this.prisma.dataQualityCheck.create({
      data: {
        connectionId: connection?.id ?? null,
        checkType: 'SYSTEM',
        status,
        cutoffAt: latestSourceAt,
        scope: { global: true },
        stats: {
          freshnessLagSeconds: Number.isFinite(freshnessLagMs) ? Math.floor(freshnessLagMs / 1000) : null,
          pendingRaw,
          failedRaw,
          rawLagSeconds: Math.floor(rawLagMs / 1000),
          reportFailures,
          reportLagSeconds: Math.floor(reportLagMs / 1000),
          activeDeals,
          factDeals,
          dealMismatches,
          historyRows,
          transitionRows,
          workers: workers.length,
        },
        message: status === 'CERTIFIED' ? 'Данные прошли обязательные проверки' : findings[0]?.message ?? 'Данные обновляются',
        buildId: RELEASE_BUILD_ID,
        metricVersion: METRIC_VERSION,
        startedAt,
        finishedAt,
      },
    });

    if (status === 'CERTIFIED' && connection) {
      await this.prisma.amoConnection.update({
        where: { id: connection.id },
        data: { lastCertifiedAt: finishedAt },
      });
    }

    return this.formatStatus(check, openIncidents, latestSourceAt, finishedAt);
  }

  async status() {
    const check = await this.prisma.dataQualityCheck.findFirst({ orderBy: { startedAt: 'desc' } });
    const incidents = await this.prisma.dataQualityIncident.findMany({
      where: { status: 'OPEN', connectionId: check?.connectionId ?? null },
      orderBy: [{ confirmedAt: 'desc' }, { firstDetectedAt: 'desc' }],
      take: 50,
    });
    if (!check) {
      return {
        overall: 'CHECKING' as DataQualityStatus,
        availability: 'CHECKING',
        freshness: 'CHECKING',
        correctness: 'CHECKING',
        checkedAt: null,
        cutoffAt: null,
        buildId: RELEASE_BUILD_ID,
        metricVersion: METRIC_VERSION,
        incidents: [],
      };
    }
    const checkedAt = check.finishedAt ?? check.startedAt;
    if (Date.now() - checkedAt.getTime() > CERTIFICATION_MAX_AGE_MS) {
      return this.formatStatus({ ...check, status: 'CHECKING' }, incidents, check.cutoffAt, checkedAt);
    }
    return this.formatStatus(check, incidents, check.cutoffAt, checkedAt);
  }

  async sanitizedStatus() {
    const current = await this.status();
    return {
      status: current.overall === 'CERTIFIED' ? 'ok' : current.overall === 'BLOCKED' ? 'blocked' : 'checking',
      checkedAt: current.checkedAt,
      cutoffAt: current.cutoffAt,
      freshness: current.freshness,
    };
  }

  async incident(id: string) {
    return this.prisma.dataQualityIncident.findUnique({ where: { id } });
  }

  async reportQuality(input: ReportQualityInput, sourceSyncAt: Date | null, knownStatus?: Awaited<ReturnType<DataQualityService['status']>>) {
    const current = knownStatus ?? await this.status();
    const applicable = current.incidents.filter((incident: any) => this.scopeMatches(incident.scope, input));
    const blocked = applicable.find((incident: any) => incident.confirmedAt);
    const currentCutoffAt = current.cutoffAt ? new Date(current.cutoffAt) : null;
    const sourceIsCurrent = Boolean(
      sourceSyncAt
      && currentCutoffAt
      && sourceSyncAt.getTime() >= currentCutoffAt.getTime() - REPORT_SOURCE_TOLERANCE_MS,
    );
    const status: DataQualityStatus = blocked
      ? 'BLOCKED'
      : current.overall === 'CERTIFIED' && sourceIsCurrent
        ? 'CERTIFIED'
        : 'CHECKING';
    return {
      status,
      checkedAt: current.checkedAt,
      cutoffAt: current.cutoffAt,
      incidentId: blocked?.id ?? null,
      metricVersion: METRIC_VERSION,
      buildId: RELEASE_BUILD_ID,
      reason: blocked?.message ?? (status === 'CHECKING' ? 'Данные проходят проверку' : null),
    };
  }

  async notificationsDue() {
    const now = Date.now();
    const incidents = await this.prisma.dataQualityIncident.findMany({
      where: {
        OR: [
          { status: 'OPEN', confirmedAt: { not: null } },
          { status: 'RESOLVED', confirmedAt: { not: null }, resolvedNotifiedAt: null },
        ],
      },
      orderBy: { firstDetectedAt: 'asc' },
    });
    const due = incidents.filter((incident) => {
      if (incident.status === 'RESOLVED') return !incident.resolvedNotifiedAt;
      if (!incident.lastNotifiedAt) return true;
      const delay = incident.notificationCount <= 1 ? 30 * 60_000 : 2 * 60 * 60_000;
      return now - incident.lastNotifiedAt.getTime() >= delay;
    });
    const owners = await this.prisma.user.findMany({
      where: { isActive: true, OR: [{ role: 'ADMIN' }, { businessRole: 'OWNER' }] },
      select: { id: true },
    });
    return { incidents: due, ownerUserIds: owners.map((owner) => owner.id) };
  }

  async markNotified(id: string, resolved: boolean) {
    await this.prisma.dataQualityIncident.update({
      where: { id },
      data: resolved
        ? { resolvedNotifiedAt: new Date() }
        : { lastNotifiedAt: new Date(), notificationCount: { increment: 1 } },
    });
  }

  notificationText(incident: { id: string; code: string; message: string; status: string; firstDetectedAt: Date; resolvedAt: Date | null }) {
    if (incident.status === 'RESOLVED') {
      return `✅ Данные восстановлены\nИнцидент: ${incident.id}\nПроблема: ${incident.message}\nИсправлено: ${(incident.resolvedAt ?? new Date()).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
    }
    return `🔴 Цифры заблокированы\nИнцидент: ${incident.id}\nПроблема: ${incident.message}\nОбнаружено: ${incident.firstDetectedAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`;
  }

  async testNotificationPayload() {
    const owners = await this.prisma.user.findMany({
      where: { isActive: true, OR: [{ role: 'ADMIN' }, { businessRole: 'OWNER' }] },
      select: { id: true },
    });
    return {
      ownerUserIds: owners.map((owner) => owner.id),
      message: `✅ Тест контроля данных\nTelegram-уведомления PulseBoard работают.\nВерсия: ${RELEASE_BUILD_ID}`,
      eventKey: `data-quality-test:${Date.now()}`,
    };
  }

  private async synchronizeIncidents(connectionId: string | null, findings: QualityFinding[], now: Date) {
    const activeCodes = new Set(findings.map((finding) => finding.code));
    const open = await this.prisma.dataQualityIncident.findMany({ where: { status: 'OPEN' } });

    for (const finding of findings) {
      const existing = open.find((incident) => incident.code === finding.code && incident.connectionId === connectionId);
      if (!existing) {
        await this.prisma.dataQualityIncident.create({
          data: {
            connectionId,
            code: finding.code,
            severity: finding.severity,
            scope: (finding.scope ?? { global: true }) as Prisma.InputJsonValue,
            message: finding.message,
            details: (finding.details ?? {}) as Prisma.InputJsonValue,
            confirmedAt: finding.immediate ? now : null,
          },
        });
        continue;
      }

      const detectionCount = existing.detectionCount + 1;
      const oldEnough = now.getTime() - existing.firstDetectedAt.getTime() >= CONFIRMATION_WINDOW_MS;
      const confirmedAt = existing.confirmedAt ?? (finding.immediate || (detectionCount >= 3 && oldEnough) ? now : null);
      await this.prisma.dataQualityIncident.update({
        where: { id: existing.id },
        data: {
          severity: finding.severity,
          scope: (finding.scope ?? { global: true }) as Prisma.InputJsonValue,
          message: finding.message,
          details: (finding.details ?? {}) as Prisma.InputJsonValue,
          detectionCount,
          lastDetectedAt: now,
          confirmedAt,
        },
      });
    }

    for (const incident of open) {
      if (incident.connectionId !== connectionId || activeCodes.has(incident.code)) continue;
      await this.prisma.dataQualityIncident.update({
        where: { id: incident.id },
        data: { status: 'RESOLVED', resolvedAt: now },
      });
    }
  }

  private formatStatus(check: any, incidents: any[], cutoffAt: Date | null, checkedAt: Date) {
    const confirmed = incidents.filter((incident) => incident.status === 'OPEN' && incident.confirmedAt);
    const pending = incidents.filter((incident) => incident.status === 'OPEN' && !incident.confirmedAt);
    const overall: DataQualityStatus = confirmed.length ? 'BLOCKED' : check.status;
    return {
      overall,
      availability: confirmed.some((incident) => ['WORKER_HEARTBEAT_STALE', 'WORKER_MISSING', 'RUNTIME_VERSION_MISMATCH'].includes(incident.code)) ? 'BLOCKED' : 'AVAILABLE',
      freshness: overall === 'CERTIFIED' ? 'FRESH' : overall === 'BLOCKED' ? 'STALE' : 'CHECKING',
      correctness: confirmed.length ? 'BLOCKED' : pending.length ? 'CHECKING' : overall,
      checkedAt: checkedAt.toISOString(),
      cutoffAt: cutoffAt?.toISOString() ?? null,
      buildId: check.buildId ?? RELEASE_BUILD_ID,
      metricVersion: check.metricVersion ?? METRIC_VERSION,
      incidents: incidents.map((incident) => ({
        id: incident.id,
        code: incident.code,
        status: incident.status,
        severity: incident.severity,
        message: incident.message,
        scope: incident.scope,
        firstDetectedAt: incident.firstDetectedAt,
        lastDetectedAt: incident.lastDetectedAt,
        confirmedAt: incident.confirmedAt,
      })),
    };
  }

  private scopeMatches(scopeValue: unknown, input: ReportQualityInput) {
    const scope = (scopeValue && typeof scopeValue === 'object' ? scopeValue : {}) as QualityScope;
    if (scope.global) return true;
    if (scope.reportNames?.length && input.name && scope.reportNames.includes(input.name)) return true;
    const filters = input.filters ?? {};
    const pipelineIds = this.stringArray(filters.pipelineIds ?? filters.pipelineId);
    const managerIds = this.stringArray(filters.managerIds ?? filters.responsibleIds ?? filters.responsibleId);
    if (scope.pipelineIds?.some((id) => pipelineIds.includes(id))) return true;
    if (scope.managerIds?.some((id) => managerIds.includes(id))) return true;
    return !scope.reportNames?.length && !scope.pipelineIds?.length && !scope.managerIds?.length;
  }

  private stringArray(value: unknown) {
    if (Array.isArray(value)) return value.map(String);
    return value == null ? [] : [String(value)];
  }

  private latestDate(...dates: Array<Date | null | undefined>) {
    const valid = dates.filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));
    if (!valid.length) return null;
    return new Date(Math.max(...valid.map((date) => date.getTime())));
  }
}
