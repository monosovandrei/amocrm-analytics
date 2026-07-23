import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ExportJobStatus, Prisma, ReportSourceType, UserRole } from '../generated/prisma';
import {
  absoluteDurationDays,
  endOfMonth,
  median,
  moscowBusinessDurationDays,
  moscowDate,
  moscowWeekdayDurationDays,
  startOfMonth,
  toDateFromAmoTimestamp,
} from '../common/date.util';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportQueryDto, SaveReportTemplateDto } from './dto/report-query.dto';
import {
  ConversionStep,
  DataContractConfig,
  DataContractDuration,
  DataContractFilter,
  DataContractMetric,
  ReportConfig,
  ReportFilters,
} from './report-types';

type XlsxValue = string | number | boolean | null | undefined;
type XlsxSheet = { name: string; rows: XlsxValue[][] };
type BuiltinReportTemplate = {
  name: string;
  position: number;
  sourceType: ReportSourceType;
  config: ReportConfig;
};
type ContractDealSample = {
  dealId: string;
  dealExternalId?: string | null;
  dealTitle: string;
  amount: number | null;
  expectedAmount?: number | null;
  probabilityPercent?: number | null;
  stageName?: string | null;
  pipelineName?: string | null;
  updatedAt?: string | null;
};
type ContractBucket = {
  count: number;
  values: number[];
  dealIds: Set<string>;
  samples: ContractDealSample[];
  value: number | null;
  unit: string;
};
type StageSuccessProbability = {
  probability: number;
  source: 'personal' | 'blended' | 'team' | 'default';
  personalSample: number;
  teamSample: number;
  personalWins: number;
  teamWins: number;
  personalRate: number | null;
  teamRate: number | null;
};
type StageSuccessProbabilityModel = {
  probability: (stageId: string, managerId?: string | null) => StageSuccessProbability;
};
type ReportCacheConfig = {
  dto?: ReportQueryDto;
  user?: { id: string; role: UserRole };
};
type RevenueForecastBucketKey =
  | 'salesShippedThisMonth'
  | 'salesShippingThisMonth'
  | 'salesInvoiceThisMonth'
  | 'salesQuoteThisMonth'
  | 'salesNotThisMonth'
  | 'repeatShippedThisMonth'
  | 'repeatShippingThisMonth'
  | 'repeatInvoiceThisMonth'
  | 'repeatQuoteThisMonth'
  | 'repeatNotThisMonth';

const LOSS_REASON_CUSTOM_FIELD_NAMES = new Set(['причина отказа', 'причины отказа'].map(normalizeCustomFieldName));
const MISSING_LOSS_REASON_LABEL = 'Не указано';
const DEFAULT_REPORT_FRESH_COMPUTE_CONCURRENCY = 2;
const DEFAULT_WORKER_RECYCLE_RSS_MB = 850;
const EXPORTS_DIR = process.env.REPORT_EXPORT_DIR || '/tmp/amocrm-analytics-exports';
const MB = 1024 * 1024;

