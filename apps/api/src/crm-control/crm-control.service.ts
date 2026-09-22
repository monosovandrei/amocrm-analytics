import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { CrmControlSourceService } from './crm-control-source.service';
import { indexCrmControlSourcesForDeals } from './crm-control-source.normalizer';
import { CrmControlSourceWindow } from './crm-control-source.types';
import { CrmControlDriveReader } from './crm-control-drive';
import { CrmControlProposalSourceCollector } from './crm-control-proposal-sources';
import { CrmControlAnalysisBatchService } from './crm-control-analysis-batch.service';
import { crmControlLocalAnalysisOptions } from './crm-control-analysis.service';
import { crmControlAnalysisProof } from './crm-control-analysis-proof';
import { crmControlDocumentDirectory, crmControlDocumentEvidence, readCrmControlDocument } from './crm-control-document-evidence';
import { CrmBrowserSourceBatch, CrmControlBrowserSourceService } from './crm-control-browser-source.service';
import { CrmControlDocumentAnalysisService } from './crm-control-document-analysis.service';
import { assessArchivedOffer } from './crm-control-offer.assessment';
import { CrmControlAnalysisSummary, crmControlAnalysisProjection, crmControlAnalysisSummaryInclude } from './crm-control-analysis.projection';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/jwt.strategy';
import { AmoService } from '../amo/amo.service';
import { AmoRequestError } from '../amo/amo-client';
import { CaptureHealth, CrmControlEvidenceService, sanitizeCrmCaptureHealth } from './crm-control-evidence.service';
import { publicEvidenceManifest } from './crm-control-evidence-manifest';
import { CRM_CONTROL_RULE_CATALOG, CRM_CONTROL_RULE_VERSION, evaluateCrmControlDeal } from './crm-control.rules';
import { hasStageDeadline, stageDeadlineConfigError } from './crm-control-deadline';
import { CrmControlConfig, CrmControlCounts, CrmControlDecisionInput, CrmControlManualReviewInput, CrmControlRuleInput, CrmControlRuleResult,
  CrmControlScope, DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';
import { addControlCounts, controlCompletion, controlManualReviewAllowed, controlManualReviewGuidance, controlScheduleSlot, emptyControlCounts, nextControlCaseState, observationCounts } from './crm-control.logic';

type Access = { role: 'OWNER' | 'ROP' | 'MANAGER'; managerId?: string; groupId?: string; actorId: string; actorName: string };
type Pipeline = Prisma.PipelineGetPayload<{ include: { stages: true } }>;
const isWorkingStage = (stage: Pipeline['stages'][number]) => !stage.isWon && !stage.isLost
  && !(stage.raw && typeof stage.raw === 'object' && !Array.isArray(stage.raw) && stage.raw.type === 1);
const observationInclude = { results: { include: { case: { include: { decisions: true } }, analyses: crmControlAnalysisSummaryInclude } }, evidence: true } as const;
type Observation = Prisma.CrmControlObservationGetPayload<{ include: typeof observationInclude }>;
type AssessedDecision = { id?: string; action: string; observationId: string; createdAt: Date; validUntil: Date | null; reason?: string; actorName?: string };
type AssessedResult = { status: string; observationId: string; analyses?: CrmControlAnalysisSummary[]; case?: { status: string; confirmedAt?: Date | null;
  decisions?: AssessedDecision[] } | null };
const manualReviewActions = ['VERIFY_PASS', 'VERIFY_FAIL', 'VERIFY_NA'];
const newestDecision = (items: AssessedDecision[]) => [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || String(b.id ?? '').localeCompare(String(a.id ?? '')))[0];
type RuleDealCounts = { failedDeals: number; reviewDeals: number; unknownDeals: number };
type RuleBreakdown = RuleDealCounts & { ruleCode: string; ruleName: string;
  byManager: Array<RuleDealCounts & { managerId: string | null; department: string }> };
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const normal = (value: string) => value.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
const timestamp = (value: unknown): Date | null => Number.isFinite(Number(value)) && Number(value) > 0 ? new Date(Number(value) * 1000) : null;
const opaqueError = () => 'Не удалось прочитать данные amoCRM. Проверьте подключение и повторите проверку.';
class ControlRunError extends Error {}
const runAttempts = (run: { counts: unknown; startedAt?: Date | null }) => {
  const stored = Number((run.counts as any)?.executionAttempts);
  return Number.isInteger(stored) && stored > 0 ? stored : run.startedAt ? 1 : 0;
};
const runDay = (run: { config: unknown }, date: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: (run.config as CrmControlConfig).timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);
const transientRunError = (error: unknown) => error instanceof AmoRequestError ? error.transient
  : !!error && typeof error === 'object' && 'code' in error && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(String(error.code));

@Injectable()
export class CrmControlService {
  private readonly logger = new Logger(CrmControlService.name);
  constructor(private readonly prisma: PrismaService, private readonly amo: AmoService,
    private readonly evidenceProvider: CrmControlEvidenceService, private readonly analysisBatches?: CrmControlAnalysisBatchService,
    private readonly browserSources?: CrmControlBrowserSourceService, private readonly documentAnalysis?: CrmControlDocumentAnalysisService) {}

  async access(actor: AuthUser): Promise<Access> {
    const user = await this.prisma.user.findUnique({ where: { id: actor.id },
      select: { id: true, name: true, isActive: true, businessRole: true, crmUserId: true, crmUser: { select: { groupId: true } } } });
    if (!user?.isActive) throw new ForbiddenException('Нет доступа');
    if (user.businessRole === 'OWNER') return { role: 'OWNER', actorId: user.id, actorName: user.name };
    if (!user.crmUserId) throw new ForbiddenException('Для доступа свяжите пользователя с менеджером amoCRM');
    if (user.businessRole === 'ROP') {
      if (!user.crmUser?.groupId) throw new ForbiddenException('У руководителя не задана группа amoCRM');
      return { role: 'ROP', groupId: user.crmUser.groupId, actorId: user.id, actorName: user.name };
    }
    return { role: 'MANAGER', managerId: user.crmUserId, actorId: user.id, actorName: user.name };
  }

  private scopeWhere(access: Access): Prisma.CrmControlObservationWhereInput {
    return access.role === 'OWNER' ? {} : access.role === 'ROP' ? { groupId: access.groupId } : { managerId: access.managerId };
  }

  private async storedSettings() {
    const row = await this.prisma.crmControlSettings.findUnique({ where: { id: 'default' } });
    return { version: row?.version ?? 1, config: row ? row.config as unknown as CrmControlConfig : { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [] } };
  }

  async settings(actor: AuthUser) {
    const access = await this.access(actor);
    const [stored, pipelines, taskTypes] = await Promise.all([
      this.storedSettings(), this.prisma.pipeline.findMany({ where: { isArchived: false }, include: { stages: { orderBy: { position: 'asc' } } }, orderBy: { name: 'asc' } }),
      this.taskTypeCatalog(),
    ]);
    const capture = this.evidenceProvider.capabilities();
    const health = await this.readEvidenceHealth(capture);
    const captureMessage = !capture.screenshots ? capture.message : health.status === 'READY'
      ? 'Вход сборщика проверен на карточке amoCRM. Доступ проверяется при каждом снимке.'
      : health.status === 'ERROR' ? health.message : 'Сессия подготовлена, но текущий вход в amoCRM ещё не подтверждён сборщиком.';
    return { ...stored, canManage: access.role === 'OWNER', canReview: access.role !== 'MANAGER', canDispute: true,
      capabilities: { ...capture, health, message: captureMessage, communications: false, proposalFiles: false, taskTypes: taskTypes.available,
        localAnalysis: Boolean(crmControlLocalAnalysisOptions()) },
      options: { pipelines: pipelines.map((pipeline) => ({ id: pipeline.id, name: pipeline.name,
        stages: pipeline.stages.filter(isWorkingStage).map(({ id, name, isWon, isLost }) => ({ id, name, isWon, isLost })) })),
        taskTypes: taskTypes.items },
      suggestedScopes: this.suggestScopes(pipelines), configurationIssues: [...this.configurationIssues(stored.config, pipelines),
        ...(taskTypes.available ? [] : ['Справочник типов задач amoCRM недоступен. Обновите страницу после восстановления подключения.'])],
      ruleCatalog: CRM_CONTROL_RULE_CATALOG };
  }

  private async taskTypeCatalog(): Promise<{ available: boolean; items: Array<{ id: number; name: string }> }> {
    try {
      const connection = await this.amo.getActiveConnectionOrFail();
      const client = await this.amo.getClient(connection);
      const account = await client.get<any>('/account', { with: 'task_types' });
      const rows = account?._embedded?.task_types;
      if ((connection.accountId && String(account?.id) !== String(connection.accountId)) || !Array.isArray(rows)
        || rows.some((row) => !row || !Number.isInteger(row.id) || row.id < 1 || typeof row.name !== 'string' || !row.name.trim())
        || new Set(rows.map((row) => row.id)).size !== rows.length) {
        return { available: false, items: [] };
      }
      return { available: true, items: rows.map((row) => ({ id: row.id, name: row.name })) };
    } catch {
      // Recorded tasks only show types already used; they are not a complete account catalog.
      return { available: false, items: [] };
    }
  }

  private suggestScopes(pipelines: Pipeline[]): CrmControlScope[] {
    const result: CrmControlScope[] = [];
    for (const aliases of [['продажи', 'воронка продажи', 'воронка продаж'], ['база'], ['закрепленные компании']]) {
      const matches = pipelines.filter((pipeline) => aliases.includes(normal(pipeline.name)));
      if (matches.length !== 1) continue;
      const pipeline = matches[0];
      const stage = (label: string) => { const matches = pipeline.stages.filter((item) => isWorkingStage(item) && normal(item.name) === label); return matches.length === 1 ? matches[0].id : undefined; };
      result.push({ department: aliases[0] === 'продажи' ? 'sales' : 'csm', pipelineId: pipeline.id,
        assignedStageId: stage('назначен ответственный'), newClientStageId: stage('новый клиент'), baseStageId: stage('база'),
        preparedProposalStageId: stage('кп подготовлено'), priceRequestedStageId: stage('цена запрошена'), stageRules: {} });
    }
    return result;
  }

  private configurationIssues(config: CrmControlConfig, pipelines: Pipeline[]): string[] {
    const issues: string[] = [];
    if (!config.scopes.length) issues.push('Не выбраны воронки для проверки.');
    for (const scope of config.scopes) {
      const pipeline = pipelines.find((item) => item.id === scope.pipelineId);
      if (!pipeline) { issues.push('Выбранная воронка больше недоступна.'); continue; }
      const needed = scope.department === 'sales' ? ['assignedStageId', 'preparedProposalStageId'] : ['newClientStageId', 'baseStageId', 'preparedProposalStageId', 'priceRequestedStageId'];
      for (const field of needed) {
        const id = (scope as any)[field];
        if (id === null) continue;
        if (!id) issues.push(`${pipeline.name}: не настроен этап ${this.stageLabel(field)}.`);
        else if (!pipeline.stages.some((stage) => stage.id === id && isWorkingStage(stage))) issues.push(`${pipeline.name}: выбран недоступный рабочий этап ${this.stageLabel(field)}.`);
      }
      if (Object.keys(scope.stageRules ?? {}).some((id) => !pipeline.stages.some((stage) => stage.id === id && isWorkingStage(stage)))) {
        issues.push(`${pipeline.name}: нормативы заданы для этапов вне проверки.`);
      }
      const openStages = pipeline.stages.filter((stage) => isWorkingStage(stage) && stage.id !== scope.baseStageId);
      if (openStages.some((stage) => !scope.stageRules?.[stage.id]?.allowedTaskTypeIds?.length)) issues.push(`${pipeline.name}: типы задач для части этапов не настроены.`);
      if (openStages.some((stage) => !hasStageDeadline(scope.stageRules?.[stage.id]))) issues.push(`${pipeline.name}: сроки для части этапов не настроены.`);
    }
    return issues;
  }

  private stageLabel(key: string) {
    return ({ assignedStageId: '«Назначен ответственный»', newClientStageId: '«Новый клиент»', baseStageId: '«База»',
      preparedProposalStageId: '«КП подготовлено»', priceRequestedStageId: '«Цена запрошена»' } as Record<string, string>)[key] ?? key;
  }

  async saveSettings(actor: AuthUser, body: unknown) {
    const access = await this.access(actor);
    if (access.role !== 'OWNER') throw new ForbiddenException('Регламент может менять только владелец');
    const config = await this.validateConfig(body);
    await this.prisma.crmControlSettings.upsert({ where: { id: 'default' }, create: { id: 'default', config: json(config), updatedBy: actor.id },
      update: { config: json(config), version: { increment: 1 }, updatedBy: actor.id } });
    return this.settings(actor);
  }

  private async validateConfig(body: unknown): Promise<CrmControlConfig> {
    const value = body as CrmControlConfig;
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.scopes) || value.scopes.length > 30) throw new BadRequestException('Неверные настройки проверки');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeOfDay ?? '') || value.timeOfDay < '19:00') throw new BadRequestException('Время проверки должно быть не раньше 19:00');
    try { new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).format(new Date()); } catch { throw new BadRequestException('Неверный часовой пояс'); }
    if (typeof value.timeZone !== 'string' || !value.timeZone) throw new BadRequestException('Укажите часовой пояс');
    if (!Array.isArray(value.workdays) || !value.workdays.length || value.workdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new BadRequestException('Выберите рабочие дни');
    if (!['calendar_month', '30_days'].includes(value.maxDealAge) || typeof value.excludeBaseFromAge !== 'boolean') throw new BadRequestException('Неверное правило возраста сделки');
    const pipelines = await this.prisma.pipeline.findMany({ where: { isArchived: false }, include: { stages: true } });
    const seen = new Set<string>();
    const selectedTaskTypes = new Set<number>();
    for (const scope of value.scopes) {
      if (!scope || typeof scope !== 'object' || Array.isArray(scope) || typeof scope.pipelineId !== 'string') throw new BadRequestException('Неверные настройки воронки');
      const pipeline = pipelines.find((item) => item.id === scope.pipelineId);
      if (!pipeline || seen.has(scope.pipelineId) || !['sales', 'csm'].includes(scope.department)) throw new BadRequestException('Воронка отсутствует или выбрана повторно');
      if (scope.checkDealAge !== undefined && typeof scope.checkDealAge !== 'boolean') throw new BadRequestException('Неверное правило возраста для воронки');
      seen.add(scope.pipelineId);
      for (const key of ['assignedStageId', 'newClientStageId', 'baseStageId', 'preparedProposalStageId', 'priceRequestedStageId']) {
        const id = (scope as any)[key];
        if (id != null && id !== '' && !pipeline.stages.some((stage) => stage.id === id && isWorkingStage(stage))) throw new BadRequestException('Этап не относится к рабочим этапам выбранной воронки');
      }
      if (scope.stageRules != null && (typeof scope.stageRules !== 'object' || Array.isArray(scope.stageRules))) throw new BadRequestException('Неверные нормативы этапов');
      for (const [stageId, rule] of Object.entries(scope.stageRules ?? {})) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new BadRequestException('Неверный норматив этапа');
        if (!pipeline.stages.some((stage) => stage.id === stageId && isWorkingStage(stage))) throw new BadRequestException('Норматив можно задать только для рабочего этапа выбранной воронки');
        const deadlineError = stageDeadlineConfigError(rule);
        if (deadlineError) throw new BadRequestException(deadlineError);
        if (rule.allowedTaskTypeIds != null && (!Array.isArray(rule.allowedTaskTypeIds) || rule.allowedTaskTypeIds.some((id) => !Number.isInteger(id) || id < 1))) throw new BadRequestException('Неверные типы задач');
        for (const id of rule.allowedTaskTypeIds ?? []) selectedTaskTypes.add(id);
      }
    }
    if (selectedTaskTypes.size) {
      const catalog = await this.taskTypeCatalog();
      if (!catalog.available) throw new BadRequestException('Не удалось проверить справочник типов задач amoCRM. Повторите сохранение после восстановления подключения.');
      const knownIds = new Set(catalog.items.map((item) => item.id));
      if ([...selectedTaskTypes].some((id) => !knownIds.has(id))) throw new BadRequestException('Выбранный тип задачи отсутствует в справочнике amoCRM');
    }
    if (value.enabled && !value.scopes.length) throw new BadRequestException('Для расписания выберите хотя бы одну воронку');
    return { enabled: value.enabled, timeZone: value.timeZone, timeOfDay: value.timeOfDay, workdays: [...new Set(value.workdays)],
      maxDealAge: value.maxDealAge, excludeBaseFromAge: value.excludeBaseFromAge, scopes: value.scopes };
  }

  async enqueue(actor: AuthUser, body: { sourceRunId?: string; requestKey?: string } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.sourceRunId !== undefined && typeof body.sourceRunId !== 'string') || (body.requestKey !== undefined && typeof body.requestKey !== 'string')) throw new BadRequestException('Неверные параметры запуска');
    const access = await this.access(actor);
    const stored = await this.storedSettings();
    if (!stored.config.scopes.length) throw new BadRequestException('Сначала выберите воронки в регламенте');
    if (body.sourceRunId) await this.run(actor, body.sourceRunId);
    const requestKey = body.requestKey ? String(body.requestKey).slice(0, 120) : randomUUID();
    const run = await this.prisma.crmControlRun.upsert({ where: { requestKey: `manual:${actor.id}:${requestKey}` },
      create: { requestKey: `manual:${actor.id}:${requestKey}`, trigger: body.sourceRunId ? 'RECHECK' : 'MANUAL', requestedBy: actor.id,
        sourceRunId: body.sourceRunId, scheduledFor: new Date(), config: json({ ...stored.config, _access: access }), configVersion: stored.version, ruleVersion: CRM_CONTROL_RULE_VERSION }, update: {} });
    return this.publicRun(run, emptyControlCounts());
  }

  async schedule(now = new Date()) {
    const stored = await this.storedSettings();
    const slot = controlScheduleSlot(now, stored.config);
    if (!slot) return;
    await this.prisma.crmControlRun.upsert({ where: { requestKey: `daily:${slot}` }, update: {},
      create: { requestKey: `daily:${slot}`, trigger: 'SCHEDULED', scheduledFor: now, config: json(stored.config), configVersion: stored.version, ruleVersion: CRM_CONTROL_RULE_VERSION } });
  }

  async recheckRemaining(actor: AuthUser, runId: string, body: { requestKey?: string } = {}) {
    const access = await this.access(actor);
    if (access.role === 'MANAGER') throw new ForbiddenException('Допроверку запускает владелец или руководитель.');
    await this.run(actor, runId);
    if (!this.analysisBatches) throw new BadRequestException('Локальная допроверка недоступна.');
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.requestKey !== undefined && (typeof body.requestKey !== 'string' || body.requestKey.length > 120))) {
      throw new BadRequestException('Неверные параметры допроверки.');
    }
    const batch = await this.analysisBatches.enqueue(runId, access, `manual:${runId}:${actor.id}:${body.requestKey || randomUUID()}`);
    return { id: batch.id, status: batch.status, processed: batch.processed, queued: batch.queued, deferred: batch.deferred };
  }

  async runs(actor: AuthUser, cursor?: string) {
    const access = await this.access(actor);
    const where: Prisma.CrmControlRunWhereInput = access.role === 'OWNER' ? {} : { OR: [{ requestedBy: actor.id }, { observations: { some: this.scopeWhere(access) } }] };
    const items = await this.prisma.crmControlRun.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    return { items: await Promise.all(items.slice(0, 30).map(async (item) => this.publicRun(item, (await this.summary(item.id, access)).counts))),
      nextCursor: items.length > 30 ? items[29].id : null };
  }

  private publicRun(run: any, counts: CrmControlCounts) {
    return { id: run.id, status: run.status, trigger: run.trigger, scheduledFor: run.scheduledFor, startedAt: run.startedAt,
      finishedAt: run.finishedAt, sourceSyncAt: run.sourceSyncAt, error: run.error, counts, configVersion: run.configVersion, ruleVersion: run.ruleVersion,
      completion: controlCompletion(run.status, counts, Array.isArray(run.issues) ? run.issues : []) };
  }

  private async summary(runId: string, access: Access) {
    const observations = await this.prisma.crmControlObservation.findMany({ where: { runId, ...this.scopeWhere(access) },
      select: { managerId: true, managerName: true, groupName: true, department: true, counts: true, observedAt: true,
        results: { select: { status: true, ruleCode: true, ruleName: true, observationId: true, analyses: crmControlAnalysisSummaryInclude, case: { select: { status: true,
          decisions: { select: { id: true, action: true, observationId: true, createdAt: true, validUntil: true } } } } } } } });
    const counts = emptyControlCounts();
    const managers = new Map<string, CrmControlCounts & { managerId: string | null; managerName: string | null; groupName: string | null; department: string }>();
    const rules = new Map<string, RuleBreakdown>();
    const analysis = { queued: 0, running: 0, completed: 0, failed: 0, unresolved: 0, preparing: false };
    for (const observation of observations) {
      const value = this.effectiveCounts(observation.results, observation.observedAt);
      addControlCounts(counts, value);
      const key = `${observation.department}:${observation.managerId ?? ''}`;
      const manager = managers.get(key) ?? { ...emptyControlCounts(), managerId: observation.managerId, managerName: observation.managerName,
        groupName: observation.groupName, department: observation.department };
      // Aggregate only count fields: manager metadata is never coerced into numbers.
      const totals = addControlCounts(Object.fromEntries(Object.keys(emptyControlCounts()).map((key) => [key, (manager as any)[key]])) as unknown as CrmControlCounts, value);
      managers.set(key, { ...manager, ...totals });
      // Several tasks may fail the same rule. Each cell counts the deal only once per status.
      const statusesByRule = new Map<string, { name: string; statuses: Set<string> }>();
      for (const result of observation.results) {
        const automatic = crmControlAnalysisProjection(result.analyses);
        if (automatic) {
          if (automatic.status === 'QUEUED') analysis.queued++;
          else if (automatic.status === 'RUNNING') analysis.running++;
          else if (automatic.status === 'ERROR') analysis.failed++;
          else if (automatic.outcome) analysis.completed++;
          else analysis.unresolved++;
        }
        const item = statusesByRule.get(result.ruleCode) ?? { name: result.ruleName, statuses: new Set<string>() };
        item.statuses.add(this.effectiveStatus(result, observation.observedAt));
        statusesByRule.set(result.ruleCode, item);
      }
      for (const [ruleCode, item] of statusesByRule) {
        const value: RuleDealCounts = { failedDeals: Number(item.statuses.has('FAIL')),
          reviewDeals: Number(item.statuses.has('REVIEW')), unknownDeals: Number(item.statuses.has('UNKNOWN')) };
        const rule = rules.get(ruleCode) ?? { ruleCode, ruleName: item.name, failedDeals: 0, reviewDeals: 0, unknownDeals: 0, byManager: [] };
        let cell = rule.byManager.find(cell => cell.managerId === observation.managerId && cell.department === observation.department);
        if (!cell) { cell = { managerId: observation.managerId, department: observation.department, failedDeals: 0, reviewDeals: 0, unknownDeals: 0 }; rule.byManager.push(cell); }
        for (const field of ['failedDeals', 'reviewDeals', 'unknownDeals'] as const) { rule[field] += value[field]; cell[field] += value[field]; }
        rules.set(ruleCode, rule);
      }
    }
    if (crmControlLocalAnalysisOptions()) analysis.preparing = Boolean(await this.prisma.crmControlAnalysisBatch.findFirst({ where: { runId, status: { in: ['QUEUED','RUNNING'] },
      ...(access.role === 'OWNER' ? {} : access.role === 'ROP' ? { OR: [{ scopeRole: 'OWNER' }, { groupId: access.groupId }] } : { OR: [{ scopeRole: 'OWNER' }, { managerId: access.managerId }] }) }, select: { id: true } }));
    return { counts, analysis, managers: [...managers.values()].sort((a, b) => b.failedDeals - a.failedDeals || String(a.managerName).localeCompare(String(b.managerName), 'ru')),
      ruleBreakdown: [...rules.values()].sort((a, b) => b.failedDeals - a.failedDeals || a.ruleName.localeCompare(b.ruleName, 'ru')) };
  }

  async run(actor: AuthUser, id: string) {
    const access = await this.access(actor);
    const run = await this.prisma.crmControlRun.findFirst({ where: { id, ...(access.role === 'OWNER' ? {} : { OR: [{ requestedBy: actor.id }, { observations: { some: this.scopeWhere(access) } }] }) } });
    if (!run) throw new NotFoundException('Проверка не найдена');
    const summary = await this.summary(id, access);
    return { run: this.publicRun(run, summary.counts), ...summary, configurationIssues: run.issues };
  }

  async deals(actor: AuthUser, runId: string, query: { managerId?: string; department?: string; status?: string; ruleCode?: string; cursor?: string }) {
    const access = await this.access(actor);
    await this.run(actor, runId);
    if (query.status && !['FAIL', 'REVIEW', 'UNKNOWN', 'PASS', 'NA'].includes(query.status)) throw new BadRequestException('Неверный статус проверки');
    if (query.ruleCode && !CRM_CONTROL_RULE_CATALOG.some(rule => rule.code === query.ruleCode)) throw new BadRequestException('Неверный тип проверки');
    if (query.department && !['sales', 'csm'].includes(query.department)) throw new BadRequestException('Неверный отдел');
    const where: Prisma.CrmControlObservationWhereInput = { AND: [{ runId }, this.scopeWhere(access),
      ...(query.managerId ? [{ managerId: query.managerId === 'unassigned' ? null : query.managerId }] : []),
      ...(query.department ? [{ department: query.department }] : []),
      ...(query.ruleCode ? [{ results: { some: { ruleCode: query.ruleCode } } }] : [])] };
    const matching: ReturnType<CrmControlService['publicObservation']>[] = [];
    let cursor = query.cursor;
    // Decisions are temporal. Filter using exactly the same projection as the rows and manager summary.
    while (matching.length <= 50) {
      const rows = await this.prisma.crmControlObservation.findMany({ where, orderBy: { id: 'asc' }, take: 100, include: observationInclude,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) break;
      for (const row of rows) {
        const view = this.publicObservation(row);
        const matchingResults = view.results.filter(result => !query.ruleCode || result.ruleCode === query.ruleCode);
        if ((!query.ruleCode || matchingResults.length > 0) && (!query.status || (query.status === 'PASS' && !query.ruleCode
          ? view.counts.checkedDeals === 1 && view.counts.failedDeals === 0
          : matchingResults.some(result => result.effectiveStatus === query.status)))) matching.push(view);
        if (matching.length > 50) break;
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < 100) break;
    }
    return { items: matching.slice(0, 50), nextCursor: matching.length > 50 ? matching[49].id : null };
  }

  private publicObservation(row: Observation) {
    const { snapshot, snapshotHash, results, evidence, ...rest } = row;
    const counts = this.effectiveCounts(results, row.observedAt);
    return { ...rest, counts, results: results.map(({ case: caseValue, analyses, ...result }) => ({ ...result,
      effectiveStatus: this.effectiveStatus({ ...result, analyses, case: caseValue }, row.observedAt), caseStatus: caseValue?.status ?? null,
      analysis: crmControlAnalysisProjection(analyses), review: this.manualReviewState({ ...result, case: caseValue }) })),
      evidence: evidence.map(({ storageKey, ...item }) => ({ ...item, downloadUrl: item.status === 'READY' ? `/crm-control/evidence/${item.id}/file` : null })) };
  }

  private effectiveStatus(result: AssessedResult, observedAt: Date) {
    const decision = newestDecision((result.case?.decisions ?? []).filter((decision) => manualReviewActions.includes(decision.action)
      ? decision.observationId === result.observationId
      : ['FAIL', 'REVIEW'].includes(result.status) && ['CONFIRM', 'EXEMPT'].includes(decision.action)
        && (decision.observationId === result.observationId || decision.createdAt <= observedAt)));
    if (decision && manualReviewActions.includes(decision.action)) return decision.action.slice('VERIFY_'.length);
    if (decision?.action === 'EXEMPT' && decision.validUntil && decision.validUntil >= observedAt) return 'NA';
    if (decision?.action === 'CONFIRM') return 'FAIL';
    return crmControlAnalysisProjection(result.analyses)?.outcome ?? result.status;
  }

  private manualReviewState(result: AssessedResult & { ruleCode?: string; message?: string; details?: unknown }) {
    const decisions = (result.case?.decisions ?? []).filter((decision) => decision.observationId === result.observationId);
    const latest = newestDecision(decisions);
    const current = latest && manualReviewActions.includes(latest.action) ? latest : null;
    return { allowed: controlManualReviewAllowed(result), expectedDecisionId: latest?.id ?? null,
      current: current ? this.manualReviewResponse(current) : null, guidance: controlManualReviewGuidance(result) };
  }

  private manualReviewResponse(decision: AssessedDecision) {
    return { decisionId: decision.id, outcome: decision.action.slice('VERIFY_'.length), reason: decision.reason,
      reviewedBy: decision.actorName, reviewedAt: decision.createdAt };
  }

  private effectiveCounts(results: AssessedResult[], observedAt: Date) {
    const counts = observationCounts(results.map((item) => ({ status: this.effectiveStatus(item, observedAt) })) as CrmControlRuleResult[]);
    counts.unresolvedDeals = Number(results.some((result) => this.effectiveStatus(result, observedAt) === 'FAIL' && result.case && ['OPEN', 'REVIEW', 'DISPUTED'].includes(result.case.status)));
    return counts;
  }

  private async visibleObservation(actor: AuthUser, id: string) {
    const access = await this.access(actor);
    const row = await this.prisma.crmControlObservation.findFirst({ where: { id, ...this.scopeWhere(access) }, include: observationInclude });
    if (!row) throw new NotFoundException('Сделка в проверке не найдена');
    return { row, access };
  }

  async observation(actor: AuthUser, id: string) {
    const { row, access } = await this.visibleObservation(actor, id);
    const caseIds = row.results.flatMap((item) => item.caseId ? [item.caseId] : []);
    const [cases, history] = await Promise.all([
      this.prisma.crmControlCase.findMany({ where: { id: { in: caseIds } }, include: { decisions: { orderBy: { createdAt: 'desc' },
        where: access.role === 'OWNER' ? {} : access.role === 'ROP' ? { groupId: access.groupId } : { managerId: access.managerId } } } }),
      this.prisma.crmControlObservation.findMany({ where: { dealId: row.dealId, ...this.scopeWhere(access) }, orderBy: { observedAt: 'desc' },
        take: 100, select: { id: true, runId: true, observedAt: true, counts: true } }),
    ]);
    return { ...this.publicObservation(row), snapshot: row.snapshot, snapshotHash: row.snapshotHash, cases, history,
      documents: crmControlDocumentEvidence(row.snapshot).map(item => ({ ...item,
        downloadUrl: `/crm-control/observations/${encodeURIComponent(row.id)}/documents/${item.sha256}/file` })),
      historyLimited: history.length === 100 };
  }

  async documentEvidence(actor: AuthUser, observationId: string, sha256: string) {
    const { row } = await this.visibleObservation(actor, observationId);
    const artifact = crmControlDocumentEvidence(row.snapshot).find(item => item.sha256 === sha256);
    const root = crmControlDocumentDirectory();
    if (!artifact || !root) throw new NotFoundException('Сохранённый документ не найден');
    try { return await readCrmControlDocument(root, artifact); }
    catch { throw new NotFoundException('Сохранённый документ недоступен или не прошёл проверку целостности'); }
  }

  async analysisProof(actor: AuthUser, observationId: string, resultId: string) {
    const { row } = await this.visibleObservation(actor, observationId);
    const result = row.results.find(item => item.id === resultId);
    if (!result) throw new NotFoundException('Результат проверки не найден');
    const latest = result.analyses?.[0];
    if (!latest) return { analysis: null, findings: [] };
    const job = await this.prisma.crmControlAnalysisJob.findFirst({ where: { id: latest.id, resultId },
      include: { attempts: { where: { status: 'READY' }, orderBy: { attemptNo: 'desc' }, take: 1 } } });
    if (!job) return { analysis: null, findings: [] };
    return crmControlAnalysisProof(job, row.snapshotHash, job.attempts[0] ?? null);
  }

  async decide(actor: AuthUser, id: string, body: CrmControlDecisionInput) {
    const access = await this.access(actor);
    const item = await this.prisma.crmControlCase.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Нарушение не найдено');
    const { row: currentObservation } = await this.visibleObservation(actor, item.latestObservationId);
    if (!body || !['CONFIRM', 'EXEMPT', 'DISPUTE'].includes(body.action) || typeof body.reason !== 'string' || body.reason.trim().length < 5 || body.reason.length > 4000) throw new BadRequestException('Укажите действие и содержательное обоснование');
    if (access.role === 'MANAGER' && body.action !== 'DISPUTE') throw new ForbiddenException('Менеджер может только оспорить нарушение');
    const caseResults = currentObservation.results.filter((result) => result.caseId === id);
    if (body.action !== 'DISPUTE' && (!caseResults.length || caseResults.some((result) => result.status === 'UNKNOWN'
      || this.effectiveStatus(result, currentObservation.observedAt) !== 'FAIL'))) {
      throw new BadRequestException('Сначала выполните ручную допроверку пункта с объяснением и ссылкой на подтверждение');
    }
    const expectedDecisionId = newestDecision((caseResults[0]?.case?.decisions ?? []).filter((decision) => decision.observationId === currentObservation.id))?.id ?? null;
    if (['RESOLVED', 'SUPERSEDED'].includes(item.status)) throw new BadRequestException('Этот эпизод уже завершён');
    const validUntil = body.validUntil ? new Date(body.validUntil) : null;
    if (body.action === 'EXEMPT' && (!validUntil || !Number.isFinite(validUntil.getTime()) || validUntil <= new Date())) throw new BadRequestException('Укажите будущую дату окончания исключения');
    const status = body.action === 'CONFIRM' ? 'OPEN' : body.action === 'EXEMPT' ? 'EXEMPTED' : 'DISPUTED';
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CrmControlCase" WHERE "id" = ${id} FOR UPDATE`;
      const last = await tx.crmControlDecision.findFirst({ where: { caseId: id, observationId: currentObservation.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if ((last?.id ?? null) !== expectedDecisionId) throw new ConflictException('Решение уже изменилось. Обновите карточку');
      const update = await tx.crmControlCase.updateMany({ where: { id, status: item.status, latestObservationId: item.latestObservationId },
        data: { status, exemptionUntil: body.action === 'EXEMPT' ? validUntil : null,
          ...(body.action === 'CONFIRM' ? { confirmedAt: new Date() } : body.action === 'EXEMPT' ? { confirmedAt: null } : {}) } });
      if (update.count !== 1) throw new BadRequestException('Состояние изменилось. Обновите карточку');
      return tx.crmControlDecision.create({ data: { caseId: id, observationId: currentObservation.id, actorId: actor.id, actorName: access.actorName,
        managerId: currentObservation.managerId, groupId: currentObservation.groupId, action: body.action,
        reason: body.reason.trim(), validUntil: body.action === 'EXEMPT' ? validUntil : null,
        createdAt: new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0)) } });
    });
  }

  async reviewResult(actor: AuthUser, observationId: string, resultId: string, body: CrmControlManualReviewInput) {
    const { row, access } = await this.visibleObservation(actor, observationId);
    if (access.role === 'MANAGER') throw new ForbiddenException('Ручную проверку может выполнить только руководитель');
    if (!row.results.some((result) => result.id === resultId)) throw new NotFoundException('Пункт в этой проверке не найден');
    if (!body || !['PASS', 'FAIL', 'NA'].includes(body.outcome) || typeof body.reason !== 'string' || body.reason.trim().length < 20 || body.reason.length > 4000
      || typeof body.evidence !== 'string' || body.evidence.length > 2048
      || !(body.expectedDecisionId === null || (typeof body.expectedDecisionId === 'string' && body.expectedDecisionId.length > 0 && body.expectedDecisionId.length <= 100))) {
      throw new BadRequestException('Укажите результат, объяснение от 20 символов и ссылку на проверенное подтверждение');
    }
    let evidence: URL;
    try { evidence = new URL(body.evidence.trim()); } catch { throw new BadRequestException('Укажите полную ссылку http(s) на проверенное подтверждение'); }
    if (!['http:', 'https:'].includes(evidence.protocol) || evidence.username || evidence.password) throw new BadRequestException('Допустима ссылка http(s) без учётных данных');
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CrmControlResult" WHERE "id" = ${resultId} AND "observationId" = ${observationId} FOR UPDATE`;
      if (!locked.length) throw new NotFoundException('Пункт в этой проверке не найден');
      const result = await tx.crmControlResult.findUnique({ where: { id: resultId } });
      if (!result || !controlManualReviewAllowed(result)) throw new BadRequestException('Этот пункт нельзя допроверить вручную: повторите автоматическую проверку после наступления срока');
      let caseId = result.caseId;
      if (!caseId) {
        const reviewCase = await tx.crmControlCase.create({ data: { caseKey: `review:${result.id}`, activeKey: null,
          dealId: row.dealId, ruleCode: result.ruleCode, subjectId: result.subjectId, status: 'REVIEW',
          firstDetectedAt: row.observedAt, lastDetectedAt: row.observedAt, latestObservationId: row.id,
          assessmentHash: createHash('sha256').update(`${row.snapshotHash}:${result.id}`).digest('hex') } });
        const linked = await tx.crmControlResult.updateMany({ where: { id: resultId, caseId: null }, data: { caseId: reviewCase.id } });
        if (linked.count !== 1) throw new ConflictException('Пункт уже изменился. Обновите карточку');
        caseId = reviewCase.id;
      }
      await tx.$queryRaw`SELECT "id" FROM "CrmControlCase" WHERE "id" = ${caseId} FOR UPDATE`;
      const last = await tx.crmControlDecision.findFirst({ where: { caseId, observationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
      if ((last?.id ?? null) !== body.expectedDecisionId) throw new ConflictException('Решение уже изменилось. Обновите карточку и проверьте результат');
      // The reference is recorded, never fetched by the server. Review does not rewrite source facts or other observations.
      const decision = await tx.crmControlDecision.create({ data: { caseId, observationId, actorId: actor.id, actorName: access.actorName,
        managerId: row.managerId, groupId: row.groupId, action: `VERIFY_${body.outcome}`,
        reason: `${body.reason.trim()}\nИсточник: ${evidence.href}`, validUntil: null,
        createdAt: new Date(Math.max(Date.now(), last ? last.createdAt.getTime() + 1 : 0)) } });
      if (body.outcome === 'FAIL') await this.ensureEvidenceForObservation(tx, row);
      return this.manualReviewResponse(decision);
    });
  }

  private async ensureEvidenceForObservation(tx: Prisma.TransactionClient, observation: { id: string; dealUrl: string }) {
    const capability = this.evidenceProvider.capabilities();
    // A later manual FAIL may be the first violation in this observation. Never replace an existing image or retry history.
    return tx.crmControlEvidence.upsert({ where: { observationId: observation.id }, update: {},
      create: { observationId: observation.id, sourceUrl: observation.dealUrl,
        status: capability.screenshots ? 'PENDING' : 'DISABLED', error: capability.screenshots ? null : capability.message } });
  }

  private async persistEvidenceHealth() {
    const runtime = this.evidenceProvider.runtimeHealth();
    const config = json({ configurationFingerprint: runtime.configurationFingerprint,
      health: sanitizeCrmCaptureHealth(runtime.health) });
    try {
      await this.prisma.crmControlSettings.upsert({ where: { id: 'runtime:screenshot-health' },
        create: { id: 'runtime:screenshot-health', config }, update: { config } });
    } catch { this.logger.warn('CRM screenshot runtime health could not be saved; no session data is logged'); }
  }

  private async readEvidenceHealth(capture: { screenshots: boolean; health?: CaptureHealth }): Promise<CaptureHealth> {
    if (!capture.screenshots) return sanitizeCrmCaptureHealth(capture.health);
    const runtime = this.evidenceProvider.runtimeHealth();
    const local = sanitizeCrmCaptureHealth(runtime.health);
    if (!runtime.configurationFingerprint) return local;
    const saved = await this.prisma.crmControlSettings.findUnique({ where: { id: 'runtime:screenshot-health' }, select: { config: true } });
    const envelope = saved?.config;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)
      || envelope.configurationFingerprint !== runtime.configurationFingerprint) return local;
    const shared = sanitizeCrmCaptureHealth(envelope.health);
    if (local.checkedAt && (!shared.checkedAt || Date.parse(local.checkedAt) > Date.parse(shared.checkedAt))) return local;
    return shared;
  }

  async probeEvidence(actor: AuthUser, observationId: string) {
    const { row, access } = await this.visibleObservation(actor, observationId);
    if (access.role !== 'OWNER') throw new ForbiddenException('Подключение сборщика проверяет владелец');
    if (!await this.captureOwnerMatches(row, row.dealUrl)) throw new BadRequestException('Ответственный или группа изменились. Выберите актуальную проверку сделки');
    const health = await this.evidenceProvider.probe({ observationId: row.id, dealExternalId: row.dealExternalId, sourceUrl: row.dealUrl, dealTitle: row.dealTitle });
    await this.persistEvidenceHealth();
    return sanitizeCrmCaptureHealth(health);
  }

  async requeueDisabledEvidence(actor: AuthUser, observationId: string) {
    const health = await this.probeEvidence(actor, observationId);
    if (health.status !== 'READY') throw new BadRequestException(health.message || 'Сначала восстановите вход сборщика в amoCRM');
    // Only jobs that could not start are resumed. ERROR and READY retain their existing history.
    const updated = await this.prisma.crmControlEvidence.updateMany({ where: { status: 'DISABLED' },
      data: { status: 'PENDING', attempts: 0, startedAt: null, nextAttemptAt: null, error: null } });
    return { queued: updated.count, health };
  }

  async evidenceFile(actor: AuthUser, id: string) {
    const evidence = await this.prisma.crmControlEvidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException('Подтверждение не найдено');
    const { row } = await this.visibleObservation(actor, evidence.observationId);
    if (evidence.status !== 'READY' || !evidence.storageKey) throw new NotFoundException('Снимок ещё не готов');
    return this.evidenceProvider.read(evidence.storageKey, { observationId: row.id, dealExternalId: row.dealExternalId,
      observedAt: row.observedAt, snapshotHash: row.snapshotHash, snapshot: row.snapshot, results: row.results });
  }

  async evidenceManifest(actor: AuthUser, id: string) {
    const evidence = await this.prisma.crmControlEvidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException('Подтверждение не найдено');
    const { row } = await this.visibleObservation(actor, evidence.observationId);
    if (evidence.status !== 'READY' || !evidence.storageKey) throw new NotFoundException('Снимок ещё не готов');
    const manifest = await this.evidenceProvider.readManifest(evidence.storageKey, { observationId: row.id, dealExternalId: row.dealExternalId,
      observedAt: row.observedAt, snapshotHash: row.snapshotHash, snapshot: row.snapshot, results: row.results });
    return manifest ? publicEvidenceManifest(manifest, evidence.id) : { version: 0, observedAt: row.observedAt,
      capturedAt: evidence.capturedAt, frames: [{ id: 'legacy', label: 'Ранее сохранённая карточка', capturedAt: evidence.capturedAt,
        downloadUrl: `/crm-control/evidence/${encodeURIComponent(evidence.id)}/file` }], coverage: [],
      limitation: evidence.coverage || 'Сохранён один кадр. Покрытие отдельных правил в этой версии не фиксировалось.' };
  }

  async evidenceFrameFile(actor: AuthUser, id: string, frameId: string) {
    const evidence = await this.prisma.crmControlEvidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException('Подтверждение не найдено');
    const { row } = await this.visibleObservation(actor, evidence.observationId);
    if (evidence.status !== 'READY' || !evidence.storageKey) throw new NotFoundException('Снимок ещё не готов');
    return this.evidenceProvider.readFrame(evidence.storageKey, frameId, { observationId: row.id, dealExternalId: row.dealExternalId,
      observedAt: row.observedAt, snapshotHash: row.snapshotHash, snapshot: row.snapshot, results: row.results });
  }

  async retryEvidence(actor: AuthUser, id: string) {
    const evidence = await this.prisma.crmControlEvidence.findUnique({ where: { id } });
    if (!evidence) throw new NotFoundException('Подтверждение не найдено');
    await this.visibleObservation(actor, evidence.observationId);
    if (!['ERROR', 'DISABLED'].includes(evidence.status)) throw new BadRequestException('Снимок уже сохранён или находится в очереди');
    const capability = this.evidenceProvider.capabilities();
    if (!capability.screenshots) throw new BadRequestException(capability.message || 'Скриншоты не подключены');
    const updated = await this.prisma.crmControlEvidence.updateMany({ where: { id, status: evidence.status },
      data: { status: 'PENDING', attempts: 0, startedAt: null, nextAttemptAt: null, error: null } });
    if (updated.count !== 1) throw new BadRequestException('Состояние изменилось. Обновите карточку');
    return { id, status: 'PENDING' };
  }

  async processQueue() {
    const expiredBefore = new Date(Date.now() - 30 * 60_000);
    const expired = await this.prisma.crmControlRun.findMany({ where: { status: 'RUNNING', activeKey: 'global', OR: [
      { heartbeatAt: { lt: expiredBefore } }, { heartbeatAt: null, startedAt: { lt: expiredBefore } },
    ] } });
    for (const item of expired) {
      const resumable = runAttempts(item) < 3 && item.ruleVersion === CRM_CONTROL_RULE_VERSION
        && runDay(item, item.scheduledFor) === runDay(item, new Date());
      await this.prisma.crmControlRun.updateMany({ where: { id: item.id, status: 'RUNNING', activeKey: 'global', startedAt: item.startedAt, heartbeatAt: item.heartbeatAt },
        data: { status: resumable ? 'QUEUED' : 'ERROR', activeKey: null, finishedAt: resumable ? null : new Date(),
          error: resumable ? null : 'Проверка прервана. Продолжение в тот же день и с прежней версией правил недоступно либо исчерпаны три попытки. Нужен новый запуск.' } });
    }
    if (await this.prisma.crmControlRun.count({ where: { activeKey: 'global' } })) return;
    const pending = await this.prisma.crmControlRun.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
    if (!pending) return;
    if (runAttempts(pending) > 0 && (runAttempts(pending) >= 3 || pending.ruleVersion !== CRM_CONTROL_RULE_VERSION)) {
      await this.prisma.crmControlRun.updateMany({ where: { id: pending.id, status: 'QUEUED', startedAt: pending.startedAt },
        data: { status: 'ERROR', finishedAt: new Date(), error: 'Продолжение с прежней версией правил недоступно либо исчерпаны три попытки. Нужен новый запуск.' } });
      return;
    }
    let claimed: { count: number };
    const claimedAt = new Date(Math.max(Date.now(), (pending.startedAt?.getTime() ?? 0) + 1));
    const attempt = runAttempts(pending) + 1;
    try { claimed = await this.prisma.crmControlRun.updateMany({ where: { id: pending.id, status: 'QUEUED', startedAt: pending.startedAt },
      data: { status: 'RUNNING', activeKey: 'global', startedAt: claimedAt, heartbeatAt: new Date(), ruleVersion: CRM_CONTROL_RULE_VERSION,
        sourceSyncAt: pending.sourceSyncAt ?? claimedAt, error: null, counts: json({ ...(pending.counts as object), executionAttempts: attempt }) } }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return; throw error; }
    if (claimed.count !== 1) return;
    try { await this.executeRun({ ...pending, startedAt: claimedAt, sourceSyncAt: pending.sourceSyncAt ?? claimedAt,
      ruleVersion: CRM_CONTROL_RULE_VERSION, counts: { ...(pending.counts as object), executionAttempts: attempt } }); }
    catch (error) {
      const retry = transientRunError(error) && attempt < 3 && runDay(pending, pending.scheduledFor) === runDay(pending, new Date());
      await this.prisma.crmControlRun.updateMany({ where: { id: pending.id, activeKey: 'global', status: 'RUNNING', startedAt: claimedAt },
        data: { status: retry ? 'QUEUED' : 'ERROR', activeKey: null, finishedAt: retry ? null : new Date(),
          error: retry ? null : error instanceof ControlRunError ? error.message : opaqueError() } });
      this.logger.warn(`CRM control run ${pending.id} failed; source credentials and responses are omitted`); }
  }

  private async executeRun(run: Prisma.CrmControlRunGetPayload<Record<string, never>>) {
    if (!run.startedAt) throw new ControlRunError('Не удалось подтвердить попытку выполнения проверки.');
    const config = run.config as unknown as CrmControlConfig & { _access?: Access };
    const localDay = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    if (localDay(run.scheduledFor) !== localDay(new Date())) throw new ControlRunError('Проверка не выполнена в назначенный день. Нужен новый запуск; прошлое состояние не восстановлено.');
    const [pipelines, users, connection] = await Promise.all([
      this.prisma.pipeline.findMany({ include: { stages: true } }), this.prisma.crmUser.findMany({ include: { group: true } }),
      this.amo.getActiveConnectionOrFail(),
    ]);
    const requestedInterval = Number(process.env.CRM_CONTROL_REQUEST_INTERVAL_MS ?? 250);
    const client = await this.amo.getClient(connection, { minRequestIntervalMs: Number.isFinite(requestedInterval) ? Math.max(250, requestedInterval) : 250 });
    const issues = [...new Set([...this.configurationIssues(config, pipelines),
      ...(Array.isArray(run.issues) ? run.issues.filter((issue): issue is string => typeof issue === 'string') : [])])];
    const counts = emptyControlCounts();
    const scopeByExternalId = new Map(config.scopes.flatMap((scope) => {
      const pipeline = pipelines.find((item) => item.id === scope.pipelineId);
      return pipeline ? [[pipeline.externalId, { scope, pipeline }] as const] : [];
    }));
    if (!scopeByExternalId.size) throw new Error('No configured source scope');
    for (const { scope, pipeline } of scopeByExternalId.values()) {
      const configuredIds = [scope.assignedStageId, scope.newClientStageId, scope.baseStageId, scope.preparedProposalStageId,
        scope.priceRequestedStageId, ...Object.keys(scope.stageRules ?? {})];
      if (pipeline.stages.some((stage) => configuredIds.includes(stage.id) && !isWorkingStage(stage))) {
        throw new ControlRunError(`${pipeline.name}: в настройках выбран системный или закрытый этап. Выберите рабочие этапы перед запуском.`);
      }
    }
    const sourceStartedAt = run.sourceSyncAt ?? new Date();
    const sourceParams: Record<string, string | number> = { 'order[id]': 'asc' };
    let statusIndex = 0;
    for (const { pipeline } of scopeByExternalId.values()) for (const stage of pipeline.stages.filter(isWorkingStage)) {
      sourceParams[`filter[statuses][${statusIndex}][pipeline_id]`] = pipeline.externalId;
      sourceParams[`filter[statuses][${statusIndex}][status_id]`] = stage.externalId;
      statusIndex += 1;
    }
    if (!statusIndex) throw new ControlRunError('В выбранных воронках нет доступных открытых этапов.');
    const observedDealIds = new Set<string>();
    // Resume reads only missing deals; saved observations retain their original observedAt and raw facts.
    let observationCursor: string | undefined;
    while (true) {
      const saved = await this.prisma.crmControlObservation.findMany({ where: { runId: run.id }, orderBy: { id: 'asc' }, take: 250,
        select: { id: true, dealExternalId: true, counts: true }, ...(observationCursor ? { cursor: { id: observationCursor }, skip: 1 } : {}) });
      if (!saved.length) break;
      for (const observation of saved) {
        observedDealIds.add(observation.dealExternalId);
        addControlCounts(counts, observation.counts as unknown as CrmControlCounts);
      }
      observationCursor = saved[saved.length - 1].id;
    }
    const lease = { id: run.id, status: 'RUNNING', activeKey: 'global', startedAt: run.startedAt };
    const heartbeat = async () => {
      const updated = await this.prisma.crmControlRun.updateMany({ where: lease,
        data: { heartbeatAt: new Date(), counts: json({ ...counts, executionAttempts: runAttempts(run) }), issues: json(issues) } });
      if (updated.count !== 1) throw new ControlRunError('Проверка прервана другим процессом.');
    };
    await heartbeat();
    const communicationReadAt = new Date();
    let sourceWindow: CrmControlSourceWindow | null = null;
    try {
      sourceWindow = await new CrmControlSourceService(this.prisma).loadWindow({ connectionId: connection.id,
        receivedFrom: new Date(0), receivedTo: communicationReadAt, maxRows: 50_000 });
    } catch { issues.push('Не удалось прочитать сохранённые сообщения amoCRM. Сверка отправленных документов не завершена.'); }
    const messageIndex = indexCrmControlSourcesForDeals(sourceWindow?.messages ?? [], { connectionId: connection.id,
      dealExternalIds: [...new Set((sourceWindow?.messages ?? []).flatMap(message => message.binding.leadExternalId ? [message.binding.leadExternalId] : []))],
      observedAt: communicationReadAt });
    const proposalFields = await this.prisma.customFieldDefinition.findMany({ where: { entityType: 'LEAD', type: 'file' },
      select: { externalId: true, name: true } });
    const namedProposalFields = proposalFields.filter(field => normal(field.name) === 'кп');
    const proposalFieldId = namedProposalFields.length === 1 ? namedProposalFields[0].externalId : null;
    let driveReader: CrmControlDriveReader | null = null;
    try {
      const account = await client.get<any>('/account', { with: 'drive_url' });
      driveReader = new CrmControlDriveReader(client, account.drive_url);
    } catch { issues.push('Не удалось подключить хранилище файлов amoCRM для сверки КП.'); }
    const proposalCollector = new CrmControlProposalSourceCollector(driveReader, crmControlDocumentDirectory());
    // Enumerate the source itself. A fresh local sync timestamp cannot prove a complete task/notes list.
    const collectOpenDeals = async (sourceBatch?: CrmBrowserSourceBatch) => {
    await client.paginateBatch<any>('/leads', 'leads', sourceParams, async (leads) => {
      const uniqueLeads = [...new Map(leads.map((lead) => [String(lead.id), lead])).values()];
      for (let offset = 0; offset < uniqueLeads.length; offset += 3) {
        const collected = await Promise.allSettled(uniqueLeads.slice(offset, offset + 3).map(async (listedLead) => {
        if (localDay(new Date()) !== localDay(sourceStartedAt)) throw new ControlRunError('Обход пересёк полночь. Сохранена только выполненная часть; запустите новую проверку.');
        if (observedDealIds.has(String(listedLead.id))) return;
        const match = scopeByExternalId.get(String(listedLead.pipeline_id));
        if (!match) return;
        let stage = match.pipeline.stages.find((item) => item.externalId === String(listedLead.status_id));
        if (!stage) { if (!issues.includes('Часть этапов отсутствует в справочнике. Обновите синхронизацию amoCRM.')) issues.push('Часть этапов отсутствует в справочнике. Обновите синхронизацию amoCRM.'); return; }
        if (!isWorkingStage(stage) || listedLead.is_deleted) return;
        const user = users.find((item) => item.externalId === String(listedLead.responsible_user_id));
        if (config._access?.role === 'MANAGER' && user?.id !== config._access.managerId) return;
        if (config._access?.role === 'ROP' && user?.groupId !== config._access.groupId) return;
        const sourceReadStartedAt = new Date();
        let lead = listedLead;
        let dealComplete = true, tasksComplete = true, notesComplete = true;
        try { lead = await client.get(`/leads/${listedLead.id}`); } catch { dealComplete = false; }
        // A deal may have moved while the source list was being paginated.
        const currentMatch = scopeByExternalId.get(String(lead.pipeline_id));
        if (!currentMatch) return;
        stage = currentMatch.pipeline.stages.find((item) => item.externalId === String(lead.status_id));
        if (!stage || !isWorkingStage(stage) || lead.is_deleted) return;
        const responsible = users.find((item) => item.externalId === String(lead.responsible_user_id));
        if (config._access?.role === 'MANAGER' && responsible?.id !== config._access.managerId) return;
        if (config._access?.role === 'ROP' && responsible?.groupId !== config._access.groupId) return;
        let taskRows: any[] = [], noteRows: any[] = [];
        const [tasksRead, notesRead, eventsRead] = await Promise.allSettled([
          client.paginate('/tasks', 'tasks', { 'filter[entity_type]': 'leads', 'filter[entity_id]': String(lead.id), 'filter[is_completed]': 0 }),
          client.paginate(`/leads/${lead.id}/notes`, 'notes'),
          client.paginate<any>('/events', 'events', { 'filter[entity]': 'lead', 'filter[entity_id][]': String(lead.id),
            'filter[type]': 'lead_status_changed', limit: 100 }),
        ]);
        if (tasksRead.status === 'fulfilled') taskRows = tasksRead.value; else tasksComplete = false;
        if (notesRead.status === 'fulfilled') noteRows = notesRead.value; else notesComplete = false;
        // Source identity stays stable even if the first audit precedes the local CRM sync.
        const dealId = `amo:${lead.id}`;
        let stageEnteredAt: Date | null = null;
        let stageEvent: any = null;
        if (eventsRead.status === 'fulfilled') {
          stageEvent = eventsRead.value.sort((a, b) => Number(b.created_at) - Number(a.created_at))[0] ?? null;
          const changedTo = stageEvent?.value_after?.[0]?.lead_status;
          if (String(changedTo?.id) === String(lead.status_id) && String(changedTo?.pipeline_id) === String(lead.pipeline_id)) {
            stageEnteredAt = timestamp(stageEvent.created_at);
          }
        }
        const messageEvidence = messageIndex.byDeal.get(String(lead.id)) ?? [];
        const proposalSources = await proposalCollector.collect(lead.custom_fields_values ?? [], proposalFieldId, messageEvidence);
        const browserSources = sourceBatch ? await sourceBatch.collectCurrent({ dealExternalId: String(lead.id),
          sourceUrl: `https://${client.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/leads/detail/${lead.id}` }) : null;
        await heartbeat();
        const documentAnalysis = this.documentAnalysis ? await this.documentAnalysis.collect(proposalSources, browserSources) : null;
        let finalLead: any = null;
        try {
          finalLead = await client.get(`/leads/${lead.id}`);
          if (['updated_at', 'status_id', 'pipeline_id', 'responsible_user_id', 'price'].some((key) => String(finalLead?.[key]) !== String(lead?.[key]))) dealComplete = false;
        } catch { dealComplete = false; }
        if (!finalLead) {
          // Later task/note data cannot be attributed to the old owner if the final ownership check failed.
          taskRows = []; noteRows = []; tasksComplete = false; notesComplete = false; stageEvent = null; stageEnteredAt = null;
        }
        if (finalLead && String(finalLead.responsible_user_id) !== String(lead.responsible_user_id)) {
          if (!issues.includes('Часть сделок сменила ответственного во время обхода; нужен повтор.')) issues.push('Часть сделок сменила ответственного во время обхода; нужен повтор.');
          return;
        }
        const finalStage = finalLead && pipelines.find((pipeline) => pipeline.externalId === String(finalLead.pipeline_id))?.stages.find((item) => item.externalId === String(finalLead.status_id));
        if (finalLead && (finalLead.is_deleted || (finalStage && !isWorkingStage(finalStage)))) return;
        const observedAt = new Date();
        if (localDay(observedAt) !== localDay(sourceStartedAt)) throw new ControlRunError('Обход пересёк полночь. Сохранена только выполненная часть; запустите новую проверку.');
        const input: CrmControlRuleInput = {
          deal: { id: dealId, externalId: String(lead.id), title: String(lead.name ?? ''), amount: Number(lead.price ?? 0),
            createdAt: timestamp(lead.created_at) ?? new Date(NaN), pipelineId: currentMatch.pipeline.id, stageId: stage.id,
            responsibleId: responsible?.id ?? null, customFields: lead.custom_fields_values ?? [], raw: lead },
          tasks: taskRows.map((task) => ({ id: `amo:${task.id}`, externalId: String(task.id), title: String(task.text ?? ''), typeId: task.task_type_id ?? null,
            dueAt: timestamp(task.complete_till), isCompleted: Boolean(task.is_completed), raw: task })),
          notes: noteRows.map((note) => ({ id: `amo:${note.id}`, externalId: String(note.id), type: String(note.note_type ?? ''), text: note.params?.text ?? null,
            createdAt: timestamp(note.created_at) ?? new Date(NaN), raw: note })),
          communications: finalLead ? messageEvidence.map(({ message }) => ({ id: message.messageId!, createdAt: message.occurredAt!,
            type: message.direction, text: message.text ?? '' })) : [],
          stageEnteredAt, observedAt, sourceCompleteness: { deal: dealComplete && Boolean(timestamp(lead.created_at)), tasks: tasksComplete, notes: notesComplete,
            stageHistory: Boolean(stageEnteredAt), communications: false }, config, scope: currentMatch.scope,
        };
        const results = evaluateCrmControlDeal(input);
        const snapshot = { ...input, config: undefined, scope: input.scope, sourceReadStartedAt, sourceReadFinishedAt: observedAt,
          currency: finalLead && browserSources?.accountCurrency?.status === 'VERIFIED' ? browserSources.accountCurrency.code : null,
          finalLead, stageEvent, historySource: 'amoCRM_event',
          proposalSources: finalLead ? proposalSources : null,
          browserSources: finalLead ? browserSources : null,
          documentAnalysis: finalLead ? documentAnalysis : null,
          communicationSources: finalLead ? { readAt: communicationReadAt, datasetReadComplete: sourceWindow?.datasetReadComplete ?? false,
            sourceCoverage: 'UNVERIFIED', messages: messageEvidence.map(({ message, bindingProof }) => ({ bindingProof,
              message: { ...message, attachments: message.attachments.map(({ url: _privateDownloadUrl, ...attachment }) => attachment) } })) } : null };
        const observation = await this.persistObservation(run.id, input, results, snapshot, {
          pipelineName: currentMatch.pipeline.name, stageName: stage.name,
          managerName: responsible?.name ?? (lead.responsible_user_id ? `Менеджер amoCRM #${lead.responsible_user_id}` : null),
          groupId: responsible?.groupId ?? null, groupName: responsible?.group?.name ?? null,
          dealUrl: `https://${client.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/leads/detail/${lead.id}`,
        }, run.startedAt!);
        observedDealIds.add(String(lead.id));
        addControlCounts(counts, observation.counts as unknown as CrmControlCounts);
        }));
        // Wait for all in-flight writers before releasing the lease or starting another attempt.
        const failure = collected.find((item): item is PromiseRejectedResult => item.status === 'rejected');
        await heartbeat();
        if (failure) throw failure.reason;
      }
      await heartbeat();
    });
    };
    if (this.browserSources && this.evidenceProvider.capabilities().screenshots) {
      let sourceActionFailed = false, sourceActionError: unknown;
      const browserResult = await this.browserSources.withBatch(async batch => {
        try { await collectOpenDeals(batch); }
        catch (error) { sourceActionFailed = true; sourceActionError = error; throw error; }
      });
      if (sourceActionFailed) throw sourceActionError;
      if (!browserResult.ok) {
        issues.push('Сборщик истории amoCRM недоступен. Проверки отправленных КП и договорённостей остались незавершёнными.');
        await collectOpenDeals();
      }
    } else await collectOpenDeals();
    // Previously observed cases are re-read even if the source's open-deal list no longer contains them.
    // A 404 is not evidence of correction: permissions and deletion must not erase a violation.
    let caseCursor: string | undefined;
    const reconciled = new Set<string>();
    while (true) {
      const active = await this.prisma.crmControlCase.findMany({ where: { activeKey: { not: null } }, orderBy: { id: 'asc' }, take: 200,
        ...(caseCursor ? { cursor: { id: caseCursor }, skip: 1 } : {}) });
      if (!active.length) break;
      caseCursor = active[active.length - 1].id;
      for (const item of active) {
        if (localDay(new Date()) !== localDay(sourceStartedAt)) throw new ControlRunError('Обход пересёк полночь. Сохранена только выполненная часть; запустите новую проверку.');
        if (reconciled.has(item.dealId)) continue;
        reconciled.add(item.dealId);
        const prior = await this.prisma.crmControlObservation.findUnique({ where: { id: item.latestObservationId } });
        if (!prior || observedDealIds.has(prior.dealExternalId) || !config.scopes.some((scope) => scope.pipelineId === prior.pipelineId)) continue;
        if (config._access && ((config._access.role === 'MANAGER' && prior.managerId !== config._access.managerId) || (config._access.role === 'ROP' && prior.groupId !== config._access.groupId))) continue;
        let current: any = null;
        try { current = await client.get(`/leads/${prior.dealExternalId}`); } catch { /* Keep historical cases open when the source is unavailable. */ }
        const currentResponsible = current ? users.find((user) => user.externalId === String(current.responsible_user_id)) : null;
        if (current && config._access && ((config._access.role === 'MANAGER' && currentResponsible?.id !== config._access.managerId)
          || (config._access.role === 'ROP' && currentResponsible?.groupId !== config._access.groupId))) continue;
        const pipeline = pipelines.find((candidate) => candidate.externalId === String(current?.pipeline_id));
        const stage = pipeline?.stages.find((candidate) => candidate.externalId === String(current?.status_id));
        const closed = Boolean(current && stage && (stage.isWon || stage.isLost));
        // Moving into an intake system bucket is outside this audit, not proof of correction.
        if (current && stage && !isWorkingStage(stage) && !closed) continue;
        const scope = config.scopes.find((scope) => scope.pipelineId === prior.pipelineId)!;
        const observedAt = new Date();
        if (localDay(observedAt) !== localDay(sourceStartedAt)) throw new ControlRunError('Обход пересёк полночь. Сохранена только выполненная часть; запустите новую проверку.');
        const openCases = await this.prisma.crmControlCase.findMany({ where: { dealId: item.dealId, activeKey: { not: null } } });
        const results: CrmControlRuleResult[] = openCases.map((openCase) => {
          const definition = CRM_CONTROL_RULE_CATALOG.find((rule) => rule.code === openCase.ruleCode);
          return { ruleCode: openCase.ruleCode, ruleName: definition?.name ?? openCase.ruleCode, subjectId: openCase.subjectId || undefined,
            clauses: definition?.clauses ?? [], status: closed ? 'NA' : 'UNKNOWN',
            message: closed ? 'Сделка закрыта в amoCRM. Проверка открытой сделки больше не применяется; прежнее нарушение сохранено в истории.'
              : 'Сделка отсутствует в текущей выборке. Устранение нарушения не подтверждено.',
            details: { ...(closed ? { resolvesPrior: true } : {}), sourceState: closed ? 'CLOSED' : 'UNAVAILABLE', statusId: current?.status_id ?? null } };
        });
        const raw = current ?? ((prior.snapshot as any)?.deal?.raw ?? {});
        const input: CrmControlRuleInput = { deal: { id: prior.dealId, externalId: prior.dealExternalId, title: current?.name ?? prior.dealTitle,
          amount: Number(current?.price ?? 0), createdAt: timestamp(current?.created_at) ?? new Date(NaN), pipelineId: pipeline?.id ?? prior.pipelineId,
          stageId: stage?.id ?? prior.stageId, responsibleId: current ? currentResponsible?.id ?? null : prior.managerId, customFields: current?.custom_fields_values ?? [], raw },
          tasks: [], notes: [], stageEnteredAt: null, observedAt, config, scope,
          sourceCompleteness: { deal: Boolean(current), tasks: false, notes: false, stageHistory: false, communications: false } };
        const observation = await this.persistObservation(run.id, input, results, { ...input, config: undefined, reconciliation: true, sourceReadFinishedAt: observedAt },
          { pipelineName: pipeline?.name ?? prior.pipelineName, stageName: stage?.name ?? prior.stageName,
            managerName: current ? currentResponsible?.name ?? null : prior.managerName,
            groupId: current ? currentResponsible?.groupId ?? null : prior.groupId,
            groupName: current ? currentResponsible?.group?.name ?? null : prior.groupName, dealUrl: prior.dealUrl }, run.startedAt!);
        addControlCounts(counts, observation.counts as unknown as CrmControlCounts);
        await heartbeat();
      }
    }
    if (!counts.deals) issues.push('В выбранной области нет открытых сделок. Это не подтверждение соблюдения всех правил.');
    await this.prisma.crmControlRun.updateMany({ where: lease, data: {
      status: issues.length || counts.unknown > 0 || counts.review > 0 ? 'PARTIAL' : 'COMPLETED', counts: json({ ...counts, executionAttempts: runAttempts(run) }), issues: json(issues),
      activeKey: null, sourceSyncAt: sourceStartedAt, finishedAt: new Date(), heartbeatAt: new Date(),
    } });
  }

  private async persistObservation(runId: string, input: CrmControlRuleInput, results: CrmControlRuleResult[], snapshot: unknown,
    meta: { pipelineName: string; stageName: string; managerName: string | null; groupId: string | null; groupName: string | null; dealUrl: string }, leaseStartedAt: Date) {
    const snapshotJson = json(snapshot);
    const observationId = randomUUID(), snapshotHash = createHash('sha256').update(JSON.stringify(snapshotJson)).digest('hex');
    const offerRule = (result: CrmControlRuleResult) => result.status !== 'NA' && ['offer_budget', 'proposal_file'].includes(result.ruleCode);
    // File reads and deterministic interpretation happen before DB locks. Reconciliation records preserve their original NA/UNKNOWN semantics.
    if (!(snapshotJson as any)?.reconciliation && results.some(offerRule)) {
      if (!input.deal.responsibleId) {
        results = results.map(result => offerRule(result) ? { ...result, status: 'UNKNOWN',
          message: 'Ответственный за сделку не подтверждён; документы не сравнивались.',
          details: { ...result.details, verificationMethod: 'ARCHIVED_OFFER_V1', offerAnalysis: { version: 1, historyStatus: 'UNVERIFIED',
            issues: ['DEAL_OWNER_UNVERIFIED'], reasons: ['Ответственный за сделку не подтверждён; документы не сравнивались.'], inspectedDocuments: 0, candidates: [], evidence: [] } } } : result);
      } else {
        const assessment = await assessArchivedOffer({ scope: { dealId: input.deal.id, ownerId: input.deal.responsibleId,
          observationId, snapshotHash }, snapshot: snapshotJson }, this.documentAnalysis);
        results = results.map(result => {
          if (!offerRule(result)) return result;
          const key = result.ruleCode === 'offer_budget' ? 'offerBudget' : 'proposalFile';
          const rule = assessment.validation[key];
          return { ...result, status: rule.status, message: assessment.messages[result.ruleCode as 'offer_budget' | 'proposal_file'],
            details: { ...result.details, ...rule.details, verificationMethod: 'ARCHIVED_OFFER_V1',
              offerAnalysis: { ...assessment.details, issues: [...new Set([...assessment.details.issues, ...rule.issues])], evidence: rule.evidence } } };
        });
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const lease = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "CrmControlRun" WHERE "id" = ${runId} AND "status" = 'RUNNING' AND "activeKey" = 'global' AND "startedAt" = ${leaseStartedAt} FOR UPDATE`;
      if (!lease.length) throw new ControlRunError('Проверка больше не выполняется.');
      await tx.$queryRaw`SELECT "id" FROM "CrmControlCase" WHERE "dealId" = ${input.deal.id} FOR UPDATE`;
      const existing = await tx.crmControlObservation.findUnique({ where: { runId_dealId: { runId, dealId: input.deal.id } } });
      if (existing) return existing;
      const observation = await tx.crmControlObservation.create({ data: { id: observationId, runId, dealId: input.deal.id, dealExternalId: input.deal.externalId,
        dealTitle: input.deal.title, dealUrl: meta.dealUrl, managerId: input.deal.responsibleId, managerName: meta.managerName, groupId: meta.groupId,
        groupName: meta.groupName, department: input.scope.department, pipelineId: input.deal.pipelineId, pipelineName: meta.pipelineName,
        stageId: input.deal.stageId, stageName: meta.stageName, observedAt: input.observedAt, snapshot: snapshotJson,
        snapshotHash, counts: json(observationCounts(results)) } });
      for (const result of results) {
        const activeKey = `${input.deal.id}:${result.ruleCode}:${result.subjectId ?? ''}`;
        let previous = await tx.crmControlCase.findUnique({ where: { activeKey } });
        const assessmentHash = this.assessmentHash(input, result);
        if (previous && (previous.confirmedAt || previous.status === 'EXEMPTED') && ['FAIL', 'REVIEW'].includes(result.status) && previous.assessmentHash !== assessmentHash) {
          await tx.crmControlCase.update({ where: { id: previous.id }, data: { status: 'SUPERSEDED', activeKey: null } });
          previous = null;
        }
        const state = nextControlCaseState(previous, result, input.observedAt);
        let caseId = previous?.id ?? null;
        if (state) {
          const item = await tx.crmControlCase.upsert({ where: { activeKey }, create: { caseKey: `${activeKey}:${observation.id}`, activeKey, assessmentHash, dealId: input.deal.id,
            ruleCode: result.ruleCode, subjectId: result.subjectId ?? '', status: state, firstDetectedAt: input.observedAt,
            lastDetectedAt: input.observedAt, latestObservationId: observation.id },
            update: { status: state, assessmentHash, latestObservationId: observation.id,
              ...(state === 'RESOLVED' ? { activeKey: null, resolvedAt: previous?.resolvedAt ?? input.observedAt } : { lastDetectedAt: input.observedAt, resolvedAt: null }) } });
          caseId = item.id;
        }
        await tx.crmControlResult.create({ data: { observationId: observation.id, ruleCode: result.ruleCode, ruleName: result.ruleName,
          subjectId: result.subjectId ?? '', status: result.status, message: result.message, clauses: json(result.clauses), details: json(result.details ?? {}), caseId } });
      }
      if (input.sourceCompleteness.tasks && input.sourceCompleteness.deal) {
        const activeIds = input.tasks.filter((task) => !task.isCompleted).map((task) => task.externalId || task.id);
        await tx.crmControlCase.updateMany({ where: { dealId: input.deal.id, ruleCode: { in: ['task_deadline', 'task_type', 'task_text', 'task_stage_deadline'] },
          subjectId: { not: '', notIn: activeIds }, status: { not: 'RESOLVED' } },
          data: { status: 'RESOLVED', activeKey: null, resolvedAt: input.observedAt, latestObservationId: observation.id } });
      }
      // An explicit unlimited policy does not depend on receiving every current task.
      if (input.sourceCompleteness.deal && results.some((result) => result.ruleCode === 'task_stage_deadline' && result.status === 'NA' && result.details?.resolvesAllSubjects === true)) {
        await tx.crmControlCase.updateMany({ where: { dealId: input.deal.id, ruleCode: 'task_stage_deadline', activeKey: { not: null } },
          data: { status: 'RESOLVED', activeKey: null, resolvedAt: input.observedAt, latestObservationId: observation.id } });
      }
      if (results.some((result) => result.status === 'FAIL' || result.status === 'REVIEW')) {
        const capture = this.evidenceProvider.capabilities();
        await tx.crmControlEvidence.create({ data: { observationId: observation.id, status: capture.screenshots ? 'PENDING' : 'DISABLED',
          sourceUrl: meta.dealUrl, error: capture.screenshots ? null : capture.message ?? 'Снимки amoCRM не подключены' } });
      }
      return observation;
    }, { timeout: 30_000 });
  }

  private assessmentHash(input: CrmControlRuleInput, result: CrmControlRuleResult) {
    const { elapsedHours, dueToday, overdue, ...details } = result.details ?? {};
    const noteIds = Array.isArray(details.noteIds) ? details.noteIds : [];
    const facts = { ruleCode: result.ruleCode, details, stageId: input.deal.stageId, scope: input.scope,
      agePolicy: input.config.maxDealAge,
      notes: input.notes.filter((note) => noteIds.includes(note.externalId || note.id)).map((note) => ({ id: note.externalId, type: note.type, text: note.text, raw: note.raw })) };
    return createHash('sha256').update(JSON.stringify(json(facts))).digest('hex');
  }

  async processEvidenceQueue() {
    const now = new Date();
    await this.prisma.crmControlEvidence.updateMany({ where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 10 * 60_000) } },
      data: { status: 'ERROR', nextAttemptAt: now, error: 'Сбор подтверждения прерван. После трёх попыток доступен ручной повтор.' } });
    const job = await this.prisma.crmControlEvidence.findFirst({ where: { OR: [
      { status: 'PENDING', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: 'ERROR', attempts: { lt: 3 }, nextAttemptAt: { lte: now } },
    ] }, orderBy: { createdAt: 'asc' },
      include: { observation: { select: { dealExternalId: true, dealTitle: true, managerId: true, groupId: true,
        observedAt: true, snapshotHash: true, snapshot: true, results: { select: { id: true, ruleCode: true, subjectId: true, status: true, details: true } } } } } });
    if (!job) return;
    const claimedAt = new Date();
    const attempt = job.attempts + 1;
    const claim = await this.prisma.crmControlEvidence.updateMany({ where: { id: job.id, status: job.status, attempts: job.attempts },
      data: { status: 'RUNNING', startedAt: claimedAt, nextAttemptAt: null, attempts: { increment: 1 } } });
    if (claim.count !== 1) return;
    const lease = { id: job.id, status: 'RUNNING', startedAt: claimedAt, attempts: attempt };
    const retryAt = () => attempt < 3 ? new Date(Date.now() + 30_000 * 2 ** (attempt - 1)) : null;
    try {
      // A delayed screenshot is current CRM data: never attach another manager's card to old evidence.
      if (!await this.captureOwnerMatches(job.observation, job.sourceUrl)) {
        await this.prisma.crmControlEvidence.updateMany({ where: lease, data: { status: 'ERROR', nextAttemptAt: null,
          error: 'Ответственный или группа изменились. Новый снимок нельзя прикрепить к прежней проверке.' } });
        return;
      }
      const capture = await this.evidenceProvider.capture({ dealExternalId: job.observation.dealExternalId, dealTitle: job.observation.dealTitle,
        sourceUrl: job.sourceUrl, observationId: job.observationId, observedAt: job.observation.observedAt,
        snapshotHash: job.observation.snapshotHash, snapshot: job.observation.snapshot, results: job.observation.results });
      await this.persistEvidenceHealth();
      if (capture.status === 'READY' && !await this.captureOwnerMatches(job.observation, job.sourceUrl)) {
        await this.prisma.crmControlEvidence.updateMany({ where: lease, data: { status: 'ERROR', nextAttemptAt: null,
          error: 'Ответственный или группа изменились во время съёмки. Снимок не прикреплён.' } });
        return;
      }
      await this.prisma.crmControlEvidence.updateMany({ where: lease, data: { status: capture.status, storageKey: capture.storageKey,
        contentType: capture.mimeType, sha256: capture.sha256, capturedAt: capture.capturedAt,
        nextAttemptAt: capture.status === 'ERROR' && capture.retryable !== false ? retryAt() : null,
        coverage: capture.status === 'READY' ? capture.message : null, error: capture.status === 'READY' ? null : capture.message } });
    } catch { await this.prisma.crmControlEvidence.updateMany({ where: lease,
      data: { status: 'ERROR', nextAttemptAt: retryAt(), error: 'Не удалось проверить доступ к текущей карточке или сохранить снимок amoCRM' } }); }
  }

  private async captureOwnerMatches(observation: { dealExternalId: string; managerId: string | null; groupId: string | null }, sourceUrl: string) {
    if (!observation.managerId) return false;
    const [manager, group, connection] = await Promise.all([
      this.prisma.crmUser.findUnique({ where: { id: observation.managerId }, select: { externalId: true } }),
      observation.groupId ? this.prisma.crmGroup.findUnique({ where: { id: observation.groupId }, select: { externalId: true } }) : null,
      this.amo.getActiveConnectionOrFail(),
    ]);
    if (!manager || (observation.groupId && !group)) return false;
    const client = await this.amo.getClient(connection);
    if (new URL(sourceUrl).hostname !== client.domain) return false;
    const lead = await client.get<any>(`/leads/${encodeURIComponent(observation.dealExternalId)}`);
    if (String(lead?.id) !== observation.dealExternalId || String(lead?.responsible_user_id) !== manager.externalId) return false;
    const user = await client.get<any>(`/users/${encodeURIComponent(manager.externalId)}`);
    if (String(user?.id) !== manager.externalId || !Object.prototype.hasOwnProperty.call(user?.rights ?? {}, 'group_id')) {
      throw new Error('Current source owner could not be verified');
    }
    const currentGroup = user.rights.group_id == null ? null : String(user.rights.group_id);
    return currentGroup === (group?.externalId ?? null);
  }
}