function normalizeCustomFieldName(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private readonly freshComputeQueue: Array<() => void> = [];
  private readonly freshComputeConcurrency = this.resolveFreshComputeConcurrency();
  private activeFreshComputes = 0;
  private reportCacheReady?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async compute(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    const cacheKey = this.reportCacheKey(dto, user);
    const latestSyncAt = await this.latestReportSourceSyncAt();
    const cached = await this.getCachedReport(cacheKey);
    if (cached) {
      if (this.cacheIsStale(cached.sourceSyncAt, latestSyncAt)) {
        await this.enqueueReportCacheRefresh(cacheKey, dto, user);
      }
      return cached.payload;
    }

    const report = await this.computeFresh(dto, user);
    await this.saveCachedReport(cacheKey, dto.name, report, latestSyncAt, dto, user);
    return report;
  }

  private async computeFresh(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    return this.withFreshComputeSlot(async () => {
      const filters = dto.filters as ReportFilters;
      const config = dto.config as ReportConfig;
      const report = await this.computeBase(filters, config, user);
      return this.attachComparison(report, filters, config, user);
    });
  }

  private reportCacheKey(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    return createHash('sha256')
      .update(stableStringify({
        name: dto.name,
        sourceType: dto.sourceType,
        filters: dto.filters,
        config: dto.config,
        role: user.role,
      }))
      .digest('hex');
  }

  private async ensureReportCacheTable() {
    this.reportCacheReady ??= this.ensureReportCacheSchema();
    return this.reportCacheReady;
  }

  private async ensureReportCacheSchema() {
    await this.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS report_result_cache (
        cache_key TEXT PRIMARY KEY,
        name TEXT,
        payload JSONB NOT NULL,
        report_config JSONB,
        source_sync_at TIMESTAMPTZ,
        refresh_status TEXT NOT NULL DEFAULT 'IDLE',
        refresh_requested_at TIMESTAMPTZ,
        refreshing_at TIMESTAMPTZ,
        refresh_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE report_result_cache ADD COLUMN IF NOT EXISTS report_config JSONB`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE report_result_cache ADD COLUMN IF NOT EXISTS refresh_status TEXT NOT NULL DEFAULT 'IDLE'`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE report_result_cache ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE report_result_cache ADD COLUMN IF NOT EXISTS refreshing_at TIMESTAMPTZ`);
    await this.prisma.$executeRawUnsafe(`ALTER TABLE report_result_cache ADD COLUMN IF NOT EXISTS refresh_error TEXT`);
    await this.prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS report_result_cache_refresh_idx
      ON report_result_cache (refresh_status, refresh_requested_at)
    `);
  }

  private async getCachedReport(cacheKey: string) {
    await this.ensureReportCacheTable();
    const rows = await this.prisma.$queryRaw<Array<{ payload: unknown; source_sync_at: Date | null }>>`
      SELECT payload, source_sync_at
      FROM report_result_cache
      WHERE cache_key = ${cacheKey}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { payload: row.payload as Record<string, any>, sourceSyncAt: row.source_sync_at };
  }

  private async saveCachedReport(
    cacheKey: string,
    name: string,
    report: unknown,
    sourceSyncAt: Date | null,
    dto?: ReportQueryDto,
    user?: { id: string; role: UserRole },
  ) {
    await this.ensureReportCacheTable();
    const reportConfig = dto && user ? JSON.stringify({ dto, user: { id: user.id, role: user.role } }) : null;
    await this.prisma.$executeRawUnsafe(
      `
        INSERT INTO report_result_cache (
          cache_key,
          name,
          payload,
          report_config,
          source_sync_at,
          refresh_status,
          refresh_requested_at,
          refreshing_at,
          refresh_error,
          updated_at
        )
        VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, 'IDLE', NULL, NULL, NULL, NOW())
        ON CONFLICT (cache_key)
        DO UPDATE SET
          name = EXCLUDED.name,
          payload = EXCLUDED.payload,
          report_config = COALESCE(EXCLUDED.report_config, report_result_cache.report_config),
          source_sync_at = EXCLUDED.source_sync_at,
          refresh_status = 'IDLE',
          refresh_requested_at = NULL,
          refreshing_at = NULL,
          refresh_error = NULL,
          updated_at = NOW()
      `,
      cacheKey,
      name,
      JSON.stringify(report),
      reportConfig,
      sourceSyncAt,
    );
  }

  private async enqueueReportCacheRefresh(cacheKey: string, dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    await this.ensureReportCacheTable();
    await this.prisma.$executeRawUnsafe(
      `
        UPDATE report_result_cache
        SET
          name = $2,
          report_config = $3::jsonb,
          refresh_status = CASE WHEN refresh_status = 'RUNNING' THEN refresh_status ELSE 'QUEUED' END,
          refresh_requested_at = CASE WHEN refresh_status = 'RUNNING' THEN refresh_requested_at ELSE NOW() END,
          refresh_error = NULL,
          updated_at = NOW()
        WHERE cache_key = $1
      `,
      cacheKey,
      dto.name,
      JSON.stringify({ dto, user: { id: user.id, role: user.role } }),
    );
  }

  async processReportCacheRefreshJobs(limit = 1) {
    await this.ensureReportCacheTable();
    await this.requeueStaleReportCacheLocks();
    const jobs = await this.prisma.$queryRaw<Array<{ cache_key: string; report_config: ReportCacheConfig | null }>>`
      SELECT cache_key, report_config
      FROM report_result_cache
      WHERE refresh_status = 'QUEUED' AND report_config IS NOT NULL
      ORDER BY refresh_requested_at ASC NULLS FIRST, updated_at ASC
      LIMIT ${limit}
    `;

    for (const job of jobs) {
      const locked = await this.prisma.$executeRawUnsafe(
        `
          UPDATE report_result_cache
          SET refresh_status = 'RUNNING', refreshing_at = NOW(), refresh_error = NULL, updated_at = NOW()
          WHERE cache_key = $1 AND refresh_status = 'QUEUED'
        `,
        job.cache_key,
      );
      if (!locked) continue;

      try {
        const dto = job.report_config?.dto;
        const user = job.report_config?.user;
        if (!dto || !user?.id || !user?.role) throw new Error('Invalid report cache refresh payload');

        const latestSyncAt = await this.latestReportSourceSyncAt();
        const report = await this.computeFresh(dto, user);
        await this.saveCachedReport(job.cache_key, dto.name, report, latestSyncAt, dto, user);
      } catch (error: any) {
        await this.prisma.$executeRawUnsafe(
          `
            UPDATE report_result_cache
            SET refresh_status = 'ERROR', refreshing_at = NULL, refresh_error = $2, updated_at = NOW()
            WHERE cache_key = $1
          `,
          job.cache_key,
          String(error?.message ?? error),
        );
        this.logger.warn(`Report cache refresh ${job.cache_key} failed: ${error.message}`);
      } finally {
        this.compactHeap();
        await this.recycleWorkerIfNeeded('report cache refresh');
      }
    }

    return { processed: jobs.length };
  }

  async enqueueStaleReportCacheRefreshJobs(limit = 25) {
    await this.ensureReportCacheTable();
    const latestSyncAt = await this.latestReportSourceSyncAt();
    if (!latestSyncAt) return { queued: 0 };

    const queued = await this.prisma.$executeRawUnsafe(
      `
        WITH stale AS (
          SELECT cache_key
          FROM report_result_cache
          WHERE report_config IS NOT NULL
            AND refresh_status NOT IN ('QUEUED', 'RUNNING')
            AND (source_sync_at IS NULL OR source_sync_at < $1)
          ORDER BY source_sync_at ASC NULLS FIRST, updated_at ASC
          LIMIT $2
        )
        UPDATE report_result_cache cache
        SET
          refresh_status = 'QUEUED',
          refresh_requested_at = NOW(),
          refresh_error = NULL,
          updated_at = NOW()
        FROM stale
        WHERE cache.cache_key = stale.cache_key
      `,
      latestSyncAt,
      Math.max(1, Math.floor(limit)),
    );

    return { queued };
  }

  private async requeueStaleReportCacheLocks() {
    await this.prisma.$executeRawUnsafe(`
      UPDATE report_result_cache
      SET refresh_status = 'QUEUED', refreshing_at = NULL, updated_at = NOW()
      WHERE refresh_status = 'RUNNING' AND refreshing_at < NOW() - INTERVAL '10 minutes'
    `);
  }

  private async latestReportSourceSyncAt() {
    const connection = await this.prisma.amoConnection.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { lastIncrementalSyncAt: true, lastFullSyncAt: true },
    });
    return connection?.lastIncrementalSyncAt ?? connection?.lastFullSyncAt ?? null;
  }

  private cacheIsStale(cachedSyncAt: Date | null, latestSyncAt: Date | null) {
    if (!latestSyncAt) return false;
    if (!cachedSyncAt) return true;
    return cachedSyncAt.getTime() < latestSyncAt.getTime();
  }

  private get db() {
    return this.prisma;
  }

  private resolveFreshComputeConcurrency() {
    const value = Number(process.env.REPORT_FRESH_COMPUTE_CONCURRENCY);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_REPORT_FRESH_COMPUTE_CONCURRENCY;
    return Math.max(1, Math.floor(value));
  }

  private async withFreshComputeSlot<T>(callback: () => Promise<T>): Promise<T> {
    if (this.activeFreshComputes >= this.freshComputeConcurrency) {
      await new Promise<void>((resolve) => this.freshComputeQueue.push(resolve));
    }

    this.activeFreshComputes += 1;
    try {
      return await callback();
    } finally {
      this.activeFreshComputes -= 1;
      this.freshComputeQueue.shift()?.();
    }
  }

  private async computeBase(filters: ReportFilters, config: ReportConfig, user: { id: string; role: UserRole }) {
    if (config.metric === 'forecast') {
      return this.computeForecast(filters);
    }
    if (config.metric === 'revenue_profit_forecast') {
      return this.computeRevenueProfitForecast(filters, user.role);
    }
    if (config.metric === 'deal_cycle') {
      return this.computeDealCycleReport(filters, user.role);
    }
    if (config.metric === 'deal_stage_age') {
      return this.computeCurrentStageAgeReport(filters, user.role);
    }
    if (config.metric === 'loss_reasons') {
      return this.computeLossReasonsReport(filters, user.role);
    }
    if (
      config.contract &&
      ((config.contract.metrics?.length ?? 0) > 0 ||
        (config.contract.conversions?.length ?? 0) > 0 ||
        (config.contract.durations?.length ?? 0) > 0)
    ) {
      return this.computeDataContract(filters, config.contract, user.role);
    }
    if (config.steps?.length) {
      return this.computeConversionReport(filters, config, user.role);
    }
    return this.computeCurrentSnapshot(filters, user.role);
  }

  private async attachComparison(report: any, filters: ReportFilters, config: ReportConfig, user: { id: string; role: UserRole }) {
    const compare = (config as any).compare;
    if (!compare?.enabled) return report;
    const previousFilters = this.previousPeriodFilters(filters);
    if (!previousFilters) {
      return { ...report, comparison: { enabled: true, available: false, reason: 'Для сравнения нужен период отчёта' } };
    }

    const previousReport = await this.computeBase(previousFilters, { ...(config as any), compare: undefined } as ReportConfig, user);
    return {
      ...report,
      comparison: {
        enabled: true,
        available: true,
        currentPeriod: { dateFrom: filters.dateFrom, dateTo: filters.dateTo },
        previousPeriod: { dateFrom: previousFilters.dateFrom, dateTo: previousFilters.dateTo },
        metrics: this.compareReportMetrics(report, previousReport),
      },
    };
  }

  private previousPeriodFilters(filters: ReportFilters) {
    if (!filters.dateFrom || !filters.dateTo) return null;
    const from = new Date(filters.dateFrom);
    const to = new Date(filters.dateTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null;
    const durationMs = to.getTime() - from.getTime();
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - durationMs);
    return {
      ...filters,
      dateFrom: previousFrom.toISOString(),
      dateTo: previousTo.toISOString(),
    };
  }

  private compareReportMetrics(current: any, previous: any) {
    const currentMetrics = this.extractComparableMetrics(current);
    const previousMetrics = this.extractComparableMetrics(previous);
    const keys = Array.from(new Set([...Object.keys(currentMetrics), ...Object.keys(previousMetrics)]));
    return keys.map((key) => {
      const currentValue = currentMetrics[key] ?? 0;
      const previousValue = previousMetrics[key] ?? 0;
      const delta = Number((currentValue - previousValue).toFixed(2));
      return {
        key,
        label: key,
        current: currentValue,
        previous: previousValue,
        delta,
        deltaPercent: previousValue ? Number(((delta / previousValue) * 100).toFixed(2)) : null,
      };
    });
  }

  private extractComparableMetrics(report: any) {
    const result: Record<string, number> = {};
    if (report?.summary) {
      for (const [key, value] of Object.entries(report.summary)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) result[`summary.${key}`] = numeric;
      }
    }
    if (Array.isArray(report?.steps)) {
      for (const step of report.steps) {
        if (Number.isFinite(Number(step.count))) result[`${step.label}: количество`] = Number(step.count);
        if (Number.isFinite(Number(step.amount))) result[`${step.label}: сумма`] = Number(step.amount);
        if (Number.isFinite(Number(step.conversion))) result[`${step.label}: конверсия`] = Number(step.conversion);
      }
    }
    if (Array.isArray(report?.rows)) {
      for (const row of report.rows) {
        if (report.type === 'lossReasons') {
          const numeric = Number(row.total);
          if (Number.isFinite(numeric)) result[`Причина отказа: ${row.reasonName}`] = numeric;
          continue;
        }
        for (const metric of Object.values(row.metrics ?? {}) as any[]) {
          const numeric = Number(metric?.value);
          if (Number.isFinite(numeric)) result[`${row.groupName}: ${metric.label}`] = numeric;
        }
      }
    }
    if (report?.forecast) {
      for (const [key, value] of Object.entries(report.forecast)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) result[`forecast.${key}`] = numeric;
      }
    }
    return result;
  }

  async listTemplates(user: { id: string; role: UserRole }) {
    await this.ensureBuiltinReportTemplates();
    const templates = await this.db.reportTemplate.findMany({ orderBy: [{ position: 'asc' }, { createdAt: 'desc' }] });
    if (user.role === 'ADMIN') return templates;
    return templates.filter((template) => {
      if (template.isShared) return true;
      if (template.userId === user.id) return true;
      const visibleUserIds = ((template.config as any)?.visibleUserIds ?? []) as string[];
      return visibleUserIds.includes(user.id);
    });
  }

  private async ensureBuiltinReportTemplates() {
    const salesTemplates = await this.buildSalesReportTemplates();
    const templates = [
      ...salesTemplates,
      ...(await this.buildCsmInSalesReportTemplates(salesTemplates)),
      ...(await this.buildCsmReportTemplates()),
      this.buildRevenueForecastReportTemplate(),
    ];

    for (const template of templates) {
      const data = {
        userId: null,
        name: template.name,
        sourceType: template.sourceType,
        config: template.config as any,
        position: template.position,
        isShared: true,
      };
      const existing = await this.db.reportTemplate.findFirst({ where: { name: template.name } });
      if (!existing) {
        await this.db.reportTemplate.create({ data });
        continue;
      }
      await this.db.reportTemplate.update({ where: { id: existing.id }, data });
      await this.db.reportTemplate.deleteMany({
        where: {
          name: template.name,
          id: { not: existing.id },
        },
      });
    }

    await this.ensureTeamScopedReportTemplates();
  }

  private async buildSalesReportTemplates(): Promise<BuiltinReportTemplate[]> {
    const refs = await this.resolveSalesRefs();
    if (!refs) return [];

    const marketingFieldId = (await this.resolveLeadFieldExternalId('маркетинг')) ?? '809047';
    const salesFilters = { pipelineIds: [refs.salesPipeline.id], groupIds: [refs.salesGroup.id] };
    const baseConfig = (key: string, order: number, config: ReportConfig): ReportConfig => ({
      ...config,
      builtinKey: key,
      dashboardSection: 'sales',
      pinned: true,
      order,
      lockPipelineFilter: true,
      lockTeamFilter: true,
    });
    const contractBase = {
      entity: 'deal' as const,
      groupBy: 'manager' as const,
      conversions: [],
      durations: [],
      includeRowTotal: false,
      rowTotalMode: 'sum' as const,
      includeSummaryRow: true,
      summaryRowMode: 'sum' as const,
    };
    const stageMetric = (
      id: string,
      label: string,
      stageIds: string[],
      display: DataContractMetric['display'] = 'number',
      measure: DataContractMetric['measure'] = 'deal_count',
      pipelineId = refs.salesPipeline.id,
    ): DataContractMetric => ({
      id,
      label,
      type: 'stage_reached',
      measure,
      display,
      pipelineId,
      stageIds,
    });
    const currentStageMetric = (
      id: string,
      label: string,
      stageIds: string[],
      display: DataContractMetric['display'] = 'number',
      measure: DataContractMetric['measure'] = 'deal_count',
      pipelineId = refs.salesPipeline.id,
    ): DataContractMetric => ({
      id,
      label,
      type: 'current_stage',
      measure,
      display,
      pipelineId,
      stageIds,
    });
    const conversionMetric = (id: string, label: string, fromMetricId: string, toMetricId: string): DataContractMetric => ({
      id,
      label,
      type: 'conversion',
      measure: 'deal_count',
      display: 'percent',
      fromMetricId,
      toMetricId,
    });

    const funnelMetrics: DataContractMetric[] = [
      {
        id: 'leads_received',
        label: 'Получили лидов',
        type: 'created_deals',
        measure: 'deal_count',
        display: 'number',
        fieldOperator: 'equals',
        extraFilters: [
          {
            id: 'marketing_accepted',
            subject: 'deal_field',
            fieldId: marketingFieldId,
            operator: 'equals',
            value: 'Принято',
          },
        ],
      },
      conversionMetric('conv_lead_to_kp', 'Конверсия лид -> КП', 'leads_received', 'kp_presented'),
      stageMetric('kp_presented', 'КП сделали', [refs.stages.kp.id]),
      conversionMetric('conv_kp_to_invoice', 'Конверсия КП -> счёт', 'kp_presented', 'invoice_sent'),
      stageMetric('invoice_sent', 'Счета выставили', [refs.stages.invoice.id]),
      conversionMetric('conv_invoice_to_paid', 'Конверсия счёт -> оплата', 'invoice_sent', 'paid'),
      stageMetric('paid', 'Оплаты получили', refs.stages.success.map((stage) => stage.id)),
      stageMetric('payment_amount', 'Сумма оплат', refs.stages.success.map((stage) => stage.id), 'money', 'field_sum'),
      {
        id: 'avg_check',
        type: 'formula',
        label: 'Средний чек',
        display: 'money',
        formula: '[Сумма оплат] / [Оплаты получили]',
      },
    ];
    const assemblyStageIds = refs.assemblyStages.map((stage) => stage.id);
    const salesKpReachedStageIds = [
      refs.stages.kp.id,
      ...(refs.stages.objections ? [refs.stages.objections.id] : []),
      refs.stages.invoice.id,
    ];
    const weightedTotalParts = [
      '[КП презентовано x конверсия]',
      ...(refs.stages.objections ? ['[Есть возражения x конверсия]'] : []),
      '[Счета x конверсия]',
      '[Сборка x 100%]',
    ];
    const weightedMetrics: DataContractMetric[] = [
      currentStageMetric('count_kp', 'Сделок в КП презентовано', [refs.stages.kp.id]),
      currentStageMetric('sum_kp', 'Сумма КП презентовано', [refs.stages.kp.id], 'money', 'field_sum'),
      {
        id: 'weighted_kp',
        label: 'КП презентовано x конверсия',
        type: 'weighted_stage_sum',
        display: 'money',
        pipelineId: refs.salesPipeline.id,
        stageIds: [refs.stages.kp.id],
        probabilityReachedStageIds: salesKpReachedStageIds,
        inferSuccessAsReached: true,
        successStageIds: refs.stages.success.map((stage) => stage.id),
        defaultProbability: 0.3,
      },
      ...(refs.stages.objections ? [
        currentStageMetric('count_objections', 'Сделок в возражениях', [refs.stages.objections.id]),
        currentStageMetric('sum_objections', 'Сумма возражений', [refs.stages.objections.id], 'money', 'field_sum'),
        {
          id: 'weighted_objections',
          label: 'Есть возражения x конверсия',
          type: 'weighted_stage_sum',
          display: 'money',
          pipelineId: refs.salesPipeline.id,
          stageIds: [refs.stages.objections.id],
          probabilityReachedStageIds: [refs.stages.objections.id],
          successStageIds: refs.stages.success.map((stage) => stage.id),
          defaultProbability: 0.3,
        } satisfies DataContractMetric,
      ] : []),
      currentStageMetric('count_invoice', 'Сделок в счетах', [refs.stages.invoice.id]),
      currentStageMetric('sum_invoice', 'Сумма счетов', [refs.stages.invoice.id], 'money', 'field_sum'),
      {
        id: 'weighted_invoice',
        label: 'Счета x конверсия',
        type: 'weighted_stage_sum',
        display: 'money',
        pipelineId: refs.salesPipeline.id,
        stageIds: [refs.stages.invoice.id],
        probabilityReachedStageIds: [refs.stages.invoice.id],
        inferSuccessAsReached: true,
        successStageIds: refs.stages.success.map((stage) => stage.id),
        defaultProbability: 0.9,
      },
      currentStageMetric('count_assembly', 'Сделок в сборке', assemblyStageIds, 'number', 'deal_count', refs.assemblyPipeline?.id ?? ''),
      currentStageMetric('sum_assembly', 'Сумма сборки', assemblyStageIds, 'money', 'field_sum', refs.assemblyPipeline?.id ?? ''),
      { id: 'weighted_assembly', label: 'Сборка x 100%', type: 'formula', display: 'money', formula: '[Сумма сборки]' },
      {
        id: 'weighted_total',
        label: 'Итого взвешенно',
        type: 'formula',
        display: 'money',
        formula: weightedTotalParts.join(' + '),
      },
    ];

    return [
      {
        name: 'Sales: шаги и конверсии за месяц',
        position: 0,
        sourceType: 'EVENT',
        config: baseConfig('sales_funnel_steps', 0, {
          metric: 'contract',
          display: 'table',
          description: 'Полученные лиды, КП, счета, оплаты и конверсии по менеджерам Sales',
          conditionLabel: 'Полученные лиды, КП, счета, оплаты и конверсии по менеджерам Sales',
          filters: salesFilters,
          contract: { ...contractBase, metrics: funnelMetrics },
          size: 'lg',
        }),
      },
      {
        name: 'Sales: взвешенная воронка',
        position: 1,
        sourceType: 'CURRENT',
        config: baseConfig('sales_weighted_funnel', 1, {
          metric: 'contract',
          display: 'table',
          description: 'Взвешенная сумма по КП, счетам и сборке по менеджерам Sales',
          filters: salesFilters,
          contract: { ...contractBase, metrics: weightedMetrics },
          size: 'lg',
        }),
      },
      {
        name: 'Sales: скорость взятия сделок',
        position: 2,
        sourceType: 'EVENT',
        config: baseConfig('sales_assigned_stage_speed', 2, {
          metric: 'contract',
          display: 'table',
          description: 'Среднее время от назначения sales-ответственного и появления задачи на него до выхода сделки из этапа',
          conditionLabel: 'От назначения sales-ответственного и задачи на него до выхода из этапа',
          filters: salesFilters,
          contract: {
            ...contractBase,
            metrics: [],
            durations: [
              {
                id: 'assigned_stage_speed',
                label: 'Среднее время до взятия',
                stageId: refs.stages.assigned.id,
                startMode: 'sales_responsible_task',
                onlyExited: true,
              },
            ],
            includeSummaryRow: false,
          },
          size: 'lg',
        }),
      },
      {
        name: 'Sales: циклы сделки',
        position: 3,
        sourceType: 'EVENT',
        config: baseConfig('sales_deal_cycle', 3, {
          metric: 'deal_cycle',
          display: 'cycle',
          description: 'Циклы сделки по менеджерам Sales',
          conditionLabel: 'Выход из этапа за выбранный период: вход в этап -> выход из этапа',
          filters: salesFilters,
          size: 'lg',
        }),
      },
      {
        name: 'Sales: текущие сделки по этапам',
        position: 4,
        sourceType: 'CURRENT',
        config: baseConfig('sales_stage_age', 4, {
          metric: 'deal_stage_age',
          display: 'cycle',
          description: 'Сколько текущие открытые сделки находятся в своих этапах по менеджерам Sales',
          conditionLabel: 'Открытые сделки сейчас: вход в текущий этап -> текущее время',
          filters: salesFilters,
          size: 'lg',
        }),
      },
      {
        name: 'Sales: причины отказа',
        position: 6,
        sourceType: 'EVENT',
        config: baseConfig('sales_loss_reasons', 6, {
          metric: 'loss_reasons',
          display: 'table',
          description: 'Сделки, отправленные в отказ за выбранный период, по причинам отказа',
          conditionLabel: 'Продажи: вход в отказ за выбранный период, по менеджерам Sales',
          filters: salesFilters,
          size: 'lg',
        }),
      },
    ];
  }

  private async buildCsmInSalesReportTemplates(salesTemplates: BuiltinReportTemplate[]): Promise<BuiltinReportTemplate[]> {
    const [refs, csmGroup] = await Promise.all([
      this.resolveSalesRefs(),
      this.findCrmGroupByName('CSM'),
    ]);
    if (!refs || !csmGroup || salesTemplates.length === 0) return [];

    const namesBySalesKey = new Map<string, string>([
      ['sales_funnel_steps', 'CSM в продажах: шаги и конверсии за месяц'],
      ['sales_weighted_funnel', 'CSM в продажах: взвешенная воронка'],
      ['sales_assigned_stage_speed', 'CSM в продажах: скорость взятия сделок'],
      ['sales_stage_age', 'CSM в продажах: текущие сделки по этапам'],
      ['sales_loss_reasons', 'CSM в продажах: причины отказа'],
    ]);
    const descriptionsBySalesKey = new Map<string, Pick<ReportConfig, 'description' | 'conditionLabel'>>([
      ['sales_funnel_steps', {
        description: 'Полученные лиды, КП, счета, оплаты и конверсии по менеджерам CSM в воронке Продажи',
        conditionLabel: 'Воронка Продажи: полученные лиды, КП, счета, оплаты и конверсии по менеджерам CSM',
      }],
      ['sales_weighted_funnel', {
        description: 'Взвешенная сумма по КП и счетам по менеджерам CSM в воронке Продажи',
      }],
      ['sales_assigned_stage_speed', {
        description: 'Среднее время взятия сделок менеджерами CSM в воронке Продажи',
        conditionLabel: 'Воронка Продажи: от назначения ответственного и задачи на него до выхода из этапа',
      }],
      ['sales_stage_age', {
        description: 'Сколько текущие открытые сделки находятся в этапах воронки Продажи по менеджерам CSM',
        conditionLabel: 'Воронка Продажи: открытые сделки сейчас, вход в текущий этап -> текущее время',
      }],
      ['sales_loss_reasons', {
        description: 'Сделки CSM, отправленные в отказ в воронке Продажи за выбранный период, по причинам отказа',
        conditionLabel: 'Воронка Продажи: вход в отказ за выбранный период, по менеджерам CSM',
      }],
    ]);

    return salesTemplates
      .filter((template) => namesBySalesKey.has(template.config.builtinKey ?? ''))
      .map((template, index) => {
        const salesKey = template.config.builtinKey ?? '';
        const csmSalesKey = salesKey.replace(/^sales_/, 'csm_sales_');
        const config: ReportConfig = {
          ...this.buildCsmInSalesConfig(template.config, salesKey),
          ...(descriptionsBySalesKey.get(salesKey) ?? {}),
          builtinKey: csmSalesKey,
          dashboardSection: 'csmSales',
          pinned: true,
          order: index,
          lockPipelineFilter: true,
          lockTeamFilter: true,
          filters: {
            ...(template.config.filters ?? {}),
            pipelineIds: [refs.salesPipeline.id],
            groupIds: [csmGroup.id],
          },
        };

        return {
          name: namesBySalesKey.get(salesKey)!,
          position: 10 + index,
          sourceType: template.sourceType,
          config,
        };
      });
  }

  private cloneReportConfig(config: ReportConfig): ReportConfig {
    return JSON.parse(JSON.stringify(config)) as ReportConfig;
  }

  private buildCsmInSalesConfig(config: ReportConfig, salesKey: string): ReportConfig {
    const cloned = this.cloneReportConfig(config);
    if (salesKey !== 'sales_weighted_funnel') return cloned;

    const assemblyMetricIds = new Set(['count_assembly', 'sum_assembly', 'weighted_assembly']);
    const metrics = (cloned.contract?.metrics ?? []).filter((metric) => !assemblyMetricIds.has(metric.id));
    const weightedTotalParts = metrics
      .filter((metric) => metric.id.startsWith('weighted_') && metric.id !== 'weighted_total')
      .map((metric) => `[${metric.label}]`);

    return {
      ...cloned,
      contract: {
        ...(cloned.contract ?? {}),
        metrics: metrics.map((metric) => (
          metric.id === 'weighted_total'
            ? { ...metric, formula: weightedTotalParts.join(' + ') }
            : metric
        )),
      },
    };
  }

  private buildRevenueForecastReportTemplate(): BuiltinReportTemplate {
    return {
      name: 'Прогноз выручки и прибыли',
      position: 5,
      sourceType: 'CURRENT',
      config: {
        metric: 'revenue_profit_forecast',
        display: 'forecast',
        description: 'Прогноз выручки до конца календарного месяца',
        conditionLabel: 'Сборка, счета, КП и возражения',
        filters: {},
        pinned: true,
        order: 5,
        dashboardSection: 'forecast',
        builtinKey: 'revenue_profit_forecast',
        size: 'lg',
      },
    };
  }

  private async buildCsmReportTemplates(): Promise<BuiltinReportTemplate[]> {
    const refs = await this.resolveCsmRefs();
    if (!refs) return [];

    const metric = (
      id: string,
      label: string,
      stageIds: string[],
      pipelineId = '',
    ): DataContractMetric => ({
      id,
      label,
      type: 'stage_reached',
      measure: 'deal_count',
      display: 'number',
      pipelineId,
      stageIds,
    });
    const conversion = (id: string, label: string, fromMetricId: string, toMetricId: string): DataContractMetric => ({
      id,
      label,
      type: 'conversion',
      measure: 'deal_count',
      display: 'percent',
      fromMetricId,
      toMetricId,
    });

    const csmPipelines = [refs.basePipeline.id, refs.assignedPipeline.id];
    const csmOfferStageIds = [refs.baseStages.offer.id, refs.assignedStages.offer.id];
    const csmInvoiceStageIds = [refs.baseStages.invoice.id, refs.assignedStages.invoice.id];
    const csmKpReachedStageIds = [...csmOfferStageIds, ...csmInvoiceStageIds];
    const csmSuccessStageIds = [
      ...new Set([
        ...refs.baseStages.success.map((stage) => stage.id),
        ...refs.assignedStages.success.map((stage) => stage.id),
      ]),
    ];
    const csmSuccessStageIdsByPipelineId = {
      [refs.basePipeline.id]: csmSuccessStageIds,
      [refs.assignedPipeline.id]: csmSuccessStageIds,
    };
    const assemblyStageIds = refs.assemblyStages.map((stage) => stage.id);
    const funnelMetrics: DataContractMetric[] = [
      metric('taken_to_work', 'Взяли в работу', [refs.baseStages.work.id, refs.assignedStages.work.id]),
      conversion('conv_work_to_offer', 'Конверсия в КП', 'taken_to_work', 'offer_made'),
      metric('offer_made', 'Сделали КП', [refs.baseStages.offer.id, refs.assignedStages.offer.id]),
      conversion('conv_offer_to_invoice', 'Конверсия КП -> счёт', 'offer_made', 'invoice_sent'),
      metric('invoice_sent', 'Счета отправили', [refs.baseStages.invoice.id, refs.assignedStages.invoice.id]),
      conversion('conv_invoice_to_paid', 'Конверсия счёт -> оплата', 'invoice_sent', 'paid'),
      metric('paid', 'Оплаченные счета', csmSuccessStageIds),
      {
        id: 'paid_amount',
        label: 'Сумма оплаченных счетов',
        type: 'stage_reached',
        measure: 'field_sum',
        display: 'money',
        pipelineId: csmPipelines[0],
        stageIds: csmSuccessStageIds,
      },
    ];
    const weightedMetrics: DataContractMetric[] = [
      {
        id: 'count_kp',
        label: 'Сделок в КП',
        type: 'current_stage',
        measure: 'deal_count',
        display: 'number',
        stageIds: csmOfferStageIds,
      },
      {
        id: 'sum_kp',
        label: 'Сумма КП',
        type: 'current_stage',
        measure: 'field_sum',
        display: 'money',
        stageIds: csmOfferStageIds,
      },
      {
        id: 'weighted_kp',
        label: 'КП x конверсия',
        type: 'weighted_stage_sum',
        display: 'money',
        stageIds: csmOfferStageIds,
        probabilityReachedStageIds: csmKpReachedStageIds,
        inferSuccessAsReached: true,
        successStageIdsByPipelineId: csmSuccessStageIdsByPipelineId,
        probabilityStageScope: 'metric',
        defaultProbability: 0.3,
      },
      {
        id: 'count_invoice',
        label: 'Сделок в счетах',
        type: 'current_stage',
        measure: 'deal_count',
        display: 'number',
        stageIds: csmInvoiceStageIds,
      },
      {
        id: 'sum_invoice',
        label: 'Сумма счетов',
        type: 'current_stage',
        measure: 'field_sum',
        display: 'money',
        stageIds: csmInvoiceStageIds,
      },
      {
        id: 'weighted_invoice',
        label: 'Счета x конверсия',
        type: 'weighted_stage_sum',
        display: 'money',
        stageIds: csmInvoiceStageIds,
        probabilityReachedStageIds: csmInvoiceStageIds,
        inferSuccessAsReached: true,
        successStageIdsByPipelineId: csmSuccessStageIdsByPipelineId,
        probabilityStageScope: 'metric',
        defaultProbability: 0.9,
      },
      {
        id: 'count_assembly',
        label: 'Сделок в сборке',
        type: 'current_stage',
        measure: 'deal_count',
        display: 'number',
        pipelineId: refs.assemblyPipeline?.id ?? '',
        stageIds: assemblyStageIds,
      },
      {
        id: 'sum_assembly',
        label: 'Сумма сборки',
        type: 'current_stage',
        measure: 'field_sum',
        display: 'money',
        pipelineId: refs.assemblyPipeline?.id ?? '',
        stageIds: assemblyStageIds,
      },
      {
        id: 'weighted_assembly',
        label: 'Сборка x 100%',
        type: 'formula',
        display: 'money',
        formula: '[Сумма сборки]',
      },
      {
        id: 'weighted_total',
        label: 'Итого взвешенно',
        type: 'formula',
        display: 'money',
        formula: '[КП x конверсия] + [Счета x конверсия] + [Сборка x 100%]',
      },
    ];

    const contract = {
      entity: 'deal' as const,
      groupBy: 'manager' as const,
      metrics: funnelMetrics,
      conversions: [],
      durations: [],
      includeRowTotal: false,
      rowTotalMode: 'sum' as const,
      includeSummaryRow: true,
      summaryRowMode: 'sum' as const,
    };
    const weightedContract = {
      entity: 'deal' as const,
      groupBy: 'manager' as const,
      metrics: weightedMetrics,
      conversions: [],
      durations: [],
      includeRowTotal: false,
      rowTotalMode: 'sum' as const,
      includeSummaryRow: true,
      summaryRowMode: 'sum' as const,
    };

    const baseConfig = (key: string, order: number, config: ReportConfig): ReportConfig => ({
      ...config,
      builtinKey: key,
      dashboardSection: 'csm',
      pinned: true,
      order,
      lockPipelineFilter: true,
      lockTeamFilter: true,
    });

    return [
      {
        name: 'CSM: воронка',
        position: 100,
        sourceType: 'CURRENT',
        config: baseConfig('csm_funnel', 100, {
          metric: 'contract',
          display: 'table',
          description: 'Взяли в работу, КП, счета, оплаты и конверсии по CSM',
          conditionLabel: 'База + Закрепленные компании: переходы по этапам и конверсии',
          filters: { pipelineIds: csmPipelines, groupIds: [refs.csmGroup.id] },
          contract,
          size: 'lg',
        }),
      },
      {
        name: 'CSM: взвешенная воронка',
        position: 101,
        sourceType: 'CURRENT',
        config: baseConfig('csm_weighted_funnel', 101, {
          metric: 'contract',
          display: 'table',
          description: 'Взвешенная сумма по КП, счетам и сборке CSM',
          conditionLabel: 'База + Закрепленные компании: КП и счета по персональной конверсии, сборка x 100%',
          filters: { pipelineIds: csmPipelines, groupIds: [refs.csmGroup.id] },
          contract: weightedContract,
          size: 'lg',
        }),
      },
      {
        name: 'CSM: время на этапах - База',
        position: 102,
        sourceType: 'CURRENT',
        config: baseConfig('csm_base_deal_cycle', 102, {
          metric: 'deal_cycle',
          display: 'cycle',
          description: 'Среднее время нахождения сделок на этапах воронки База',
          conditionLabel: 'База: сделки, вышедшие из этапов за выбранный период',
          filters: { pipelineIds: [refs.basePipeline.id], groupIds: [refs.csmGroup.id] },
          size: 'lg',
        }),
      },
      {
        name: 'CSM: время на этапах - Закрепленные компании',
        position: 103,
        sourceType: 'CURRENT',
        config: baseConfig('csm_assigned_deal_cycle', 103, {
          metric: 'deal_cycle',
          display: 'cycle',
          description: 'Среднее время нахождения сделок на этапах воронки Закрепленные компании',
          conditionLabel: 'Закрепленные компании: сделки, вышедшие из этапов за выбранный период',
          filters: { pipelineIds: [refs.assignedPipeline.id], groupIds: [refs.csmGroup.id] },
          size: 'lg',
        }),
      },
      {
        name: 'CSM: текущие сделки на этапах - База',
        position: 104,
        sourceType: 'CURRENT',
        config: baseConfig('csm_base_stage_age', 104, {
          metric: 'deal_stage_age',
          display: 'cycle',
          description: 'Текущее время нахождения открытых сделок на этапах воронки База',
          conditionLabel: 'База: открытые сделки сейчас',
          filters: { pipelineIds: [refs.basePipeline.id], groupIds: [refs.csmGroup.id] },
          size: 'lg',
        }),
      },
      {
        name: 'CSM: текущие сделки на этапах - Закрепленные компании',
        position: 105,
        sourceType: 'CURRENT',
        config: baseConfig('csm_assigned_stage_age', 105, {
          metric: 'deal_stage_age',
          display: 'cycle',
          description: 'Текущее время нахождения открытых сделок на этапах воронки Закрепленные компании',
          conditionLabel: 'Закрепленные компании: открытые сделки сейчас',
          filters: { pipelineIds: [refs.assignedPipeline.id], groupIds: [refs.csmGroup.id] },
          size: 'lg',
        }),
      },
    ];
  }

  private async ensureTeamScopedReportTemplates() {
    const [salesGroup, csmGroup, salesPipeline] = await Promise.all([
      this.findCrmGroupByName('Sales'),
      this.findCrmGroupByName('CSM'),
      this.findPipelineByName('\u0432\u043e\u0440\u043e\u043d\u043a\u0430 \u043f\u0440\u043e\u0434\u0430\u0436'),
    ]);

    await this.ensureSalesLossReasonsReportTemplate(salesGroup?.id, salesPipeline?.id);
    await this.applyTeamScopeToTemplates('Sales:', salesGroup?.id, salesPipeline ? [salesPipeline.id] : undefined, true);
    await this.applyTeamScopeToTemplates('CSM в продажах:', csmGroup?.id, salesPipeline ? [salesPipeline.id] : undefined, true);
    await this.applyTeamScopeToTemplates('CSM:', csmGroup?.id, undefined, true);
    await this.applySalesAssignedStageSpeedMode();
    await this.applySalesLeadsReceivedMetric();
  }

  private async ensureSalesLossReasonsReportTemplate(salesGroupId?: string, salesPipelineId?: string) {
    const name = 'Sales: причины отказа';
    const config: ReportConfig = {
      metric: 'loss_reasons',
      display: 'table',
      dashboardSection: 'sales',
      pinned: true,
      order: 6,
      size: 'lg',
      builtinKey: 'sales_loss_reasons',
      description: 'Сделки, отправленные в отказ за выбранный период, по причинам отказа',
      conditionLabel: 'Продажи: вход в отказ за выбранный период, по менеджерам Sales',
      lockPipelineFilter: true,
      lockTeamFilter: true,
      filters: {
        ...(salesPipelineId ? { pipelineIds: [salesPipelineId] } : {}),
        ...(salesGroupId ? { groupIds: [salesGroupId] } : {}),
      },
    };
    const data = {
      userId: null,
      name,
      sourceType: 'EVENT' as ReportSourceType,
      config: config as any,
      position: config.order ?? 6,
      isShared: true,
    };
    const existing = await this.db.reportTemplate.findFirst({ where: { name } });
    if (!existing) {
      await this.db.reportTemplate.create({ data });
      return;
    }
    await this.db.reportTemplate.update({ where: { id: existing.id }, data });
  }

  private async applySalesAssignedStageSpeedMode() {
    const templates = await this.db.reportTemplate.findMany({ where: { name: 'Sales: \u0441\u043a\u043e\u0440\u043e\u0441\u0442\u044c \u0432\u0437\u044f\u0442\u0438\u044f \u0441\u0434\u0435\u043b\u043e\u043a' } });
    for (const template of templates) {
      const config = template.config as ReportConfig;
      const durations = config.contract?.durations ?? [];
      if (!durations.length) continue;

      const nextDurations = durations.map((duration) =>
        duration.id === 'assigned_stage_speed' && duration.startMode !== 'sales_responsible_task'
          ? { ...duration, startMode: 'sales_responsible_task' as const }
          : duration,
      );
      const conditionLabel = '\u041e\u0442 \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u044f sales-\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u043e\u0433\u043e \u0438 \u0437\u0430\u0434\u0430\u0447\u0438 \u043d\u0430 \u043d\u0435\u0433\u043e \u0434\u043e \u0432\u044b\u0445\u043e\u0434\u0430 \u0438\u0437 \u044d\u0442\u0430\u043f\u0430';
      const description = '\u0421\u0440\u0435\u0434\u043d\u0435\u0435 \u0432\u0440\u0435\u043c\u044f \u043e\u0442 \u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u044f sales-\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u043e\u0433\u043e \u0438 \u043f\u043e\u044f\u0432\u043b\u0435\u043d\u0438\u044f \u0437\u0430\u0434\u0430\u0447\u0438 \u043d\u0430 \u043d\u0435\u0433\u043e \u0434\u043e \u0432\u044b\u0445\u043e\u0434\u0430 \u0441\u0434\u0435\u043b\u043a\u0438 \u0438\u0437 \u044d\u0442\u0430\u043f\u0430';
      const shouldUpdate =
        nextDurations.some((duration, index) => duration !== durations[index]) ||
        config.conditionLabel !== conditionLabel ||
        config.description !== description;
      if (!shouldUpdate) continue;

      await this.db.reportTemplate.update({
        where: { id: template.id },
        data: {
          config: {
            ...config,
            conditionLabel,
            description,
            contract: {
              ...(config.contract ?? {}),
              durations: nextDurations,
            },
          } as any,
        },
      });
    }
  }

  private async applySalesLeadsReceivedMetric() {
    const templates = await this.db.reportTemplate.findMany({ where: { name: { startsWith: 'Sales:' } } });
    const marketingFieldId = await this.resolveLeadFieldExternalId('маркетинг') ?? '809047';
    for (const template of templates) {
      const config = template.config as ReportConfig;
      const metrics = config.contract?.metrics ?? [];
      if (!metrics.some((metric) => metric.id === 'leads_received')) continue;

      const nextMetrics = metrics.map((metric) => {
        if (metric.id !== 'leads_received') return metric;
        const { fieldId: _fieldId, fieldValue: _fieldValue, ...restMetric } = metric;
        return {
          ...restMetric,
          type: 'created_deals' as const,
          measure: 'deal_count' as const,
          display: 'number' as const,
          fieldOperator: 'equals' as const,
          extraFilters: [
            {
              id: 'marketing_accepted',
              subject: 'deal_field' as const,
              fieldId: marketingFieldId,
              operator: 'equals' as const,
              value: '\u041f\u0440\u0438\u043d\u044f\u0442\u043e',
            },
          ],
        };
      });

      await this.db.reportTemplate.update({
        where: { id: template.id },
        data: {
          config: {
            ...config,
            contract: {
              ...(config.contract ?? {}),
              metrics: nextMetrics,
            },
          } as any,
        },
      });
    }
  }

  private async resolveLeadFieldExternalId(name: string) {
    const fields = await this.db.customFieldDefinition.findMany({
      where: { entityType: 'LEAD' as any, isVisible: true },
      select: { externalId: true, name: true },
    });
    const needle = this.normalizeStageName(name);
    return fields.find((field) => this.normalizeStageName(field.name) === needle)?.externalId ??
      fields.find((field) => this.normalizeStageName(field.name).includes(needle))?.externalId ??
      null;
  }

  private async applyTeamScopeToTemplates(prefix: string, groupId?: string, pipelineIds?: string[], lockPipelineFilter = false) {
    if (!groupId) return;
    const templates = await this.db.reportTemplate.findMany({ where: { name: { startsWith: prefix } } });
    for (const template of templates) {
      const config = template.config as ReportConfig;
      const nextConfig: ReportConfig = {
        ...config,
        filters: {
          ...(config.filters ?? {}),
          groupIds: [groupId],
          ...(pipelineIds?.length ? { pipelineIds } : {}),
        },
        lockTeamFilter: true,
        lockPipelineFilter: lockPipelineFilter || Boolean(pipelineIds?.length) ? true : config.lockPipelineFilter,
      };
      await this.db.reportTemplate.update({
        where: { id: template.id },
        data: { config: nextConfig as any },
      });
    }
  }

  private async findPipelineByName(name: string) {
    const pipelines = await this.db.pipeline.findMany({ where: { isArchived: false }, select: { id: true, name: true } });
    const normalizedNeedle = this.normalizeStageName(name);
    return pipelines.find((pipeline) => this.normalizeStageName(pipeline.name) === normalizedNeedle) ??
      pipelines.find((pipeline) => this.normalizeStageName(pipeline.name).includes(normalizedNeedle)) ??
      null;
  }

  async saveTemplate(dto: SaveReportTemplateDto, userId: string) {
    const existing = dto.id ? await this.db.reportTemplate.findUnique({ where: { id: dto.id } }) : null;
    if (existing?.userId && existing.userId !== userId) {
      const actor = await this.db.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (actor?.role !== 'ADMIN') throw new ForbiddenException('Редактировать отчёт может только автор или админ');
    }
    const data = {
      userId: existing?.userId ?? userId,
      name: dto.name,
      sourceType: dto.sourceType as ReportSourceType,
      config: { filters: dto.filters, ...dto.config },
      position: Number(dto.config?.order ?? 0),
    };
    if (dto.id) {
      const template = await this.db.reportTemplate.update({ where: { id: dto.id }, data });
      await this.audit.record({
        userId,
        action: 'reports.template.update',
        entity: 'ReportTemplate',
        entityId: template.id,
        metadata: { name: template.name, sourceType: template.sourceType },
      });
      return template;
    }
    const template = await this.db.reportTemplate.create({ data });
    await this.audit.record({
      userId,
      action: 'reports.template.create',
      entity: 'ReportTemplate',
      entityId: template.id,
      metadata: { name: template.name, sourceType: template.sourceType },
    });
    return template;
  }

  async deleteTemplate(id: string, user?: { id: string; role: UserRole }) {
    const template = await this.db.reportTemplate.findUnique({ where: { id }, select: { userId: true } });
    if (template?.userId && template.userId !== user?.id && user?.role !== 'ADMIN') {
      throw new ForbiddenException('Удалить отчёт может только автор или админ');
    }
    await this.db.reportTemplate.delete({ where: { id } });
    await this.audit.record({
      userId: user?.id,
      action: 'reports.template.delete',
      entity: 'ReportTemplate',
      entityId: id,
    });
    return { ok: true };
  }

  async exportExcel(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    const latestSyncAt = await this.latestReportSourceSyncAt();
    const cacheKey = this.reportCacheKey(dto, user);
    const report = await this.computeFresh(dto, user);
    await this.saveCachedReport(cacheKey, dto.name, report, latestSyncAt, dto, user);
    const sheets: XlsxSheet[] = [
      {
        name: 'Параметры',
        rows: [
          ['Отчет', dto.name],
          ['Источник', dto.sourceType],
          ['Сформирован', new Date().toISOString()],
          ['Фильтры', JSON.stringify(dto.filters)],
        ],
      },
    ];

    if (Array.isArray((report as any).steps)) {
      sheets.push(this.jsonSheet('Конверсии', (report as any).steps));
    }
    if ((report as any).type === 'lossReasons') {
      sheets.push(this.jsonSheet('Причины отказа', (report as any).tableRows ?? []));
    } else if (Array.isArray((report as any).rows)) {
      sheets.push(this.jsonSheet('Данные', (report as any).rows));
    }
    if ((report as any).type !== 'lossReasons' && Array.isArray((report as any).tableRows)) {
      sheets.push(this.jsonSheet('Data contract', (report as any).tableRows));
    }
    if ((report as any).forecast) {
      sheets.push(this.jsonSheet('Прогноз', [(report as any).forecast]));
    }
    if ((report as any).type === 'dealCycle') {
      sheets.push(this.jsonSheet('Циклы сделок', this.flattenDealCycleRows((report as any).rows ?? [], (report as any).summary)));
    }
    if ((report as any).type === 'dealStageAge') {
      sheets.push(this.jsonSheet('Текущие этапы', this.flattenDealCycleRows((report as any).rows ?? [], (report as any).summary)));
    }
    if ((report as any).type === 'revenueProfitForecast') {
      sheets.push(this.jsonSheet('Прогноз выручки', (report as any).rows ?? []));
      sheets.push(this.jsonSheet('Сделки прогноза', ((report as any).rows ?? []).flatMap((row: any) => row.deals ?? [])));
    }

    return this.buildXlsx(sheets);
  }

  async enqueueExport(dto: ReportQueryDto, user: { id: string; role: UserRole }) {
    const job = await this.prisma.exportJob.create({
      data: {
        status: ExportJobStatus.QUEUED,
        reportConfig: {
          dto,
          user: { id: user.id, role: user.role },
          fileName: `${dto.name || 'report'}.xlsx`,
        } as any,
      },
    });
    return { jobId: job.id, status: job.status };
  }

  async processExportJobs(limit = 1) {
    const jobs = await this.prisma.exportJob.findMany({
      where: { status: ExportJobStatus.QUEUED },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    for (const job of jobs) {
      const locked = await this.prisma.exportJob.updateMany({
        where: { id: job.id, status: ExportJobStatus.QUEUED },
        data: { status: ExportJobStatus.RUNNING, error: null },
      });
      if (locked.count === 0) continue;

      try {
        const config = job.reportConfig as any;
        const dto = config?.dto as ReportQueryDto;
        const user = config?.user as { id: string; role: UserRole };
        if (!dto || !user?.id || !user?.role) throw new Error('Invalid export job payload');

        const buffer = await this.exportExcel(dto, user);
        await mkdir(EXPORTS_DIR, { recursive: true });
        const filePath = join(EXPORTS_DIR, `${job.id}.xlsx`);
        await writeFile(filePath, buffer);
        await this.prisma.exportJob.update({
          where: { id: job.id },
          data: { status: ExportJobStatus.SUCCESS, filePath, finishedAt: new Date(), error: null },
        });
      } catch (error: any) {
        await this.prisma.exportJob.update({
          where: { id: job.id },
          data: { status: ExportJobStatus.ERROR, error: String(error?.message ?? error), finishedAt: new Date() },
        });
        this.logger.warn(`Export job ${job.id} failed: ${error.message}`);
      } finally {
        this.compactHeap();
        await this.recycleWorkerIfNeeded('report export');
      }
    }

    return { processed: jobs.length };
  }

  async getExportJob(id: string, user: { id: string; role: UserRole }) {
    const job = await this.prisma.exportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Export job not found');
    this.ensureExportJobOwner(job.reportConfig, user);
    return {
      id: job.id,
      status: job.status,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    };
  }

  async getExportFile(id: string, user: { id: string; role: UserRole }) {
    const job = await this.prisma.exportJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Export job not found');
    this.ensureExportJobOwner(job.reportConfig, user);
    if (job.status !== ExportJobStatus.SUCCESS || !job.filePath) {
      throw new NotFoundException('Export file is not ready');
    }
    const config = job.reportConfig as any;
    return {
      stream: createReadStream(job.filePath),
      fileName: String(config?.fileName || 'report.xlsx'),
    };
  }

  private ensureExportJobOwner(reportConfig: Prisma.JsonValue, user: { id: string; role: UserRole }) {
    if (user.role === UserRole.ADMIN) return;
    const ownerId = (reportConfig as any)?.user?.id;
    if (ownerId !== user.id) throw new ForbiddenException('Export job is not available');
  }

  private compactHeap() {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gc === 'function') gc();
  }

  private async recycleWorkerIfNeeded(reason: string) {
    if (!process.argv.some((arg) => arg.endsWith('worker.js'))) return;
    const limit = this.resolveWorkerRecycleRssMb();
    if (limit <= 0) return;

    const rssMb = Math.round(process.memoryUsage().rss / MB);
    if (rssMb < limit) return;

    const runningSyncJobs = await this.prisma.syncJob.count({ where: { status: 'RUNNING' } });
    if (runningSyncJobs > 0) {
      this.logger.warn(`Worker RSS ${rssMb}MB exceeded ${limit}MB after ${reason}; restart delayed, sync jobs are running`);
      return;
    }

    this.logger.warn(`Worker RSS ${rssMb}MB exceeded ${limit}MB after ${reason}; restarting worker process`);
    setTimeout(() => process.exit(0), 100);
  }

  private resolveWorkerRecycleRssMb() {
    const value = Number(process.env.WORKER_RECYCLE_RSS_MB);
    if (!Number.isFinite(value)) return DEFAULT_WORKER_RECYCLE_RSS_MB;
    return Math.floor(value);
  }

  private jsonSheet(name: string, rows: Array<Record<string, any>>): XlsxSheet {
    if (rows.length === 0) return { name, rows: [] };

    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    return {
      name,
      rows: [columns, ...rows.map((row) => columns.map((key) => this.excelCellValue(row[key])))],
    };
  }

  private excelCellValue(value: unknown) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    return JSON.stringify(value);
  }

  private async buildXlsx(sheets: XlsxSheet[]) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', this.contentTypesXml(sheets.length));
    zip.folder('_rels')!.file('.rels', this.rootRelsXml());
    zip.folder('xl')!.file('workbook.xml', this.workbookXml(sheets));
    zip.folder('xl')!.folder('_rels')!.file('workbook.xml.rels', this.workbookRelsXml(sheets.length));
    const worksheets = zip.folder('xl')!.folder('worksheets')!;
    sheets.forEach((sheet, index) => worksheets.file(`sheet${index + 1}.xml`, this.worksheetXml(sheet.rows)));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  private contentTypesXml(sheetCount: number) {
    const sheets = Array.from({ length: sheetCount }, (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets}
</Types>`;
  }

  private rootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  }

  private workbookXml(sheets: XlsxSheet[]) {
    const sheetItems = sheets
      .map((sheet, index) => `<sheet name="${this.xmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheetItems}</sheets>
</workbook>`;
  }

  private workbookRelsXml(sheetCount: number) {
    const rels = Array.from({ length: sheetCount }, (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    ).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
  }

  private worksheetXml(rows: XlsxValue[][]) {
    const rowXml = rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, colIndex) => this.cellXml(value, `${this.columnName(colIndex + 1)}${rowIndex + 1}`))
          .join('');
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
  }

  private cellXml(value: XlsxValue, ref: string) {
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t>${this.xmlText(String(value ?? ''))}</t></is></c>`;
  }

  private columnName(index: number) {
    let name = '';
    let current = index;
    while (current > 0) {
      const remainder = (current - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      current = Math.floor((current - 1) / 26);
    }
    return name;
  }

  private xmlText(value: string) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private xmlAttr(value: string) {
    return this.xmlText(value).replace(/"/g, '&quot;');
  }
  private async computeDataContract(filters: ReportFilters, contract: DataContractConfig, role: UserRole) {
    if (contract.entity === 'task') return this.computeTaskDataContract(filters, contract, role);

    const groupBy = contract.groupBy ?? 'manager';
    const groups = new Map<string, { id: string; name: string }>();
    const metricResults = new Map<string, Map<string, ContractBucket>>();
    if (groupBy === 'none') groups.set('all', { id: 'all', name: 'Отдел' });
    if (groupBy === 'manager') {
      const managers = await this.visibleManagers(role, filters.groupIds, filters.managerIds);
      for (const manager of managers) groups.set(manager.id, { id: manager.id, name: manager.name });
    }

    for (const metric of contract.metrics ?? []) {
      const byGroup = new Map<string, ContractBucket>();
      byGroup.set('all', this.emptyContractBucket(metric));

      if (metric.type === 'conversion' || metric.type === 'formula') {
        metricResults.set(metric.id, byGroup);
        continue;
      }

      let deals = await this.findDealsForContractMetric(metric, filters, role);
      if (metric.type === 'weighted_stage_sum') {
        deals = await this.attachWeightedStageValues(deals, metric);
      }

      for (const deal of deals) {
        const group = this.contractGroup(deal, groupBy);
        const groupId = group.id;
        const groupName = group.name;
        groups.set(groupId, { id: groupId, name: groupName });
        this.addDealToContractBucket(byGroup.get('all')!, deal, metric);
        if (groupId !== 'all') {
          if (!byGroup.has(groupId)) {
            byGroup.set(groupId, this.emptyContractBucket(metric));
          }
          this.addDealToContractBucket(byGroup.get(groupId)!, deal, metric);
        }
      }

      for (const bucket of byGroup.values()) this.finalizeContractBucket(bucket, metric);
      metricResults.set(metric.id, byGroup);
    }

    const durationResults = await this.computeContractDurations(filters, contract.durations ?? [], role, groups);

    const rows: any[] = [...groups.values()].map((group) => {
      const metrics = Object.fromEntries(
        (contract.metrics ?? []).map((metric) => {
          const value = metricResults.get(metric.id)?.get(group.id) ?? {
            count: 0,
            dealIds: new Set<string>(),
            samples: [],
            values: [],
            value: this.emptyMetricValue(metric),
            unit: this.metricUnit(metric),
          };

          if (metric.type === 'conversion') {
            const fromBucket = metricResults.get(metric.fromMetricId ?? '')?.get(group.id);
            const toBucket = metricResults.get(metric.toMetricId ?? '')?.get(group.id);
            const from = fromBucket?.count ?? 0;
            const to = toBucket?.count ?? 0;
            value.count = to;
            value.value = from > 0 ? Number(((to / from) * 100).toFixed(2)) : null;
            value.unit = 'percent';
          }

          const samples = this.contractDealSamples(value.samples);
          const fromSamples = metric.type === 'conversion'
            ? this.contractDealSamples(metricResults.get(metric.fromMetricId ?? '')?.get(group.id)?.samples)
            : [];
          const toSamples = metric.type === 'conversion'
            ? this.contractDealSamples(metricResults.get(metric.toMetricId ?? '')?.get(group.id)?.samples)
            : [];

          return [
            metric.id,
            {
              id: metric.id,
              label: metric.label,
              value: value.value,
              unit: value.unit,
              dealCount: value.count,
              sampleSize: metric.type === 'conversion' ? toSamples.length : samples.length,
              samples: metric.type === 'conversion' ? toSamples : samples,
              ...(metric.type === 'conversion'
                ? {
                    from: metricResults.get(metric.fromMetricId ?? '')?.get(group.id)?.count ?? 0,
                    to: metricResults.get(metric.toMetricId ?? '')?.get(group.id)?.count ?? 0,
                    fromSamples,
                    toSamples,
                  }
                : {}),
            },
          ];
        }),
      );

      const conversions = Object.fromEntries(
        (contract.conversions ?? []).map((conversion) => {
          const fromBucket = metricResults.get(conversion.fromMetricId)?.get(group.id);
          const toBucket = metricResults.get(conversion.toMetricId)?.get(group.id);
          const fromSamples = this.contractDealSamples(fromBucket?.samples);
          const toSamples = this.contractDealSamples(toBucket?.samples);
          const from = fromBucket?.count ?? 0;
          const to = toBucket?.count ?? 0;
          return [
            conversion.id,
            {
              id: conversion.id,
              label: conversion.label,
              from,
              to,
              conversion: from > 0 ? Number(((to / from) * 100).toFixed(2)) : null,
              sampleSize: toSamples.length,
              samples: toSamples,
              fromSamples,
              toSamples,
            },
          ];
        }),
      );

      const durations = Object.fromEntries(
        (contract.durations ?? []).map((duration) => [
          duration.id,
          durationResults.get(duration.id)?.get(group.id) ?? {
            id: duration.id,
            label: duration.label,
            avgDays: null,
            sampleSize: 0,
            samples: [],
          },
        ]),
      );

      return { groupId: group.id, groupName: group.name, metrics, conversions, durations };
    });

    for (const row of rows) {
      for (const metric of contract.metrics ?? []) {
        if (metric.type !== 'formula') continue;
        const value = this.evaluateFormula(metric.formula ?? '', row.metrics);
        row.metrics[metric.id] = {
          id: metric.id,
          label: metric.label,
          value,
          unit: metric.display ?? 'number',
          dealCount: 0,
        };
      }
      if (contract.includeRowTotal) {
        row.rowTotal = this.calculateRowSummary(row.metrics, contract.rowTotalMode ?? 'sum');
      }
    }

    const summaryRows = contract.includeSummaryRow
      ? [this.calculateSummaryRow(rows, contract.metrics ?? [], contract.summaryRowMode ?? 'sum')]
      : [];

    return {
      type: 'contract',
      groupBy,
      metrics: contract.metrics ?? [],
      conversions: contract.conversions ?? [],
      durations: contract.durations ?? [],
      summaryRows,
      rows,
      tableRows: this.flattenContractRows(rows, contract),
    };
  }

  private async computeTaskDataContract(filters: ReportFilters, contract: DataContractConfig, role: UserRole) {
    const groupBy = contract.groupBy ?? 'manager';
    const groups = new Map<string, { id: string; name: string }>();
    const metricResults = new Map<
      string,
      Map<string, { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string }>
    >();
    if (groupBy === 'none') groups.set('all', { id: 'all', name: 'Отдел' });
    if (groupBy === 'manager') {
      const managers = await this.visibleManagers(role, filters.groupIds, filters.managerIds);
      for (const manager of managers) groups.set(manager.id, { id: manager.id, name: manager.name });
    }

    for (const metric of contract.metrics ?? []) {
      const byGroup = new Map<string, { count: number; values: number[]; dealIds: Set<string>; value: number | null; unit: string }>();
      byGroup.set('all', { count: 0, values: [], dealIds: new Set<string>(), value: null, unit: metric.display ?? 'number' });

      if (metric.type === 'formula') {
        metricResults.set(metric.id, byGroup);
        continue;
      }

      const tasks = await this.findTasksForContractMetric(metric, filters, role);
      for (const task of tasks) {
        const group = this.taskContractGroup(task, groupBy);
        const groupId = group.id;
        groups.set(groupId, { id: groupId, name: group.name });
        byGroup.get('all')!.count += 1;
        if (groupId !== 'all') {
          if (!byGroup.has(groupId)) {
            byGroup.set(groupId, { count: 0, values: [], dealIds: new Set<string>(), value: null, unit: metric.display ?? 'number' });
          }
          byGroup.get(groupId)!.count += 1;
        }
      }
      for (const bucket of byGroup.values()) bucket.value = bucket.count;
      metricResults.set(metric.id, byGroup);
    }

    const rows: any[] = [...groups.values()].map((group) => {
      const metrics = Object.fromEntries(
        (contract.metrics ?? []).map((metric) => {
          const value = metricResults.get(metric.id)?.get(group.id) ?? {
            count: 0,
            values: [],
            dealIds: new Set<string>(),
            value: metric.type === 'formula' ? null : 0,
            unit: metric.display ?? 'number',
          };
          return [
            metric.id,
            {
              id: metric.id,
              label: metric.label,
              value: value.value,
              unit: value.unit,
              dealCount: value.count,
            },
          ];
        }),
      );
      return { groupId: group.id, groupName: group.name, metrics, conversions: {}, durations: {} };
    });

    for (const row of rows) {
      for (const metric of contract.metrics ?? []) {
        if (metric.type !== 'formula') continue;
        const value = this.evaluateFormula(metric.formula ?? '', row.metrics);
        row.metrics[metric.id] = {
          id: metric.id,
          label: metric.label,
          value,
          unit: metric.display ?? 'number',
          dealCount: 0,
        };
      }
      if (contract.includeRowTotal) {
        row.rowTotal = this.calculateRowSummary(row.metrics, contract.rowTotalMode ?? 'sum');
      }
    }

    const summaryRows = contract.includeSummaryRow
      ? [this.calculateSummaryRow(rows, contract.metrics ?? [], contract.summaryRowMode ?? 'sum')]
      : [];

    return {
      type: 'contract',
      entity: 'task',
      groupBy,
      metrics: contract.metrics ?? [],
      conversions: [],
      durations: [],
      summaryRows,
      rows,
      tableRows: this.flattenContractRows(rows, contract),
    };
  }

  private taskContractGroup(task: any, groupBy: 'manager' | 'group' | 'none') {
    if (groupBy === 'group') {
      return {
        id: task.responsible?.group?.id ?? 'unassigned-group',
        name: task.responsible?.group?.name ?? 'Без группы',
      };
    }
    if (groupBy === 'manager') {
      return {
        id: task.responsibleId ?? 'unassigned',
        name: task.responsible?.name ?? 'Без менеджера',
      };
    }
    return { id: 'all', name: 'Отдел' };
  }

  private async findTasksForContractMetric(metric: DataContractMetric, filters: ReportFilters, role: UserRole) {
    const where: Record<string, any> = {};
    if (filters.managerIds?.length) where.responsibleId = { in: filters.managerIds };
    const visibleManagerIds = await this.visibleManagerIds(role, filters.groupIds);
    if (visibleManagerIds) {
      where.responsibleId = where.responsibleId
        ? { in: where.responsibleId.in.filter((id: string) => visibleManagerIds.includes(id)) }
        : { in: visibleManagerIds };
    }
    const tasks = await this.db.task.findMany({
      where,
      include: { responsible: { include: { group: true } } },
    });
    return tasks.filter((task) => (metric.extraFilters ?? []).every((filter) => this.matchesTaskFilter(task, filter)));
  }

  private matchesTaskFilter(task: any, filter: DataContractFilter) {
    if (filter.operator === 'within_last' || filter.operator === 'older_than') {
      return this.matchesRelativeDateFilter(this.taskFilterValue(task, filter), filter);
    }
    return this.matchesFilterValue(this.taskFilterValue(task, filter), filter);
  }

  private taskFilterValue(task: any, filter: DataContractFilter) {
    if (filter.subject === 'task_created_at') return task.createdAt;
    if (filter.subject === 'task_updated_at') return task.updatedAt;
    if (filter.subject === 'task_due_at') return task.dueAt;
    if (filter.subject === 'task_completed_at') return task.completedAt;
    if (filter.subject === 'task_type') return task.typeId == null ? null : String(task.typeId);
    if (filter.subject === 'task_status') return this.taskStatus(task);
    if (filter.subject === 'task_text') return task.title;
    if (filter.subject === 'task_responsible') return task.responsibleId;
    if (filter.subject === 'task_group') return task.responsible?.group?.id;
    return null;
  }

  private taskStatus(task: any) {
    if (task.isCompleted) return 'completed';
    if (!task.dueAt) return 'no_due';
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const dueAt = new Date(task.dueAt);
    if (dueAt < start) return 'overdue';
    if (dueAt <= end) return 'planned_today';
    return 'planned_future';
  }

  private contractGroup(deal: any, groupBy: 'manager' | 'group' | 'none') {
    if (groupBy === 'group') {
      return {
        id: deal.responsible?.group?.id ?? 'unassigned-group',
        name: deal.responsible?.group?.name ?? 'Без группы',
      };
    }
    if (groupBy === 'manager') {
      return {
        id: deal.responsibleId ?? 'unassigned',
        name: deal.responsible?.name ?? 'Без менеджера',
      };
    }
    return { id: 'all', name: 'Отдел' };
  }

  private async findDealsForContractMetric(metric: DataContractMetric, filters: ReportFilters, role: UserRole) {
    const scopedFilters: ReportFilters = {
      ...filters,
      pipelineIds: metric.pipelineId ? [metric.pipelineId] : filters.pipelineIds,
    };

    const applyMetricFilters = async (deals: any[]) => this.applyMetricDealFilters(deals, metric);

    if (metric.type === 'stage_reached') {
      const stageIds = metric.stageIds?.filter(Boolean) ?? [];
      if (stageIds.length === 0) return [];
      const dealIds = await this.findDealIdsFromHistoryMany(stageIds, filters, role, metric.fromStageId);
      return applyMetricFilters(await this.findDealsByIds(dealIds));
    }

    if (metric.type === 'current_stage' || metric.type === 'weighted_stage_sum') {
      const stageIds = metric.stageIds?.filter(Boolean) ?? [];
      if (stageIds.length === 0) return [];
      return applyMetricFilters(await this.findFilteredDeals({ ...scopedFilters, stageIds }, role));
    }

    if (metric.type === 'field_condition' && metric.fieldId) {
      return applyMetricFilters(await this.findFilteredDeals(
        {
          ...scopedFilters,
          customFields: [
            {
              fieldId: metric.fieldId,
              operator: metric.fieldOperator ?? 'equals',
              value: metric.fieldValue,
            },
          ],
        },
        role,
        { createdAt: this.dateRange(filters) },
      ));
    }

    if (metric.type === 'field_changed' && metric.fieldId) {
      const dealIds = await this.findDealIdsFromFieldEvents(metric, filters, role);
      return applyMetricFilters(await this.findDealsByIds(dealIds));
    }

    return applyMetricFilters(await this.findFilteredDeals(scopedFilters, role, { createdAt: this.dateRange(filters) }));
  }

  private async findDealIdsFromFieldEvents(metric: DataContractMetric, filters: ReportFilters, role: UserRole) {
    const range = this.dateRange(filters);
    const events = await this.db.crmEvent.findMany({
      where: {
        type: `custom_field_${metric.fieldId}_value_changed`,
        dealId: { not: null },
        createdAt: range,
        deal: await this.buildDealWhere(filters, role, { ignorePipeline: true, ignoreStage: true }),
      },
      orderBy: [{ dealId: 'asc' }, { createdAt: 'asc' }],
      select: { dealId: true, valueAfter: true },
    });

    const firstEventByDeal = new Map<string, true>();
    for (const event of events) {
      if (!event.dealId) continue;
      if (!this.eventMatchesFieldMetric(event.valueAfter, metric)) continue;
      if (!firstEventByDeal.has(event.dealId)) firstEventByDeal.set(event.dealId, true);
    }

    return [...firstEventByDeal.keys()];
  }

  private eventMatchesFieldMetric(valueAfter: Prisma.JsonValue | null, metric: DataContractMetric) {
    const values = Array.isArray(valueAfter) ? valueAfter : [valueAfter];
    const expected = String(metric.fieldValue ?? '');
    return values.some((item: any) => {
      const value = item?.custom_field_value;
      if (!value || String(value.field_id ?? '') !== String(metric.fieldId)) return false;
      return String(value.text ?? value.value ?? value.enum_id ?? '') === expected;
    });
  }

  private async applyMetricDealFilters(deals: any[], metric: DataContractMetric) {
    const filters: DataContractFilter[] = [...(metric.extraFilters ?? [])];
    if (metric.createdWithinAmount && metric.createdWithinAmount > 0) {
      filters.push({
        subject: 'deal_created_at',
        operator: 'within_last',
        amount: metric.createdWithinAmount,
        unit: metric.createdWithinUnit ?? 'days',
      });
    }
    if (metric.lastNoteOlderThanAmount && metric.lastNoteOlderThanAmount > 0) {
      filters.push({
        subject: 'last_note_created_at',
        operator: 'older_than',
        amount: metric.lastNoteOlderThanAmount,
        unit: metric.lastNoteOlderThanUnit ?? 'hours',
      });
    }
    if (filters.length === 0 || deals.length === 0) return deals;

    let lastNoteByDeal = new Map<string, { createdAt: Date; text: string | null }>();
    if (filters.some((filter) => filter.subject === 'last_note_created_at' || filter.subject === 'last_note_text')) {
      const notes = await this.db.note.findMany({
        where: { dealId: { in: deals.map((deal) => deal.id) } },
        orderBy: { createdAt: 'desc' },
        select: { dealId: true, createdAt: true, text: true },
      });
      lastNoteByDeal = new Map<string, { createdAt: Date; text: string | null }>();
      for (const note of notes) {
        if (note.dealId && !lastNoteByDeal.has(note.dealId)) {
          lastNoteByDeal.set(note.dealId, { createdAt: note.createdAt, text: note.text });
        }
      }
    }

    return deals.filter((deal) => filters.every((filter) => this.matchesContractFilter(deal, filter, lastNoteByDeal)));
  }

  private async attachWeightedStageValues(deals: any[], metric: DataContractMetric) {
    if (deals.length === 0) return deals;
    const stageIds = metric.stageIds?.filter(Boolean) ?? [];
    const pipelineIds = [...new Set(deals.map((deal) => deal.pipelineId).filter(Boolean))];
    const successStageIdsByPipelineId = this.metricSuccessStageIdsByPipelineId(metric, pipelineIds);
    const model = await this.computeStageSuccessProbabilityModel({
      pipelineIds,
      stageIds,
      successStageIdsByPipelineId,
      groupStageIds: metric.probabilityStageScope === 'metric',
      reachedStageIds: metric.probabilityReachedStageIds,
      inferSuccessAsReached: metric.inferSuccessAsReached,
      defaultProbability: metric.defaultProbability ?? 0,
    });

    return deals.map((deal) => {
      const probability = model.probability(deal.stageId, deal.responsibleId);
      const amount = Number(deal.amount ?? 0);
      return {
        ...deal,
        __contractExpectedAmount: amount * probability.probability,
        __contractProbabilityPercent: Math.round(probability.probability * 100),
      };
    });
  }

  private metricSuccessStageIdsByPipelineId(metric: DataContractMetric, pipelineIds: string[]) {
    const byPipeline = new Map<string, Set<string>>();
    const add = (pipelineId: string | undefined, stageId: string | undefined) => {
      if (!pipelineId || !stageId) return;
      if (!byPipeline.has(pipelineId)) byPipeline.set(pipelineId, new Set<string>());
      byPipeline.get(pipelineId)!.add(stageId);
    };
    for (const [pipelineId, stageIds] of Object.entries(metric.successStageIdsByPipelineId ?? {})) {
      for (const stageId of stageIds ?? []) add(pipelineId, stageId);
    }
    for (const [pipelineId, stageId] of Object.entries(metric.successStageByPipelineId ?? {})) {
      add(pipelineId, stageId);
    }
    if (metric.successStageIds?.length) {
      const targetPipelineIds = metric.pipelineId ? [metric.pipelineId] : pipelineIds;
      for (const pipelineId of targetPipelineIds) {
        for (const stageId of metric.successStageIds) add(pipelineId, stageId);
      }
    }
    if (metric.successStageId) {
      if (metric.pipelineId) add(metric.pipelineId, metric.successStageId);
      for (const pipelineId of pipelineIds) {
        if (!byPipeline.has(pipelineId)) add(pipelineId, metric.successStageId);
      }
    }
    return Object.fromEntries([...byPipeline.entries()].map(([pipelineId, stageIds]) => [pipelineId, [...stageIds]]));
  }

  private async computeStageSuccessProbabilityModel(options: {
    pipelineIds: string[];
    stageIds: string[];
    successStageByPipelineId?: Record<string, string>;
    successStageIdsByPipelineId?: Record<string, string[]>;
    groupStageIds?: boolean;
    reachedStageIds?: string[];
    inferSuccessAsReached?: boolean;
    defaultProbability: number;
    now?: Date;
  }): Promise<StageSuccessProbabilityModel> {
    const pipelineIds = [...new Set(options.pipelineIds.filter(Boolean))];
    const stageIds = [...new Set(options.stageIds.filter(Boolean))];
    const reachedStageIds = [...new Set([...(options.reachedStageIds ?? []), ...stageIds].filter(Boolean))];
    const successStageIdsByPipelineId = this.normalizeSuccessStageIdsByPipelineId(options);
    const successStageIds = [...new Set(Object.values(successStageIdsByPipelineId).flat().filter(Boolean))];
    const defaultProbability = this.clampProbability(options.defaultProbability);
    if (!pipelineIds.length || !stageIds.length || !successStageIds.length) {
      return { probability: () => this.defaultStageProbability(defaultProbability) };
    }

    const now = options.now ?? new Date();
    const periodFrom = this.addDays(now, -30);
    const periodTo = now;
    const stageRows = await this.db.pipelineStage.findMany({
      where: {
        OR: [
          { id: { in: [...reachedStageIds, ...successStageIds] } },
          { pipelineId: { in: pipelineIds } },
        ],
      },
      select: {
        id: true,
        pipelineId: true,
        name: true,
        isLost: true,
        pipeline: { select: { name: true } },
      },
    });
    const pipelineByStageId = new Map(stageRows.map((stage) => [stage.id, stage.pipelineId]));
    const lossStageIds = this.probabilityLossStageIds(stageRows, pipelineIds);
    const terminalStageIds = [...new Set([...successStageIds, ...lossStageIds])];
    if (!terminalStageIds.length) {
      return { probability: () => this.defaultStageProbability(defaultProbability) };
    }

    const terminalEntries = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: { in: terminalStageIds },
        movedAt: { gte: periodFrom, lte: periodTo },
        deal: { deletedAt: null },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: {
        dealId: true,
        fromStageId: true,
        toStageId: true,
        movedAt: true,
        deal: { select: { pipelineId: true, responsibleId: true } },
      },
    });
    if (!terminalEntries.length) {
      return { probability: () => this.defaultStageProbability(defaultProbability) };
    }

    const lastTerminalByDeal = new Map<string, (typeof terminalEntries)[number]>();
    for (const entry of terminalEntries) {
      lastTerminalByDeal.set(entry.dealId, entry);
    }
    const historyEntries = await this.db.dealStageHistory.findMany({
      where: {
        dealId: { in: [...lastTerminalByDeal.keys()] },
        movedAt: { lte: periodTo },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: {
        dealId: true,
        fromStageId: true,
        toStageId: true,
        movedAt: true,
      },
    });

    const stats = new Map<string, { sample: number; wins: number }>();
    const add = (key: string, win: boolean) => {
      const stat = stats.get(key) ?? { sample: 0, wins: 0 };
      stat.sample += 1;
      if (win) stat.wins += 1;
      stats.set(key, stat);
    };
    const byDeal = new Map<string, typeof historyEntries>();
    for (const entry of historyEntries) {
      if (!byDeal.has(entry.dealId)) byDeal.set(entry.dealId, []);
      byDeal.get(entry.dealId)!.push(entry);
    }

    for (const terminalEntry of lastTerminalByDeal.values()) {
      const managerId = terminalEntry.deal.responsibleId ?? 'unassigned';
      const dealEntries = (byDeal.get(terminalEntry.dealId) ?? []).filter((entry) => entry.movedAt <= terminalEntry.movedAt);
      const won = successStageIds.includes(terminalEntry.toStageId);
      if (options.groupStageIds) {
        if (!this.probabilityStageReached(dealEntries, terminalEntry, reachedStageIds, won, Boolean(options.inferSuccessAsReached))) continue;
        add(`${managerId}:metric`, won);
        add('all:metric', won);
        add(`${managerId}:all`, won);
        add('all:all', won);
        continue;
      }
      for (const stageId of stageIds) {
        const pipelineId = pipelineByStageId.get(stageId);
        if (!pipelineId || !pipelineIds.includes(pipelineId)) continue;
        if (!this.probabilityStageReached(dealEntries, terminalEntry, reachedStageIds, won, Boolean(options.inferSuccessAsReached))) continue;
        add(`${managerId}:${stageId}`, won);
        add(`all:${stageId}`, won);
        add(`${managerId}:all`, won);
        add('all:all', won);
      }
    }

    const getStat = (key: string) => stats.get(key) ?? { sample: 0, wins: 0 };
    const rate = (stat: { sample: number; wins: number }) => (stat.sample > 0 ? stat.wins / stat.sample : null);

    return {
      probability: (stageId: string, managerId?: string | null) => {
        const safeManagerId = managerId ?? 'unassigned';
        const probabilityStageId = options.groupStageIds ? 'metric' : stageId;
        const personal = getStat(`${safeManagerId}:${probabilityStageId}`);
        const personalFallback = getStat(`${safeManagerId}:all`);
        const team = getStat(`all:${probabilityStageId}`);
        const teamFallback = getStat('all:all');
        const personalStat = personal.sample > 0 ? personal : personalFallback;
        const teamStat = team.sample > 0 ? team : teamFallback;
        const personalRate = rate(personalStat);
        const teamRate = rate(teamStat);

        if (personalStat.sample >= 10 && personalRate !== null) {
          return this.stageProbabilityResult(this.clampProbability(personalRate), 'personal', personalStat, teamStat, personalRate, teamRate);
        }
        if (personalStat.sample >= 5 && personalRate !== null && teamStat.sample >= 10 && teamRate !== null) {
          return this.stageProbabilityResult(
            this.clampProbability((personalRate + teamRate) / 2),
            'blended',
            personalStat,
            teamStat,
            personalRate,
            teamRate,
          );
        }
        if (teamStat.sample >= 10 && teamRate !== null) {
          return this.stageProbabilityResult(this.clampProbability(teamRate), 'team', personalStat, teamStat, personalRate, teamRate);
        }
        if (teamStat.sample >= 5 && teamRate !== null) {
          return this.stageProbabilityResult(
            this.clampProbability((teamRate + defaultProbability) / 2),
            'blended',
            personalStat,
            teamStat,
            personalRate,
            teamRate,
          );
        }
        return this.stageProbabilityResult(defaultProbability, 'default', personalStat, teamStat, personalRate, teamRate);
      },
    };
  }

  private probabilityLossStageIds(
    stages: Array<{ id: string; pipelineId: string; name: string; isLost: boolean; pipeline?: { name: string } | null }>,
    pipelineIds: string[],
  ) {
    return stages
      .filter((stage) => pipelineIds.includes(stage.pipelineId))
      .filter((stage) => stage.isLost || this.isBaseFreeBaseStage(stage))
      .map((stage) => stage.id);
  }

  private isBaseFreeBaseStage(stage: { name: string; pipeline?: { name: string } | null }) {
    const stageName = this.normalizeStageName(stage.name);
    const pipelineName = this.normalizeStageName(stage.pipeline?.name ?? '');
    return pipelineName === this.normalizeStageName('База') && stageName.includes(this.normalizeStageName('Свободная база'));
  }

  private probabilityStageReached(
    dealEntries: Array<{ fromStageId?: string | null; toStageId: string; movedAt: Date }>,
    terminalEntry: { fromStageId?: string | null; toStageId: string },
    reachedStageIds: string[],
    won: boolean,
    inferSuccessAsReached: boolean,
  ) {
    if (won && inferSuccessAsReached) return true;
    return dealEntries.some((entry) => (
      reachedStageIds.includes(entry.toStageId) ||
      (entry.fromStageId ? reachedStageIds.includes(entry.fromStageId) : false)
    )) || (terminalEntry.fromStageId ? reachedStageIds.includes(terminalEntry.fromStageId) : false);
  }

  private normalizeSuccessStageIdsByPipelineId(options: {
    successStageByPipelineId?: Record<string, string>;
    successStageIdsByPipelineId?: Record<string, string[]>;
  }) {
    const normalized: Record<string, string[]> = {};
    for (const [pipelineId, stageIds] of Object.entries(options.successStageIdsByPipelineId ?? {})) {
      normalized[pipelineId] = [...new Set((stageIds ?? []).filter(Boolean))];
    }
    for (const [pipelineId, stageId] of Object.entries(options.successStageByPipelineId ?? {})) {
      if (!stageId) continue;
      normalized[pipelineId] = [...new Set([...(normalized[pipelineId] ?? []), stageId])];
    }
    return normalized;
  }

  private defaultStageProbability(probability: number): StageSuccessProbability {
    return this.stageProbabilityResult(probability, 'default', { sample: 0, wins: 0 }, { sample: 0, wins: 0 }, null, null);
  }

  private stageProbabilityResult(
    probability: number,
    source: StageSuccessProbability['source'],
    personal: { sample: number; wins: number },
    team: { sample: number; wins: number },
    personalRate: number | null,
    teamRate: number | null,
  ): StageSuccessProbability {
    return {
      probability,
      source,
      personalSample: personal.sample,
      teamSample: team.sample,
      personalWins: personal.wins,
      teamWins: team.wins,
      personalRate,
      teamRate,
    };
  }

  private clampProbability(value: number) {
    if (!Number.isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 0.98);
  }

  private relativeThreshold(amount?: number, unit?: 'hours' | 'days' | 'weeks' | 'months') {
    if (!amount || amount <= 0 || !unit) return null;
    const date = new Date();
    if (unit === 'hours') date.setHours(date.getHours() - amount);
    if (unit === 'days') date.setDate(date.getDate() - amount);
    if (unit === 'weeks') date.setDate(date.getDate() - amount * 7);
    if (unit === 'months') date.setMonth(date.getMonth() - amount);
    return date;
  }

  private matchesContractFilter(
    deal: any,
    filter: DataContractFilter,
    lastNoteByDeal: Map<string, { createdAt: Date; text: string | null }>,
  ) {
    if (filter.operator === 'within_last' || filter.operator === 'older_than') {
      return this.matchesRelativeDateFilter(this.contractFilterValue(deal, filter, lastNoteByDeal), filter);
    }
    return this.matchesFilterValue(this.contractFilterValue(deal, filter, lastNoteByDeal), filter);
  }

  private contractFilterValue(
    deal: any,
    filter: DataContractFilter,
    lastNoteByDeal: Map<string, { createdAt: Date; text: string | null }>,
  ) {
    if (filter.subject === 'deal_created_at') return deal.createdAt;
    if (filter.subject === 'deal_updated_at') return deal.updatedAt;
    if (filter.subject === 'deal_closed_at') return deal.closedAt;
    if (filter.subject === 'deal_expected_close_at') return deal.expectedCloseAt;
    if (filter.subject === 'deal_amount') return deal.amount;
    if (filter.subject === 'deal_stage') return deal.stageId;
    if (filter.subject === 'deal_responsible') return deal.responsibleId;
    if (filter.subject === 'deal_group') return deal.responsible?.group?.id;
    if (filter.subject === 'deal_field' && filter.fieldId) {
      const field = (deal.customFields as Record<string, any>)?.[filter.fieldId];
      return field?.value ?? field;
    }
    if (filter.subject === 'last_note_created_at') return lastNoteByDeal.get(deal.id)?.createdAt ?? null;
    if (filter.subject === 'last_note_text') return lastNoteByDeal.get(deal.id)?.text ?? null;
    return null;
  }

  private matchesRelativeDateFilter(value: unknown, filter: DataContractFilter) {
    if (filter.operator === 'older_than' && filter.subject === 'last_note_created_at' && !value) return true;
    if (!value) return false;
    const date = new Date(value as any);
    if (Number.isNaN(date.getTime())) return false;
    const threshold = this.relativeThreshold(filter.amount, filter.unit);
    if (!threshold) return false;
    if (filter.operator === 'within_last') return date >= threshold;
    return date < threshold;
  }

  private matchesFilterValue(value: unknown, filter: DataContractFilter) {
    const actual = Array.isArray(value) ? value[0] : value;
    if (filter.operator === 'is_set') return actual !== undefined && actual !== null && actual !== '';
    if (filter.operator === 'contains') return String(actual ?? '').toLowerCase().includes(String(filter.value ?? '').toLowerCase());
    if (['lt', 'lte', 'gt', 'gte'].includes(filter.operator)) {
      const actualNumber = this.toNumber(actual);
      const expectedNumber = this.toNumber(filter.value);
      if (actualNumber === null || expectedNumber === null) return false;
      if (filter.operator === 'lt') return actualNumber < expectedNumber;
      if (filter.operator === 'lte') return actualNumber <= expectedNumber;
      if (filter.operator === 'gt') return actualNumber > expectedNumber;
      if (filter.operator === 'gte') return actualNumber >= expectedNumber;
    }
    return String(actual ?? '') === String(filter.value ?? '');
  }

  private addDealToContractBucket(
    bucket: ContractBucket,
    deal: any,
    metric: DataContractMetric,
  ) {
    if (bucket.dealIds.has(deal.id)) return;
    bucket.dealIds.add(deal.id);
    bucket.count += 1;
    bucket.samples.push(this.contractDealSample(deal));
    if (metric.type === 'weighted_stage_sum') {
      bucket.values.push(Number(deal.__contractExpectedAmount ?? 0));
      return;
    }
    const measure = metric.measure ?? 'deal_count';
    if (measure === 'field_sum' || measure === 'field_avg') {
      const fieldId = metric.valueFieldId ?? metric.amountFieldId ?? metric.marginFieldId;
      const number = fieldId
        ? this.numericCustomField(deal.customFields as Record<string, any>, fieldId)
        : Number(deal.amount ?? 0);
      bucket.values.push(number);
    }
  }

  private finalizeContractBucket(
    bucket: ContractBucket,
    metric: DataContractMetric,
  ) {
    const measure = metric.measure ?? 'deal_count';
    if (measure === 'field_sum') {
      bucket.value = Math.round(bucket.values.reduce((sum, value) => sum + value, 0));
      return;
    }
    if (metric.type === 'weighted_stage_sum') {
      bucket.value = Math.round(bucket.values.reduce((sum, value) => sum + value, 0));
      return;
    }
    if (measure === 'field_avg') {
      bucket.value = bucket.values.length
        ? Number((bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length).toFixed(2))
        : null;
      return;
    }
    bucket.value = bucket.count;
  }

  private emptyContractBucket(metric: DataContractMetric): ContractBucket {
    return {
      count: 0,
      values: [],
      dealIds: new Set<string>(),
      samples: [],
      value: null,
      unit: this.metricUnit(metric),
    };
  }

  private contractDealSample(deal: any): ContractDealSample {
    return {
      dealId: deal.id,
      dealExternalId: deal.externalId ?? null,
      dealTitle: deal.title,
      amount: Number.isFinite(Number(deal.amount)) ? Number(deal.amount) : null,
      expectedAmount: Number.isFinite(Number(deal.__contractExpectedAmount)) ? Number(deal.__contractExpectedAmount) : null,
      probabilityPercent: Number.isFinite(Number(deal.__contractProbabilityPercent)) ? Number(deal.__contractProbabilityPercent) : null,
      stageName: deal.stage?.name ?? null,
      pipelineName: deal.pipeline?.name ?? null,
      updatedAt: deal.updatedAt instanceof Date ? deal.updatedAt.toISOString() : null,
    };
  }

  private contractDealSamples(samples: ContractDealSample[] = []) {
    const unique = new Map<string, ContractDealSample>();
    for (const sample of samples) {
      if (!unique.has(sample.dealId)) unique.set(sample.dealId, sample);
    }
    return [...unique.values()].sort((a, b) => {
      const byDate = Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '');
      if (Number.isFinite(byDate) && byDate !== 0) return byDate;
      return a.dealTitle.localeCompare(b.dealTitle, 'ru');
    });
  }

  private metricUnit(metric: DataContractMetric) {
    if (metric.type === 'conversion' || metric.display === 'percent') return 'percent';
    if (metric.display === 'money' || metric.measure === 'field_sum' || metric.measure === 'field_avg') return 'money';
    return 'number';
  }

  private emptyMetricValue(metric: DataContractMetric) {
    if (metric.type === 'conversion' || metric.type === 'formula' || metric.measure === 'field_avg') return null;
    return 0;
  }

  private async computeContractDurations(
    filters: ReportFilters,
    durations: DataContractDuration[],
    role: UserRole,
    groups: Map<string, { id: string; name: string }>,
  ) {
    const result = new Map<
      string,
      Map<string, {
        id: string;
        label: string;
        avgDays: number | null;
        sampleSize: number;
        samples: Array<{ dealId: string; dealExternalId?: string | null; dealTitle: string; durationDays: number }>;
      }>
    >();
    const stageIds = durations.map((item) => item.stageId).filter(Boolean);
    if (stageIds.length === 0) return result;
    const range = this.dateRange(filters);
    const hasOnlyExitedDuration = durations.some((duration) => duration.onlyExited);
    const entryMovedAtFilter = hasOnlyExitedDuration && range?.lte ? { lte: range.lte } : range;

    const entries = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: { in: stageIds },
        movedAt: entryMovedAtFilter,
        NOT: [{ fromStageId: { in: stageIds } }],
        deal: await this.buildDealWhere(filters, role),
      },
      include: {
        deal: { include: { responsible: { include: { group: true } } } },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
    });

    const allHistory = entries.length
      ? await this.db.dealStageHistory.findMany({
          where: { dealId: { in: [...new Set(entries.map((entry) => entry.dealId))] } },
          orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
          select: { id: true, dealId: true, toStageId: true, movedAt: true },
        })
      : [];
    const historiesByDeal = new Map<string, Array<{ id: string; dealId: string; toStageId: string; movedAt: Date }>>();
    for (const item of allHistory) {
      if (!historiesByDeal.has(item.dealId)) historiesByDeal.set(item.dealId, []);
      historiesByDeal.get(item.dealId)!.push(item);
    }

    const needsSalesResponsibleTaskStart = durations.some((duration) => duration.startMode === 'sales_responsible_task');
    const eligibleManagers = needsSalesResponsibleTaskStart
      ? new Set((await this.visibleManagerIds(role, filters.groupIds)).filter((id) => !filters.managerIds?.length || filters.managerIds.includes(id)))
      : new Set<string>();
    const responsibleHistoryByDeal = new Map<string, Array<{ fromUserId: string | null; toUserId: string | null; changedAt: Date }>>();
    const tasksByDeal = new Map<string, Array<{ responsibleId: string | null; createdAt: Date; raw: unknown }>>();

    if (needsSalesResponsibleTaskStart && entries.length > 0) {
      const dealIds = [...new Set(entries.map((entry) => entry.dealId))];
      const [responsibleHistory, tasks] = await Promise.all([
        this.db.dealResponsibleHistory.findMany({
          where: { dealId: { in: dealIds } },
          orderBy: [{ dealId: 'asc' }, { changedAt: 'asc' }],
          select: { dealId: true, fromUserId: true, toUserId: true, changedAt: true },
        }),
        this.db.task.findMany({
          where: {
            dealId: { in: dealIds },
            responsibleId: eligibleManagers.size ? { in: [...eligibleManagers] } : undefined,
          },
          select: { dealId: true, responsibleId: true, createdAt: true, raw: true },
          orderBy: [{ dealId: 'asc' }, { createdAt: 'asc' }],
        }),
      ]);

      for (const item of responsibleHistory) {
        if (!responsibleHistoryByDeal.has(item.dealId)) responsibleHistoryByDeal.set(item.dealId, []);
        responsibleHistoryByDeal.get(item.dealId)!.push(item);
      }
      for (const task of tasks) {
        if (!task.dealId) continue;
        if (!tasksByDeal.has(task.dealId)) tasksByDeal.set(task.dealId, []);
        tasksByDeal.get(task.dealId)!.push({
          responsibleId: task.responsibleId,
          createdAt: this.taskCreatedAt(task),
          raw: task.raw,
        });
      }
    }

    for (const duration of durations) {
      const byGroupValues = new Map<string, number[]>();
      const byGroupSamples = new Map<string, Array<{ dealId: string; dealExternalId?: string | null; dealTitle: string; durationDays: number }>>();
      byGroupValues.set('all', []);
      byGroupSamples.set('all', []);

      for (const entry of entries.filter((item) => item.toStageId === duration.stageId)) {
        const history = historiesByDeal.get(entry.dealId) ?? [];
        const index = history.findIndex((item) => item.id === entry.id);
        const nextEntry = index >= 0 ? history.slice(index + 1).find((item) => item.toStageId !== entry.toStageId) : null;
        if (duration.onlyExited && !nextEntry) continue;
        const endAt = nextEntry?.movedAt ?? new Date();
        if (duration.onlyExited ? !this.isDateInRange(endAt, range) : !this.isDateInRange(entry.movedAt, range)) continue;

        const start = duration.startMode === 'sales_responsible_task'
          ? this.salesResponsibleTaskStart(
              entry,
              endAt,
              eligibleManagers,
              responsibleHistoryByDeal.get(entry.dealId) ?? [],
              tasksByDeal.get(entry.dealId) ?? [],
            )
          : { startedAt: entry.movedAt, managerId: entry.deal.responsibleId ?? 'unassigned' };
        if (!start || endAt <= start.startedAt) continue;

        const days = duration.startMode === 'sales_responsible_task'
          ? this.businessDurationDays(start.startedAt, endAt)
          : this.durationDays(start.startedAt, endAt);
        if (days === null) continue;
        const groupId = start.managerId ?? entry.deal.responsibleId ?? 'unassigned';
        const groupName = groups.get(groupId)?.name ?? entry.deal.responsible?.name ?? 'Без менеджера';
        const sample = {
          dealId: entry.deal.id,
          dealExternalId: entry.deal.externalId,
          dealTitle: entry.deal.title,
          durationDays: days,
        };
        groups.set(groupId, { id: groupId, name: groupName });
        byGroupValues.get('all')!.push(days);
        byGroupSamples.get('all')!.push(sample);
        if (!byGroupValues.has(groupId)) byGroupValues.set(groupId, []);
        if (!byGroupSamples.has(groupId)) byGroupSamples.set(groupId, []);
        byGroupValues.get(groupId)!.push(days);
        byGroupSamples.get(groupId)!.push(sample);
      }

      result.set(
        duration.id,
        new Map(
          [...byGroupValues.entries()].map(([groupId, values]) => [
            groupId,
            {
              id: duration.id,
              label: duration.label,
              avgDays: values.length ? this.roundDurationDays(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
              sampleSize: values.length,
              samples: (byGroupSamples.get(groupId) ?? []).sort((a, b) => b.durationDays - a.durationDays),
            },
          ]),
        ),
      );
    }

    return result;
  }

  private salesResponsibleTaskStart(
    entry: {
      dealId: string;
      movedAt: Date;
      deal: { responsibleId?: string | null };
    },
    endAt: Date,
    eligibleManagers: Set<string>,
    responsibleHistory: Array<{ fromUserId: string | null; toUserId: string | null; changedAt: Date }>,
    tasks: Array<{ responsibleId: string | null; createdAt: Date }>,
  ) {
    if (!eligibleManagers.size || tasks.length === 0) return null;

    const assignmentCandidates: Array<{ managerId: string; assignedAt: Date }> = [];
    const responsibleAtEntry = this.responsibleAtStageEntry(entry, responsibleHistory, eligibleManagers);
    if (responsibleAtEntry) assignmentCandidates.push({ managerId: responsibleAtEntry, assignedAt: entry.movedAt });

    for (const item of responsibleHistory) {
      if (!item.toUserId || !eligibleManagers.has(item.toUserId)) continue;
      if (item.changedAt < entry.movedAt || item.changedAt > endAt) continue;
      assignmentCandidates.push({ managerId: item.toUserId, assignedAt: item.changedAt });
    }

    let best: { startedAt: Date; managerId: string } | null = null;
    for (const assignment of assignmentCandidates) {
      const managerTasks = tasks.filter((task) => task.responsibleId === assignment.managerId && task.createdAt <= endAt);
      for (const task of managerTasks) {
        const startedAt = new Date(Math.max(entry.movedAt.getTime(), assignment.assignedAt.getTime(), task.createdAt.getTime()));
        if (startedAt >= endAt) continue;
        if (!best || startedAt < best.startedAt) best = { startedAt, managerId: assignment.managerId };
      }
    }

    return best;
  }

  private responsibleAtStageEntry(
    entry: { movedAt: Date; deal: { responsibleId?: string | null } },
    responsibleHistory: Array<{ fromUserId: string | null; toUserId: string | null; changedAt: Date }>,
    eligibleManagers: Set<string>,
  ) {
    const lastBeforeEntry = [...responsibleHistory].reverse().find((item) => item.changedAt <= entry.movedAt);
    if (lastBeforeEntry?.toUserId && eligibleManagers.has(lastBeforeEntry.toUserId)) return lastBeforeEntry.toUserId;

    const firstAfterEntry = responsibleHistory.find((item) => item.changedAt > entry.movedAt);
    if (firstAfterEntry?.fromUserId && eligibleManagers.has(firstAfterEntry.fromUserId)) return firstAfterEntry.fromUserId;

    if (!responsibleHistory.length && entry.deal.responsibleId && eligibleManagers.has(entry.deal.responsibleId)) {
      return entry.deal.responsibleId;
    }

    return null;
  }

  private taskCreatedAt(task: { createdAt: Date; raw?: unknown }) {
    const rawCreatedAt = toDateFromAmoTimestamp((task.raw as any)?.created_at);
    return rawCreatedAt ?? task.createdAt;
  }

  private flattenContractRows(rows: any[], contract: DataContractConfig) {
    const itemLabel = contract.entity === 'task' ? 'задач' : 'сделок';
    return rows.map((row) => {
      const flat: Record<string, unknown> = { Срез: row.groupName };
      for (const metric of contract.metrics ?? []) {
        const value = row.metrics?.[metric.id];
        flat[metric.label] = value?.value ?? null;
        if (metric.type !== 'formula') flat[`${metric.label}: ${itemLabel}`] = value?.dealCount ?? 0;
      }
      for (const conversion of contract.conversions ?? []) {
        flat[`${conversion.label}: %`] = row.conversions?.[conversion.id]?.conversion ?? null;
      }
      for (const duration of contract.durations ?? []) {
        flat[`${duration.label}: дней`] = row.durations?.[duration.id]?.avgDays ?? null;
      }
      if (row.rowTotal) flat[`Итог по строке`] = row.rowTotal.value;
      return flat;
    });
  }

  private flattenDealCycleRows(rows: any[], summary?: any) {
    return [...rows, summary].filter(Boolean).map((row) => {
      const flat: Record<string, unknown> = {
        Менеджер: row.managerName,
        Сделок: row.totalDeals,
      };
      for (const stage of row.stages ?? []) {
        flat[stage.stageName] = stage.avgDays ?? null;
        flat[`${stage.stageName}: сделок`] = stage.sampleSize ?? 0;
      }
      const stageTotal = row.stageTotal ?? row.overallAverage;
      if (stageTotal) {
        flat['Сумма текущих этапов'] = stageTotal.avgDays ?? null;
        flat['Сумма текущих этапов: сделок'] = stageTotal.sampleSize ?? 0;
      }
      flat['Цикл до успеха'] = row.successCycle?.avgDays ?? null;
      flat['Цикл до успеха: сделок'] = row.successCycle?.sampleSize ?? 0;
      flat['Цикл до отказа'] = row.lostCycle?.avgDays ?? null;
      flat['Цикл до отказа: сделок'] = row.lostCycle?.sampleSize ?? 0;
      return flat;
    });
  }

  private evaluateFormula(formula: string, metrics: Record<string, any>) {
    if (!formula.trim()) return null;
    let expression = formula;
    for (const [id, metric] of Object.entries(metrics)) {
      const value = Number((metric as any)?.value ?? 0);
      const safeValue = Number.isFinite(value) ? String(value) : '0';
      expression = expression
        .replaceAll(`{${id}}`, safeValue)
        .replaceAll(`[${(metric as any)?.label ?? id}]`, safeValue);
    }
    if (!/^[\d\s+\-*/().,%]+$/.test(expression)) return null;
    try {
      const value = Function(`"use strict"; return (${expression.replace(/,/g, '.').replace(/%/g, '/100')});`)();
      if (!Number.isFinite(Number(value))) return null;
      return Number(Number(value).toFixed(2));
    } catch {
      return null;
    }
  }

  private calculateRowSummary(metrics: Record<string, any>, mode: 'sum' | 'avg') {
    const values = Object.values(metrics)
      .filter((metric: any) => metric.unit !== 'percent')
      .map((metric: any) => Number(metric.value))
      .filter((value) => Number.isFinite(value));
    if (values.length === 0) return { mode, value: null };
    const sum = values.reduce((total, value) => total + value, 0);
    return { mode, value: mode === 'avg' ? Number((sum / values.length).toFixed(2)) : Number(sum.toFixed(2)) };
  }

  private calculateSummaryRow(rows: any[], metrics: DataContractMetric[], mode: 'sum' | 'avg') {
    const result: Record<string, any> = {};
    for (const metric of metrics) {
      if (metric.type === 'formula' && mode === 'sum') {
        result[metric.id] = {
          id: metric.id,
          label: metric.label,
          value: this.evaluateFormula(metric.formula ?? '', result),
          unit: metric.display ?? this.metricUnit(metric),
        };
        continue;
      }
      if (metric.type === 'conversion' && mode === 'sum') {
        const sourceRows = rows.filter((row) => row.groupId !== 'all');
        const from = sourceRows
          .map((row) => Number(row.metrics?.[metric.fromMetricId ?? '']?.dealCount ?? row.metrics?.[metric.fromMetricId ?? '']?.value))
          .filter((value) => Number.isFinite(value))
          .reduce((total, value) => total + value, 0);
        const to = sourceRows
          .map((row) => Number(row.metrics?.[metric.toMetricId ?? '']?.dealCount ?? row.metrics?.[metric.toMetricId ?? '']?.value))
          .filter((value) => Number.isFinite(value))
          .reduce((total, value) => total + value, 0);
        const fromSamples = this.contractDealSamples(sourceRows.flatMap((row) => row.metrics?.[metric.fromMetricId ?? '']?.samples ?? []));
        const toSamples = this.contractDealSamples(sourceRows.flatMap((row) => row.metrics?.[metric.toMetricId ?? '']?.samples ?? []));
        result[metric.id] = {
          id: metric.id,
          label: metric.label,
          value: from > 0 ? Number(((to / from) * 100).toFixed(2)) : null,
          unit: 'percent',
          dealCount: to,
          sampleSize: toSamples.length,
          samples: toSamples,
          from,
          to,
          fromSamples,
          toSamples,
        };
        continue;
      }
      const sourceRows = rows.filter((row) => row.groupId !== 'all');
      const values = rows
        .filter((row) => row.groupId !== 'all')
        .map((row) => Number(row.metrics?.[metric.id]?.value))
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) {
        result[metric.id] = { id: metric.id, label: metric.label, value: null, unit: metric.display ?? this.metricUnit(metric) };
        continue;
      }
      const sum = values.reduce((total, value) => total + value, 0);
      const samples = this.contractDealSamples(sourceRows.flatMap((row) => row.metrics?.[metric.id]?.samples ?? []));
      const dealCount = sourceRows
        .map((row) => Number(row.metrics?.[metric.id]?.dealCount ?? 0))
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total + value, 0);
      result[metric.id] = {
        id: metric.id,
        label: metric.label,
        value: mode === 'avg' ? Number((sum / values.length).toFixed(2)) : Number(sum.toFixed(2)),
        unit: metric.display ?? this.metricUnit(metric),
        dealCount,
        sampleSize: samples.length,
        samples,
      };
    }
    const label = mode === 'avg' ? 'Среднее' : 'Итого';
    return { id: 'summary', groupId: 'summary', groupName: label, label, metrics: result };
  }

  private async computeConversionReport(filters: ReportFilters, config: ReportConfig, role: UserRole) {
    const steps = config.steps ?? [];
    const computed: Array<{ id: string; label: string; count: number; amount: number; dealIds: string[] }> = [];

    for (const step of steps) {
      const dealIds = await this.resolveStepDealIds(step, filters, role);
      const amount = await this.sumDealAmount(dealIds);
      computed.push({
        id: step.id,
        label: step.label,
        count: dealIds.length,
        amount,
        dealIds,
      });
    }

    const denominatorMode = config.denominator ?? 'previous';
    const firstCount = computed[0]?.count ?? 0;
    const visibleSteps = computed.map((step, index) => {
      const denominator =
        denominatorMode === 'first'
          ? firstCount
          : index === 0
            ? step.count
            : computed[index - 1]?.count ?? 0;
      return {
        id: step.id,
        label: step.label,
        count: step.count,
        amount: step.amount,
        denominator,
        conversion: denominator > 0 ? Number(((step.count / denominator) * 100).toFixed(2)) : null,
      };
    });

    return {
      type: 'conversion',
      denominator: denominatorMode,
      steps: visibleSteps,
    };
  }

  private async computeDealCycleReport(filters: ReportFilters, role: UserRole) {
    const deals = await this.findFilteredDeals(filters, role);
    const range = this.dateRange(filters);
    const pipelineIds = filters.pipelineIds?.length
      ? filters.pipelineIds
      : [...new Set(deals.map((deal) => deal.pipelineId).filter(Boolean))];

    const stageRows = await this.db.pipelineStage.findMany({
      where: this.compactWhere({
        pipelineId: pipelineIds.length ? { in: pipelineIds } : undefined,
        isVisible: true,
      }),
      orderBy: [{ pipelineId: 'asc' }, { position: 'asc' }],
      select: {
        id: true,
        pipelineId: true,
        name: true,
        position: true,
        color: true,
        isWon: true,
        isLost: true,
      },
    });

    const timelineStages = stageRows.filter((stage) => !this.isBusinessWonStage(stage) && !this.isBusinessLostStage(stage));
    const timelineStageIds = new Set(timelineStages.map((stage) => stage.id));
    const wonStageIds = new Set(stageRows.filter((stage) => this.isBusinessWonStage(stage)).map((stage) => stage.id));
    const lostStageIds = new Set(stageRows.filter((stage) => this.isBusinessLostStage(stage)).map((stage) => stage.id));
    const managers = await this.visibleManagers(role, filters.groupIds, filters.managerIds);
    const groups = new Map<string, { id: string; name: string }>();
    for (const manager of managers) groups.set(manager.id, { id: manager.id, name: manager.name });

    const dealIds = deals.map((deal) => deal.id);
    const history = dealIds.length
      ? await this.db.dealStageHistory.findMany({
          where: { dealId: { in: dealIds } },
          orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
          select: {
            dealId: true,
            fromStageId: true,
            toStageId: true,
            movedAt: true,
          },
        })
      : [];

    const historyByDeal = new Map<
      string,
      Array<{ dealId: string; fromStageId: string | null; toStageId: string; movedAt: Date }>
    >();
    for (const entry of history) {
      if (!historyByDeal.has(entry.dealId)) historyByDeal.set(entry.dealId, []);
      historyByDeal.get(entry.dealId)!.push(entry);
    }

    const stageValues = new Map<string, Map<string, number[]>>();
    const stageSamples = new Map<string, Map<string, Array<{ dealId: string; dealExternalId: string; dealTitle: string; durationDays: number }>>>();
    const successValues = new Map<string, number[]>();
    const lostValues = new Map<string, number[]>();
    const dealCounts = new Map<string, Set<string>>();
    const allGroupId = 'all';

    const valuesFor = (map: Map<string, number[]>, groupId: string) => {
      if (!map.has(groupId)) map.set(groupId, []);
      return map.get(groupId)!;
    };
    const stageValuesFor = (groupId: string, stageId: string) => {
      if (!stageValues.has(groupId)) stageValues.set(groupId, new Map<string, number[]>());
      const byStage = stageValues.get(groupId)!;
      if (!byStage.has(stageId)) byStage.set(stageId, []);
      return byStage.get(stageId)!;
    };
    const stageSamplesFor = (groupId: string, stageId: string) => {
      if (!stageSamples.has(groupId)) stageSamples.set(groupId, new Map<string, Array<{ dealId: string; dealExternalId: string; dealTitle: string; durationDays: number }>>());
      const byStage = stageSamples.get(groupId)!;
      if (!byStage.has(stageId)) byStage.set(stageId, []);
      return byStage.get(stageId)!;
    };
    const addCycleValue = (map: Map<string, number[]>, groupId: string, value: number | null) => {
      if (value === null) return;
      valuesFor(map, groupId).push(value);
      valuesFor(map, allGroupId).push(value);
    };
    const addDealToScope = (groupId: string, dealId: string) => {
      if (!dealCounts.has(groupId)) dealCounts.set(groupId, new Set<string>());
      if (!dealCounts.has(allGroupId)) dealCounts.set(allGroupId, new Set<string>());
      dealCounts.get(groupId)!.add(dealId);
      dealCounts.get(allGroupId)!.add(dealId);
    };
    for (const deal of deals) {
      const groupId = deal.responsibleId ?? 'unassigned';
      const groupName = deal.responsible?.name ?? 'Без менеджера';
      groups.set(groupId, { id: groupId, name: groupName });

      const dealHistory = (historyByDeal.get(deal.id) ?? []).filter((entry) => entry.movedAt >= deal.createdAt);

      for (let index = 0; index < dealHistory.length; index += 1) {
        const entry = dealHistory[index];
        if (!timelineStageIds.has(entry.toStageId)) continue;
        if (entry.fromStageId && entry.fromStageId === entry.toStageId) continue;

        const exitEntry = dealHistory.slice(index + 1).find((nextEntry) => nextEntry.toStageId !== entry.toStageId);
        if (!exitEntry || !this.isDateInRange(exitEntry.movedAt, range)) continue;
        const duration = exitEntry ? this.durationDays(entry.movedAt, exitEntry.movedAt) : null;
        if (duration === null) continue;

        stageValuesFor(groupId, entry.toStageId).push(duration);
        stageValuesFor(allGroupId, entry.toStageId).push(duration);
        const sample = { dealId: deal.id, dealExternalId: deal.externalId, dealTitle: deal.title, durationDays: duration };
        stageSamplesFor(groupId, entry.toStageId).push(sample);
        stageSamplesFor(allGroupId, entry.toStageId).push(sample);
        addDealToScope(groupId, deal.id);
      }

      const successAt = this.terminalCycleAt(deal, dealHistory, wonStageIds, (stage) => this.isBusinessWonStage(stage));
      const lostAt = this.terminalCycleAt(deal, dealHistory, lostStageIds, (stage) => this.isBusinessLostStage(stage));
      if (successAt && this.isDateInRange(successAt, range)) {
        addCycleValue(successValues, groupId, this.terminalDurationDays(deal.createdAt, successAt));
        addDealToScope(groupId, deal.id);
      }
      if (lostAt && this.isDateInRange(lostAt, range)) {
        addCycleValue(lostValues, groupId, this.terminalDurationDays(deal.createdAt, lostAt));
        addDealToScope(groupId, deal.id);
      }
    }

    const buildCycle = (values: number[] = []) => ({
      avgDays: this.averageDays(values),
      sampleSize: values.length,
    });
    const buildStageAverage = (groupId: string) => {
      const values = [...(stageValues.get(groupId)?.values() ?? [])].flat();
      return buildCycle(values);
    };
    const buildStageItems = (groupId: string) =>
      timelineStages.map((stage) => {
        const values = stageValues.get(groupId)?.get(stage.id) ?? [];
        return {
          stageId: stage.id,
          stageName: stage.name,
          pipelineId: stage.pipelineId,
          color: stage.color,
          position: stage.position,
          avgDays: this.averageDays(values),
          sampleSize: values.length,
          samples: stageSamples.get(groupId)?.get(stage.id) ?? [],
        };
      });
    const rows = [...groups.values()].map((group) => ({
      managerId: group.id,
      managerName: group.name,
      totalDeals: dealCounts.get(group.id)?.size ?? 0,
      stages: buildStageItems(group.id),
      stageAverage: buildStageAverage(group.id),
      successCycle: buildCycle(successValues.get(group.id)),
      lostCycle: buildCycle(lostValues.get(group.id)),
    }));
    const summary = {
      managerId: allGroupId,
      managerName: 'Итого',
      totalDeals: dealCounts.get(allGroupId)?.size ?? 0,
      stages: buildStageItems(allGroupId),
      stageAverage: buildStageAverage(allGroupId),
      successCycle: buildCycle(successValues.get(allGroupId)),
      lostCycle: buildCycle(lostValues.get(allGroupId)),
    };
    const maxAvgDays = Math.max(
      0,
      ...[...rows, summary].flatMap((row) => row.stages.map((stage) => stage.avgDays ?? 0)),
    );

    return {
      type: 'dealCycle',
      periodBasis: 'stageExitAt',
      stages: timelineStages.map((stage) => ({
        stageId: stage.id,
        stageName: stage.name,
        pipelineId: stage.pipelineId,
        color: stage.color,
        position: stage.position,
      })),
      rows,
      summary,
      maxAvgDays,
    };
  }

  private async computeLossReasonsReport(filters: ReportFilters, role: UserRole) {
    const range = this.dateRange(filters);
    const managers = await this.visibleManagers(role, filters.groupIds, filters.managerIds);
    const managerIds = new Set(managers.map((manager) => manager.id));
    const stageRows = await this.db.pipelineStage.findMany({
      where: this.compactWhere({
        pipelineId: filters.pipelineIds?.length ? { in: filters.pipelineIds } : undefined,
        isVisible: true,
      }),
      select: {
        id: true,
        name: true,
        isLost: true,
      },
    });
    const lostStageIds = stageRows.filter((stage) => this.isBusinessLostStage(stage)).map((stage) => stage.id);
    if (!lostStageIds.length) {
      return {
        type: 'lossReasons',
        periodBasis: 'lostStageEntry',
        managers,
        rows: [],
        summary: { total: 0, values: Object.fromEntries(managers.map((manager) => [manager.id, 0])) },
      };
    }

    const dealWhere = await this.buildDealWhere(filters, role, { ignoreStage: true, ignoreLossReason: true });
    const entries = await this.db.dealStageHistory.findMany({
      where: this.compactWhere({
        toStageId: { in: lostStageIds },
        movedAt: range,
        deal: dealWhere,
      }),
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      include: {
        deal: {
          select: {
            ...this.dealReportSelect(),
            lossReason: { select: { id: true, name: true } },
          },
        },
      },
    });

    const firstEntryByDeal = new Map<string, any>();
    for (const entry of entries as any[]) {
      if (firstEntryByDeal.has(entry.dealId)) continue;
      if (!this.matchesCustomFieldFilters(entry.deal?.customFields as any, filters.customFields)) continue;
      firstEntryByDeal.set(entry.dealId, entry);
    }

    const percent = (value: number, denominator: number) =>
      denominator > 0 ? Number(((value / denominator) * 100).toFixed(2)) : 0;
    const lossReasonCell = (value: number, denominator: number) => `${value} (${percent(value, denominator)}%)`;
    const valuesByReason = new Map<string, { reasonId: string; reasonName: string; values: Record<string, number>; total: number }>();
    const summaryValues: Record<string, number> = Object.fromEntries(managers.map((manager) => [manager.id, 0]));
    let total = 0;

    for (const entry of firstEntryByDeal.values()) {
      const deal = entry.deal;
      const managerId = deal?.responsibleId;
      if (!managerId || !managerIds.has(managerId)) continue;
      const { reasonId, reasonName } = this.lossReasonFromCustomField(deal?.customFields as Record<string, any>);
      if (!valuesByReason.has(reasonId)) {
        valuesByReason.set(reasonId, {
          reasonId,
          reasonName,
          values: Object.fromEntries(managers.map((manager) => [manager.id, 0])),
          total: 0,
        });
      }
      const row = valuesByReason.get(reasonId)!;
      row.values[managerId] = (row.values[managerId] ?? 0) + 1;
      row.total += 1;
      summaryValues[managerId] = (summaryValues[managerId] ?? 0) + 1;
      total += 1;
    }

    const rows = [...valuesByReason.values()]
      .map((row) => ({
        ...row,
        percentages: Object.fromEntries(managers.map((manager) => [
          manager.id,
          percent(row.values[manager.id] ?? 0, summaryValues[manager.id] ?? 0),
        ])),
        totalPercent: percent(row.total, total),
      }))
      .sort((a, b) => b.total - a.total || a.reasonName.localeCompare(b.reasonName, 'ru'));
    const tableRows = rows.map((row) => ({
      'Причина отказа': row.reasonName,
      ...Object.fromEntries(managers.map((manager) => [
        manager.name,
        lossReasonCell(row.values[manager.id] ?? 0, summaryValues[manager.id] ?? 0),
      ])),
      Всего: lossReasonCell(row.total, total),
    }));

    return {
      type: 'lossReasons',
      periodBasis: 'lostStageEntry',
      managers,
      rows,
      summary: { total, values: summaryValues },
      tableRows,
    };
  }

  private async computeCurrentStageAgeReport(filters: ReportFilters, role: UserRole) {
    const deals = await this.findFilteredDeals(filters, role);
    const pipelineIds = filters.pipelineIds?.length
      ? filters.pipelineIds
      : [...new Set(deals.map((deal) => deal.pipelineId).filter(Boolean))];

    const stageRows = await this.db.pipelineStage.findMany({
      where: this.compactWhere({
        pipelineId: pipelineIds.length ? { in: pipelineIds } : undefined,
        isVisible: true,
      }),
      orderBy: [{ pipelineId: 'asc' }, { position: 'asc' }],
      select: {
        id: true,
        pipelineId: true,
        name: true,
        position: true,
        color: true,
        isWon: true,
        isLost: true,
      },
    });

    const timelineStages = stageRows.filter((stage) => !this.isBusinessWonStage(stage) && !this.isBusinessLostStage(stage));
    const timelineStageIds = new Set(timelineStages.map((stage) => stage.id));
    const managers = await this.visibleManagers(role, filters.groupIds, filters.managerIds);
    const groups = new Map<string, { id: string; name: string }>();
    for (const manager of managers) groups.set(manager.id, { id: manager.id, name: manager.name });

    const openDeals = deals.filter((deal) => timelineStageIds.has(deal.stageId));
    const dealIds = openDeals.map((deal) => deal.id);
    const history = dealIds.length
      ? await this.db.dealStageHistory.findMany({
          where: { dealId: { in: dealIds } },
          orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
          select: {
            dealId: true,
            toStageId: true,
            movedAt: true,
          },
        })
      : [];

    const historyByDeal = new Map<string, Array<{ dealId: string; toStageId: string; movedAt: Date }>>();
    for (const entry of history) {
      if (!historyByDeal.has(entry.dealId)) historyByDeal.set(entry.dealId, []);
      historyByDeal.get(entry.dealId)!.push(entry);
    }

    const stageValues = new Map<string, Map<string, number[]>>();
    const stageSamples = new Map<string, Map<string, Array<{ dealId: string; dealExternalId: string; dealTitle: string; durationDays: number }>>>();
    const dealCounts = new Map<string, Set<string>>();
    const allGroupId = 'all';
    const now = new Date();

    const stageValuesFor = (groupId: string, stageId: string) => {
      if (!stageValues.has(groupId)) stageValues.set(groupId, new Map<string, number[]>());
      const byStage = stageValues.get(groupId)!;
      if (!byStage.has(stageId)) byStage.set(stageId, []);
      return byStage.get(stageId)!;
    };
    const stageSamplesFor = (groupId: string, stageId: string) => {
      if (!stageSamples.has(groupId)) stageSamples.set(groupId, new Map<string, Array<{ dealId: string; dealExternalId: string; dealTitle: string; durationDays: number }>>());
      const byStage = stageSamples.get(groupId)!;
      if (!byStage.has(stageId)) byStage.set(stageId, []);
      return byStage.get(stageId)!;
    };
    const addDealToScope = (groupId: string, dealId: string) => {
      if (!dealCounts.has(groupId)) dealCounts.set(groupId, new Set<string>());
      if (!dealCounts.has(allGroupId)) dealCounts.set(allGroupId, new Set<string>());
      dealCounts.get(groupId)!.add(dealId);
      dealCounts.get(allGroupId)!.add(dealId);
    };

    for (const deal of openDeals) {
      const groupId = deal.responsibleId ?? 'unassigned';
      const groupName = deal.responsible?.name ?? 'Без менеджера';
      groups.set(groupId, { id: groupId, name: groupName });

      const dealHistory = historyByDeal.get(deal.id) ?? [];
      const currentStageEntry = [...dealHistory].reverse().find((entry) => entry.toStageId === deal.stageId);
      const enteredAt = currentStageEntry?.movedAt ?? deal.createdAt;
      const duration = this.durationDays(enteredAt, now);
      if (duration === null) continue;

      stageValuesFor(groupId, deal.stageId).push(duration);
      stageValuesFor(allGroupId, deal.stageId).push(duration);
      const sample = { dealId: deal.id, dealExternalId: deal.externalId, dealTitle: deal.title, durationDays: duration };
      stageSamplesFor(groupId, deal.stageId).push(sample);
      stageSamplesFor(allGroupId, deal.stageId).push(sample);
      addDealToScope(groupId, deal.id);
    }

    const buildStageItems = (groupId: string) =>
      timelineStages.map((stage) => {
        const values = stageValues.get(groupId)?.get(stage.id) ?? [];
        return {
          stageId: stage.id,
          stageName: stage.name,
          pipelineId: stage.pipelineId,
          color: stage.color,
          position: stage.position,
          avgDays: this.averageDays(values),
          sampleSize: values.length,
          samples: stageSamples.get(groupId)?.get(stage.id) ?? [],
        };
      });
    const rows = [...groups.values()].map((group) => {
      const stages = buildStageItems(group.id);
      const stageTotal = this.currentStageTotal(stages);
      return {
        managerId: group.id,
        managerName: group.name,
        totalDeals: dealCounts.get(group.id)?.size ?? 0,
        stages,
        stageTotal,
        overallAverage: stageTotal,
      };
    });
    const summaryStages = buildStageItems(allGroupId);
    const summaryStageTotal = this.currentStageTotal(summaryStages);
    const summary = {
      managerId: allGroupId,
      managerName: 'Итого',
      totalDeals: dealCounts.get(allGroupId)?.size ?? 0,
      stages: summaryStages,
      stageTotal: summaryStageTotal,
      overallAverage: summaryStageTotal,
    };
    const maxAvgDays = Math.max(
      0,
      ...[...rows, summary].flatMap((row) => [
        ...row.stages.map((stage) => stage.avgDays ?? 0),
        row.stageTotal?.avgDays ?? 0,
      ]),
    );

    return {
      type: 'dealStageAge',
      periodBasis: 'currentStageAge',
      stages: timelineStages.map((stage) => ({
        stageId: stage.id,
        stageName: stage.name,
        pipelineId: stage.pipelineId,
        color: stage.color,
        position: stage.position,
      })),
      rows,
      summary,
      maxAvgDays,
    };
  }

  private currentStageTotal(
    stages: Array<{
      avgDays: number | null;
      sampleSize: number;
      samples?: Array<{ dealId: string; dealExternalId: string; dealTitle: string; durationDays: number }>;
    }>,
  ) {
    const activeStages = stages.filter((stage) => stage.avgDays !== null && stage.sampleSize > 0);
    const samples = activeStages.flatMap((stage) => stage.samples ?? []);
    return {
      avgDays: activeStages.length
        ? this.roundDurationDays(
            activeStages.reduce((sum, stage) => sum + this.displayDurationDays(Number(stage.avgDays)), 0),
          )
        : null,
      sampleSize: activeStages.reduce((sum, stage) => sum + stage.sampleSize, 0),
      samples,
    };
  }

  private displayDurationDays(value: number) {
    const totalMinutes = Math.round(value * 24 * 60);
    if (totalMinutes < 60) return Math.max(totalMinutes, 1) / 24 / 60;

    const hours = Math.floor(totalMinutes / 60);
    if (hours < 24) return totalMinutes / 24 / 60;
    return hours / 24;
  }

  private async computeCurrentSnapshot(filters: ReportFilters, role: UserRole) {
    const deals = await this.findFilteredDeals(filters, role);
    const totalAmount = deals.reduce((sum, deal) => sum + Number(deal.amount), 0);

    return {
      type: 'current',
      summary: {
        count: deals.length,
        totalAmount,
        avgAmount: deals.length ? Math.round(totalAmount / deals.length) : 0,
      },
      rows: deals.map((deal) => ({
        id: deal.id,
        title: deal.title,
        amount: Number(deal.amount),
        pipeline: deal.pipeline.name,
        stage: deal.stage.name,
        manager: deal.responsible?.name ?? null,
        updatedAt: deal.updatedAt,
      })),
    };
  }

  private async computeRevenueProfitForecast(filters: ReportFilters, role: UserRole) {
    const refs = await this.resolveRevenueForecastRefs();
    const now = new Date();
    const monthFrom = this.startOfMoscowMonth(now);
    const monthTo = this.endOfMoscowMonth(now);
    const recentShippingRange = { gte: this.addDays(now, -30), lte: now };
    const profitRate = 0.32;
    const warnings: string[] = [];

    if (!refs.ready) {
      return {
        type: 'revenueProfitForecast',
        ready: false,
        warnings: refs.warnings,
        rows: [],
        totals: [],
        summary: { revenue: 0, profit: null, count: 0 },
      };
    }

    const shippingStageIds = refs.assemblyStages.map((stage) => stage.id);
    const shippingCycle = await this.computeStageGroupToTargetCycle(
      refs.assemblyPipeline!.id,
      shippingStageIds,
      refs.shippingDoneStage!.id,
      recentShippingRange,
    );
    if (shippingCycle.avgDays == null) {
      warnings.push('Нет сделок, отгруженных за последние 30 дней. Цикл отгрузки рассчитан как 0 дней.');
    }

    const shippingDays = shippingCycle.avgDays ?? 0;
    const salesWonStageIds = refs.salesWonStages.map((stage) => stage.id);
    const invoiceSpeed = await this.computeStageToSuccessSpeed(refs.salesPipeline!.id, [refs.invoiceStage!.id], salesWonStageIds);
    const quoteSpeed = await this.computeStageToSuccessSpeed(
      refs.salesPipeline!.id,
      refs.quoteStages.map((stage) => stage.id),
      salesWonStageIds,
    );
    const salesSuccessStageIdsByPipelineId = { [refs.salesPipeline!.id]: salesWonStageIds };
    const invoiceProbability = await this.computeStageSuccessProbabilityModel({
      pipelineIds: [refs.salesPipeline!.id],
      stageIds: [refs.invoiceStage!.id],
      successStageIdsByPipelineId: salesSuccessStageIdsByPipelineId,
      defaultProbability: 0.9,
    });
    const quoteProbability = await this.computeStageSuccessProbabilityModel({
      pipelineIds: [refs.salesPipeline!.id],
      stageIds: refs.quoteStages.map((stage) => stage.id),
      successStageIdsByPipelineId: salesSuccessStageIdsByPipelineId,
      defaultProbability: 0.3,
    });
    const repeatSuccessStageIds = refs.repeatPipelines.flatMap((item) => item.wonStages.map((stage) => stage.id));
    const repeatSpeeds = await Promise.all(
      refs.repeatPipelines.map(async (pipeline) => {
        return {
          ...pipeline,
          invoiceSpeed: pipeline.invoiceStage
            ? await this.computeStageToSuccessSpeed(pipeline.id, [pipeline.invoiceStage.id], repeatSuccessStageIds)
            : null,
          quoteSpeed: pipeline.quoteStages.length
            ? await this.computeStageToSuccessSpeed(
                pipeline.id,
                pipeline.quoteStages.map((stage) => stage.id),
                repeatSuccessStageIds,
              )
            : null,
          invoiceProbability: pipeline.invoiceStage
            ? await this.computeStageSuccessProbabilityModel({
                pipelineIds: [pipeline.id],
                stageIds: [pipeline.invoiceStage.id],
                successStageIdsByPipelineId: { [pipeline.id]: repeatSuccessStageIds },
                defaultProbability: 0.9,
              })
            : null,
          quoteProbability: pipeline.quoteStages.length
            ? await this.computeStageSuccessProbabilityModel({
                pipelineIds: [pipeline.id],
                stageIds: pipeline.quoteStages.map((stage) => stage.id),
                successStageIdsByPipelineId: { [pipeline.id]: repeatSuccessStageIds },
                defaultProbability: 0.3,
              })
            : null,
        };
      }),
    );

    const buckets = this.createRevenueForecastBuckets();
    const addDeal = (
      bucketKey: RevenueForecastBucketKey,
      deal: any,
      probability: number | StageSuccessProbability,
      source: string,
      predictedShipAt: Date | null,
      closeDays: number | null,
      shippingRemainingDays: number | null,
    ) => {
      const probabilityValue = typeof probability === 'number' ? probability : probability.probability;
      const probabilitySource = typeof probability === 'number' ? 'fixed' : probability.source;
      const probabilitySample = typeof probability === 'number' ? null : probability.personalSample || probability.teamSample;
      const revenue = Number(deal.amount ?? 0) * probabilityValue;
      const profit = revenue * profitRate;
      const bucket = buckets[bucketKey];
      bucket.count += 1;
      bucket.revenue += revenue;
      bucket.profit = (bucket.profit ?? 0) + profit;
      bucket.deals.push({
        dealId: deal.id,
        dealExternalId: deal.externalId,
        title: deal.title,
        manager: deal.responsible?.name ?? 'Без менеджера',
        stage: deal.stage?.name ?? '',
        source,
        probabilityPercent: Math.round(probabilityValue * 100),
        probabilitySource,
        probabilitySample,
        amount: Number(deal.amount ?? 0),
        revenue: Math.round(revenue),
        profit: Math.round(profit),
        closeDays,
        shippingRemainingDays,
        predictedShipAt: predictedShipAt?.toISOString() ?? null,
      });
    };

    const alreadyShippedEntries = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: refs.shippingDoneStage!.id,
        movedAt: { gte: monthFrom, lte: monthTo },
        deal: await this.buildDealWhere(this.fixedPipelineFilters(filters, refs.assemblyPipeline!.id, undefined, { ignoreTeam: true }), role),
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: {
        movedAt: true,
        deal: { select: this.dealReportSelect() },
      },
    });
    const alreadyShippedByDeal = new Map<string, { deal: any; shippedAt: Date }>();
    for (const entry of alreadyShippedEntries) {
      if (!alreadyShippedByDeal.has(entry.deal.id)) {
        alreadyShippedByDeal.set(entry.deal.id, { deal: entry.deal, shippedAt: entry.movedAt });
      }
    }
    for (const { deal, shippedAt } of alreadyShippedByDeal.values()) {
      addDeal(this.revenueForecastShippedBucket(deal, refs), deal, 1, 'Отгружено', shippedAt, null, 0);
    }

    const assemblyDeals = (await this.findFilteredDeals(this.fixedPipelineFilters(filters, refs.assemblyPipeline!.id, undefined, { ignoreTeam: true }), role))
      .filter((deal) => !this.isBusinessWonStage(deal.stage) && !this.isBusinessLostStage(deal.stage));
    const assemblyEntryByDeal = await this.firstStageEntryByDeal(assemblyDeals.map((deal) => deal.id), shippingStageIds);
    for (const deal of assemblyDeals) {
      const enteredAt = assemblyEntryByDeal.get(deal.id) ?? deal.createdAt;
      const elapsedDays = this.absoluteDurationDays(enteredAt, now) ?? 0;
      const remainingDays = Math.max(shippingDays - elapsedDays, 0);
      const predictedShipAt = this.addDays(now, remainingDays);
      addDeal(this.revenueForecastShippingBucket(deal, refs, predictedShipAt <= monthTo), deal, 1, 'Сборка', predictedShipAt, null, remainingDays);
    }

    const invoiceDeals = await this.findFilteredDeals(
      this.fixedPipelineFilters(filters, refs.salesPipeline!.id, [refs.invoiceStage!.id]),
      role,
    );
    for (const deal of invoiceDeals) {
      const closeDays = invoiceSpeed.average(deal.stageId, deal.responsibleId);
      const predictedShipAt = closeDays == null ? null : this.addDays(now, closeDays + shippingDays);
      addDeal(
        predictedShipAt && predictedShipAt <= monthTo ? 'salesInvoiceThisMonth' : 'salesNotThisMonth',
        deal,
        invoiceProbability.probability(deal.stageId, deal.responsibleId),
        'Счёт отправлен',
        predictedShipAt,
        closeDays,
        shippingDays,
      );
    }

    const quoteDeals = await this.findFilteredDeals(
      this.fixedPipelineFilters(filters, refs.salesPipeline!.id, refs.quoteStages.map((stage) => stage.id)),
      role,
    );
    for (const deal of quoteDeals) {
      const closeDays = quoteSpeed.average(deal.stageId, deal.responsibleId);
      const predictedShipAt = closeDays == null ? null : this.addDays(now, closeDays + shippingDays);
      addDeal(
        predictedShipAt && predictedShipAt <= monthTo ? 'salesQuoteThisMonth' : 'salesNotThisMonth',
        deal,
        quoteProbability.probability(deal.stageId, deal.responsibleId),
        deal.stage?.name ?? 'КП / возражения',
        predictedShipAt,
        closeDays,
        shippingDays,
      );
    }

    for (const pipeline of repeatSpeeds) {
      if (pipeline.invoiceStage && pipeline.invoiceSpeed && pipeline.invoiceProbability) {
        const deals = await this.findFilteredDeals(
          this.fixedPipelineFilters(filters, pipeline.id, [pipeline.invoiceStage.id]),
          role,
        );
        for (const deal of deals) {
          const closeDays = pipeline.invoiceSpeed.average(deal.stageId, deal.responsibleId);
          const predictedShipAt = closeDays == null ? null : this.addDays(now, closeDays + shippingDays);
          addDeal(
            predictedShipAt && predictedShipAt <= monthTo ? 'repeatInvoiceThisMonth' : 'repeatNotThisMonth',
            deal,
            pipeline.invoiceProbability.probability(deal.stageId, deal.responsibleId),
            `${pipeline.name}: счет отправлен`,
            predictedShipAt,
            closeDays,
            shippingDays,
          );
        }
      }

      if (pipeline.quoteStages.length && pipeline.quoteSpeed && pipeline.quoteProbability) {
        const deals = await this.findFilteredDeals(
          this.fixedPipelineFilters(filters, pipeline.id, pipeline.quoteStages.map((stage) => stage.id)),
          role,
        );
        for (const deal of deals) {
          const closeDays = pipeline.quoteSpeed.average(deal.stageId, deal.responsibleId);
          const predictedShipAt = closeDays == null ? null : this.addDays(now, closeDays + shippingDays);
          addDeal(
            predictedShipAt && predictedShipAt <= monthTo ? 'repeatQuoteThisMonth' : 'repeatNotThisMonth',
            deal,
            pipeline.quoteProbability.probability(deal.stageId, deal.responsibleId),
            `${pipeline.name}: ${deal.stage?.name ?? 'предложение'}`,
            predictedShipAt,
            closeDays,
            shippingDays,
          );
        }
      }
    }

    const rows = Object.values(buckets).map((bucket) => ({
      ...bucket,
      revenue: Math.round(bucket.revenue),
      profit: Math.round(bucket.profit ?? 0),
      deals: bucket.deals.sort((a: any, b: any) => String(a.predictedShipAt ?? '').localeCompare(String(b.predictedShipAt ?? ''))),
    }));
    const inMonthRows = rows.filter((row) => !['salesNotThisMonth', 'repeatNotThisMonth'].includes(row.id));
    const summaryProfit = rows.reduce((sum, row) => sum + Number(row.profit ?? 0), 0);

    return {
      type: 'revenueProfitForecast',
      ready: true,
      month: {
        to: monthTo.toISOString(),
        daysLeft: Number((this.absoluteDurationDays(now, monthTo) ?? 0).toFixed(1)),
      },
      shippingCycle: {
        ...shippingCycle,
        basis: 'Сделки, отгруженные за последние 30 дней',
      },
      profit: {
        available: true,
        basis: '32% от суммы сделки',
        percent: 32,
        fieldId: null,
        fieldName: null,
      },
      assumptions: [
        'Сборка считается с вероятностью 100%.',
        'Счета, КП и возражения взвешиваются по персональной исторической конверсии менеджера.',
        'Конверсии считаются по переходам за последние 30 дней.',
        'Если у менеджера мало данных, берётся конверсия команды, затем базовые 90% для счёта и 30% для КП.',
        'База и Закрепленные Компании считаются как Повторные продажи.',
        'Уже отгруженные сделки показываются отдельной строкой с вероятностью 100%.',
      ],
      warnings,
      summary: {
        count: inMonthRows.reduce((sum, row) => sum + row.count, 0),
        revenue: Math.round(inMonthRows.reduce((sum, row) => sum + row.revenue, 0)),
        profit: Math.round(inMonthRows.reduce((sum, row) => sum + Number(row.profit ?? 0), 0)),
        allRevenue: Math.round(rows.reduce((sum, row) => sum + row.revenue, 0)),
        allProfit: Math.round(summaryProfit),
      },
      rows,
      totals: this.createRevenueForecastTotalRows(rows),
    };
  }

  private async computeForecast(filters: ReportFilters) {
    const settings = await this.db.forecastSettings.findFirst();
    const monthFrom = startOfMonth();
    const monthTo = endOfMonth();
    const closingStageId = filters.stageIds?.[0] ?? settings?.closingStageId ?? undefined;

    const closedDeals = closingStageId
      ? await this.db.deal.findMany({
          where: {
            stageId: closingStageId,
            closedAt: { gte: monthFrom, lte: monthTo },
          },
          select: { id: true, amount: true },
        })
      : [];

    const weightedDeals = await this.db.deal.findMany({
      where: {
        deletedAt: null,
        stage: { isWon: false, isLost: false },
      },
      include: {
        stage: { include: { probabilities: true } },
      },
    });

    const probabilityMode = settings?.probabilityMode ?? 'HYBRID';
    const weighted = weightedDeals.map((deal) => {
      const probability = deal.stage.probabilities[0];
      const manual = probability?.manualPercent == null ? null : Number(probability.manualPercent);
      const auto = probability?.autoPercent == null ? null : Number(probability.autoPercent);
      const percent =
        probabilityMode === 'MANUAL'
          ? manual ?? 0
          : probabilityMode === 'AUTO'
            ? auto ?? 0
            : manual ?? auto ?? 0;
      return {
        dealId: deal.id,
        title: deal.title,
        stage: deal.stage.name,
        amount: Number(deal.amount),
        probabilityPercent: percent,
        expectedAmount: Number(deal.amount) * (percent / 100),
        probabilitySource: manual != null ? 'manual' : 'auto',
        confidence: Number(probability?.confidence ?? 0),
      };
    });

    const shippingShoulder = await this.computeShippingShoulder(
      settings?.shippingPipelineId ?? undefined,
      settings?.shippingSuccessStageId ?? undefined,
    );

    const closedAmount = closedDeals.reduce((sum, deal) => sum + Number(deal.amount), 0);
    const weightedAmount = weighted.reduce((sum, deal) => sum + deal.expectedAmount, 0);

    return {
      type: 'forecast',
      forecast: {
        closedAmount,
        weightedAmount: Math.round(weightedAmount),
        totalForecast: Math.round(closedAmount + weightedAmount),
        closedDeals: closedDeals.length,
        openWeightedDeals: weighted.length,
        shippingShoulder,
      },
      rows: weighted,
    };
  }

  private async computeShippingShoulder(shippingPipelineId?: string, successStageId?: string) {
    if (!shippingPipelineId || !successStageId) {
      return { configured: false, avgDays: null, medianDays: null, sampleSize: 0 };
    }
    const shippingStageIds = await this.db.pipelineStage.findMany({
      where: { pipelineId: shippingPipelineId },
      select: { id: true },
    });
    const stageIds = shippingStageIds.map((stage) => stage.id);
    if (stageIds.length === 0) {
      return { configured: true, avgDays: null, medianDays: null, sampleSize: 0 };
    }

    const entries = await this.db.dealStageHistory.findMany({
      where: { toStageId: { in: stageIds } },
      orderBy: { movedAt: 'asc' },
      select: { dealId: true, toStageId: true, movedAt: true },
    });

    const firstEntryByDeal = new Map<string, Date>();
    const successByDeal = new Map<string, Date>();
    for (const entry of entries) {
      if (!firstEntryByDeal.has(entry.dealId)) firstEntryByDeal.set(entry.dealId, entry.movedAt);
      if (entry.toStageId === successStageId) successByDeal.set(entry.dealId, entry.movedAt);
    }

    const durations = [...successByDeal.entries()]
      .map(([dealId, successAt]) => {
        const firstAt = firstEntryByDeal.get(dealId);
        if (!firstAt || successAt <= firstAt) return null;
        return this.absoluteDurationDays(firstAt, successAt);
      })
      .filter((value): value is number => value !== null);

    const avgDays = durations.length
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null;

    return {
      configured: true,
      avgDays: avgDays == null ? null : Number(avgDays.toFixed(2)),
      medianDays: median(durations),
      sampleSize: durations.length,
    };
  }

  private async resolveRevenueForecastRefs() {
    const [pipelines, csmGroup] = await Promise.all([
      this.db.pipeline.findMany({
        include: { stages: { orderBy: { position: 'asc' } } },
      }),
      this.findCrmGroupByName('CSM'),
    ]);
    const pipelineByName = (needle: string) =>
      pipelines.find((pipeline) => this.normalizeStageName(pipeline.name).includes(this.normalizeStageName(needle))) ?? null;
    const stageByName = (stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>, needles: string[]) =>
      stages.find((stage) => {
        const name = this.normalizeStageName(stage.name);
        return needles.every((needle) => name.includes(this.normalizeStageName(needle)));
      }) ?? null;

    const salesPipeline = pipelineByName('воронка продажи');
    const assemblyPipeline = pipelineByName('воронка сборка');
    const basePipeline = pipelineByName('база');
    const assignedCompaniesPipeline = pipelineByName('закреплен');
    const salesStages = salesPipeline?.stages ?? [];
    const assemblyStages = assemblyPipeline?.stages ?? [];
    const invoiceStage = stageByName(salesStages, ['счет', 'отправ']);
    const quoteLikeStages = (stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>) => stages.filter((stage) => {
      const name = this.normalizeStageName(stage.name);
      return (
        (name.includes('кп') && (name.includes('презент') || name.includes('отправ'))) ||
        name.includes('возраж') ||
        name.includes('предлож')
      );
    });
    const quoteStages = quoteLikeStages(salesStages);
    const salesWonStages = this.businessWonStages(salesStages);
    const salesWonStage = salesWonStages[0] ?? null;
    const shippingDoneStage =
      assemblyStages.find((stage) => this.normalizeStageName(stage.name).includes('отгруж')) ??
      assemblyStages.find((stage) => this.isBusinessWonStage(stage)) ??
      null;
    const openAssemblyStages = assemblyStages.filter((stage) => !this.isBusinessWonStage(stage) && !this.isBusinessLostStage(stage));
    const repeatPipelines: Array<{
      id: string;
      name: string;
      invoiceStage: { id: string; name: string; isWon?: boolean; isLost?: boolean } | null;
      quoteStages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>;
      wonStage: { id: string; name: string; isWon?: boolean; isLost?: boolean };
      wonStages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>;
    }> = [];
    for (const pipeline of [basePipeline, assignedCompaniesPipeline]) {
      if (!pipeline) continue;
      const stages = pipeline.stages ?? [];
      const wonStages = this.businessWonStages(stages);
      const wonStage = wonStages[0] ?? null;
      if (!wonStage) continue;
      repeatPipelines.push({
        id: pipeline.id,
        name: pipeline.name,
        invoiceStage: stageByName(stages, ['счет', 'отправ']),
        quoteStages: quoteLikeStages(stages),
        wonStage,
        wonStages,
      });
    }

    const warnings = [
      salesPipeline ? '' : 'Не найдена воронка Продажи.',
      assemblyPipeline ? '' : 'Не найдена воронка Сборка.',
      basePipeline ? '' : 'Не найдена воронка База.',
      assignedCompaniesPipeline ? '' : 'Не найдена воронка Закрепленные Компании.',
      invoiceStage ? '' : 'Не найден этап Счёт отправлен.',
      quoteStages.length ? '' : 'Не найдены этапы КП/возражения.',
      salesWonStage ? '' : 'Не найден успешный этап продаж.',
      shippingDoneStage ? '' : 'Не найден этап отгружено в сборке.',
      ...repeatPipelines.flatMap((pipeline) => [
        pipeline.invoiceStage ? '' : `Не найден этап Счёт отправлен в воронке ${pipeline.name}.`,
        pipeline.quoteStages.length ? '' : `Не найден этап предложения/КП в воронке ${pipeline.name}.`,
      ]),
    ].filter(Boolean);

    return {
      ready: warnings.length === 0,
      warnings,
      salesPipeline,
      assemblyPipeline,
      salesWonStage,
      salesWonStages,
      invoiceStage,
      quoteStages,
      repeatPipelines,
      shippingDoneStage,
      assemblyStages: openAssemblyStages,
      csmGroup,
    };
  }

  private async resolveSalesRefs() {
    const [pipelines, salesGroup] = await Promise.all([
      this.db.pipeline.findMany({
        where: { isArchived: false },
        include: { stages: { orderBy: { position: 'asc' } } },
      }),
      this.findCrmGroupByName('Sales'),
    ]);
    if (!salesGroup) return null;

    const pipelineByExternalId = (externalId: string) =>
      pipelines.find((pipeline) => String(pipeline.externalId ?? '') === externalId) ?? null;
    const pipelineByName = (needle: string) =>
      pipelines.find((pipeline) => this.normalizeStageName(pipeline.name).includes(this.normalizeStageName(needle))) ?? null;
    const stageByExternalId = (
      stages: Array<{ id: string; externalId?: string | null; name: string; isWon?: boolean; isLost?: boolean }>,
      externalId: string,
    ) => stages.find((stage) => String(stage.externalId ?? '') === externalId) ?? null;
    const stageByName = (
      stages: Array<{ id: string; externalId?: string | null; name: string; isWon?: boolean; isLost?: boolean }>,
      needles: string[],
    ) =>
      stages.find((stage) => {
        const name = this.normalizeStageName(stage.name);
        return needles.every((needle) => name.includes(this.normalizeStageName(needle)));
      }) ?? null;

    const salesPipeline = pipelineByExternalId('1278508') ?? pipelineByName('воронка продажи') ?? pipelineByName('продажи');
    const assemblyPipeline = pipelineByExternalId('1278793') ?? pipelineByName('воронка сборка') ?? pipelineByName('сборка');
    if (!salesPipeline) return null;

    const salesStages = salesPipeline.stages ?? [];
    const assigned =
      stageByExternalId(salesStages, '20959402') ??
      stageByName(salesStages, ['назначен', 'ответствен']);
    const kp =
      stageByExternalId(salesStages, '20959408') ??
      stageByName(salesStages, ['кп', 'презент']) ??
      stageByName(salesStages, ['кп', 'отправ']);
    const objections =
      stageByExternalId(salesStages, '57732446') ??
      stageByName(salesStages, ['возраж']);
    const invoice =
      stageByExternalId(salesStages, '20959411') ??
      stageByName(salesStages, ['счет', 'отправ']);
    const paid =
      stageByExternalId(salesStages, '142') ??
      stageByName(salesStages, ['счет', 'оплачен']) ??
      salesStages.find((stage) => this.isBusinessWonStage(stage)) ??
      null;
    const success = this.businessWonStages(salesStages);
    if (!assigned || !kp || !invoice || !paid) return null;

    const assemblyStages = (assemblyPipeline?.stages ?? [])
      .filter((stage) => !this.isBusinessWonStage(stage) && !this.isBusinessLostStage(stage))
      .filter((stage) => {
        const name = this.normalizeStageName(stage.name);
        return !name.includes('dispatched / not fully paid') && !name.includes('partially dispatched');
      });

    return {
      salesGroup,
      salesPipeline,
      assemblyPipeline,
      assemblyStages,
      stages: {
        assigned,
        kp,
        objections,
        invoice,
        paid,
        success: success.length ? success : [paid],
      },
    };
  }

  private async resolveCsmRefs() {
    const pipelines = await this.db.pipeline.findMany({
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    const pipelineByExactName = (needle: string) =>
      pipelines.find((pipeline) => this.normalizeStageName(pipeline.name) === this.normalizeStageName(needle)) ?? null;
    const pipelineByName = (needle: string) =>
      pipelines.find((pipeline) => this.normalizeStageName(pipeline.name).includes(this.normalizeStageName(needle))) ?? null;
    const stageByName = (stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>, needles: string[]) =>
      stages.find((stage) => {
        const name = this.normalizeStageName(stage.name);
        return needles.every((needle) => name.includes(this.normalizeStageName(needle)));
      }) ?? null;

    const basePipeline = pipelineByExactName('база');
    const assignedPipeline = pipelineByName('закреплен');
    const assemblyPipeline = pipelineByName('воронка сборка') ?? pipelineByName('сборка');
    const csmGroup = await this.findCrmGroupByName('CSM');
    if (!basePipeline || !assignedPipeline || !csmGroup) return null;

    const resolveStages = (stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>) => {
      const work = stageByName(stages, ['взят', 'работ']);
      const offer = stageByName(stages, ['сделано', 'предлож']);
      const invoice = stageByName(stages, ['счет', 'отправ']);
      const paid =
        stageByName(stages, ['счет', 'оплачен']) ??
        stages.find((stage) => stage.isWon && this.normalizeStageName(stage.name).includes('оплачен')) ??
        stageByName(stages, ['оплачено']) ??
        stages.find((stage) => this.isBusinessWonStage(stage)) ??
        null;
      const success = this.businessWonStages(stages);
      if (!work || !offer || !invoice || !paid) return null;
      return { work, offer, invoice, paid, success: success.length ? success : [paid] };
    };

    const baseStages = resolveStages(basePipeline.stages);
    const assignedStages = resolveStages(assignedPipeline.stages);
    if (!baseStages || !assignedStages) return null;
    const assemblyStages = (assemblyPipeline?.stages ?? [])
      .filter((stage) => !this.isBusinessWonStage(stage) && !this.isBusinessLostStage(stage))
      .filter((stage) => {
        const name = this.normalizeStageName(stage.name);
        return !name.includes('dispatched / not fully paid') && !name.includes('partially dispatched');
      });

    return {
      basePipeline,
      assignedPipeline,
      assemblyPipeline,
      assemblyStages,
      baseStages,
      assignedStages,
      csmGroup,
    };
  }

  private async findCrmGroupByName(name: string) {
    const groups = await this.db.crmGroup.findMany({ select: { id: true, name: true } });
    const normalizedNeedle = this.normalizeStageName(name);
    return groups.find((group) => this.normalizeStageName(group.name) === normalizedNeedle) ?? null;
  }

  private createRevenueForecastBuckets() {
    return {
      salesShippedThisMonth: {
        id: 'salesShippedThisMonth',
        label: 'Продажи: уже отгружено',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      salesShippingThisMonth: {
        id: 'salesShippingThisMonth',
        label: 'Продажи: в отгрузке',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      salesInvoiceThisMonth: {
        id: 'salesInvoiceThisMonth',
        label: 'Продажи: счета, которые успеют купить и отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      salesQuoteThisMonth: {
        id: 'salesQuoteThisMonth',
        label: 'Продажи: КП, которые успеют купить и отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      salesNotThisMonth: {
        id: 'salesNotThisMonth',
        label: 'Продажи: не успеют отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      repeatShippedThisMonth: {
        id: 'repeatShippedThisMonth',
        label: 'Повторные продажи: уже отгружено',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      repeatShippingThisMonth: {
        id: 'repeatShippingThisMonth',
        label: 'Повторные продажи: в отгрузке',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      repeatInvoiceThisMonth: {
        id: 'repeatInvoiceThisMonth',
        label: 'Повторные продажи: счета, которые успеют купить и отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      repeatQuoteThisMonth: {
        id: 'repeatQuoteThisMonth',
        label: 'Повторные продажи: КП, которые успеют купить и отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
      repeatNotThisMonth: {
        id: 'repeatNotThisMonth',
        label: 'Повторные продажи: не успеют отгрузиться',
        count: 0,
        revenue: 0,
        profit: null as number | null,
        deals: [] as any[],
      },
    };
  }

  private createRevenueForecastTotalRows(rows: Array<{
    id: string;
    count: number;
    revenue: number;
    profit: number | null;
    deals: any[];
  }>) {
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    const combine = (id: string, label: string, rowIds: RevenueForecastBucketKey[]) => {
      const sourceRows = rowIds.map((rowId) => rowsById.get(rowId)).filter(Boolean) as typeof rows;
      const deals = sourceRows
        .flatMap((row) => row.deals ?? [])
        .sort((a: any, b: any) => String(a.predictedShipAt ?? '').localeCompare(String(b.predictedShipAt ?? '')));

      return {
        id,
        label,
        count: sourceRows.reduce((sum, row) => sum + Number(row.count ?? 0), 0),
        revenue: Math.round(sourceRows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0)),
        profit: Math.round(sourceRows.reduce((sum, row) => sum + Number(row.profit ?? 0), 0)),
        deals,
      };
    };

    return [
      combine('totalShippedThisMonth', 'Уже отгружено', ['salesShippedThisMonth', 'repeatShippedThisMonth']),
      combine('totalShippingThisMonth', 'В отгрузке', ['salesShippingThisMonth', 'repeatShippingThisMonth']),
      combine('totalInvoiceThisMonth', 'Счета, которые успеют купить и отгрузиться', ['salesInvoiceThisMonth', 'repeatInvoiceThisMonth']),
      combine('totalQuoteThisMonth', 'КП, которые успеют купить и отгрузиться', ['salesQuoteThisMonth', 'repeatQuoteThisMonth']),
      combine('totalNotThisMonth', 'Не успеют отгрузиться', ['salesNotThisMonth', 'repeatNotThisMonth']),
    ];
  }

  private revenueForecastShippedBucket(deal: any, refs: { csmGroup?: { id: string; name: string } | null }): RevenueForecastBucketKey {
    return this.isRepeatRevenueForecastDeal(deal, refs) ? 'repeatShippedThisMonth' : 'salesShippedThisMonth';
  }

  private revenueForecastShippingBucket(deal: any, refs: { csmGroup?: { id: string; name: string } | null }, inMonth: boolean): RevenueForecastBucketKey {
    const isRepeat = this.isRepeatRevenueForecastDeal(deal, refs);
    if (isRepeat) return inMonth ? 'repeatShippingThisMonth' : 'repeatNotThisMonth';
    return inMonth ? 'salesShippingThisMonth' : 'salesNotThisMonth';
  }

  private isRepeatRevenueForecastDeal(deal: any, refs: { csmGroup?: { id: string; name: string } | null }) {
    const groupId = deal.responsible?.group?.id ?? null;
    const groupName = this.normalizeStageName(deal.responsible?.group?.name ?? '');
    const csmGroupName = this.normalizeStageName(refs.csmGroup?.name ?? 'CSM');
    return Boolean(
      (refs.csmGroup?.id && groupId === refs.csmGroup.id) ||
      groupName === csmGroupName ||
      groupName.includes('csm'),
    );
  }

  private fixedPipelineFilters(
    filters: ReportFilters,
    pipelineId: string,
    stageIds?: string[],
    options?: { ignoreTeam?: boolean },
  ): ReportFilters {
    return {
      managerIds: options?.ignoreTeam ? undefined : filters.managerIds,
      groupIds: options?.ignoreTeam ? undefined : filters.groupIds,
      pipelineIds: [pipelineId],
      stageIds,
    };
  }

  private async computeStageGroupToTargetCycle(
    pipelineId: string,
    fromStageIds: string[],
    targetStageId: string,
    targetRange?: { gte: Date; lte: Date },
  ) {
    const entries = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: { in: [...fromStageIds, targetStageId] },
        deal: { pipelineId, deletedAt: null },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: {
        dealId: true,
        toStageId: true,
        movedAt: true,
        deal: { select: { createdAt: true } },
      },
    });
    const byDeal = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (!byDeal.has(entry.dealId)) byDeal.set(entry.dealId, []);
      byDeal.get(entry.dealId)!.push(entry);
    }
    const values: number[] = [];
    for (const dealEntries of byDeal.values()) {
      const targetEntry = dealEntries.find((entry) => entry.toStageId === targetStageId);
      if (!targetEntry) continue;
      if (targetRange && !this.isDateInRange(targetEntry.movedAt, targetRange)) continue;
      const firstEntry = dealEntries.find((entry) => fromStageIds.includes(entry.toStageId) && entry.movedAt <= targetEntry.movedAt);
      const startedAt = firstEntry?.movedAt ?? targetEntry.deal.createdAt;
      const duration = this.absoluteDurationDays(startedAt, targetEntry.movedAt);
      if (duration !== null) values.push(duration);
    }
    return {
      avgDays: this.averageDays(values),
      medianDays: median(values),
      sampleSize: values.length,
    };
  }

  private async computeStageToSuccessSpeed(pipelineId: string, fromStageIds: string[], successStageId: string | string[]) {
    const successStageIds = Array.isArray(successStageId) ? successStageId.filter(Boolean) : [successStageId].filter(Boolean);
    const entries = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: { in: [...fromStageIds, ...successStageIds] },
        deal: { deletedAt: null },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: {
        dealId: true,
        toStageId: true,
        movedAt: true,
        deal: { select: { responsibleId: true } },
      },
    });
    const fromStageRows = await this.db.pipelineStage.findMany({
      where: { id: { in: fromStageIds } },
      select: { id: true, pipelineId: true },
    });
    const validFromStageIds = new Set(fromStageRows.filter((stage) => stage.pipelineId === pipelineId).map((stage) => stage.id));
    const values = new Map<string, number[]>();
    const add = (key: string, value: number) => {
      if (!values.has(key)) values.set(key, []);
      values.get(key)!.push(value);
    };
    const byDeal = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (!byDeal.has(entry.dealId)) byDeal.set(entry.dealId, []);
      byDeal.get(entry.dealId)!.push(entry);
    }
    for (const dealEntries of byDeal.values()) {
      const successEntry = dealEntries.find((entry) => successStageIds.includes(entry.toStageId));
      if (!successEntry) continue;
      const managerId = successEntry.deal.responsibleId ?? 'unassigned';
      for (const stageId of fromStageIds) {
        if (!validFromStageIds.has(stageId)) continue;
        const stageEntry = [...dealEntries]
          .reverse()
          .find((entry) => entry.toStageId === stageId && entry.movedAt < successEntry.movedAt);
        if (!stageEntry) continue;
        const duration = this.absoluteDurationDays(stageEntry.movedAt, successEntry.movedAt);
        if (duration === null) continue;
        add(`${managerId}:${stageId}`, duration);
        add(`all:${stageId}`, duration);
        add(`${managerId}:all`, duration);
        add('all:all', duration);
      }
    }
    const avg = (key: string) => this.averageDays(values.get(key) ?? []);
    return {
      average: (stageId: string, managerId?: string | null) =>
        avg(`${managerId ?? 'unassigned'}:${stageId}`) ??
        avg(`all:${stageId}`) ??
        avg(`${managerId ?? 'unassigned'}:all`) ??
        avg('all:all'),
    };
  }

  private async firstStageEntryByDeal(dealIds: string[], stageIds: string[]) {
    if (!dealIds.length || !stageIds.length) return new Map<string, Date>();
    const entries = await this.db.dealStageHistory.findMany({
      where: { dealId: { in: dealIds }, toStageId: { in: stageIds } },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, movedAt: true },
    });
    const result = new Map<string, Date>();
    for (const entry of entries) {
      if (!result.has(entry.dealId)) result.set(entry.dealId, entry.movedAt);
    }
    return result;
  }

  private addDays(date: Date, days: number) {
    return new Date(date.getTime() + days * 86_400_000);
  }

  private startOfMoscowMonth(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    return new Date(Date.UTC(year, month - 1, 0, 21, 0, 0, 0));
  }

  private endOfMoscowMonth(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date);
    const year = Number(parts.find((part) => part.type === 'year')?.value);
    const month = Number(parts.find((part) => part.type === 'month')?.value);
    return new Date(Date.UTC(year, month, 0, 20, 59, 59, 999));
  }

  private async resolveStepDealIds(step: ConversionStep, filters: ReportFilters, role: UserRole) {
    if (step.type === 'stage_reached' && step.stageId) {
      return this.findDealIdsFromHistory({ toStageId: step.stageId }, filters, role);
    }
    if (step.type === 'stage_changed' && step.toStageId) {
      return this.findDealIdsFromHistory(
        {
          toStageId: step.toStageId,
          fromStageId: step.fromStageId,
        },
        filters,
        role,
      );
    }
    if (step.type === 'current_stage' && step.stageId) {
      const deals = await this.findFilteredDeals({ ...filters, stageIds: [step.stageId] }, role);
      return deals.map((deal) => deal.id);
    }
    if (step.type === 'current_field' && step.fieldId) {
      const deals = await this.findFilteredDeals(
        {
          ...filters,
          customFields: [{ fieldId: step.fieldId, operator: step.operator ?? 'equals', value: step.value }],
        },
        role,
      );
      return deals.map((deal) => deal.id);
    }
    return [];
  }

  private async findDealIdsFromHistory(
    stageFilter: { toStageId: string; fromStageId?: string },
    filters: ReportFilters,
    role: UserRole,
  ) {
    return this.findDealIdsFromHistoryMany([stageFilter.toStageId], filters, role, stageFilter.fromStageId);
  }

  private async findDealIdsFromHistoryMany(stageIds: string[], filters: ReportFilters, role: UserRole, fromStageId?: string) {
    const range = this.dateRange(filters);
    const history = await this.db.dealStageHistory.findMany({
      where: {
        toStageId: { in: stageIds },
        fromStageId: fromStageId || undefined,
        movedAt: range,
        deal: await this.buildDealWhere(filters, role, { ignorePipeline: true, ignoreStage: true }),
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, movedAt: true },
    });

    const firstEntryByDeal = new Map<string, { dealId: string; movedAt: Date }>();
    for (const entry of history) {
      if (!firstEntryByDeal.has(entry.dealId)) firstEntryByDeal.set(entry.dealId, entry);
    }

    const firstEntries = [...firstEntryByDeal.values()];
    if (!firstEntries.length) return [];

    const maxMovedAt = new Date(Math.max(...firstEntries.map((entry) => entry.movedAt.getTime())));
    const previousEntries = await this.db.dealStageHistory.findMany({
      where: {
        dealId: { in: firstEntries.map((entry) => entry.dealId) },
        toStageId: { in: stageIds },
        movedAt: { lt: maxMovedAt },
      },
      select: { dealId: true, movedAt: true },
    });
    const repeatedDealIds = new Set<string>();
    for (const entry of previousEntries) {
      const current = firstEntryByDeal.get(entry.dealId);
      if (current && entry.movedAt < current.movedAt) repeatedDealIds.add(entry.dealId);
    }

    return firstEntries.filter((entry) => !repeatedDealIds.has(entry.dealId)).map((entry) => entry.dealId);
  }

  private async findDealsByIds(dealIds: string[]) {
    if (dealIds.length === 0) return [];
    return this.db.deal.findMany({
      where: { id: { in: dealIds }, deletedAt: null },
      select: this.dealReportSelect(),
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async findFilteredDeals(filters: ReportFilters, role: UserRole, extraWhere: Record<string, any> = {}) {
    const deals = await this.db.deal.findMany({
      where: {
        ...(await this.buildDealWhere(filters, role)),
        ...this.compactWhere(extraWhere),
      },
      select: this.dealReportSelect(),
      orderBy: { updatedAt: 'desc' },
    });
    return deals.filter((deal) => this.matchesCustomFieldFilters(deal.customFields as any, filters.customFields));
  }

  private dealReportSelect() {
    return {
      id: true,
      externalId: true,
      title: true,
      amount: true,
      currency: true,
      source: true,
      tags: true,
      customFields: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      expectedCloseAt: true,
      pipelineId: true,
      stageId: true,
      responsibleId: true,
      lossReasonId: true,
      pipeline: { select: { id: true, name: true } },
      stage: { select: { id: true, name: true, isWon: true, isLost: true } },
      lossReason: { select: { id: true, name: true } },
      responsible: {
        select: {
          id: true,
          name: true,
          groupId: true,
          isActive: true,
          isVisible: true,
          group: { select: { id: true, name: true } },
        },
      },
    };
  }

  private dateRange(filters: ReportFilters) {
    const range: Record<string, Date> = {};
    if (filters.dateFrom) range.gte = this.parseFilterDate(filters.dateFrom, false);
    if (filters.dateTo) range.lte = this.parseFilterDate(filters.dateTo, true);
    return Object.keys(range).length ? range : undefined;
  }

  private isDateInRange(value: Date, range?: Record<string, Date>) {
    if (!range) return true;
    if (range.gte && value < range.gte) return false;
    if (range.lte && value > range.lte) return false;
    return true;
  }

  private durationDays(from: Date, to: Date) {
    return moscowWeekdayDurationDays(from, to);
  }

  private terminalDurationDays(from: Date, to: Date) {
    if (to.getTime() === from.getTime()) return 0;
    return moscowWeekdayDurationDays(from, to);
  }

  private businessDurationDays(from: Date, to: Date) {
    return moscowBusinessDurationDays(from, to);
  }

  private absoluteDurationDays(from: Date, to: Date) {
    return absoluteDurationDays(from, to);
  }

  private terminalCycleAt(
    deal: any,
    history: Array<{ toStageId: string; movedAt: Date }>,
    terminalStageIds: Set<string>,
    isCurrentTerminalStage: (stage: { isWon?: boolean; isLost?: boolean; name?: string }) => boolean,
  ) {
    if (!isCurrentTerminalStage(deal.stage)) return null;
    if (deal.closedAt) return deal.closedAt;
    return history.find((entry) => terminalStageIds.has(entry.toStageId) && entry.movedAt > deal.createdAt)?.movedAt ?? null;
  }

  private isBusinessWonStage(stage: { isWon?: boolean; name?: string }) {
    if (stage.isWon) return true;
    const name = this.normalizeStageName(stage.name);
    return name.includes('оплачен') || name.includes('успеш');
  }

  private businessWonStages<T extends { id: string; isWon?: boolean; name?: string }>(stages: T[]) {
    const byId = new Map<string, T>();
    for (const stage of stages) {
      if (this.isBusinessWonStage(stage)) byId.set(stage.id, stage);
    }
    return [...byId.values()];
  }

  private isBusinessLostStage(stage: { isLost?: boolean; name?: string }) {
    if (stage.isLost) return true;
    const name = this.normalizeStageName(stage.name);
    return name.includes('отказ') || name.includes('не реализовано') || name.includes('нереализовано');
  }

  private normalizeStageName(value?: string) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .trim();
  }

  private averageDays(values: number[]) {
    if (!values.length) return null;
    return this.roundDurationDays(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  private roundDurationDays(value: number) {
    return Number(value.toFixed(6));
  }

  private parseFilterDate(value: string, endOfDay: boolean) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      return endOfDay
        ? moscowDate(year, month, day, 23, 59, 59, 999)
        : moscowDate(year, month, day, 0, 0, 0, 0);
    }
    return new Date(value);
  }

  private compactWhere(where: Record<string, any>) {
    return Object.fromEntries(Object.entries(where).filter(([, value]) => value !== undefined));
  }

  private async buildDealWhere(
    filters: ReportFilters,
    role: UserRole,
    options: { ignorePipeline?: boolean; ignoreStage?: boolean; ignoreLossReason?: boolean } = {},
  ) {
    const where: Record<string, any> = { deletedAt: null };

    if (!options.ignorePipeline && filters.pipelineIds?.length) where.pipelineId = { in: filters.pipelineIds };
    if (!options.ignoreStage && (filters.stageIds?.length || filters.excludeStageIds?.length)) {
      where.stageId = {};
      if (filters.stageIds?.length) where.stageId.in = filters.stageIds;
      if (filters.excludeStageIds?.length) where.stageId.notIn = filters.excludeStageIds;
    }
    if (filters.managerIds?.length) where.responsibleId = { in: filters.managerIds };
    if (!options.ignoreLossReason && filters.lossReasonIds?.length) where.lossReasonId = { in: filters.lossReasonIds };
    if (filters.amountFrom !== undefined || filters.amountTo !== undefined) {
      where.amount = {};
      if (filters.amountFrom !== undefined) where.amount.gte = filters.amountFrom;
      if (filters.amountTo !== undefined) where.amount.lte = filters.amountTo;
    }
    if (filters.tagIncludes?.length) where.tags = { hasSome: filters.tagIncludes };

    const visibleManagerIds = await this.visibleManagerIds(role, filters.groupIds);
    if (visibleManagerIds) {
      where.responsibleId = where.responsibleId
        ? { in: where.responsibleId.in.filter((id: string) => visibleManagerIds.includes(id)) }
        : { in: visibleManagerIds };
    }

    return where;
  }

  private async visibleManagerIds(role: UserRole, groupIds?: string[]) {
    const managers = await this.visibleManagers(role, groupIds);
    return managers.map((manager) => manager.id);
  }

  private async visibleManagers(role: UserRole, groupIds?: string[], managerIds?: string[]) {
    const where: Record<string, any> = { isActive: true };
    if (role === 'ROP') where.isVisible = true;
    if (groupIds?.length) where.groupId = { in: groupIds };
    if (managerIds?.length) where.id = { in: managerIds };
    return this.db.crmUser.findMany({ where, select: { id: true, name: true }, orderBy: { name: 'asc' } });
  }

  private lossReasonFromCustomField(customFields?: Record<string, any> | null) {
    for (const [fieldId, field] of Object.entries(customFields ?? {})) {
      if (!field || typeof field !== 'object') continue;
      if (!LOSS_REASON_CUSTOM_FIELD_NAMES.has(normalizeCustomFieldName((field as any).name))) continue;
      const reasonName = this.customFieldTextValue((field as any).value ?? (field as any).values);
      if (reasonName) {
        return {
          reasonId: `custom:${normalizeCustomFieldName(reasonName)}`,
          reasonName,
        };
      }
    }
    return {
      reasonId: 'custom:not_set',
      reasonName: MISSING_LOSS_REASON_LABEL,
    };
  }

  private customFieldTextValue(value: unknown): string | null {
    const values = this.customFieldScalarValues(value)
      .map((item) => item.trim())
      .filter(Boolean);
    const uniqueValues = [...new Set(values)];
    return uniqueValues.length ? uniqueValues.join(', ') : null;
  }

  private customFieldScalarValues(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => this.customFieldScalarValues(item));
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return this.customFieldScalarValues(record.value ?? record.text ?? record.enum_id ?? null);
    }
    if (value === null || value === undefined) return [];
    return [String(value)];
  }

  private matchesCustomFieldFilters(
    customFields: Record<string, any>,
    filters?: ReportFilters['customFields'],
  ) {
    if (!filters?.length) return true;
    return filters.every((filter) => {
      const field = customFields?.[filter.fieldId];
      const value = field?.value ?? field;
      if (filter.operator === 'is_set') return value !== undefined && value !== null && value !== '';
      if (filter.operator === 'contains') return String(value ?? '').includes(String(filter.value ?? ''));
      if (['lt', 'lte', 'gt', 'gte'].includes(filter.operator)) {
        const actual = this.toNumber(value);
        const expected = this.toNumber(filter.value);
        if (actual === null || expected === null) return false;
        if (filter.operator === 'lt') return actual < expected;
        if (filter.operator === 'lte') return actual <= expected;
        if (filter.operator === 'gt') return actual > expected;
        if (filter.operator === 'gte') return actual >= expected;
      }
      return String(value ?? '') === String(filter.value ?? '');
    });
  }

  private numericCustomField(customFields: Record<string, any>, fieldId: string) {
    const field = customFields?.[fieldId];
    return this.toNumber(field?.value ?? field) ?? 0;
  }

  private toNumber(value: unknown) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === null || raw === undefined || raw === '') return null;
    const number = Number(String(raw).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(number) ? number : null;
  }

  private async sumDealAmount(dealIds: string[]) {
    if (dealIds.length === 0) return 0;
    const agg = await this.db.deal.aggregate({
      where: { id: { in: dealIds } },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }
}
