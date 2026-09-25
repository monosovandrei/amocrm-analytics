import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AlertOperator,
  DeliveryStatus,
  PlanPeriodType,
  PlanTargetType,
  PlatformBusinessRole,
  Prisma,
  QualityRule,
  QualitySeverity,
  ReportScheduleFrequency,
  UserRole,
} from '../generated/prisma';
import { AuthUser } from '../auth/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { isMoscowBusinessDay, moscowDate, moscowParts } from '../common/date.util';
import { FactMartsService } from '../facts/fact-marts.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { TelegramService } from './telegram.service';
import { CrmEventNotificationsService } from './crm-event-notifications.service';
import {
  isRealAmoExternalId,
  ROP_DEFAULT_STAGE_SLA_DAYS,
  ROP_DEPARTMENTS,
  resolveDefaultRopStageSla,
  ropDepartmentKeyFromInput,
  RopDepartmentKey,
} from './rop-stage-sla';

type PlanFactTeamKey = 'sales' | 'csm';
type TeamFunnelDefinition = NonNullable<Awaited<ReturnType<ReportsService['getTeamFunnelDefinition']>>>;
type ActualShipping = Awaited<ReturnType<ReportsService['getActualShipping']>>;
// Aliases only: the report owns stage selection, attribution and counting rules.
const PLAN_FACT_REPORT_METRICS: Record<PlanFactTeamKey, Record<string, string>> = {
  sales: {
    sales_qualified_leads: 'leads_received',
    sales_kp_count: 'kp_presented',
    sales_conv_kp_to_invoice: 'conv_kp_presented_to_invoice',
    sales_invoice_count: 'invoice_sent',
    sales_conv_invoice_to_paid: 'conv_invoice_to_paid',
    sales_paid_count: 'paid',
    sales_paid_amount: 'payment_amount',
  },
  csm: {
    csm_taken_to_work_count: 'taken_to_work',
    csm_conv_work_to_kp: 'conv_work_to_offer',
    csm_kp_count: 'offer_made',
    csm_conv_kp_to_invoice: 'conv_offer_to_invoice',
    csm_invoice_count: 'invoice_sent',
    csm_conv_invoice_to_paid: 'conv_invoice_to_paid',
    csm_paid_count: 'paid',
    csm_paid_amount: 'paid_amount',
  },
};
type PlanFactMetricUnit = 'number' | 'money' | 'percent';
type PlanFactMetric = {
  key: string;
  label: string;
  unit: PlanFactMetricUnit;
  team: PlanFactTeamKey;
  kind: 'additive' | 'conversion';
};

type TelegramDeliveryMode = 'system' | 'direct_responsible' | 'selected' | 'group' | 'all_connected' | 'disabled';

const TELEGRAM_DELIVERY_MODE_KIND = 'delivery_mode';
const TELEGRAM_DELIVERY_MODES: TelegramDeliveryMode[] = [
  'system',
  'direct_responsible',
  'selected',
  'group',
  'all_connected',
  'disabled',
];
const PERSONAL_TELEGRAM_EVENTS = new Set(['amo_new_assigned_lead', 'amo_assigned_lead_10m', 'amo_take_to_work_enabled']);
const OBSOLETE_TELEGRAM_TEMPLATE_EVENT_TYPES = ['amo_loss_without_reason'];

type EmailDirection = 'incoming' | 'outgoing';
type EmailPipelineKey = 'sales' | 'base' | 'assignedCompanies';

type EmailMessageItem = {
  id: string;
  noteExternalId?: string | null;
  direction: EmailDirection;
  createdAt: Date;
  subject: string | null;
  summary: string | null;
  body: string | null;
  from: string | null;
  to: string | null;
  attachCount: number;
  deliveryStatus: string | null;
  source: 'note' | 'event';
};

type EmailMessageParams = {
  income: boolean | null;
  threadId: string | null;
  subject: string | null;
  summary: string | null;
  body: string | null;
  from: string | null;
  fromEmail: string | null;
  to: string | null;
  toEmail: string | null;
  attachCount: number;
  deliveryStatus: string | null;
};

type EmailThreadDraft = {
  deal: {
    id: string;
    externalId: string;
    title: string;
    amount: unknown;
    contactId: string | null;
    pipeline: { name: string } | null;
    stage: { name: string } | null;
    responsible: { name: string; externalId: string | null; group: { name: string } | null } | null;
    contact: { externalId: string; name: string; email: string | null } | null;
    contactExternalIds?: string[];
  };
  threadId: string;
  messages: EmailMessageItem[];
};

type EmailThreadStateView = {
  dealId: string;
  threadId: string;
  lastIncomingNoteExternalId: string | null;
  lastIncomingAt: Date | null;
  subject: string | null;
  summary: string | null;
  attachCount: number;
  messages: Prisma.JsonValue;
  deal: EmailThreadDraft['deal'];
};

type RopActionPriority = 'critical' | 'warning' | 'info';
type RopActionType =
  | 'offer_touch'
  | 'pending_email'
  | 'overdue_task'
  | 'no_next_step'
  | 'stuck_deal'
  | 'crm_issue'
  | 'risk_deal';
type RopPeriodPreset = 'today' | 'yesterday' | 'this_week' | 'this_month';

type RopDashboardV2Query = {
  department?: string | string[];
  departments?: string | string[];
  groupId?: string | string[];
  groupIds?: string | string[];
  managerId?: string | string[];
  managerIds?: string | string[];
  pipelineId?: string | string[];
  stageId?: string | string[];
  stageIds?: string | string[];
  periodPreset?: string | string[];
};

type RopSelectedFilters = {
  departments: Set<RopDepartmentKey>;
  groupIds: Set<string>;
  managerIds: Set<string>;
  pipelineId: string | null;
  stageIds: Set<string>;
  periodPreset: RopPeriodPreset;
};

type RopManagerAccumulator = {
  departmentKey: RopDepartmentKey;
  departmentLabel: string;
  managerId: string;
  managerName: string;
  groupId: string;
  groupName: string;
  openDeals: number;
  openAmount: number;
  tasksTodayTotal: number;
  tasksTodayDone: number;
  overdueTasks: number;
  taskReschedules: number;
  noNextStep: number;
  offerTouches: number;
  pendingEmails: number;
  stuckDeals: number;
  crmIssues: number;
  riskDealIds: Set<string>;
};

type RopActionQueueItem = {
  id: string;
  type: RopActionType;
  priority: RopActionPriority;
  title: string;
  reason: string;
  departmentKey: RopDepartmentKey;
  departmentLabel: string;
  managerId: string;
  managerName: string;
  groupId: string;
  groupName: string;
  dealId: string;
  dealExternalId: string;
  dealTitle: string;
  dealUrl: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  amount: number;
  ageHours: number | null;
  ageDays?: number;
  slaDays?: number;
  taskId?: string;
  threadId?: string;
  ruleCode?: string;
  detectedAt: Date;
};

type RopManagerMeta = {
  departmentKey: RopDepartmentKey;
  departmentLabel: string;
  managerId: string;
  managerName: string;
  managerExternalId: string;
  groupId: string;
  groupName: string;
  groupExternalId: string;
};

type RopDealRef = RopManagerMeta & {
  dealId: string;
  dealExternalId: string;
  dealTitle: string;
  dealUrl: string;
  amount: number;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
};

type RopStageSlaRuleConfig = {
  isEnabled: boolean;
  slaDays: number | null;
  reason: string | null;
};

const EMAIL_THREAD_CREATE_BATCH_SIZE = 100;
const EMAIL_THREAD_SOURCE_LOOKUP_BATCH_SIZE = 100;
const EMAIL_EVENT_SCAN_BATCH_SIZE = 100;
const EMAIL_THREAD_DRAFT_MESSAGE_LIMIT = 12;
const EMAIL_THREAD_STATE_MESSAGE_LIMIT = 8;
const EMAIL_THREAD_SUBJECT_LIMIT = 500;
const EMAIL_THREAD_SUMMARY_LIMIT = 500;
const EMAIL_THREAD_BODY_LIMIT = 1200;
const EMAIL_THREAD_PARTY_LIMIT = 500;

const EMAIL_PIPELINE_GROUPS: Array<{ key: EmailPipelineKey; label: string }> = [
  { key: 'sales', label: 'Продажи' },
  { key: 'base', label: 'База' },
  { key: 'assignedCompanies', label: 'Закреплённые компании' },
];
const BASE_EMAIL_STAGE_NAMES = new Set([
  'взят в работу',
  'квалифицирован',
  'цена запрошена',
  'сделано предложение',
  'счет отправлен',
]);

const ROP_ACTION_LIMIT = 200;
const ROP_TOP_DEALS_LIMIT = 5;
const ROP_IGNORED_QUALITY_RULE_CODES = new Set(['open_deal_without_task']);

const PLAN_FACT_METRICS: PlanFactMetric[] = [
  { key: 'sales_qualified_leads', label: 'Квал лиды', unit: 'number', team: 'sales', kind: 'additive' },
  { key: 'sales_conv_lead_to_kp', label: 'Конверсия лиды -> КП', unit: 'percent', team: 'sales', kind: 'conversion' },
  { key: 'sales_kp_count', label: 'КП', unit: 'number', team: 'sales', kind: 'additive' },
  { key: 'sales_conv_kp_to_invoice', label: 'Конверсия КП -> счёт', unit: 'percent', team: 'sales', kind: 'conversion' },
  { key: 'sales_invoice_count', label: 'Счета', unit: 'number', team: 'sales', kind: 'additive' },
  { key: 'sales_conv_invoice_to_paid', label: 'Конверсия счёт -> оплата', unit: 'percent', team: 'sales', kind: 'conversion' },
  { key: 'sales_paid_count', label: 'Оплаты', unit: 'number', team: 'sales', kind: 'additive' },
  { key: 'sales_paid_amount', label: 'Сумма оплат', unit: 'money', team: 'sales', kind: 'additive' },
  { key: 'sales_shipped_count', label: 'Отгрузки', unit: 'number', team: 'sales', kind: 'additive' },
  { key: 'sales_shipped_amount', label: 'Сумма отгрузок', unit: 'money', team: 'sales', kind: 'additive' },
  { key: 'csm_taken_to_work_count', label: 'Взяты в работу', unit: 'number', team: 'csm', kind: 'additive' },
  { key: 'csm_conv_work_to_kp', label: 'Конверсия в работу -> КП', unit: 'percent', team: 'csm', kind: 'conversion' },
  { key: 'csm_kp_count', label: 'КП', unit: 'number', team: 'csm', kind: 'additive' },
  { key: 'csm_conv_kp_to_invoice', label: 'Конверсия КП -> счёт', unit: 'percent', team: 'csm', kind: 'conversion' },
  { key: 'csm_invoice_count', label: 'Счета', unit: 'number', team: 'csm', kind: 'additive' },
  { key: 'csm_conv_invoice_to_paid', label: 'Конверсия счёт -> оплата', unit: 'percent', team: 'csm', kind: 'conversion' },
  { key: 'csm_paid_count', label: 'Оплаты', unit: 'number', team: 'csm', kind: 'additive' },
  { key: 'csm_paid_amount', label: 'Сумма оплат', unit: 'money', team: 'csm', kind: 'additive' },
  { key: 'csm_shipped_count', label: 'Отгрузки', unit: 'number', team: 'csm', kind: 'additive' },
  { key: 'csm_shipped_amount', label: 'Сумма отгрузок', unit: 'money', team: 'csm', kind: 'additive' },
];

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
    private readonly crmEventNotifications: CrmEventNotificationsService,
    private readonly facts: FactMartsService,
  ) {}

  async overview(user: AuthUser) {
    const alertWhere = user.role === 'ADMIN' ? {} : { userId: user.id };
    const scheduleWhere = user.role === 'ADMIN' ? {} : { userId: user.id };
    const [telegramStatus, alertsCount, activePlan, openViolations, schedulesCount, deliveries] = await Promise.all([
      this.telegram.status(user.id),
      this.prisma.alertRule.count({ where: alertWhere }),
      this.prisma.planSet.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.qualityViolation.count({ where: { resolvedAt: null } }),
      this.prisma.reportSchedule.count({ where: scheduleWhere }),
      this.prisma.notificationDelivery.findMany({
        where: user.role === 'ADMIN' ? {} : { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);

    return {
      telegram: telegramStatus,
      alertsCount,
      activePlan,
      openViolations,
      schedulesCount,
      deliveries,
    };
  }

  async ropDashboard(actor: AuthUser) {
    return this.ropDashboardV2(actor, {});
  }

  async ropDashboardV2(actor: AuthUser, query: RopDashboardV2Query = {}) {
    this.ensureEmailThreadAccess(actor);

    const now = new Date();
    const filters = this.parseRopDashboardV2Query(query);
    const period = this.resolveRopPeriod(filters.periodPreset, now);
    const [domain, crmUsers] = await Promise.all([
      this.resolveAmoDomain(),
      this.prisma.crmUser.findMany({
        where: { isActive: true, isVisible: true },
        orderBy: [{ group: { name: 'asc' } }, { name: 'asc' }],
        select: {
          id: true,
          externalId: true,
          name: true,
          groupId: true,
          group: { select: { id: true, externalId: true, name: true } },
        },
      }),
    ]);

    const allManagers = crmUsers
      .map((user): RopManagerMeta | null => {
        const department = this.ropDepartmentFromGroupName(user.group?.name);
        if (!department || !user.groupId || !user.group?.name) return null;
        if (!isRealAmoExternalId(user.externalId) || !isRealAmoExternalId(user.group?.externalId)) return null;
        return {
          departmentKey: department.key,
          departmentLabel: department.label,
          managerId: user.id,
          managerExternalId: user.externalId,
          managerName: user.name,
          groupId: user.groupId,
          groupExternalId: user.group.externalId,
          groupName: user.group.name,
        };
      })
      .filter((manager): manager is RopManagerMeta => Boolean(manager));

    const managerById = new Map(allManagers.map((manager) => [manager.managerId, manager]));
    const activeManagerIds = [...managerById.keys()];
    const selectedManagers = allManagers.filter((manager) => this.ropManagerMatchesFilters(manager, filters));
    const selectedManagerIds = new Set(selectedManagers.map((manager) => manager.managerId));

    const [allOpenDeals, taskRows, pendingEmailStates, qualityViolations, stageSlaRules, taskDeadlineEvents] = await Promise.all([
      this.prisma.deal.findMany({
        where: {
          deletedAt: null,
          responsibleId: { in: activeManagerIds },
          pipeline: { isArchived: false },
          stage: { isWon: false, isLost: false, isVisible: true },
        },
        select: {
          id: true,
          externalId: true,
          title: true,
          amount: true,
          createdAt: true,
          updatedAt: true,
          responsibleId: true,
          pipeline: { select: { id: true, name: true } },
          stage: { select: { id: true, name: true, position: true } },
        },
      }),
      this.prisma.task.findMany({
        where: {
          AND: [
            {
              OR: [
                { dueAt: { gte: period.startAt, lt: period.endAt } },
                { completedAt: { gte: period.startAt, lt: period.endAt } },
                { isCompleted: false },
              ],
            },
            {
              OR: [
                { responsibleId: { in: activeManagerIds } },
                { deal: { responsibleId: { in: activeManagerIds } } },
              ],
            },
          ],
        },
        select: {
          id: true,
          externalId: true,
          title: true,
          dueAt: true,
          completedAt: true,
          isCompleted: true,
          deal: {
            select: {
              id: true,
              externalId: true,
              title: true,
              amount: true,
              responsibleId: true,
              pipeline: { select: { id: true, name: true } },
              stage: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.emailThreadState.findMany({
        where: {
          isPending: true,
          lastIncomingAt: { not: null },
          lastIncomingNoteExternalId: { not: null },
          deal: {
            deletedAt: null,
            responsibleId: { in: activeManagerIds },
            stage: { isWon: false, isLost: false },
          },
        },
        orderBy: { lastIncomingAt: 'asc' },
        select: {
          dealId: true,
          threadId: true,
          lastIncomingNoteExternalId: true,
          lastIncomingAt: true,
          subject: true,
          summary: true,
          attachCount: true,
          messages: true,
          deal: {
            select: {
              id: true,
              externalId: true,
              title: true,
              amount: true,
              contactId: true,
              responsibleId: true,
              pipeline: { select: { id: true, name: true } },
              stage: { select: { id: true, name: true } },
              responsible: {
                select: {
                  id: true,
                  name: true,
                  externalId: true,
                  groupId: true,
                  group: { select: { id: true, name: true } },
                },
              },
              contact: { select: { externalId: true, name: true, email: true } },
            },
          },
        },
      }),
      this.prisma.qualityViolation.findMany({
        where: { resolvedAt: null },
        select: {
          id: true,
          managerId: true,
          dealId: true,
          taskId: true,
          severity: true,
          message: true,
          detectedAt: true,
          rule: { select: { code: true, name: true } },
        },
      }),
      this.prisma.ropStageSlaRule.findMany({
        select: {
          departmentKey: true,
          stageId: true,
          isEnabled: true,
          slaDays: true,
          reason: true,
        },
      }),
      this.prisma.crmEvent.findMany({
        where: {
          type: 'task_deadline_changed',
          createdAt: { gte: period.startAt, lt: period.endAt },
        },
        select: {
          externalId: true,
          raw: true,
          createdAt: true,
        },
      }),
    ]);
    const stageSlaRuleMap = new Map(
      stageSlaRules.map((rule) => [this.ropStageSlaKey(rule.departmentKey, rule.stageId), {
        isEnabled: rule.isEnabled,
        slaDays: rule.slaDays,
        reason: rule.reason,
      }]),
    );

    const managerScopedDeals = allOpenDeals.filter((deal) => selectedManagerIds.has(deal.responsibleId ?? ''));
    const selectedPipelineCandidates = new Set(managerScopedDeals.map((deal) => deal.pipeline.id));
    const scopedDeals = managerScopedDeals.filter((deal) => {
      if (filters.pipelineId && deal.pipeline.id !== filters.pipelineId) return false;
      if (filters.stageIds.size && !filters.stageIds.has(deal.stage.id)) return false;
      return true;
    });
    const scopedDealIds = new Set(scopedDeals.map((deal) => deal.id));
    const stageHistory = scopedDeals.length
      ? await this.prisma.dealStageHistory.findMany({
        where: { dealId: { in: scopedDeals.map((deal) => deal.id) } },
        orderBy: { movedAt: 'desc' },
        select: { dealId: true, toStageId: true, movedAt: true },
      })
      : [];
    const [todayTouchNotes, todayTouchEvents] = scopedDeals.length
      ? await Promise.all([
        this.prisma.note.findMany({
          where: {
            dealId: { in: scopedDeals.map((deal) => deal.id) },
            createdAt: { gte: period.startAt, lt: period.endAt },
          },
          select: { dealId: true, type: true, raw: true },
        }),
        this.prisma.crmEvent.findMany({
          where: {
            dealId: { in: scopedDeals.map((deal) => deal.id) },
            createdAt: { gte: period.startAt, lt: period.endAt },
            type: { in: ['outgoing_mail'] },
          },
          select: { dealId: true },
        }),
      ])
      : [[], []];

    const stageEntryByDealId = new Map<string, Date>();
    const currentStageByDealId = new Map(scopedDeals.map((deal) => [deal.id, deal.stage.id]));
    for (const item of stageHistory) {
      if (stageEntryByDealId.has(item.dealId)) continue;
      if (currentStageByDealId.get(item.dealId) === item.toStageId) {
        stageEntryByDealId.set(item.dealId, item.movedAt);
      }
    }

    const managerRows = new Map<string, RopManagerAccumulator>();
    for (const manager of selectedManagers) {
      managerRows.set(manager.managerId, {
        ...manager,
        openDeals: 0,
        openAmount: 0,
        tasksTodayTotal: 0,
        tasksTodayDone: 0,
        overdueTasks: 0,
        taskReschedules: 0,
        noNextStep: 0,
        offerTouches: 0,
        pendingEmails: 0,
        stuckDeals: 0,
        crmIssues: 0,
        riskDealIds: new Set<string>(),
      });
    }

    const queue: Record<Exclude<RopActionType, 'risk_deal'>, RopActionQueueItem[]> = {
      offer_touch: [],
      pending_email: [],
      overdue_task: [],
      no_next_step: [],
      stuck_deal: [],
      crm_issue: [],
    };
    const riskByDealId = new Map<string, { ref: RopDealRef; priority: RopActionPriority; reasons: string[]; detectedAt: Date }>();
    const dealRefsById = new Map<string, RopDealRef>();
    const stageMetaByDealId = new Map<string, {
      enteredAt: Date;
      ageDays: number;
      slaDays: number | null;
      slaApplies: boolean;
      reason: string;
      isStuck: boolean;
    }>();
    const pipelineStats = new Map<string, { id: string; name: string; openDeals: number; stuckDeals: number; stuckAmount: number }>();

    const addRisk = (ref: RopDealRef, priority: RopActionPriority, reason: string, detectedAt: Date) => {
      const row = managerRows.get(ref.managerId);
      row?.riskDealIds.add(ref.dealId);
      const existing = riskByDealId.get(ref.dealId);
      if (!existing) {
        riskByDealId.set(ref.dealId, { ref, priority, reasons: [reason], detectedAt });
        return;
      }
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      if (this.actionPriorityRank(priority) < this.actionPriorityRank(existing.priority)) existing.priority = priority;
      if (detectedAt < existing.detectedAt) existing.detectedAt = detectedAt;
    };

    for (const deal of scopedDeals) {
      const manager = managerById.get(deal.responsibleId ?? '');
      const row = deal.responsibleId ? managerRows.get(deal.responsibleId) : null;
      if (!manager || !row) continue;

      const amount = this.numberValue(deal.amount);
      const ref: RopDealRef = {
        ...manager,
        dealId: deal.id,
        dealExternalId: deal.externalId,
        dealTitle: deal.title,
        dealUrl: this.dealUrl(domain, deal.externalId),
        amount,
        pipelineId: deal.pipeline.id,
        pipelineName: deal.pipeline.name,
        stageId: deal.stage.id,
        stageName: deal.stage.name,
      };
      dealRefsById.set(deal.id, ref);

      row.openDeals += 1;
      row.openAmount += amount;

      const enteredAt = stageEntryByDealId.get(deal.id) ?? deal.updatedAt ?? deal.createdAt;
      const ageDays = this.ageDays(enteredAt, now);
      const sla = this.resolveRopStageSla(manager.departmentKey, deal.stage.id, deal.pipeline.name, deal.stage.name, stageSlaRuleMap);
      const isStuck = sla.days !== null && ageDays >= sla.days;
      stageMetaByDealId.set(deal.id, {
        enteredAt,
        ageDays,
        slaDays: sla.days,
        slaApplies: sla.days !== null,
        reason: sla.reason,
        isStuck,
      });

      const pipeline = pipelineStats.get(deal.pipeline.id) ?? {
        id: deal.pipeline.id,
        name: deal.pipeline.name,
        openDeals: 0,
        stuckDeals: 0,
        stuckAmount: 0,
      };
      pipeline.openDeals += 1;
      if (isStuck) {
        pipeline.stuckDeals += 1;
        pipeline.stuckAmount += amount;
      }
      pipelineStats.set(deal.pipeline.id, pipeline);

      if (!isStuck) continue;
      row.stuckDeals += 1;
      const slaDays = sla.days ?? ROP_DEFAULT_STAGE_SLA_DAYS;
      const priority: RopActionPriority = ageDays >= slaDays * 2 ? 'critical' : 'warning';
      const action: RopActionQueueItem = {
        ...ref,
        id: `stuck-deal:${deal.id}`,
        type: 'stuck_deal',
        priority,
        title: 'Зависшая сделка',
        reason: `${sla.reason} На этапе ${this.roundMetric(ageDays)} дн.`,
        ageHours: this.ageHours(enteredAt, now),
        ageDays: this.roundMetric(ageDays),
        slaDays,
        detectedAt: enteredAt,
      };
      queue.stuck_deal.push(action);
      addRisk(ref, priority, action.reason, enteredAt);
    }

    const openTaskByDealId = new Map<string, (typeof taskRows)[number]>();
    const openTaskDueInPeriodByDealId = new Map<string, (typeof taskRows)[number]>();
    const taskDealIdByExternalId = new Map<string, string>();
    const touchedDealIdsInPeriod = new Set<string>();
    for (const note of todayTouchNotes) {
      if (note.dealId && this.isRopTouchNote(note)) touchedDealIdsInPeriod.add(note.dealId);
    }
    for (const event of todayTouchEvents) {
      if (event.dealId) touchedDealIdsInPeriod.add(event.dealId);
    }
    for (const task of taskRows) {
      if (!task.deal?.id || !scopedDealIds.has(task.deal.id)) continue;
      if (task.externalId) taskDealIdByExternalId.set(task.externalId, task.deal.id);
      const ref = dealRefsById.get(task.deal.id);
      const row = ref ? managerRows.get(ref.managerId) : null;
      if (!ref || !row) continue;

      const dueAt = task.dueAt;
      const completedAt = task.completedAt;
      const dueInPeriod = Boolean(dueAt && dueAt >= period.startAt && dueAt < period.endAt);
      const completedInPeriod = Boolean(completedAt && completedAt >= period.startAt && completedAt < period.endAt);
      const overdue = Boolean(!task.isCompleted && dueAt && dueAt < now && dueAt < period.endAt);
      if (!task.isCompleted) {
        openTaskByDealId.set(task.deal.id, task);
        if (dueInPeriod && !openTaskDueInPeriodByDealId.has(task.deal.id)) {
          openTaskDueInPeriodByDealId.set(task.deal.id, task);
        }
      }

      if (dueInPeriod) {
        row.tasksTodayTotal += 1;
        if (task.isCompleted) row.tasksTodayDone += 1;
      }
      if (completedInPeriod) touchedDealIdsInPeriod.add(task.deal.id);
      if (!overdue || !dueAt) continue;

      row.overdueTasks += 1;
      const priority: RopActionPriority = dueAt < period.startAt ? 'critical' : 'warning';
      const action: RopActionQueueItem = {
        ...ref,
        id: `overdue-task:${task.id}`,
        type: 'overdue_task',
        priority,
        title: 'Просроченная задача',
        reason: task.title,
        taskId: task.id,
        ageHours: this.ageHours(dueAt, now),
        detectedAt: dueAt,
      };
      queue.overdue_task.push(action);
      addRisk(ref, priority, 'Просроченная задача', dueAt);
    }

    const managerByExternalId = new Map(selectedManagers.map((manager) => [manager.managerExternalId, manager]));
    const hasDealScopeFilter = Boolean(filters.pipelineId) || filters.stageIds.size > 0;
    for (const event of taskDeadlineEvents) {
      const manager = managerByExternalId.get(this.ropEventActorExternalId(event));
      if (!manager) continue;
      if (hasDealScopeFilter) {
        const taskExternalId = this.ropEventEntityId(event);
        const dealId = taskExternalId ? taskDealIdByExternalId.get(taskExternalId) : null;
        if (!dealId || !scopedDealIds.has(dealId)) continue;
      }
      const row = managerRows.get(manager.managerId);
      if (row) row.taskReschedules += 1;
    }

    for (const deal of scopedDeals) {
      const ref = dealRefsById.get(deal.id);
      const row = ref ? managerRows.get(ref.managerId) : null;
      const touchTask = openTaskDueInPeriodByDealId.get(deal.id);
      if (!ref || !row || !touchTask || touchedDealIdsInPeriod.has(deal.id)) continue;
      if (!this.isRopOfferSentStage(deal.stage.name)) continue;

      row.offerTouches += 1;
      const action: RopActionQueueItem = {
        ...ref,
        id: `offer-touch:${deal.id}:${touchTask.id}`,
        type: 'offer_touch',
        priority: 'warning',
        title: 'Нужно касание по отправленному офферу',
        reason: 'Оффер отправлен, задача на касание стоит на сегодня, завершенного касания сегодня нет.',
        taskId: touchTask.id,
        ageHours: touchTask.dueAt ? this.ageHours(touchTask.dueAt, now) : null,
        detectedAt: touchTask.dueAt ?? now,
      };
      queue.offer_touch.push(action);
      addRisk(ref, 'warning', 'Нужно касание после оффера в выбранном периоде', action.detectedAt);
    }

    for (const deal of scopedDeals) {
      if (openTaskByDealId.has(deal.id)) continue;
      const ref = dealRefsById.get(deal.id);
      const row = ref ? managerRows.get(ref.managerId) : null;
      if (!ref || !row) continue;

      row.noNextStep += 1;
      const action: RopActionQueueItem = {
        ...ref,
        id: `no-next-step:${deal.id}`,
        type: 'no_next_step',
        priority: 'critical',
        title: 'Нет следующего шага',
        reason: 'В открытой сделке нет незавершенной задачи. РОПу нужно добиться конкретного следующего действия.',
        ageHours: null,
        detectedAt: now,
      };
      queue.no_next_step.push(action);
      addRisk(ref, 'critical', 'В сделке нет следующего шага', now);
    }

    const pendingEmailThreads = await this.visiblePendingEmailThreadsFromStates(pendingEmailStates, now, domain);
    for (const { state, thread } of pendingEmailThreads) {
      if (!scopedDealIds.has(state.dealId)) continue;
      const ref = dealRefsById.get(state.dealId);
      const row = ref ? managerRows.get(ref.managerId) : null;
      if (!ref || !row) continue;

      row.pendingEmails += 1;
      const priority: RopActionPriority = thread.waitingSeconds >= 24 * 60 * 60 ? 'critical' : 'warning';
      const detectedAt = state.lastIncomingAt ?? now;
      const action: RopActionQueueItem = {
        ...ref,
        id: `pending-email:${thread.id}`,
        type: 'pending_email',
        priority,
        title: 'Письмо без ответа',
        reason: thread.subject || thread.summary || 'Есть входящее письмо без исходящего ответа.',
        threadId: state.threadId,
        ageHours: this.roundMetric(thread.waitingSeconds / 3600),
        detectedAt,
      };
      queue.pending_email.push(action);
      addRisk(ref, priority, 'Письмо клиента без ответа', detectedAt);
    }

    for (const violation of qualityViolations) {
      if (ROP_IGNORED_QUALITY_RULE_CODES.has(violation.rule.code)) continue;
      if (!violation.dealId || !scopedDealIds.has(violation.dealId)) continue;
      const ref = dealRefsById.get(violation.dealId);
      const row = ref ? managerRows.get(ref.managerId) : null;
      if (!ref || !row) continue;

      row.crmIssues += 1;
      const priority = this.qualitySeverityPriority(violation.severity);
      const action: RopActionQueueItem = {
        ...ref,
        id: `crm-issue:${violation.id}`,
        type: 'crm_issue',
        priority,
        title: violation.rule.name,
        reason: violation.message,
        taskId: violation.taskId ?? undefined,
        ruleCode: violation.rule.code,
        ageHours: this.ageHours(violation.detectedAt, now),
        detectedAt: violation.detectedAt,
      };
      queue.crm_issue.push(action);
      addRisk(ref, priority, `CRM-дисциплина: ${violation.rule.name}`, violation.detectedAt);
    }

    const selectedPipelineId = filters.pipelineId && selectedPipelineCandidates.has(filters.pipelineId)
      ? filters.pipelineId
      : ([...pipelineStats.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'))[0]?.id ?? null);

    const stageBuckets = new Map<string, {
      pipelineId: string;
      pipelineName: string;
      stageId: string;
      stageName: string;
      stagePosition: number;
      openDeals: number;
      stuckDeals: number;
      stuckAmount: number;
      ageDays: number[];
      slaDays: number | null;
      slaApplies: boolean;
      reason: string;
      topDeals: Array<RopDealRef & { ageDays: number; slaDays: number; reason: string }>;
    }>();

    for (const deal of scopedDeals) {
      const ref = dealRefsById.get(deal.id);
      const stageMeta = stageMetaByDealId.get(deal.id);
      if (!ref || !stageMeta) continue;

      const key = `${deal.pipeline.id}:${deal.stage.id}`;
      const bucket = stageBuckets.get(key) ?? {
        pipelineId: deal.pipeline.id,
        pipelineName: deal.pipeline.name,
        stageId: deal.stage.id,
        stageName: deal.stage.name,
        stagePosition: deal.stage.position,
        openDeals: 0,
        stuckDeals: 0,
        stuckAmount: 0,
        ageDays: [],
        slaDays: stageMeta.slaDays,
        slaApplies: stageMeta.slaApplies,
        reason: stageMeta.reason,
        topDeals: [],
      };
      bucket.openDeals += 1;
      bucket.ageDays.push(stageMeta.ageDays);
      if (stageMeta.isStuck) {
        bucket.stuckDeals += 1;
        bucket.stuckAmount += ref.amount;
        bucket.topDeals.push({
          ...ref,
          ageDays: this.roundMetric(stageMeta.ageDays),
          slaDays: stageMeta.slaDays ?? ROP_DEFAULT_STAGE_SLA_DAYS,
          reason: stageMeta.reason,
        });
      }
      stageBuckets.set(key, bucket);
    }

    const riskDeals = [...riskByDealId.values()].map(({ ref, priority, reasons, detectedAt }): RopActionQueueItem => ({
      ...ref,
      id: `risk-deal:${ref.dealId}`,
      type: 'risk_deal',
      priority,
      title: 'Сделка с риском',
      reason: reasons.join('; '),
      ageHours: this.ageHours(detectedAt, now),
      detectedAt,
    }));

    const managerOutput = [...managerRows.values()]
      .map((row) => ({
        departmentKey: row.departmentKey,
        departmentLabel: row.departmentLabel,
        departmentId: row.departmentKey,
        departmentName: row.departmentLabel,
        managerId: row.managerId,
        managerName: row.managerName,
        groupId: row.groupId,
        groupName: row.groupName,
        openDeals: row.openDeals,
        openAmount: this.roundMetric(row.openAmount),
        tasksTodayTotal: row.tasksTodayTotal,
        tasksTodayDone: row.tasksTodayDone,
        tasksTodayOpen: Math.max(0, row.tasksTodayTotal - row.tasksTodayDone),
        overdueTasks: row.overdueTasks,
        taskReschedules: row.taskReschedules,
        noNextStep: row.noNextStep,
        offerTouches: row.offerTouches,
        pendingEmails: row.pendingEmails,
        stuckDeals: row.stuckDeals,
        crmIssues: row.crmIssues,
        riskDeals: row.riskDealIds.size,
        crmQualityPercent: this.ropCrmQualityPercent(row.openDeals, row.riskDealIds.size),
      }))
      .sort((a, b) => this.ropManagerAttention(b) - this.ropManagerAttention(a) || a.managerName.localeCompare(b.managerName, 'ru'));

    const hasDepartmentFilter = filters.departments.size > 0;
    const hasManagerScopeFilter = filters.groupIds.size > 0 || filters.managerIds.size > 0 || Boolean(filters.pipelineId) || filters.stageIds.size > 0;
    const departments = ROP_DEPARTMENTS
      .filter((department) => !hasDepartmentFilter || filters.departments.has(department.key))
      .map((department) => {
        const rows = managerOutput
          .filter((row) => row.departmentKey === department.key)
          .filter((row) => !hasDealScopeFilter || row.openDeals > 0 || row.tasksTodayTotal > 0 || this.ropManagerAttention(row) > 0);
        const managers = selectedManagers
          .filter((manager) => manager.departmentKey === department.key)
          .sort((a, b) => a.managerName.localeCompare(b.managerName, 'ru'));
        return {
          id: department.key,
          key: department.key,
          name: department.label,
          label: department.label,
          groups: this.ropGroupOptions(managers),
          managers: managers.map((manager) => ({
            id: manager.managerId,
            name: manager.managerName,
            groupId: manager.groupId,
            groupName: manager.groupName,
          })),
          summary: this.ropDepartmentSummary(rows),
          managerRows: rows,
        };
      })
      .filter((department) => !hasManagerScopeFilter || department.managerRows.length > 0);

    const filterDepartments = this.ropFilterDepartments(allManagers, allOpenDeals);
    const filterGroups = filterDepartments.flatMap((department) =>
      department.groups.map((group) => ({
        ...group,
        departmentKey: department.key,
        departmentLabel: department.label,
      })),
    );
    const filterManagers = filterDepartments.flatMap((department) =>
      department.managers.map((manager) => ({
        ...manager,
        departmentKey: department.key,
        departmentLabel: department.label,
      })),
    );
    const filterPipelines = [...new Map(
      filterDepartments
        .flatMap((department) => department.pipelines)
        .map((pipeline) => [pipeline.id, pipeline]),
    ).values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const filterStages = this.ropFilterStages(allManagers, allOpenDeals);

    return {
      generatedAt: now.toISOString(),
      filters: {
        selected: {
          departments: [...filters.departments],
          groupIds: [...filters.groupIds],
          managerIds: [...filters.managerIds],
          pipelineId: filters.pipelineId,
          stageIds: [...filters.stageIds],
          periodPreset: filters.periodPreset,
        },
        period: {
          preset: filters.periodPreset,
          label: period.label,
          startAt: period.startAt.toISOString(),
          endAt: period.endAt.toISOString(),
        },
        departments: filterDepartments,
        groups: filterGroups,
        managers: filterManagers,
        pipelines: filterPipelines,
        stages: filterStages,
      },
      departments,
      actionQueues: {
        offerTouches: this.sortRopActions(queue.offer_touch),
        pendingEmails: this.sortRopActions(queue.pending_email),
        overdueTasks: this.sortRopActions(queue.overdue_task),
        noNextStep: this.sortRopActions(queue.no_next_step),
        stuckDeals: this.sortRopActions(queue.stuck_deal),
        crmIssues: this.sortRopActions(queue.crm_issue),
        riskDeals: this.sortRopActions(riskDeals),
      },
      funnel: {
        pipelines: [...pipelineStats.values()]
          .map((pipeline) => ({
            id: pipeline.id,
            name: pipeline.name,
            openDeals: pipeline.openDeals,
            stuckDeals: pipeline.stuckDeals,
            stuckAmount: this.roundMetric(pipeline.stuckAmount),
          }))
          .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
        selectedPipelineId,
        stages: [...stageBuckets.values()]
          .map((bucket) => ({
            pipelineId: bucket.pipelineId,
            pipelineName: bucket.pipelineName,
            stage: {
              id: bucket.stageId,
              name: bucket.stageName,
              position: bucket.stagePosition,
            },
            stageId: bucket.stageId,
            stageName: bucket.stageName,
            stagePosition: bucket.stagePosition,
            openDeals: bucket.openDeals,
            stuckDeals: bucket.stuckDeals,
            stuckAmount: this.roundMetric(bucket.stuckAmount),
            avgStageAgeDays: this.roundMetric(bucket.ageDays.reduce((sum, value) => sum + value, 0) / Math.max(1, bucket.ageDays.length)),
            slaDays: bucket.slaDays,
            slaApplies: bucket.slaApplies,
            reason: bucket.reason,
            topDeals: bucket.topDeals
              .sort((a, b) => b.ageDays - a.ageDays || b.amount - a.amount)
              .slice(0, ROP_TOP_DEALS_LIMIT)
              .map((deal) => ({
                dealId: deal.dealId,
                dealExternalId: deal.dealExternalId,
                dealTitle: deal.dealTitle,
                dealUrl: deal.dealUrl,
                managerId: deal.managerId,
                managerName: deal.managerName,
                amount: deal.amount,
                ageDays: deal.ageDays,
                slaDays: deal.slaDays,
                reason: deal.reason,
              })),
          }))
          .sort((a, b) => a.pipelineName.localeCompare(b.pipelineName, 'ru') || a.stage.position - b.stage.position),
      },
    };
  }

  telegramStatus(userId: string) {
    return this.telegram.status(userId);
  }

  async listUserLinks(actor: AuthUser) {
    this.ensureTelegramOwner(actor);
    const [users, crmUsers] = await Promise.all([
      this.prisma.user.findMany({
        where: { isActive: true },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          businessRole: true,
          crmUserId: true,
          telegramAccount: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              isActive: true,
              linkedAt: true,
            },
          },
          crmUser: {
            select: {
              id: true,
              externalId: true,
              name: true,
              email: true,
              isActive: true,
              group: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.crmUser.findMany({
        where: { isActive: true, isVisible: true },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        select: {
          id: true,
          externalId: true,
          name: true,
          email: true,
          group: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { users, crmUsers };
  }

  async updateUserLink(actor: AuthUser, userId: string, body: Record<string, any>) {
    this.ensureTelegramOwner(actor);
    const data: Prisma.UserUpdateInput = {};
    if (body.businessRole !== undefined) {
      data.businessRole = this.parseBusinessRole(body.businessRole);
    }
    if (body.crmUserId !== undefined) {
      const crmUserId = this.optionalString(body.crmUserId);
      data.crmUser = crmUserId ? { connect: { id: crmUserId } } : { disconnect: true };
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        businessRole: true,
        crmUserId: true,
        telegramAccount: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            isActive: true,
            linkedAt: true,
          },
        },
        crmUser: {
          select: {
            id: true,
            externalId: true,
            name: true,
            email: true,
            isActive: true,
            group: { select: { id: true, name: true } },
          },
        },
      },
    });
    await this.audit.record({
      userId: actor.id,
      action: 'platform.user_link.update',
      entity: 'User',
      entityId: user.id,
      metadata: {
        businessRole: user.businessRole,
        crmUserId: user.crmUserId,
      },
    });
    return user;
  }

  async listCrmTelegramLinks(actor: AuthUser) {
    const where = await this.crmTelegramAccessWhere(actor);
    const crmUsers = await this.prisma.crmUser.findMany({
      where,
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      select: {
        id: true,
        externalId: true,
        name: true,
        email: true,
        isActive: true,
        group: { select: { id: true, name: true } },
        telegramAccount: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            isActive: true,
            linkedAt: true,
          },
        },
        telegramLinkCodes: {
          where: { usedAt: null, expiresAt: { gt: new Date() } },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, code: true, expiresAt: true, createdAt: true },
        },
      },
    });

    return {
      crmUsers: crmUsers.map(({ telegramLinkCodes, ...crmUser }) => ({
        ...crmUser,
        activeCode: telegramLinkCodes[0] ?? null,
      })),
    };
  }

  async createCrmTelegramLinkCode(actor: AuthUser, crmUserId: string) {
    const crmUser = await this.ensureCrmTelegramAccess(actor, crmUserId);
    const code = await this.telegram.createCrmUserLinkCode(crmUser.id);
    await this.audit.record({
      userId: actor.id,
      action: 'platform.telegram_crm_user.link_code',
      entity: 'CrmUser',
      entityId: crmUser.id,
      metadata: { crmUserName: crmUser.name },
    });
    return code;
  }

  async disconnectCrmTelegram(actor: AuthUser, crmUserId: string) {
    const crmUser = await this.ensureCrmTelegramAccess(actor, crmUserId);
    await this.prisma.$transaction([
      this.prisma.telegramAccount.deleteMany({ where: { crmUserId: crmUser.id } }),
      this.prisma.telegramLinkCode.updateMany({
        where: { crmUserId: crmUser.id, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      userId: actor.id,
      action: 'platform.telegram_crm_user.disconnect',
      entity: 'CrmUser',
      entityId: crmUser.id,
      metadata: { crmUserName: crmUser.name },
    });
    return { ok: true };
  }

  leadSlaCards() {
    return this.crmEventNotifications.leadSlaCards();
  }

  async pendingEmailThreads(actor: AuthUser) {
    this.ensureEmailThreadAccess(actor);

    const now = new Date();
    const domain = await this.resolveAmoDomain();
    const factRows = await this.prisma.factEmailThreadState.findMany({
      where: {
        isPending: true,
        lastIncomingAt: { not: null },
        lastIncomingNoteExternalId: { not: null },
        stageIsWon: false,
        stageIsLost: false,
      },
      orderBy: { lastIncomingAt: 'asc' },
      select: {
        dealId: true,
        dealExternalId: true,
        dealTitle: true,
        dealAmount: true,
        pipelineName: true,
        stageName: true,
        responsibleName: true,
        responsibleExternalId: true,
        groupName: true,
        contactId: true,
        contactExternalId: true,
        contactName: true,
        contactEmail: true,
        threadId: true,
        lastIncomingNoteExternalId: true,
        lastIncomingAt: true,
        subject: true,
        summary: true,
        attachCount: true,
        messages: true,
      },
    });
    const states: EmailThreadStateView[] = factRows.map((state) => ({
      dealId: state.dealId,
      threadId: state.threadId,
      lastIncomingNoteExternalId: state.lastIncomingNoteExternalId,
      lastIncomingAt: state.lastIncomingAt,
      subject: state.subject,
      summary: state.summary,
      attachCount: state.attachCount,
      messages: state.messages,
      deal: {
        id: state.dealId,
        externalId: state.dealExternalId,
        title: state.dealTitle,
        amount: state.dealAmount,
        contactId: state.contactId,
        pipeline: { name: state.pipelineName },
        stage: { name: state.stageName },
        responsible: state.responsibleName || state.responsibleExternalId || state.groupName
          ? {
            name: state.responsibleName ?? '',
            externalId: state.responsibleExternalId ?? '',
            group: state.groupName ? { name: state.groupName } : null,
          }
          : null,
        contact: state.contactName || state.contactExternalId || state.contactEmail
          ? {
            externalId: state.contactExternalId ?? '',
            name: state.contactName ?? '',
            email: state.contactEmail,
          }
          : null,
      },
    }));
    const dealIds = [...new Set(states.map((state) => state.dealId))];
    const dismissals = dealIds.length
      ? await this.prisma.emailThreadDismissal.findMany({
        where: { dealId: { in: dealIds } },
        select: { dealId: true, threadId: true, lastIncomingNoteExternalId: true },
      })
      : [];
    const dismissedKeys = new Set(
      dismissals.map((item) => this.emailDismissalKey(item.dealId, item.threadId, item.lastIncomingNoteExternalId)),
    );

    const latestStatesByDealId = new Map<string, (typeof states)[number]>();
    for (const state of states) {
      const current = latestStatesByDealId.get(state.dealId);
      if (!current || (state.lastIncomingAt?.getTime() ?? 0) > (current.lastIncomingAt?.getTime() ?? 0)) {
        latestStatesByDealId.set(state.dealId, state);
      }
    }

    const threads = [...latestStatesByDealId.values()]
      .map((state) => this.serializePendingEmailThreadState(state, now, domain, dismissedKeys))
      .filter((thread): thread is NonNullable<typeof thread> => Boolean(thread))
      .sort((a, b) => a.lastIncomingAt.localeCompare(b.lastIncomingAt));

    const groups = EMAIL_PIPELINE_GROUPS.map((group) => {
      const groupThreads = threads.filter((thread) => thread.pipelineKey === group.key).slice(0, 200);
      return {
        key: group.key,
        label: group.label,
        summary: this.emailThreadSummary(groupThreads),
        threads: groupThreads,
      };
    });
    const visibleThreads = groups.flatMap((group) => group.threads);

    return {
      now: now.toISOString(),
      timezone: 'Europe/Moscow',
      summary: this.emailThreadSummary(visibleThreads),
      groups,
      threads: visibleThreads,
    };
  }

  async dismissEmailThread(actor: AuthUser, body: Record<string, any>) {
    this.ensureEmailThreadAccess(actor);

    const dealId = String(body.dealId ?? '').trim();
    const threadId = String(body.threadId ?? '').trim();
    const lastIncomingNoteExternalId = String(body.lastIncomingNoteExternalId ?? '').trim();
    const reason = String(body.reason ?? '').trim() || null;

    if (!dealId || !threadId || !lastIncomingNoteExternalId) {
      throw new BadRequestException('Не хватает данных треда');
    }

    const state = await this.prisma.emailThreadState.findFirst({
      where: {
        dealId,
        threadId,
        lastIncomingNoteExternalId,
      },
      select: {
        lastIncomingAt: true,
      },
    });
    const lastIncomingAt = state?.lastIncomingAt ?? null;

    if (!lastIncomingAt) {
      throw new NotFoundException('Входящее письмо не найдено');
    }

    const dismissal = await this.prisma.emailThreadDismissal.upsert({
      where: {
        dealId_threadId_lastIncomingNoteExternalId: {
          dealId,
          threadId,
          lastIncomingNoteExternalId,
        },
      },
      create: {
        dealId,
        threadId,
        lastIncomingNoteExternalId,
        lastIncomingAt,
        dismissedById: actor.id,
        reason,
      },
      update: {
        dismissedById: actor.id,
        reason,
        lastIncomingAt,
      },
    });

    await this.audit.record({
      userId: actor.id,
      action: 'platform.email_thread.dismiss',
      entity: 'EmailThreadDismissal',
      entityId: dismissal.id,
      metadata: { dealId, threadId, lastIncomingNoteExternalId },
    });

    return { ok: true };
  }

  async rebuildEmailThreadStatesManually(actor: AuthUser) {
    this.ensureAdmin(actor);
    return this.rebuildEmailThreadStates();
  }

  async rebuildEmailThreadStates() {
    return this.rebuildEmailThreadStatesForScope();
  }

  async rebuildEmailThreadStatesForDeals(dealIds: string[]) {
    const uniqueDealIds = [...new Set(dealIds.filter(Boolean))];
    if (!uniqueDealIds.length) return { total: 0, pending: 0 };
    return this.rebuildEmailThreadStatesForScope(uniqueDealIds);
  }

  private async rebuildEmailThreadStatesForScope(dealIds?: string[]) {
    const drafts = await this.buildEmailThreadDrafts(dealIds);
    const rowsByKey = new Map<string, Prisma.EmailThreadStateCreateManyInput>();
    for (const draft of drafts) {
      const row = this.emailThreadStateData(draft);
      if (!row) continue;
      rowsByKey.set(`${row.dealId}:${row.threadId}`, row);
    }
    const rows = [...rowsByKey.values()];

    await this.prisma.emailThreadState.deleteMany(dealIds ? { where: { dealId: { in: dealIds } } } : undefined);
    for (const chunk of this.chunks(rows, EMAIL_THREAD_CREATE_BATCH_SIZE)) {
      await this.prisma.emailThreadState.createMany({ data: chunk, skipDuplicates: true });
    }
    const factCounts = await this.facts.refreshEmailThreadFactsOnly(dealIds);

    return {
      total: rows.length,
      pending: rows.filter((row) => row.isPending).length,
      factEmailThreads: factCounts.emailThreads,
    };
  }

  async listTelegramTemplates(actor: AuthUser) {
    this.ensureTelegramOwner(actor);
    await this.ensureTelegramTemplates();
    const activeEventTypes = this.defaultTelegramTemplates().map((template) => template.eventType);
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { eventType: { in: activeEventTypes } },
      orderBy: { name: 'asc' },
    });
    return templates.map((template) => this.serializeTelegramTemplate(template));
  }

  async updateTelegramTemplate(actor: AuthUser, eventType: string, body: Record<string, any>) {
    this.ensureTelegramOwner(actor);
    const defaults = this.defaultTelegramTemplates().find((template) => template.eventType === eventType);
    if (!defaults) throw new NotFoundException('Шаблон не найден');
    const text = String(body.body ?? '').trim();
    if (!text) throw new BadRequestException('Текст уведомления обязателен');
    const recipients = body.recipients === undefined ? undefined : await this.parseTelegramRecipients(body.recipients);
    const deliveryMode = this.parseTelegramDeliveryMode(body.deliveryMode, body.recipientsMode, recipients);
    if (!this.telegramDeliveryModeAllowed(eventType, deliveryMode)) {
      throw new BadRequestException('\u041d\u0435\u0434\u043e\u043f\u0443\u0441\u0442\u0438\u043c\u044b\u0439 \u0440\u0435\u0436\u0438\u043c \u0434\u043e\u0441\u0442\u0430\u0432\u043a\u0438 \u0434\u043b\u044f \u044d\u0442\u043e\u0433\u043e \u0443\u0432\u0435\u0434\u043e\u043c\u043b\u0435\u043d\u0438\u044f');
    }
    if (deliveryMode === 'selected' && !(recipients ?? []).length) {
      throw new BadRequestException('\u0412\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u0435\u0439');
    }
    const storedRecipients = body.deliveryMode === undefined && body.recipientsMode === undefined && recipients === undefined
      ? undefined
      : this.telegramRecipientsForStorage(deliveryMode, recipients ?? []);
    return this.prisma.notificationTemplate.upsert({
      where: { eventType },
      create: {
        eventType,
        name: defaults.name,
        body: text,
        recipients: this.json(storedRecipients ?? []),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
      },
      update: {
        name: defaults.name,
        body: text,
        ...(storedRecipients === undefined ? {} : { recipients: this.json(storedRecipients) }),
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
      },
    });
  }

  createTelegramLinkCode(userId: string) {
    return this.telegram.createLinkCode(userId);
  }

  async sendTelegramTest(userId: string) {
    const message = 'Тестовое сообщение PulseBoard. Telegram подключен корректно.';
    const delivery = await this.telegram.sendMessageToUser(userId, message, { type: 'telegram_test' });
    return { ok: delivery.status === 'SENT', delivery };
  }

  private async ensureTelegramTemplates() {
    await this.prisma.notificationTemplate.deleteMany({
      where: { eventType: { in: OBSOLETE_TELEGRAM_TEMPLATE_EVENT_TYPES } },
    });
    for (const template of this.defaultTelegramTemplates()) {
      await this.prisma.notificationTemplate.upsert({
        where: { eventType: template.eventType },
        create: template,
        update: { name: template.name },
      });
    }
  }

  private defaultTelegramTemplates() {
    return [
      {
        eventType: 'amo_new_assigned_lead',
        name: '\u041d\u043e\u0432\u044b\u0439 \u043b\u0438\u0434 \u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440\u0443',
        body: '{managerMention}, \u0442\u0435\u0431\u0435 \u043f\u0440\u0438\u0448\u0435\u043b \u043d\u043e\u0432\u044b\u0439 \u043b\u0438\u0434! \u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_assigned_lead_10m',
        name: '\u041b\u0438\u0434 \u0432\u0438\u0441\u0438\u0442 10 \u043c\u0438\u043d\u0443\u0442',
        body: '{managerMention}, \u043b\u0438\u0434 \u0432\u0438\u0441\u0438\u0442 10 \u043c\u0438\u043d\u0443\u0442! \u0411\u0435\u0440\u0438: {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_take_to_work_enabled',
        name: '\u0412\u0437\u044f\u0442\u044c \u0432 \u0440\u0430\u0431\u043e\u0442\u0443 = \u0415\u0441\u0442\u044c',
        body: '{managerMention}, \u0443 \u0442\u0435\u0431\u044f \u0432\u0445\u043e\u0434\u044f\u0449\u0438\u0439 \u043b\u0438\u0434 \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u0435\u043d! \u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443: {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_payment_received',
        name: '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0430',
        body: '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0430\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443: {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_task_mass_reschedule',
        name: '\u041c\u0430\u0441\u0441\u043e\u0432\u044b\u0439 \u043f\u0435\u0440\u0435\u043d\u043e\u0441 \u0437\u0430\u0434\u0430\u0447',
        body: '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {taskCount} \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.',
        isActive: true,
      },
      {
        eventType: 'amo_deal_mass_move',
        name: '\u041c\u0430\u0441\u0441\u043e\u0432\u044b\u0439 \u043f\u0435\u0440\u0435\u043d\u043e\u0441 \u0441\u0434\u0435\u043b\u043e\u043a',
        body: '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {dealCount} \u0441\u0434\u0435\u043b\u043e\u043a, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.',
        isActive: true,
      },
      {
        eventType: 'amo_csm_task_mass_reschedule',
        name: 'CSM: \u043c\u0430\u0441\u0441\u043e\u0432\u044b\u0439 \u043f\u0435\u0440\u0435\u043d\u043e\u0441 \u0437\u0430\u0434\u0430\u0447',
        body: '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {taskCount} \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.',
        isActive: true,
      },
      {
        eventType: 'amo_csm_deal_mass_move',
        name: 'CSM: \u043c\u0430\u0441\u0441\u043e\u0432\u044b\u0439 \u043f\u0435\u0440\u0435\u043d\u043e\u0441 \u0441\u0434\u0435\u043b\u043e\u043a',
        body: '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {dealCount} \u0441\u0434\u0435\u043b\u043e\u043a, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.',
        isActive: true,
      },
      {
        eventType: 'amo_csm_overdue_tasks',
        name: 'CSM: \u0431\u043e\u043b\u044c\u0448\u0435 5 \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u0435\u043d\u043d\u044b\u0445 \u0437\u0430\u0434\u0430\u0447',
        body: '\u0423 {manager} {taskCount} \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u0435\u043d\u043d\u044b\u0445 \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.',
        isActive: true,
      },
      {
        eventType: 'amo_csm_zero_taken_to_work_13',
        name: 'CSM: 0 \u0432\u0437\u044f\u0442\u044b\u0445 \u0432 \u0440\u0430\u0431\u043e\u0442\u0443 \u043a 13:00',
        body: '{managerMention}, \u043a 13:00 \u0443 \u0442\u0435\u0431\u044f 0 \u043b\u0438\u0434\u043e\u0432 \u0432\u0437\u044f\u0442\u043e \u0432 \u0440\u0430\u0431\u043e\u0442\u0443. \u041f\u0440\u043e\u0432\u0435\u0440\u044c CSM-\u0432\u043e\u0440\u043e\u043d\u043a\u0443.',
        isActive: true,
      },
      {
        eventType: 'amo_csm_zero_offer_made_13',
        name: 'CSM: 0 \u041a\u041f \u043a 13:00',
        body: '{managerMention}, \u043a 13:00 \u0443 \u0442\u0435\u0431\u044f 0 \u041a\u041f \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e. \u041f\u0440\u043e\u0432\u0435\u0440\u044c CSM-\u0432\u043e\u0440\u043e\u043d\u043a\u0443.',
        isActive: true,
      },
      {
        eventType: 'amo_invoice_no_payment_3d',
        name: '\u0421\u0447\u0435\u0442 \u0431\u0435\u0437 \u043e\u043f\u043b\u0430\u0442\u044b 3 \u0434\u043d\u044f',
        body: '\u0421\u0447\u0435\u0442 {deal} \u0431\u0435\u0437 \u043e\u043f\u043b\u0430\u0442\u044b \u0442\u0440\u0438 \u0434\u043d\u044f. {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_proposal_stale_24h',
        name: '\u041a\u041f / \u0432\u043e\u0437\u0440\u0430\u0436\u0435\u043d\u0438\u044f \u0441\u0442\u043e\u044f\u0442 24 \u0447\u0430\u0441\u0430',
        body: '\u0421\u0434\u0435\u043b\u043a\u0430 \u043d\u0430 {amount} \u0441\u0442\u043e\u0438\u0442 \u0432\u0442\u043e\u0440\u043e\u0439 \u0434\u0435\u043d\u044c - {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_proposal_prepared_stale_2bd',
        name: '\u041a\u041f \u043d\u0435 \u043f\u0440\u0435\u0437\u0435\u043d\u0442\u043e\u0432\u0430\u043d\u043e \u0437\u0430 2 \u0440\u0430\u0431\u043e\u0447\u0438\u0445 \u0434\u043d\u044f',
        body: '\u041a\u041f \u043f\u043e\u0434\u0433\u043e\u0442\u043e\u0432\u043b\u0435\u043d\u043e, \u043d\u043e \u043d\u0435 \u043f\u0440\u0435\u0437\u0435\u043d\u0442\u043e\u0432\u0430\u043d\u043e \u043a\u043b\u0438\u0435\u043d\u0442\u0443 \u0437\u0430 2 \u0440\u0430\u0431\u043e\u0447\u0438\u0445 \u0434\u043d\u044f.\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}',
        isActive: true,
      },
      {
        eventType: 'amo_high_value_idle_24h',
        name: '\u041a\u0440\u0443\u043f\u043d\u0430\u044f \u0441\u0434\u0435\u043b\u043a\u0430 \u0431\u0435\u0437 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u044f 24 \u0447\u0430\u0441\u0430',
        body: '\u041a\u0440\u0443\u043f\u043d\u0430\u044f \u0441\u0434\u0435\u043b\u043a\u0430 \u0431\u0435\u0437 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u044f 24 \u0447\u0430\u0441\u0430.\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u042d\u0442\u0430\u043f: {stage}\n\u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}',
        isActive: true,
      },
    ];
  }

  listAlerts(user: AuthUser) {
    return this.prisma.alertRule.findMany({
      where: user.role === 'ADMIN' ? {} : { userId: user.id },
      include: {
        reportTemplate: { select: { id: true, name: true, sourceType: true } },
        events: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAlert(user: AuthUser, body: Record<string, any>) {
    if (!body.name) throw new BadRequestException('Название алерта обязательно');
    const alert = await this.prisma.alertRule.create({
      data: {
        userId: user.id,
        reportTemplateId: this.optionalString(body.reportTemplateId),
        name: String(body.name),
        description: this.optionalString(body.description),
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        metricKey: this.optionalString(body.metricKey),
        operator: this.parseAlertOperator(body.operator),
        threshold: this.optionalDecimal(body.threshold),
        condition: this.json(body.condition ?? {}),
        recipients: this.json(this.parseRecipients(body.recipients, user.id)),
        checkEveryMinutes: this.clampInt(body.checkEveryMinutes, 5, 1440, 15),
        cooldownMinutes: this.clampInt(body.cooldownMinutes, 0, 10080, 60),
      },
    });
    await this.audit.record({ userId: user.id, action: 'platform.alert.create', entity: 'AlertRule', entityId: alert.id });
    return alert;
  }

  async updateAlert(user: AuthUser, id: string, body: Record<string, any>) {
    const existing = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Алерт не найден');
    this.ensureOwner(user, existing.userId);

    const data: Prisma.AlertRuleUpdateInput = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.description !== undefined) data.description = this.optionalString(body.description);
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (body.reportTemplateId !== undefined) {
      data.reportTemplate = body.reportTemplateId
        ? { connect: { id: String(body.reportTemplateId) } }
        : { disconnect: true };
    }
    if (body.metricKey !== undefined) data.metricKey = this.optionalString(body.metricKey);
    if (body.operator !== undefined) data.operator = this.parseAlertOperator(body.operator);
    if (body.threshold !== undefined) data.threshold = this.optionalDecimal(body.threshold);
    if (body.condition !== undefined) data.condition = this.json(body.condition);
    if (body.recipients !== undefined) data.recipients = this.json(this.parseRecipients(body.recipients, existing.userId ?? user.id));
    if (body.checkEveryMinutes !== undefined) data.checkEveryMinutes = this.clampInt(body.checkEveryMinutes, 5, 1440, 15);
    if (body.cooldownMinutes !== undefined) data.cooldownMinutes = this.clampInt(body.cooldownMinutes, 0, 10080, 60);

    const alert = await this.prisma.alertRule.update({ where: { id }, data });
    await this.audit.record({ userId: user.id, action: 'platform.alert.update', entity: 'AlertRule', entityId: alert.id });
    return alert;
  }

  async deleteAlert(user: AuthUser, id: string) {
    const existing = await this.prisma.alertRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Алерт не найден');
    this.ensureOwner(user, existing.userId);
    await this.prisma.alertRule.delete({ where: { id } });
    await this.audit.record({ userId: user.id, action: 'platform.alert.delete', entity: 'AlertRule', entityId: id });
    return { ok: true };
  }

  async runAlertChecks(actor?: AuthUser, force = false) {
    const now = new Date();
    const alerts = await this.prisma.alertRule.findMany({
      where: {
        enabled: true,
        ...(actor?.role === 'ROP' ? { userId: actor.id } : {}),
      },
      include: {
        user: { select: { id: true, role: true, email: true } },
        reportTemplate: true,
      },
    });

    const results: Array<Record<string, unknown>> = [];
    for (const alert of alerts) {
      if (!force && !this.alertIsDue(alert, now)) continue;
      try {
        results.push(await this.checkAlert(alert, now));
      } catch (error: any) {
        this.logger.warn(`Alert check failed ${alert.id}: ${error.message}`);
        results.push({ id: alert.id, name: alert.name, status: 'ERROR', error: error.message });
      }
    }
    return { checked: results.length, results };
  }

  listPlanSets() {
    return this.prisma.planSet.findMany({
      include: { _count: { select: { items: true } } },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
    });
  }

  async createPlanSet(userId: string, body: Record<string, any>) {
    if (!body.name) throw new BadRequestException('Название плана обязательно');
    const planSet = await this.prisma.planSet.create({
      data: {
        name: String(body.name),
        year: body.year ? Number(body.year) : null,
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        version: this.clampInt(body.version, 1, 999, 1),
        createdById: userId,
      },
    });
    await this.audit.record({ userId, action: 'platform.plan.create', entity: 'PlanSet', entityId: planSet.id });
    return planSet;
  }

  updatePlanSet(id: string, body: Record<string, any>) {
    const data: Prisma.PlanSetUpdateInput = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.year !== undefined) data.year = body.year ? Number(body.year) : null;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (body.version !== undefined) data.version = this.clampInt(body.version, 1, 999, 1);
    return this.prisma.planSet.update({ where: { id }, data });
  }

  listPlanItems(planSetId?: string) {
    return this.prisma.planItem.findMany({
      where: planSetId ? { planSetId } : {},
      orderBy: [{ periodStart: 'asc' }, { targetType: 'asc' }, { targetName: 'asc' }],
    });
  }

  async createPlanItem(body: Record<string, any>) {
    const required = ['planSetId', 'periodStart', 'periodEnd', 'metricKey', 'metricName', 'value'];
    for (const key of required) {
      if (body[key] === undefined || body[key] === '') throw new BadRequestException(`Поле ${key} обязательно`);
    }
    return this.prisma.planItem.create({
      data: {
        planSetId: String(body.planSetId),
        periodType: this.parsePlanPeriodType(body.periodType),
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        targetType: this.parsePlanTargetType(body.targetType),
        targetId: this.optionalString(body.targetId),
        targetName: this.optionalString(body.targetName),
        metricKey: String(body.metricKey),
        metricName: String(body.metricName),
        value: new Prisma.Decimal(String(body.value).replace(',', '.')),
        unit: String(body.unit ?? 'number'),
      },
    });
  }

  async deletePlanItem(id: string) {
    await this.prisma.planItem.delete({ where: { id } });
    return { ok: true };
  }

  planTemplateCsv() {
    return [
      'planSetName,year,periodType,periodStart,periodEnd,targetType,targetId,targetName,metricKey,metricName,value,unit',
      'План продаж 2026,2026,MONTH,2026-01-01,2026-01-31,MANAGER,,Иван Петров,closed_amount,Выручка закрытых сделок,5000000,rub',
      'План продаж 2026,2026,MONTH,2026-01-01,2026-01-31,GROUP,,Sales,closed_deal_count,Закрытые сделки,25,number',
    ].join('\n');
  }

  async planFact(user: AuthUser, planSetId?: string, monthInput?: string) {
    const month = this.parsePlanFactMonth(monthInput);
    const calendar = this.planFactCalendar(month);
    const planSet = planSetId
      ? await this.prisma.planSet.findUnique({ where: { id: planSetId }, include: { items: true } })
      : await this.prisma.planSet.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' }, include: { items: true } });

    const periodEnd = calendar.todayEnd < calendar.monthEnd ? calendar.todayEnd : calendar.monthEnd;
    const [refs, monthShipping] = await Promise.all([
      this.resolvePlanFactRefs(),
      calendar.monthStart > periodEnd ? null : this.reports.getPlanFactShipping(calendar.monthStart, periodEnd, user),
    ]);
    // All shipping windows use the same forecast snapshot, not independently
    // refreshed values. A reopened shipment cannot count again on a later day.
    const shipping = {
      month: monthShipping,
      today: calendar.isCurrentMonth && monthShipping
        ? { ...monthShipping, entries: monthShipping.entries.filter((entry) => entry.shippedAt >= calendar.todayStart) } : null,
      beforeToday: calendar.isCurrentMonth && monthShipping
        ? { ...monthShipping, entries: monthShipping.entries.filter((entry) => entry.shippedAt < calendar.todayStart) } : null,
    };
    const monthItems = (planSet?.items ?? []).filter((item) =>
      item.periodStart <= calendar.monthEnd && item.periodEnd >= calendar.monthStart,
    );
    const [sales, csm] = await Promise.all([
      refs.sales ? this.buildPlanFactTeam('sales', refs.sales, shipping, monthItems, calendar, user) : null,
      refs.csm ? this.buildPlanFactTeam('csm', refs.csm, shipping, monthItems, calendar, user) : null,
    ]);

    return {
      planSet: planSet
        ? {
          id: planSet.id,
          name: planSet.name,
          year: planSet.year,
          isActive: planSet.isActive,
          version: planSet.version,
        }
        : null,
      month: calendar.monthKey,
      generatedAt: new Date(),
      calendar: {
        monthStart: calendar.monthStart,
        monthEnd: calendar.monthEnd,
        todayStart: calendar.todayStart,
        todayEnd: calendar.todayEnd,
        workdaysInMonth: calendar.workdaysInMonth,
        workedDays: calendar.workedDays,
        remainingWorkdaysIncludingToday: calendar.remainingWorkdaysIncludingToday,
        isCurrentMonth: calendar.isCurrentMonth,
        isTodayWorkday: calendar.isTodayWorkday,
      },
      metrics: PLAN_FACT_METRICS,
      warnings: refs.warnings,
      teams: [sales, csm].filter(Boolean),
    };
  }

  async updatePlanFact(actor: AuthUser, body: Record<string, any>) {
    this.ensureAdmin(actor);
    const month = this.parsePlanFactMonth(String(body.month ?? ''));
    const calendar = this.planFactCalendar(month);
    const metric = PLAN_FACT_METRICS.find((item) => item.key === String(body.metricKey ?? ''));
    if (!metric) throw new BadRequestException('Неизвестная метрика плана');
    const targetType = this.parsePlanTargetType(body.targetType);
    if (targetType === 'COMPANY') throw new BadRequestException('Для план-факта нужен менеджер или отдел');
    if (metric.kind === 'conversion' && targetType !== 'GROUP') {
      throw new BadRequestException('План конверсии задаётся один раз на отдел');
    }
    const targetId = this.optionalString(body.targetId);
    if (!targetId) throw new BadRequestException('Не выбран получатель плана');
    const shouldClear = body.value === undefined || body.value === null || body.value === '';
    const parsedValue = shouldClear ? null : this.optionalDecimal(body.value);
    const value = parsedValue ? this.normalizePlanFactPlanValue(metric, parsedValue) : null;

    const planSet = body.planSetId
      ? await this.prisma.planSet.findUnique({ where: { id: String(body.planSetId) } })
      : shouldClear
        ? await this.prisma.planSet.findFirst({ where: { year: calendar.year, isActive: true }, orderBy: { updatedAt: 'desc' } })
        : await this.ensurePlanFactPlanSet(actor.id, calendar.year);
    if (!planSet) {
      if (shouldClear) return { ok: true, deleted: false };
      throw new NotFoundException('План не найден');
    }

    const targetName = await this.resolvePlanTargetName(targetType, targetId);
    const existing = await this.prisma.planItem.findFirst({
      where: {
        planSetId: planSet.id,
        metricKey: metric.key,
        targetType,
        targetId,
        periodStart: calendar.monthStart,
        periodEnd: calendar.monthEnd,
      },
    });

    if (shouldClear) {
      if (existing) {
        await this.prisma.planItem.delete({ where: { id: existing.id } });
        return { ok: true, deleted: true };
      }
      return { ok: true, deleted: false };
    }
    if (!value) throw new BadRequestException('Не указано значение плана');

    const data = {
      planSetId: planSet.id,
      periodType: 'MONTH' as PlanPeriodType,
      periodStart: calendar.monthStart,
      periodEnd: calendar.monthEnd,
      targetType,
      targetId,
      targetName,
      metricKey: metric.key,
      metricName: metric.label,
      value,
      unit: metric.unit,
    };

    const item = existing
      ? await this.prisma.planItem.update({ where: { id: existing.id }, data })
      : await this.prisma.planItem.create({ data });

    await this.audit.record({
      userId: actor.id,
      action: 'platform.plan_fact.update',
      entity: 'PlanItem',
      entityId: item.id,
      metadata: { month: calendar.monthKey, metricKey: metric.key, targetType, targetId },
    });
    return { ok: true, item, planSet };
  }

  private async ensurePlanFactPlanSet(userId: string, year: number) {
    const existing = await this.prisma.planSet.findFirst({
      where: { year, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (existing) return existing;
    return this.prisma.planSet.create({
      data: {
        name: `Планы ${year}`,
        year,
        isActive: true,
        createdById: userId,
      },
    });
  }

  private async resolvePlanTargetName(targetType: PlanTargetType, targetId: string) {
    if (targetType === 'MANAGER') {
      const manager = await this.prisma.crmUser.findUnique({ where: { id: targetId }, select: { name: true } });
      return manager?.name ?? null;
    }
    if (targetType === 'GROUP') {
      const group = await this.prisma.crmGroup.findUnique({ where: { id: targetId }, select: { name: true } });
      return group?.name ?? null;
    }
    return null;
  }

  private parsePlanFactMonth(input?: string) {
    const now = new Date();
    const current = moscowParts(now);
    const match = String(input ?? '').match(/^(\d{4})-(\d{2})$/);
    const year = match ? Number(match[1]) : current.year;
    const month = match ? Number(match[2]) : current.month;
    return moscowDate(year, Math.min(Math.max(month, 1), 12), 1, 0);
  }

  private planFactCalendar(month: Date) {
    const monthParts = moscowParts(month);
    const monthStart = moscowDate(monthParts.year, monthParts.month, 1, 0);
    const monthEnd = moscowDate(monthParts.year, monthParts.month + 1, 0, 23, 59, 59, 999);
    const nowParts = moscowParts(new Date());
    const todayStart = moscowDate(nowParts.year, nowParts.month, nowParts.day, 0);
    const todayEnd = moscowDate(nowParts.year, nowParts.month, nowParts.day, 23, 59, 59, 999);
    const monthKey = `${monthParts.year}-${String(monthParts.month).padStart(2, '0')}`;
    const currentMonthKey = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}`;
    const isCurrentMonth = monthKey === currentMonthKey;
    const isTodayWorkday = isMoscowBusinessDay(nowParts);
    const workedUntil = todayEnd < monthStart ? new Date(monthStart.getTime() - 1) : todayEnd < monthEnd ? todayEnd : monthEnd;
    return {
      year: monthParts.year,
      month: monthParts.month,
      monthKey,
      monthStart,
      monthEnd,
      todayStart,
      todayEnd,
      isCurrentMonth,
      isTodayWorkday,
      workdaysInMonth: this.countMoscowWorkdays(monthStart, monthEnd),
      workedDays: workedUntil >= monthStart ? this.countMoscowWorkdays(monthStart, workedUntil) : 0,
      remainingWorkdaysIncludingToday: isCurrentMonth ? this.countMoscowWorkdays(todayStart, monthEnd) : 0,
    };
  }

  private countMoscowWorkdays(start: Date, end: Date) {
    if (end < start) return 0;
    let count = 0;
    const startParts = moscowParts(start);
    const endParts = moscowParts(end);
    let cursor = moscowDate(startParts.year, startParts.month, startParts.day, 12);
    const last = moscowDate(endParts.year, endParts.month, endParts.day, 12);
    while (cursor <= last) {
      if (isMoscowBusinessDay(moscowParts(cursor))) count += 1;
      const parts = moscowParts(cursor);
      cursor = moscowDate(parts.year, parts.month, parts.day + 1, 12);
    }
    return count;
  }

  private async resolvePlanFactRefs() {
    const [sales, csm] = await Promise.all([
      this.reports.getTeamFunnelDefinition('sales'),
      this.reports.getTeamFunnelDefinition('csm'),
    ]);
    const warnings: string[] = [];
    if (!sales) warnings.push('Не найдены настройки воронки Sales. Данные не рассчитаны.');
    if (!csm) warnings.push('Не найдены настройки воронки CSM. Данные не рассчитаны.');
    return { sales, csm, warnings };
  }

  private async buildPlanFactTeam(
    team: PlanFactTeamKey,
    refs: TeamFunnelDefinition,
    shipping: { month: ActualShipping | null; today: ActualShipping | null; beforeToday: ActualShipping | null },
    planItems: any[],
    calendar: ReturnType<PlatformService['planFactCalendar']>,
    user: AuthUser,
  ) {
    const metrics = PLAN_FACT_METRICS.filter((metric) => metric.team === team);
    const managers = await this.prisma.crmUser.findMany({
      where: {
        isActive: true,
        ...(user.role === 'ROP' ? { isVisible: true } : {}),
        ...(team === 'sales'
          ? {
              OR: [
                { groupId: refs.group.id },
                { deals: { some: { pipelineId: { in: refs.pipelineIds }, deletedAt: null } } },
              ],
            }
          : { groupId: refs.group.id }),
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const [monthReport, todayReport, beforeTodayReport] = await Promise.all([
      this.computePlanFactContract(team, refs, shipping.month, calendar.monthStart, calendar.todayEnd < calendar.monthEnd ? calendar.todayEnd : calendar.monthEnd, user),
      calendar.isCurrentMonth
        ? this.computePlanFactContract(team, refs, shipping.today, calendar.todayStart, calendar.todayEnd, user)
        : Promise.resolve(null),
      calendar.isCurrentMonth
        ? this.computePlanFactContract(team, refs, shipping.beforeToday, calendar.monthStart, new Date(calendar.todayStart.getTime() - 1), user)
        : Promise.resolve(null),
    ]);

    // Include current owners present in facts even if they no longer own an open
    // Sales card. Otherwise the total includes deals absent from manager rows.
    const allManagers = new Map(managers.map((manager) => [manager.id, manager]));
    for (const report of [monthReport, todayReport, beforeTodayReport]) {
      for (const row of report?.rows ?? []) {
        if (!allManagers.has(row.groupId)) allManagers.set(row.groupId, { id: row.groupId, name: row.groupName });
      }
    }
    const teamName = team === 'sales' ? 'Продажи' : 'CSM';
    const rows = [...allManagers.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')).map((manager) => this.buildPlanFactTargetRow({
      targetType: 'MANAGER',
      targetId: manager.id,
      targetName: manager.name,
      groupTarget: { targetId: refs.group.id, targetName: teamName },
      metrics,
      planItems,
      calendar,
      monthReport,
      todayReport,
      beforeTodayReport,
    }));
    const total = this.buildPlanFactTargetRow({
      targetType: 'GROUP',
      targetId: refs.group.id,
      targetName: `Итого ${teamName}`,
      groupTarget: { targetId: refs.group.id, targetName: teamName },
      metrics,
      planItems,
      calendar,
      monthReport,
      todayReport,
      beforeTodayReport,
      managerRows: rows,
    });
    return {
      key: team,
      name: teamName,
      groupId: refs.group.id,
      metrics,
      rows,
      total,
    };
  }

  private buildPlanFactTargetRow(input: {
    targetType: 'MANAGER' | 'GROUP';
    targetId: string;
    targetName: string;
    groupTarget?: { targetId: string; targetName: string };
    metrics: PlanFactMetric[];
    planItems: any[];
    calendar: ReturnType<PlatformService['planFactCalendar']>;
    monthReport: any;
    todayReport: any;
    beforeTodayReport: any;
    managerRows?: any[];
  }) {
    const values = Object.fromEntries(input.metrics.map((metric) => {
      const plan = this.findPlanValue(
        input.planItems,
        metric,
        input.targetType,
        input.targetId,
        input.targetName,
        input.managerRows,
        input.groupTarget,
      );
      const factMonth = this.reportMetricValue(input.monthReport, input.targetId, input.targetType, metric.key);
      const factToday = input.todayReport ? this.reportMetricValue(input.todayReport, input.targetId, input.targetType, metric.key) : null;
      const factBeforeToday = input.beforeTodayReport
        ? this.reportMetricValue(input.beforeTodayReport, input.targetId, input.targetType, metric.key)
        : Math.max((factMonth ?? 0) - (factToday ?? 0), 0);
      const pace = this.planFactPace(metric, plan, factMonth, factToday, factBeforeToday, input.calendar);
      return [metric.key, pace];
    }));
    return {
      targetType: input.targetType,
      targetId: input.targetId,
      targetName: input.targetName,
      values,
    };
  }

  private planFactPace(
    metric: PlanFactMetric,
    plan: number | null,
    factMonth: number | null,
    factToday: number | null,
    factBeforeToday: number | null,
    calendar: ReturnType<PlatformService['planFactCalendar']>,
  ) {
    if (plan == null || plan === 0) {
      return {
        plan: null,
        upToDatePlan: null,
        factMonth,
        monthDelta: null,
        monthCompletionPercent: null,
        todayPlan: null,
        factToday,
        todayDelta: null,
        unit: metric.unit,
      };
    }
    if (metric.kind === 'conversion') {
      const sharedPlan = this.roundPlanFactValue(metric, plan);
      return {
        plan: sharedPlan,
        upToDatePlan: sharedPlan,
        factMonth,
        monthDelta: factMonth == null ? null : this.roundPlanFactDelta(metric, factMonth - sharedPlan),
        monthCompletionPercent: factMonth == null ? null : this.roundMetric((factMonth / sharedPlan) * 100),
        todayPlan: calendar.isCurrentMonth ? sharedPlan : null,
        factToday,
        todayDelta: factToday == null || !calendar.isCurrentMonth ? null : this.roundPlanFactDelta(metric, factToday - sharedPlan),
        unit: metric.unit,
      };
    }
    const baseDailyPlan = plan / Math.max(calendar.workdaysInMonth, 1);
    const upToDatePlanRaw = baseDailyPlan * calendar.workedDays;
    const todayPlanRaw = calendar.isCurrentMonth && calendar.isTodayWorkday
      ? Math.max(baseDailyPlan, (plan - (factBeforeToday ?? 0)) / Math.max(calendar.remainingWorkdaysIncludingToday, 1))
      : null;
    const monthlyPlan = this.roundPlanFactValue(metric, plan);
    const upToDatePlan = this.roundPlanFactValue(metric, upToDatePlanRaw);
    const todayPlan = todayPlanRaw == null ? null : this.roundPlanFactValue(metric, todayPlanRaw);
    return {
      plan: monthlyPlan,
      upToDatePlan,
      factMonth,
      monthDelta: factMonth == null ? null : this.roundPlanFactDelta(metric, factMonth - upToDatePlan),
      monthCompletionPercent: upToDatePlan > 0 && factMonth != null ? this.roundMetric((factMonth / upToDatePlan) * 100) : null,
      todayPlan,
      factToday,
      todayDelta: todayPlan == null || factToday == null ? null : this.roundPlanFactDelta(metric, factToday - todayPlan),
      unit: metric.unit,
    };
  }

  private async computePlanFactContract(
    team: PlanFactTeamKey,
    refs: TeamFunnelDefinition,
    shipping: ActualShipping | null,
    dateFrom: Date,
    dateTo: Date,
    user: AuthUser,
  ) {
    if (dateTo < dateFrom) return null;
    const filters = { ...refs.filters, dateFrom: dateFrom.toISOString(), dateTo: dateTo.toISOString() };
    const report = await this.reports.compute({
      name: refs.name,
      sourceType: refs.sourceType,
      filters,
      config: { ...refs.config, filters },
    }, user);
    const mapMetrics = (source: Record<string, any> = {}) => {
      const mapped: Record<string, any> = {};
      for (const [planKey, reportKey] of Object.entries(PLAN_FACT_REPORT_METRICS[team])) {
        mapped[planKey] = source[reportKey] ?? { value: null };
      }
      if (team === 'sales') {
        const leads = source.leads_received?.value;
        const quotes = source.kp_presented?.value;
        mapped.sales_conv_lead_to_kp = {
          value: leads != null && leads > 0 && quotes != null ? this.roundMetric(quotes / leads * 100) : null,
        };
      }
      mapped[team + '_shipped_count'] = { value: 0 };
      mapped[team + '_shipped_amount'] = { value: 0 };
      return mapped;
    };
    const rows: any[] = (report.rows ?? []).map((row: any) => ({ ...row, metrics: mapMetrics(row.metrics) }));
    const rowByManager = new Map(rows.map((row: any) => [row.groupId, row]));
    const summary = { metrics: mapMetrics(report.summaryRows?.[0]?.metrics) };
    for (const { deal } of shipping?.entries ?? []) {
      const isCsm = deal.responsible?.group?.id === shipping!.csmGroupId;
      if ((team === 'csm') !== isCsm) continue;
      let row = rowByManager.get(deal.responsibleId);
      if (!row) {
        // No funnel activity is a real zero, not a missing conversion.
        const emptySource = Object.fromEntries(Object.values(PLAN_FACT_REPORT_METRICS[team])
          .map((key) => [key, { value: key.startsWith('conv_') ? null : 0 }]));
        row = { groupId: deal.responsibleId, groupName: deal.responsible?.name ?? 'Без имени', metrics: mapMetrics(emptySource) };
        rows.push(row);
        rowByManager.set(deal.responsibleId, row);
      }
      for (const target of [row, summary]) {
        target.metrics[team + '_shipped_count'].value += 1;
        target.metrics[team + '_shipped_amount'].value += Number(deal.amount ?? 0);
      }
    }
    return { ...report, rows, summaryRows: [summary] };
  }

  private findPlanValue(
    planItems: any[],
    metric: PlanFactMetric,
    targetType: 'MANAGER' | 'GROUP',
    targetId: string,
    targetName: string,
    managerRows?: any[],
    groupTarget?: { targetId: string; targetName: string },
  ) {
    if (metric.kind === 'conversion' && targetType === 'MANAGER' && groupTarget) {
      const shared = planItems.find((item) =>
        item.metricKey === metric.key &&
        item.targetType === 'GROUP' &&
        (item.targetId === groupTarget.targetId ||
          this.normalizeName(item.targetName ?? '') === this.normalizeName(groupTarget.targetName)),
      );
      return shared ? Number(shared.value) : null;
    }

    const direct = planItems.find((item) =>
      item.metricKey === metric.key &&
      item.targetType === targetType &&
      (item.targetId === targetId || this.normalizeName(item.targetName ?? '') === this.normalizeName(targetName)),
    );
    if (direct) return Number(direct.value);
    if (targetType === 'GROUP' && managerRows?.length) {
      const values = managerRows
        .map((row) => row.values?.[metric.key]?.plan)
        .filter((value: unknown): value is number => value != null && Number.isFinite(Number(value)))
        .map(Number);
      if (!values.length) return null;
      return this.roundMetric(values.reduce((sum, value) => sum + value, 0));
    }
    return null;
  }

  private reportMetricValue(report: any, targetId: string, targetType: 'MANAGER' | 'GROUP', metricKey: string) {
    if (!report) return null;
    const row = report.rows?.find((item: any) => item.groupId === targetId);
    if (targetType === 'MANAGER' && !row) {
      return PLAN_FACT_METRICS.find((metric) => metric.key === metricKey)?.kind === 'additive' ? 0 : null;
    }
    const source = targetType === 'GROUP'
      ? report.summaryRows?.[0]?.metrics?.[metricKey]
      : row?.metrics?.[metricKey];
    if (source?.value == null) return null;
    const value = Number(source.value);
    return Number.isFinite(value) ? this.roundMetric(value) : null;
  }
  private nameIncludesAll(value: string, needles: string[]) {
    const normalized = this.normalizeName(value);
    return needles.every((needle) => normalized.includes(this.normalizeName(needle)));
  }

  private normalizeName(value: string) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private roundMetric(value: number) {
    return Number(Number(value).toFixed(2));
  }

  private normalizePlanFactPlanValue(metric: PlanFactMetric, value: Prisma.Decimal) {
    if (metric.unit === 'number') {
      return new Prisma.Decimal(Math.ceil(Number(value.toString())));
    }
    return value;
  }

  private roundPlanFactValue(metric: PlanFactMetric, value: number) {
    if (metric.unit === 'number') return Math.ceil(value);
    return this.roundMetric(value);
  }

  private roundPlanFactDelta(metric: PlanFactMetric, value: number) {
    if (metric.unit === 'number') return Math.round(value);
    return this.roundMetric(value);
  }

  async listQualityRules() {
    await this.ensureDefaultQualityRules();
    return this.prisma.qualityRule.findMany({ orderBy: [{ enabled: 'desc' }, { severity: 'desc' }, { name: 'asc' }] });
  }

  updateQualityRule(id: string, body: Record<string, any>) {
    const data: Prisma.QualityRuleUpdateInput = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.description !== undefined) data.description = this.optionalString(body.description);
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (body.severity !== undefined) data.severity = this.parseQualitySeverity(body.severity);
    if (body.config !== undefined) data.config = this.json(body.config);
    return this.prisma.qualityRule.update({ where: { id }, data });
  }

  async runQualityChecks() {
    await this.ensureDefaultQualityRules();
    const rules = await this.prisma.qualityRule.findMany({ where: { enabled: true } });
    const now = new Date();
    const results = [];

    for (const rule of rules) {
      const violations = await this.detectQualityViolations(rule);
      await this.prisma.qualityViolation.updateMany({
        where: { ruleId: rule.id, resolvedAt: null },
        data: { resolvedAt: now },
      });
      if (violations.length) {
        await this.prisma.qualityViolation.createMany({
          data: violations.map((violation) => ({
            ruleId: rule.id,
            managerId: violation.managerId ?? null,
            managerName: violation.managerName ?? null,
            groupId: violation.groupId ?? null,
            groupName: violation.groupName ?? null,
            dealId: violation.dealId ?? null,
            taskId: (violation as any).taskId ?? null,
            severity: rule.severity,
            message: violation.message,
            payload: this.json(violation.payload ?? {}),
            detectedAt: now,
          })),
        });
      }
      await this.prisma.qualitySnapshot.create({
        data: {
          ruleId: rule.id,
          violationsCount: violations.length,
          score: Math.max(0, 100 - violations.length),
          payload: this.json({ code: rule.code }),
          createdAt: now,
        },
      });
      results.push({ ruleId: rule.id, code: rule.code, name: rule.name, violations: violations.length });
    }
    return { checkedRules: rules.length, results };
  }

  listQualityViolations(resolved = false) {
    return this.prisma.qualityViolation.findMany({
      where: resolved ? { resolvedAt: { not: null } } : { resolvedAt: null },
      include: { rule: true },
      orderBy: { detectedAt: 'desc' },
      take: 200,
    });
  }

  listSchedules(user: AuthUser) {
    return this.prisma.reportSchedule.findMany({
      where: user.role === 'ADMIN' ? {} : { userId: user.id },
      include: {
        reportTemplate: { select: { id: true, name: true, sourceType: true } },
        logs: { orderBy: { createdAt: 'desc' }, take: 3 },
      },
      orderBy: [{ enabled: 'desc' }, { nextRunAt: 'asc' }],
    });
  }

  async createSchedule(user: AuthUser, body: Record<string, any>) {
    if (!body.name) throw new BadRequestException('Название расписания обязательно');
    const frequency = this.parseScheduleFrequency(body.frequency);
    const timeOfDay = String(body.timeOfDay ?? '09:00');
    const schedule = await this.prisma.reportSchedule.create({
      data: {
        userId: user.id,
        reportTemplateId: this.optionalString(body.reportTemplateId),
        name: String(body.name),
        enabled: body.enabled === undefined ? true : Boolean(body.enabled),
        frequency,
        cron: this.optionalString(body.cron),
        timeOfDay,
        timezone: String(body.timezone ?? 'Europe/Moscow'),
        recipients: this.json(this.parseRecipients(body.recipients, user.id)),
        format: String(body.format ?? 'telegram'),
        nextRunAt: this.nextScheduleRun(frequency, timeOfDay),
      },
    });
    await this.audit.record({ userId: user.id, action: 'platform.schedule.create', entity: 'ReportSchedule', entityId: schedule.id });
    return schedule;
  }

  async updateSchedule(user: AuthUser, id: string, body: Record<string, any>) {
    const existing = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Расписание не найдено');
    this.ensureOwner(user, existing.userId);

    const frequency = body.frequency !== undefined ? this.parseScheduleFrequency(body.frequency) : existing.frequency;
    const timeOfDay = body.timeOfDay !== undefined ? String(body.timeOfDay) : existing.timeOfDay;
    const data: Prisma.ReportScheduleUpdateInput = {};
    if (body.name !== undefined) data.name = String(body.name);
    if (body.enabled !== undefined) data.enabled = Boolean(body.enabled);
    if (body.reportTemplateId !== undefined) {
      data.reportTemplate = body.reportTemplateId ? { connect: { id: String(body.reportTemplateId) } } : { disconnect: true };
    }
    if (body.frequency !== undefined) data.frequency = frequency;
    if (body.cron !== undefined) data.cron = this.optionalString(body.cron);
    if (body.timeOfDay !== undefined) data.timeOfDay = timeOfDay;
    if (body.timezone !== undefined) data.timezone = String(body.timezone);
    if (body.recipients !== undefined) data.recipients = this.json(this.parseRecipients(body.recipients, existing.userId));
    if (body.format !== undefined) data.format = String(body.format);
    if (body.frequency !== undefined || body.timeOfDay !== undefined) data.nextRunAt = this.nextScheduleRun(frequency, timeOfDay);
    return this.prisma.reportSchedule.update({ where: { id }, data });
  }

  async deleteSchedule(user: AuthUser, id: string) {
    const existing = await this.prisma.reportSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Расписание не найдено');
    this.ensureOwner(user, existing.userId);
    await this.prisma.reportSchedule.delete({ where: { id } });
    return { ok: true };
  }

  async runScheduleNow(user: AuthUser, id: string) {
    const schedule = await this.prisma.reportSchedule.findUnique({ where: { id }, include: { reportTemplate: true, user: true } });
    if (!schedule) throw new NotFoundException('Расписание не найдено');
    this.ensureOwner(user, schedule.userId);
    return this.deliverSchedule(schedule, new Date(), true);
  }

  async processSchedules() {
    const now = new Date();
    const schedules = await this.prisma.reportSchedule.findMany({
      where: {
        enabled: true,
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      include: { reportTemplate: true, user: true },
      take: 25,
    });
    const results = [];
    for (const schedule of schedules) {
      try {
        results.push(await this.deliverSchedule(schedule, now));
      } catch (error: any) {
        this.logger.warn(`Schedule failed ${schedule.id}: ${error.message}`);
        results.push({ id: schedule.id, status: 'ERROR', error: error.message });
      }
    }
    return { processed: results.length, results };
  }

  private async checkAlert(alert: any, now: Date) {
    await this.prisma.alertRule.update({ where: { id: alert.id }, data: { lastCheckedAt: now } });
    if (!alert.reportTemplate || !alert.user) {
      return { id: alert.id, name: alert.name, status: 'SKIPPED', reason: 'Не выбран отчёт' };
    }
    const config = alert.reportTemplate.config as Record<string, any>;
    const report = await this.reports.compute(
      {
        name: alert.reportTemplate.name,
        sourceType: alert.reportTemplate.sourceType,
        filters: config.filters ?? {},
        config,
      },
      { id: alert.user.id, role: alert.user.role as UserRole },
    );
    const value = this.extractAlertValue(report, alert.metricKey ?? (alert.condition as any)?.metricKey);
    const threshold = alert.threshold == null ? null : Number(alert.threshold);
    const triggered = threshold != null && value != null && this.compare(value, threshold, alert.operator);
    const cooldownActive = alert.lastTriggeredAt
      ? now.getTime() - alert.lastTriggeredAt.getTime() < alert.cooldownMinutes * 60_000
      : false;

    if (!triggered || cooldownActive) {
      return { id: alert.id, name: alert.name, status: cooldownActive ? 'COOLDOWN' : 'OK', value, threshold };
    }

    const recipients = this.parseRecipients(alert.recipients, alert.userId);
    const message = [
      `Алерт: ${alert.name}`,
      `Отчёт: ${alert.reportTemplate.name}`,
      `Значение: ${value}`,
      `Условие: ${this.operatorLabel(alert.operator)} ${threshold}`,
    ].join('\n');
    const event = await this.prisma.alertEvent.create({
      data: {
        alertRuleId: alert.id,
        value: new Prisma.Decimal(value),
        message,
        payload: this.json({ reportTemplateId: alert.reportTemplateId, metricKey: alert.metricKey }),
      },
    });
    const deliveries = await this.telegram.sendMessageToUsers(recipients, message, { type: 'alert', alertRuleId: alert.id }, event.id);
    const status = this.deliveryStatus(deliveries.map((delivery) => delivery.status));
    await this.prisma.alertEvent.update({
      where: { id: event.id },
      data: { status, sentAt: status === 'SENT' ? new Date() : null },
    });
    await this.prisma.alertRule.update({ where: { id: alert.id }, data: { lastTriggeredAt: now } });
    return { id: alert.id, name: alert.name, status, value, threshold, deliveries: deliveries.length };
  }

  private async deliverSchedule(schedule: any, now: Date, manual = false) {
    const nextRunAt = this.nextScheduleRun(schedule.frequency, schedule.timeOfDay, now);
    if (!schedule.reportTemplate) {
      const log = await this.prisma.reportDeliveryLog.create({
        data: { scheduleId: schedule.id, status: 'ERROR', error: 'Не выбран отчёт', payload: this.json({ manual }) },
      });
      await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now, nextRunAt } });
      return { id: schedule.id, status: log.status, error: log.error };
    }

    const config = schedule.reportTemplate.config as Record<string, any>;
    const report = await this.reports.compute(
      {
        name: schedule.reportTemplate.name,
        sourceType: schedule.reportTemplate.sourceType,
        filters: config.filters ?? {},
        config,
      },
      { id: schedule.userId, role: schedule.user.role },
    );
    const message = this.reportTelegramMessage(schedule.reportTemplate.name, report);
    const recipients = this.parseRecipients(schedule.recipients, schedule.userId);
    const deliveries = await this.telegram.sendMessageToUsers(recipients, message, {
      type: 'scheduled_report',
      scheduleId: schedule.id,
    });
    const status = this.deliveryStatus(deliveries.map((delivery) => delivery.status));
    await this.prisma.reportDeliveryLog.create({
      data: {
        scheduleId: schedule.id,
        status,
        message,
        payload: this.json({ manual, reportTemplateId: schedule.reportTemplateId }),
        sentAt: status === 'SENT' ? new Date() : null,
      },
    });
    await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now, nextRunAt } });
    return { id: schedule.id, status, deliveries: deliveries.length, nextRunAt };
  }

  private alertIsDue(alert: { lastCheckedAt: Date | null; checkEveryMinutes: number }, now: Date) {
    if (!alert.lastCheckedAt) return true;
    return now.getTime() - alert.lastCheckedAt.getTime() >= alert.checkEveryMinutes * 60_000;
  }

  private async ensureDefaultQualityRules() {
    const defaults = [
      {
        code: 'open_deal_without_task',
        name: 'Открытая сделка без запланированного действия',
        description: 'У менеджера нет запланированного действия по открытой сделке.',
        severity: 'CRITICAL' as QualitySeverity,
        config: { type: 'deal_without_active_task' },
      },
      {
        code: 'overdue_task',
        name: 'Просроченная задача',
        description: 'Задача не завершена и срок уже прошёл.',
        severity: 'WARNING' as QualitySeverity,
        config: { type: 'overdue_task' },
      },
      {
        code: 'stale_open_deal',
        name: 'Открытая сделка без движения',
        description: 'Сделка давно не обновлялась.',
        severity: 'WARNING' as QualitySeverity,
        config: { type: 'stale_open_deal', maxIdleDays: 7 },
      },
      {
        code: 'deal_without_responsible',
        name: 'Сделка без ответственного',
        description: 'Открытая сделка не закреплена за менеджером.',
        severity: 'CRITICAL' as QualitySeverity,
        config: { type: 'deal_without_responsible' },
      },
      {
        code: 'task_without_due_date',
        name: 'Задача без срока',
        description: 'Активная задача не имеет даты выполнения.',
        severity: 'INFO' as QualitySeverity,
        config: { type: 'task_without_due_date' },
      },
    ];
    for (const item of defaults) {
      await this.prisma.qualityRule.upsert({
        where: { code: item.code },
        create: { ...item, config: this.json(item.config) },
        update: {
          name: item.name,
          description: item.description,
          severity: item.severity,
          config: this.json(item.config),
        },
      });
    }
  }

  private async detectQualityViolations(rule: QualityRule) {
    const config = rule.config as Record<string, any>;
    const type = config.type ?? rule.code;
    if (type === 'deal_without_active_task') return this.findDealsWithoutActiveTask(rule);
    if (type === 'overdue_task') return this.findOverdueTasks();
    if (type === 'stale_open_deal') return this.findStaleOpenDeals(Number(config.maxIdleDays ?? 7));
    if (type === 'deal_without_responsible') return this.findDealsWithoutResponsible();
    if (type === 'task_without_due_date') return this.findTasksWithoutDueDate();
    return [];
  }

  private async findDealsWithoutActiveTask(rule: QualityRule) {
    const deals = (await this.prisma.factDealCurrent.findMany({
      where: {
        deletedAt: null,
        stageIsWon: false,
        stageIsLost: false,
      },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    })).map((deal) => ({ ...this.factDealToQualityDeal(deal), dealId: deal.dealId }));
    const dealIds = deals.map((deal) => deal.dealId);
    const activeTasks = dealIds.length
      ? await this.prisma.task.findMany({
          where: { dealId: { in: dealIds }, isCompleted: false },
          select: { dealId: true },
        })
      : [];
    const dealIdsWithTasks = new Set(activeTasks.map((task) => task.dealId).filter(Boolean));
    return deals
      .filter((deal) => !dealIdsWithTasks.has(deal.dealId))
      .map((deal) => this.dealViolation(rule, deal, `Нет следующей задачи: ${deal.title}`));
  }

  private async findOverdueTasks() {
    const tasks = await this.prisma.task.findMany({
      where: { isCompleted: false, dueAt: { lt: new Date() } },
      include: { responsible: { include: { group: true } }, deal: true },
      take: 1000,
    });
    return tasks.map((task) => ({
      taskId: task.id,
      dealId: task.dealId ?? null,
      managerId: task.responsibleId ?? null,
      managerName: task.responsible?.name ?? null,
      groupId: task.responsible?.groupId ?? null,
      groupName: task.responsible?.group?.name ?? null,
      message: `Просрочена задача: ${task.title}`,
      payload: { dueAt: task.dueAt, typeName: task.typeName },
    }));
  }

  private async findStaleOpenDeals(maxIdleDays: number) {
    const cutoff = new Date(Date.now() - Math.max(maxIdleDays, 1) * 86_400_000);
    const deals = (await this.prisma.factDealCurrent.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: cutoff },
        stageIsWon: false,
        stageIsLost: false,
      },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    })).map((deal) => this.factDealToQualityDeal(deal));
    return deals.map((deal) => ({
      ...this.dealViolation(null, deal, `Давно не было движения: ${deal.title}`),
      payload: { updatedAt: deal.updatedAt, maxIdleDays },
    }));
  }

  private async findDealsWithoutResponsible() {
    const deals = (await this.prisma.factDealCurrent.findMany({
      where: {
        deletedAt: null,
        responsibleId: null,
        stageIsWon: false,
        stageIsLost: false,
      },
      orderBy: { updatedAt: 'asc' },
      take: 1000,
    })).map((deal) => this.factDealToQualityDeal(deal));
    return deals.map((deal) => this.dealViolation(null, deal, `Нет ответственного: ${deal.title}`));
  }

  private async findTasksWithoutDueDate() {
    const tasks = await this.prisma.task.findMany({
      where: { isCompleted: false, dueAt: null },
      include: { responsible: { include: { group: true } }, deal: true },
      take: 1000,
    });
    return tasks.map((task) => ({
      taskId: task.id,
      dealId: task.dealId ?? null,
      managerId: task.responsibleId ?? null,
      managerName: task.responsible?.name ?? null,
      groupId: task.responsible?.groupId ?? null,
      groupName: task.responsible?.group?.name ?? null,
      message: `У задачи нет срока: ${task.title}`,
      payload: { typeName: task.typeName },
    }));
  }

  private dealViolation(_rule: QualityRule | null, deal: any, message: string) {
    return {
      dealId: deal.id,
      managerId: deal.responsibleId ?? null,
      managerName: deal.responsible?.name ?? null,
      groupId: deal.responsible?.groupId ?? null,
      groupName: deal.responsible?.group?.name ?? null,
      message,
      payload: { externalId: deal.externalId, amount: Number(deal.amount) },
    };
  }

  private factDealToQualityDeal(deal: Prisma.FactDealCurrentGetPayload<Record<string, never>>) {
    return {
      id: deal.dealId,
      externalId: deal.dealExternalId,
      title: deal.title,
      amount: deal.amount,
      updatedAt: deal.updatedAt,
      responsibleId: deal.responsibleId,
      responsible: deal.responsibleId || deal.responsibleName || deal.groupId || deal.groupName
        ? {
            id: deal.responsibleId,
            name: deal.responsibleName,
            groupId: deal.groupId,
            group: deal.groupName ? { name: deal.groupName } : null,
          }
        : null,
    };
  }

  private async computePlanFact(item: any) {
    const baseWhere: Record<string, any> = {};
    if (item.targetType === 'MANAGER' && item.targetId) baseWhere.responsibleId = item.targetId;
    if (item.targetType === 'GROUP' && item.targetId) baseWhere.responsible = { groupId: item.targetId };

    if (item.metricKey === 'deal_count') {
      return this.prisma.deal.count({ where: { ...baseWhere, deletedAt: null, createdAt: { gte: item.periodStart, lte: item.periodEnd } } });
    }
    if (item.metricKey === 'deal_amount') {
      const aggregate = await this.prisma.deal.aggregate({
        where: { ...baseWhere, deletedAt: null, createdAt: { gte: item.periodStart, lte: item.periodEnd } },
        _sum: { amount: true },
      });
      return Number(aggregate._sum.amount ?? 0);
    }
    if (item.metricKey === 'closed_deal_count') {
      return this.prisma.deal.count({ where: { ...baseWhere, deletedAt: null, closedAt: { gte: item.periodStart, lte: item.periodEnd } } });
    }
    if (item.metricKey === 'closed_amount') {
      const aggregate = await this.prisma.deal.aggregate({
        where: { ...baseWhere, deletedAt: null, closedAt: { gte: item.periodStart, lte: item.periodEnd } },
        _sum: { amount: true },
      });
      return Number(aggregate._sum.amount ?? 0);
    }
    if (item.metricKey === 'task_count') {
      return this.prisma.task.count({
        where: { ...baseWhere, dueAt: { gte: item.periodStart, lte: item.periodEnd } },
      });
    }
    return null;
  }

  private extractAlertValue(report: any, metricKey?: string | null) {
    if (!metricKey) return null;
    const direct = this.getByPath(report, metricKey);
    if (Number.isFinite(Number(direct))) return Number(direct);
    if (Array.isArray(report?.tableRows)) {
      const fromTable = report.tableRows.find((row: Record<string, unknown>) => row[metricKey] !== undefined)?.[metricKey];
      if (Number.isFinite(Number(fromTable))) return Number(fromTable);
    }
    for (const row of report?.rows ?? []) {
      const metric = row.metrics?.[metricKey] ?? Object.values(row.metrics ?? {}).find((item: any) => item.label === metricKey);
      if (Number.isFinite(Number((metric as any)?.value))) return Number((metric as any).value);
    }
    return null;
  }

  private getByPath(source: any, path: string) {
    return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), source);
  }

  private compare(value: number, threshold: number, operator: AlertOperator) {
    if (operator === 'GT') return value > threshold;
    if (operator === 'GTE') return value >= threshold;
    if (operator === 'LT') return value < threshold;
    if (operator === 'LTE') return value <= threshold;
    if (operator === 'EQ') return value === threshold;
    if (operator === 'NEQ') return value !== threshold;
    return false;
  }

  private operatorLabel(operator: AlertOperator) {
    return ({ GT: '>', GTE: '>=', LT: '<', LTE: '<=', EQ: '=', NEQ: '!=' } as Record<AlertOperator, string>)[operator];
  }

  private reportTelegramMessage(name: string, report: any) {
    const lines = [`Отчёт: ${name}`];
    if (report?.summary) {
      if (report.summary.count !== undefined) lines.push(`Количество: ${report.summary.count}`);
      if (report.summary.totalAmount !== undefined) lines.push(`Сумма: ${Math.round(report.summary.totalAmount).toLocaleString('ru-RU')} ₽`);
      if (report.summary.avgAmount !== undefined) lines.push(`Средний чек: ${Math.round(report.summary.avgAmount).toLocaleString('ru-RU')} ₽`);
    }
    if (Array.isArray(report?.tableRows)) {
      lines.push(`Строк в таблице: ${report.tableRows.length}`);
      const firstRow = report.tableRows[0];
      if (firstRow) {
        const preview = Object.entries(firstRow)
          .slice(0, 4)
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ');
        lines.push(preview);
      }
    }
    if (Array.isArray(report?.steps)) {
      for (const step of report.steps.slice(0, 5)) {
        lines.push(`${step.label}: ${step.count}`);
      }
    }
    if (report?.comparison?.available) {
      const first = report.comparison.metrics?.[0];
      if (first) lines.push(`К прошлому периоду: ${first.delta > 0 ? '+' : ''}${first.delta}`);
    }
    return lines.join('\n');
  }

  private deliveryStatus(statuses: DeliveryStatus[]) {
    if (statuses.some((status) => status === 'SENT')) return 'SENT' as DeliveryStatus;
    if (statuses.some((status) => status === 'ERROR')) return 'ERROR' as DeliveryStatus;
    return 'SKIPPED' as DeliveryStatus;
  }

  private nextScheduleRun(frequency: ReportScheduleFrequency, timeOfDay: string, from = new Date()) {
    const [hoursRaw, minutesRaw] = timeOfDay.split(':');
    const hours = Math.min(Math.max(Number(hoursRaw) || 9, 0), 23);
    const minutes = Math.min(Math.max(Number(minutesRaw) || 0, 0), 59);
    const next = new Date(from);
    next.setHours(hours, minutes, 0, 0);
    if (next <= from) {
      if (frequency === 'WEEKLY') next.setDate(next.getDate() + 7);
      else if (frequency === 'MONTHLY') next.setMonth(next.getMonth() + 1);
      else next.setDate(next.getDate() + 1);
    }
    return next;
  }

  private async buildEmailThreadDrafts(dealIds?: string[]) {
    const where: Prisma.Sql[] = [
      Prisma.sql`fact."deleted_at" IS NULL`,
      Prisma.sql`fact."stage_is_won" = false`,
      Prisma.sql`fact."stage_is_lost" = false`,
    ];
    if (dealIds?.length) where.push(Prisma.sql`fact."deal_id" IN (${Prisma.join(dealIds)})`);

    const openDealRows = await this.prisma.$queryRaw<Array<{
      id: string;
      externalId: string;
      title: string;
      amount: Prisma.Decimal;
      contactId: string | null;
      pipelineName: string;
      stageName: string;
      responsibleName: string | null;
      responsibleExternalId: string | null;
      groupName: string | null;
      contactExternalId: string | null;
      contactName: string | null;
      contactEmail: string | null;
      embeddedContactExternalIds: string[];
    }>>`
      SELECT
        fact."deal_id" AS "id",
        fact."deal_external_id" AS "externalId",
        fact."title",
        fact."amount",
        fact."contact_id" AS "contactId",
        fact."pipeline_name" AS "pipelineName",
        fact."stage_name" AS "stageName",
        fact."responsible_name" AS "responsibleName",
        fact."responsible_external_id" AS "responsibleExternalId",
        fact."group_name" AS "groupName",
        fact."contact_external_id" AS "contactExternalId",
        fact."contact_name" AS "contactName",
        fact."contact_email" AS "contactEmail",
        COALESCE((
          SELECT ARRAY_AGG(DISTINCT contact_item->>'id')
          FROM jsonb_array_elements(COALESCE(source_deal."raw" #> '{_embedded,contacts}', '[]'::jsonb)) contact_item
          WHERE contact_item->>'id' IS NOT NULL AND contact_item->>'id' <> ''
        ), ARRAY[]::TEXT[]) AS "embeddedContactExternalIds"
      FROM "fact_deal_current" fact
      LEFT JOIN "Deal" source_deal ON source_deal."id" = fact."deal_id"
      WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY fact."created_at" ASC
    `;
    const openDeals = openDealRows.map((deal) => this.factDealToEmailDraftDeal(deal));
    if (openDeals.length === 0) return [];

    const drafts = new Map<string, EmailThreadDraft>();
    const storedNoteIds = new Set<string>();
    const internalEmailDomains = await this.emailInternalDomains();
    const openDealsById = new Map(openDeals.map((deal) => [deal.id, deal]));
    const leadExternalToDealId = new Map<string, string>();
    const contactExternalToDealIds = new Map<string, Set<string>>();
    const draftsByDealId = new Map<string, EmailThreadDraft[]>();

    for (const deal of openDeals) {
      leadExternalToDealId.set(deal.externalId, deal.id);
      for (const contactExternalId of this.dealContactExternalIds(deal)) {
        if (!contactExternalToDealIds.has(contactExternalId)) {
          contactExternalToDealIds.set(contactExternalId, new Set());
        }
        contactExternalToDealIds.get(contactExternalId)?.add(deal.id);
      }
    }

    const noteEntityIds = [...new Set([...leadExternalToDealId.keys(), ...contactExternalToDealIds.keys()])];
    const openDealIds = openDeals.map((deal) => deal.id);
    const noteEntityWhere = noteEntityIds.length
      ? Prisma.sql`("dealId" IN (${Prisma.join(openDealIds)}) OR raw->>'entity_id' IN (${Prisma.join(noteEntityIds)}))`
      : Prisma.sql`"dealId" IN (${Prisma.join(openDealIds)})`;
    const noteRows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "Note"
      WHERE type = 'amomail_message' AND ${noteEntityWhere}
      ORDER BY "createdAt" ASC
    `);

    const ensureDraft = (deal: EmailThreadDraft['deal'], threadId: string) => {
      const key = `${deal.id}:${threadId}`;
      let draft = drafts.get(key);
      if (!draft) {
        draft = {
          deal,
          threadId,
          messages: [],
        };
        drafts.set(key, draft);
        if (!draftsByDealId.has(deal.id)) draftsByDealId.set(deal.id, []);
        draftsByDealId.get(deal.id)?.push(draft);
      }
      return draft;
    };

    for (const noteIdChunk of this.chunks(noteRows.map((row) => row.id), EMAIL_THREAD_SOURCE_LOOKUP_BATCH_SIZE)) {
      const notes = await this.prisma.note.findMany({
        where: { id: { in: noteIdChunk } },
        orderBy: { createdAt: 'asc' },
        select: {
          externalId: true,
          dealId: true,
          createdAt: true,
          text: true,
          raw: true,
        },
      });

      for (const note of notes) {
        const targetDeals = new Map<string, EmailThreadDraft['deal']>();
        const directDeal = note.dealId ? openDealsById.get(note.dealId) : null;
        if (directDeal) targetDeals.set(directDeal.id, directDeal);

        const noteEntityId = this.emailNoteEntityId(note.raw);
        if (noteEntityId) {
          const leadDeal = openDealsById.get(leadExternalToDealId.get(noteEntityId) ?? '');
          if (leadDeal) targetDeals.set(leadDeal.id, leadDeal);
          for (const dealId of contactExternalToDealIds.get(noteEntityId) ?? []) {
            const contactDeal = openDealsById.get(dealId);
            if (contactDeal) targetDeals.set(contactDeal.id, contactDeal);
          }
        }

        if (targetDeals.size === 0) continue;

        const params = this.emailNoteParams(note.raw, note.text);
        const threadId = params.threadId || `note:${note.externalId}`;

        storedNoteIds.add(note.externalId);

        for (const deal of targetDeals.values()) {
          const direction = this.emailDirection(params, internalEmailDomains);
          const ownDraft = ensureDraft(deal, threadId);
          const targetDrafts = direction === 'incoming'
            ? [ownDraft]
            : (draftsByDealId.get(deal.id)?.length ? draftsByDealId.get(deal.id) ?? [] : [ownDraft]);

          for (const draft of targetDrafts) {
            this.appendEmailDraftMessage(draft, {
              id: `note:${note.externalId}:${draft.threadId}:${deal.id}`,
              noteExternalId: note.externalId,
              direction,
              createdAt: note.createdAt,
              subject: params.subject,
              summary: params.summary,
              body: params.body,
              from: params.from,
              to: params.to,
              attachCount: params.attachCount,
              deliveryStatus: params.deliveryStatus,
              source: 'note',
            });
          }
        }
      }
    }

    for (const eventEntityIdChunk of this.chunks(noteEntityIds, EMAIL_EVENT_SCAN_BATCH_SIZE)) {
      const mailEvents = await this.prisma.$queryRaw<Array<{
        id: string;
        externalId: string;
        type: 'incoming_mail' | 'outgoing_mail';
        createdAt: Date;
        raw: Prisma.JsonValue;
      }>>`
        SELECT event."id", event."externalId", event."type", event."createdAt", event."raw"
        FROM "CrmEvent" event
        WHERE event."type" IN ('incoming_mail', 'outgoing_mail')
          AND (
            event."raw"->>'entity_id' IN (${Prisma.join(eventEntityIdChunk)})
            OR event."raw" #>> '{_embedded,entity,id}' IN (${Prisma.join(eventEntityIdChunk)})
          )
        ORDER BY event."createdAt" ASC, event."id" ASC
      `;
      if (!mailEvents.length) continue;

      const eventNoteIds = [...new Set(mailEvents.map((event) => this.emailEventNoteId(event.raw)).filter(Boolean))] as string[];
      const eventNotes = eventNoteIds.length
        ? await this.prisma.note.findMany({
          where: { externalId: { in: eventNoteIds } },
          select: { externalId: true, raw: true, text: true },
        })
        : [];
      const eventNotesByExternalId = new Map(eventNotes.map((note) => [note.externalId, note]));

      for (const event of mailEvents) {
        const noteExternalId = this.emailEventNoteId(event.raw);
        if (noteExternalId && storedNoteIds.has(noteExternalId)) continue;
        const eventNote = noteExternalId ? eventNotesByExternalId.get(noteExternalId) : null;
        const eventParams = this.emailNoteParams(eventNote?.raw, eventNote?.text);

        const entity = this.emailEventEntity(event.raw);
        const dealIds = new Set<string>();
        if (entity.type === 'lead') {
          const dealId = leadExternalToDealId.get(entity.id);
          if (dealId) dealIds.add(dealId);
        }
        if (entity.type === 'contact') {
          for (const dealId of contactExternalToDealIds.get(entity.id) ?? []) dealIds.add(dealId);
        }

        for (const dealId of dealIds) {
          const deal = openDealsById.get(dealId);
          if (!deal) continue;

          const direction = this.emailDirection(eventParams, internalEmailDomains, event.type);
          const threadId = this.emailEventThreadId(entity, deal.externalId);
          const targetDrafts = direction === 'incoming'
            ? [ensureDraft(deal, threadId)]
            : (draftsByDealId.get(dealId)?.length ? draftsByDealId.get(dealId) ?? [] : [ensureDraft(deal, threadId)]);

          for (const draft of targetDrafts) {
            if (direction === 'outgoing') {
              const firstMessage = draft.messages[0];
              if (firstMessage && event.createdAt < firstMessage.createdAt) continue;
            }
            this.appendEmailDraftMessage(draft, {
              id: `event:${event.externalId}:${dealId}`,
              noteExternalId: direction === 'incoming' ? `event:${event.externalId}` : noteExternalId,
              direction,
              createdAt: event.createdAt,
              subject: eventParams.subject,
              summary: eventParams.summary ?? (direction === 'incoming' ? 'Входящее письмо в amoCRM' : 'Исходящее письмо в amoCRM'),
              body: eventParams.body,
              from: eventParams.from,
              to: eventParams.to,
              attachCount: eventParams.attachCount,
              deliveryStatus: eventParams.deliveryStatus,
              source: 'event',
            });
          }
        }
      }

    }

    for (const draft of drafts.values()) {
      draft.messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    this.closeEmailDraftsByDealReplies(draftsByDealId);

    for (const draft of drafts.values()) {
      draft.messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    return [...drafts.values()];
  }

  private factDealToEmailDraftDeal(deal: {
    id: string;
    externalId: string;
    title: string;
    amount: unknown;
    contactId: string | null;
    pipelineName: string;
    stageName: string;
    responsibleName: string | null;
    responsibleExternalId: string | null;
    groupName: string | null;
    contactExternalId: string | null;
    contactName: string | null;
    contactEmail: string | null;
    embeddedContactExternalIds?: string[];
  }): EmailThreadDraft['deal'] {
    const contactExternalIds = [
      deal.contactExternalId,
      ...(deal.embeddedContactExternalIds ?? []),
    ].filter((id): id is string => Boolean(id));

    return {
      id: deal.id,
      externalId: deal.externalId,
      title: deal.title,
      amount: deal.amount,
      contactId: deal.contactId,
      pipeline: { name: deal.pipelineName },
      stage: { name: deal.stageName },
      responsible: deal.responsibleName || deal.responsibleExternalId || deal.groupName
        ? {
            name: deal.responsibleName ?? '\u0411\u0435\u0437 \u043c\u0435\u043d\u0435\u0434\u0436\u0435\u0440\u0430',
            externalId: deal.responsibleExternalId,
            group: deal.groupName ? { name: deal.groupName } : null,
          }
        : null,
      contact: deal.contactExternalId || deal.contactName || deal.contactEmail
        ? {
            externalId: deal.contactExternalId ?? '',
            name: deal.contactName ?? '',
            email: deal.contactEmail,
          }
        : null,
      contactExternalIds,
    };
  }

  private closeEmailDraftsByDealReplies(draftsByDealId: Map<string, EmailThreadDraft[]>) {
    for (const dealDrafts of draftsByDealId.values()) {
      const outgoingMessages = dealDrafts
        .flatMap((draft) => draft.messages.filter((message) => message.direction === 'outgoing'))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      if (!outgoingMessages.length) continue;

      for (const draft of dealDrafts) {
        const incomingMessages = draft.messages.filter((message) => message.direction === 'incoming');
        const lastIncoming = incomingMessages[incomingMessages.length - 1];
        if (!lastIncoming) continue;

        const hasLaterOutgoing = draft.messages.some(
          (message) => message.direction === 'outgoing' && message.createdAt > lastIncoming.createdAt,
        );
        if (hasLaterOutgoing) continue;

        const closingOutgoing = outgoingMessages.find((message) => message.createdAt > lastIncoming.createdAt);
        if (!closingOutgoing) continue;

        this.appendEmailDraftMessage(draft, {
          ...closingOutgoing,
          id: `${closingOutgoing.id}:closes:${draft.threadId}`,
        });
      }
    }
  }

  private appendEmailDraftMessage(draft: EmailThreadDraft, message: EmailMessageItem) {
    draft.messages.push(message);
    if (draft.messages.length > EMAIL_THREAD_DRAFT_MESSAGE_LIMIT) {
      draft.messages.splice(0, draft.messages.length - EMAIL_THREAD_DRAFT_MESSAGE_LIMIT);
    }
  }

  private emailThreadStateData(draft: EmailThreadDraft): Prisma.EmailThreadStateCreateManyInput | null {
    const messages = [...draft.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage) return null;

    const incomingMessages = messages.filter((message) => message.direction === 'incoming');
    const outgoingMessages = messages.filter((message) => message.direction === 'outgoing');
    const lastIncoming = incomingMessages[incomingMessages.length - 1] ?? null;
    const lastOutgoing = outgoingMessages[outgoingMessages.length - 1] ?? null;
    const isPending = Boolean(
      lastIncoming?.noteExternalId && (!lastOutgoing || lastOutgoing.createdAt <= lastIncoming.createdAt),
    );
    const displayMessage = lastIncoming ?? lastMessage;

    return {
      dealId: draft.deal.id,
      threadId: draft.threadId,
      lastIncomingNoteExternalId: lastIncoming?.noteExternalId ?? null,
      lastIncomingAt: lastIncoming?.createdAt ?? null,
      lastOutgoingAt: lastOutgoing?.createdAt ?? null,
      lastMessageAt: lastMessage.createdAt,
      subject: this.truncateEmailText(displayMessage.subject, EMAIL_THREAD_SUBJECT_LIMIT),
      summary: this.truncateEmailText(displayMessage.summary, EMAIL_THREAD_SUMMARY_LIMIT),
      body: this.truncateEmailText(displayMessage.body, EMAIL_THREAD_BODY_LIMIT),
      from: this.truncateEmailText(displayMessage.from, EMAIL_THREAD_PARTY_LIMIT),
      to: this.truncateEmailText(displayMessage.to, EMAIL_THREAD_PARTY_LIMIT),
      attachCount: displayMessage.attachCount,
      deliveryStatus: displayMessage.deliveryStatus,
      messages: this.emailThreadStateMessages(messages) as Prisma.InputJsonValue,
      isPending,
    };
  }

  private emailThreadStateMessages(messages: EmailMessageItem[]) {
    return messages.slice(-EMAIL_THREAD_STATE_MESSAGE_LIMIT).map((message) => ({
      id: message.id,
      noteExternalId: message.noteExternalId ?? null,
      direction: message.direction,
      createdAt: message.createdAt.toISOString(),
      subject: this.truncateEmailText(message.subject, EMAIL_THREAD_SUBJECT_LIMIT),
      summary: this.truncateEmailText(message.summary, EMAIL_THREAD_SUMMARY_LIMIT),
      body: this.truncateEmailText(message.body, EMAIL_THREAD_BODY_LIMIT),
      from: this.truncateEmailText(message.from, EMAIL_THREAD_PARTY_LIMIT),
      to: this.truncateEmailText(message.to, EMAIL_THREAD_PARTY_LIMIT),
      attachCount: message.attachCount,
      deliveryStatus: message.deliveryStatus,
      source: message.source,
    }));
  }

  private serializePendingEmailThreadState(
    state: EmailThreadStateView,
    now: Date,
    domain: string,
    dismissedKeys: Set<string>,
  ) {
    if (!state.lastIncomingAt || !state.lastIncomingNoteExternalId) return null;

    const dismissalKey = this.emailDismissalKey(state.dealId, state.threadId, state.lastIncomingNoteExternalId);
    if (dismissedKeys.has(dismissalKey)) return null;

    const pipelineKey = this.emailPipelineKey(state.deal.pipeline?.name);
    if (!pipelineKey) return null;
    if (!this.isEmailThreadStageAllowed(pipelineKey, state.deal.stage?.name)) return null;

    const waitingSeconds = Math.max(0, Math.floor((now.getTime() - state.lastIncomingAt.getTime()) / 1000));
    return {
      id: dismissalKey,
      pipelineKey,
      dealId: state.deal.id,
      dealExternalId: state.deal.externalId,
      title: state.deal.title,
      amount: Number(state.deal.amount ?? 0),
      managerName: state.deal.responsible?.name ?? 'Без менеджера',
      managerExternalId: state.deal.responsible?.externalId ?? null,
      groupName: state.deal.responsible?.group?.name ?? '-',
      pipelineName: state.deal.pipeline?.name ?? '-',
      stageName: state.deal.stage?.name ?? '-',
      contactName: state.deal.contact?.name ?? null,
      contactEmail: state.deal.contact?.email ?? null,
      threadId: state.threadId,
      lastIncomingNoteExternalId: state.lastIncomingNoteExternalId,
      lastIncomingAt: state.lastIncomingAt.toISOString(),
      waitingSeconds,
      subject: state.subject,
      summary: state.summary,
      attachCount: state.attachCount,
      dealUrl: this.dealUrl(domain, state.deal.externalId),
      messages: this.emailThreadMessagesFromState(state.messages),
    };
  }

  private emailThreadMessagesFromState(value: Prisma.JsonValue) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((message): message is Record<string, any> => Boolean(message) && typeof message === 'object' && !Array.isArray(message))
      .map((message) => ({
        id: String(message.id ?? ''),
        direction: message.direction === 'outgoing' ? 'outgoing' : 'incoming',
        createdAt: String(message.createdAt ?? ''),
        subject: this.truncateEmailText(this.cleanEmailText(message.subject), EMAIL_THREAD_SUBJECT_LIMIT),
        summary: this.truncateEmailText(this.cleanEmailText(message.summary), EMAIL_THREAD_SUMMARY_LIMIT),
        body: this.truncateEmailText(typeof message.body === 'string' ? message.body : null, EMAIL_THREAD_BODY_LIMIT),
        from: this.truncateEmailText(this.cleanEmailText(message.from), EMAIL_THREAD_PARTY_LIMIT),
        to: this.truncateEmailText(this.cleanEmailText(message.to), EMAIL_THREAD_PARTY_LIMIT),
        attachCount: Math.max(0, Number(message.attachCount ?? 0) || 0),
        deliveryStatus: this.cleanEmailText(message.deliveryStatus),
        source: message.source === 'event' ? 'event' : 'note',
      }));
  }

  private serializePendingEmailThread(
    draft: EmailThreadDraft,
    now: Date,
    domain: string,
    dismissedKeys: Set<string>,
  ) {
    const incomingMessages = draft.messages.filter((message) => message.direction === 'incoming');
    const outgoingMessages = draft.messages.filter((message) => message.direction === 'outgoing');
    const lastIncoming = incomingMessages[incomingMessages.length - 1];
    if (!lastIncoming?.noteExternalId) return null;

    const lastOutgoing = outgoingMessages[outgoingMessages.length - 1];
    if (lastOutgoing && lastOutgoing.createdAt > lastIncoming.createdAt) return null;

    const dismissalKey = this.emailDismissalKey(draft.deal.id, draft.threadId, lastIncoming.noteExternalId);
    if (dismissedKeys.has(dismissalKey)) return null;

    const pipelineKey = this.emailPipelineKey(draft.deal.pipeline?.name);
    if (!pipelineKey) return null;
    if (!this.isEmailThreadStageAllowed(pipelineKey, draft.deal.stage?.name)) return null;

    const waitingSeconds = Math.max(0, Math.floor((now.getTime() - lastIncoming.createdAt.getTime()) / 1000));
    return {
      id: dismissalKey,
      pipelineKey,
      dealId: draft.deal.id,
      dealExternalId: draft.deal.externalId,
      title: draft.deal.title,
      amount: Number(draft.deal.amount ?? 0),
      managerName: draft.deal.responsible?.name ?? 'Без менеджера',
      managerExternalId: draft.deal.responsible?.externalId ?? null,
      groupName: draft.deal.responsible?.group?.name ?? '-',
      pipelineName: draft.deal.pipeline?.name ?? '-',
      stageName: draft.deal.stage?.name ?? '-',
      contactName: draft.deal.contact?.name ?? null,
      contactEmail: draft.deal.contact?.email ?? null,
      threadId: draft.threadId,
      lastIncomingNoteExternalId: lastIncoming.noteExternalId,
      lastIncomingAt: lastIncoming.createdAt.toISOString(),
      waitingSeconds,
      subject: lastIncoming.subject,
      summary: lastIncoming.summary,
      attachCount: lastIncoming.attachCount,
      dealUrl: this.dealUrl(domain, draft.deal.externalId),
      messages: draft.messages.slice(-EMAIL_THREAD_STATE_MESSAGE_LIMIT).map((message) => ({
        id: message.id,
        direction: message.direction,
        createdAt: message.createdAt.toISOString(),
        subject: this.truncateEmailText(message.subject, EMAIL_THREAD_SUBJECT_LIMIT),
        summary: this.truncateEmailText(message.summary, EMAIL_THREAD_SUMMARY_LIMIT),
        body: this.truncateEmailText(message.body, EMAIL_THREAD_BODY_LIMIT),
        from: this.truncateEmailText(message.from, EMAIL_THREAD_PARTY_LIMIT),
        to: this.truncateEmailText(message.to, EMAIL_THREAD_PARTY_LIMIT),
        attachCount: message.attachCount,
        deliveryStatus: message.deliveryStatus,
        source: message.source,
      })),
    };
  }

  private emailNoteParams(raw: unknown, storedText?: string | null) {
    const params = (raw as { params?: Record<string, any> } | null)?.params ?? {};
    const body = this.truncateEmailText(
      this.cleanEmailBody(storedText ?? params.text ?? params.body ?? params.html),
      EMAIL_THREAD_BODY_LIMIT,
    );
    const from = this.emailParty(params.from);
    const to = this.emailParty(params.to);
    return {
      income: typeof params.income === 'boolean' ? params.income : null,
      threadId: params.thread_id == null ? null : String(params.thread_id),
      subject: this.truncateEmailText(this.cleanEmailText(params.subject), EMAIL_THREAD_SUBJECT_LIMIT),
      summary: this.truncateEmailText(this.cleanEmailText(params.content_summary ?? body), EMAIL_THREAD_SUMMARY_LIMIT),
      body,
      from: this.truncateEmailText(from.label, EMAIL_THREAD_PARTY_LIMIT),
      fromEmail: from.email,
      to: this.truncateEmailText(to.label, EMAIL_THREAD_PARTY_LIMIT),
      toEmail: to.email,
      attachCount: Math.max(0, Number(params.attach_cnt ?? 0) || 0),
      deliveryStatus: params.delivery?.status == null ? null : String(params.delivery.status),
    };
  }

  private emailDirection(
    params: EmailMessageParams,
    internalEmailDomains: Set<string>,
    eventType?: string,
  ): EmailDirection {
    if (eventType === 'outgoing_mail' || params.income === false) return 'outgoing';
    const fromDomain = this.emailDomain(params.fromEmail);
    if (fromDomain && internalEmailDomains.has(fromDomain)) return 'outgoing';
    return 'incoming';
  }

  private emailEventEntity(raw: unknown) {
    const payload = raw as Record<string, any> | null;
    const type = String(payload?.entity_type ?? payload?._embedded?.entity?.type ?? '').toLowerCase();
    const id = payload?.entity_id ?? payload?._embedded?.entity?.id;
    return {
      type: type.includes('lead') ? 'lead' : type.includes('contact') ? 'contact' : type.includes('company') ? 'company' : '',
      id: id == null ? '' : String(id),
    };
  }

  private emailEventNoteId(raw: unknown) {
    const payload = raw as Record<string, any> | null;
    const value = payload?.value_after?.[0]?.note?.id ?? payload?.value_before?.[0]?.note?.id;
    return value == null ? null : String(value);
  }

  private emailEventThreadId(entity: { type: string; id: string }, dealExternalId?: string | null) {
    if (entity.type && entity.id) return `mail-event:${entity.type}:${entity.id}`;
    return `mail-event:lead:${dealExternalId ?? 'unknown'}`;
  }

  private emailNoteEntityId(raw: unknown) {
    const payload = raw as Record<string, any> | null;
    const id = payload?.entity_id ?? payload?._embedded?.entity?.id;
    return id == null ? null : String(id);
  }

  private dealContactExternalIds(deal: { contact?: { externalId: string | null } | null; contactExternalIds?: string[]; raw?: unknown }) {
    const ids = new Set<string>();
    if (deal.contact?.externalId) ids.add(deal.contact.externalId);
    for (const id of deal.contactExternalIds ?? []) {
      if (id) ids.add(id);
    }

    const contacts = (deal.raw as { _embedded?: { contacts?: Array<{ id?: unknown }> } } | null)?._embedded?.contacts;
    if (Array.isArray(contacts)) {
      for (const contact of contacts) {
        if (contact?.id != null) ids.add(String(contact.id));
      }
    }

    return [...ids];
  }

  private async emailInternalDomains() {
    const users = await this.prisma.crmUser.findMany({
      where: { isActive: true, email: { not: null } },
      select: { email: true },
    });
    const domains = new Set<string>();
    for (const user of users) {
      const domain = this.emailDomain(user.email);
      if (domain) domains.add(domain);
    }
    return domains;
  }

  private emailParty(value: unknown) {
    if (!value || typeof value !== 'object') return { label: null, email: null };
    const party = value as { name?: unknown; email?: unknown };
    const name = this.cleanEmailText(party.name);
    const email = this.cleanEmailText(party.email)?.toLowerCase() ?? null;
    return {
      label: name && email ? `${name} <${email}>` : email || name,
      email,
    };
  }

  private emailDomain(email?: string | null) {
    const value = this.cleanEmailText(email)?.toLowerCase();
    const atIndex = value?.lastIndexOf('@') ?? -1;
    if (!value || atIndex < 0 || atIndex === value.length - 1) return null;
    return value.slice(atIndex + 1);
  }

  private truncateEmailText(value: string | null | undefined, limit: number) {
    if (!value) return null;
    return value.length > limit ? `${value.slice(0, limit)}...` : value;
  }

  private chunks<T>(items: T[], size: number) {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }
    return result;
  }

  private cleanEmailText(value: unknown) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  private cleanEmailBody(value: unknown) {
    const raw = String(value ?? '');
    if (!raw.trim()) return null;
    const text = raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return text || null;
  }

  private emailPipelineKey(name?: string | null): EmailPipelineKey | null {
    const normalized = this.normalizeEmailPipelineName(name);
    if (normalized.includes('продаж')) return 'sales';
    if (normalized.includes('база')) return 'base';
    if (normalized.includes('закреплен') && normalized.includes('компан')) return 'assignedCompanies';
    return null;
  }

  private isEmailThreadStageAllowed(pipelineKey: EmailPipelineKey, stageName?: string | null) {
    if (pipelineKey !== 'base') return true;
    return BASE_EMAIL_STAGE_NAMES.has(this.normalizeEmailPipelineName(stageName));
  }

  private normalizeEmailPipelineName(name?: string | null) {
    return String(name ?? '').trim().toLowerCase().replace(/ё/g, 'е');
  }

  private emailThreadSummary(threads: Array<{ waitingSeconds: number }>) {
    return {
      total: threads.length,
      olderThan1h: threads.filter((thread) => thread.waitingSeconds >= 60 * 60).length,
      olderThan4h: threads.filter((thread) => thread.waitingSeconds >= 4 * 60 * 60).length,
      olderThan24h: threads.filter((thread) => thread.waitingSeconds >= 24 * 60 * 60).length,
    };
  }

  private emailDismissalKey(dealId: string, threadId: string, lastIncomingNoteExternalId: string) {
    return `${dealId}:${threadId}:${lastIncomingNoteExternalId}`;
  }

  private ensureEmailThreadAccess(user: AuthUser) {
    if (user.role !== 'ADMIN' && user.role !== 'ROP' && user.businessRole !== 'ROP' && user.businessRole !== 'OWNER') {
      throw new ForbiddenException('Нет доступа');
    }
  }

  private async resolveAmoDomain() {
    const connection = await this.prisma.amoConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
    const snapshot = connection
      ? null
      : await this.prisma.amoAccountSnapshot.findFirst({ orderBy: { updatedAt: 'desc' } });
    return this.cleanDomain(connection?.subdomain ?? snapshot?.subdomain ?? '');
  }

  private dealUrl(domain: string, externalId?: string | null) {
    const cleanDomain = this.cleanDomain(domain);
    if (!cleanDomain || !externalId) return '';
    return `https://${cleanDomain}/leads/detail/${externalId}`;
  }

  private cleanDomain(domain: string) {
    return domain.replace(/^https?:\/\//, '').replace(/\/$/, '').trim();
  }

  private ensureOwner(user: AuthUser, ownerId?: string | null) {
    if (user.role !== 'ADMIN' && ownerId && ownerId !== user.id) {
      throw new ForbiddenException('Нет доступа');
    }
  }

  private ensureAdmin(user: AuthUser) {
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Нет доступа');
    }
  }

  private ensureTelegramOwner(user: AuthUser) {
    if (user.businessRole !== 'OWNER') {
      throw new ForbiddenException('Нет доступа');
    }
  }

  private async crmTelegramAccessWhere(actor: AuthUser): Promise<Prisma.CrmUserWhereInput> {
    const base: Prisma.CrmUserWhereInput = { isActive: true, isVisible: true };
    this.ensureTelegramOwner(actor);
    return base;
  }

  private async ensureCrmTelegramAccess(actor: AuthUser, crmUserId: string) {
    const where = await this.crmTelegramAccessWhere(actor);
    const crmUser = await this.prisma.crmUser.findFirst({
      where: { ...where, id: crmUserId },
      select: { id: true, name: true },
    });
    if (!crmUser) throw new ForbiddenException('Нет доступа к этому пользователю amoCRM');
    return crmUser;
  }

  private async parseTelegramRecipients(input: unknown) {
    const rawItems = Array.isArray(input) ? input : [];
    const normalized = rawItems
      .map((item) => ({
        kind: String((item as Record<string, unknown>)?.kind ?? ''),
        id: String((item as Record<string, unknown>)?.id ?? ''),
      }))
      .filter((item) => (item.kind === 'platform_user' || item.kind === 'crm_user') && item.id);

    const unique = Array.from(new Map(normalized.map((item) => [`${item.kind}:${item.id}`, item])).values());
    const platformUserIds = unique.filter((item) => item.kind === 'platform_user').map((item) => item.id);
    const crmUserIds = unique.filter((item) => item.kind === 'crm_user').map((item) => item.id);

    const [platformUsers, crmUsers] = await Promise.all([
      platformUserIds.length
        ? this.prisma.user.findMany({
          where: {
            id: { in: platformUserIds },
            isActive: true,
            telegramAccount: { is: { isActive: true } },
          },
          select: { id: true },
        })
        : Promise.resolve([]),
      crmUserIds.length
        ? this.prisma.crmUser.findMany({
          where: {
            id: { in: crmUserIds },
            isActive: true,
            isVisible: true,
            telegramAccount: { is: { isActive: true } },
          },
          select: { id: true },
        })
        : Promise.resolve([]),
    ]);

    const allowedPlatformIds = new Set(platformUsers.map((item) => item.id));
    const allowedCrmIds = new Set(crmUsers.map((item) => item.id));
    return unique.filter((item) =>
      item.kind === 'platform_user' ? allowedPlatformIds.has(item.id) : allowedCrmIds.has(item.id),
    );
  }

  private parseTelegramDeliveryMode(
    input: unknown,
    legacyRecipientsMode: unknown,
    recipients?: Array<{ kind: string; id: string }>,
  ): TelegramDeliveryMode {
    const raw = String(input ?? '').trim();
    if (TELEGRAM_DELIVERY_MODES.includes(raw as TelegramDeliveryMode)) return raw as TelegramDeliveryMode;
    if (String(legacyRecipientsMode ?? 'default') === 'custom') {
      return recipients?.length ? 'selected' : 'disabled';
    }
    return 'system';
  }

  private telegramDeliveryModeAllowed(eventType: string, mode: TelegramDeliveryMode) {
    if (PERSONAL_TELEGRAM_EVENTS.has(eventType)) {
      return mode === 'system' || mode === 'direct_responsible' || mode === 'disabled';
    }
    if (mode === 'direct_responsible') return eventType === 'amo_payment_received';
    return true;
  }

  private telegramRecipientsForStorage(mode: TelegramDeliveryMode, recipients: Array<{ kind: string; id: string }>) {
    if (mode === 'system') return [];
    if (mode === 'disabled') return [{ kind: 'none', id: 'none' }];
    const modeItem = { kind: TELEGRAM_DELIVERY_MODE_KIND, id: mode };
    return mode === 'selected' ? [modeItem, ...recipients] : [modeItem];
  }

  private serializeTelegramTemplate(template: { recipients: Prisma.JsonValue; [key: string]: unknown }) {
    const raw = Array.isArray(template.recipients) ? template.recipients : [];
    const recipients = raw
      .map((item) => ({
        kind: String((item as Record<string, unknown>)?.kind ?? ''),
        id: String((item as Record<string, unknown>)?.id ?? ''),
      }))
      .filter((item) => (item.kind === 'platform_user' || item.kind === 'crm_user') && item.id);
    const disabled = raw.some((item) => {
      const record = item as Record<string, unknown>;
      return record?.kind === 'none' && record?.id === 'none';
    });
    const modeItem = raw.find((item) => {
      const record = item as Record<string, unknown>;
      return record?.kind === TELEGRAM_DELIVERY_MODE_KIND && TELEGRAM_DELIVERY_MODES.includes(String(record.id) as TelegramDeliveryMode);
    }) as Record<string, unknown> | undefined;
    const eventType = String(template.eventType ?? '');
    let deliveryMode: TelegramDeliveryMode = 'system';
    if (disabled) deliveryMode = 'disabled';
    else if (modeItem) deliveryMode = String(modeItem.id) as TelegramDeliveryMode;
    else if (recipients.length) deliveryMode = 'selected';
    if (!this.telegramDeliveryModeAllowed(eventType, deliveryMode)) deliveryMode = 'system';
    const allowedDeliveryModes = TELEGRAM_DELIVERY_MODES.filter((mode) => this.telegramDeliveryModeAllowed(eventType, mode));
    const visibleRecipients = deliveryMode === 'selected' ? recipients : [];
    return {
      ...template,
      recipients: visibleRecipients,
      deliveryMode,
      allowedDeliveryModes,
      recipientsMode: deliveryMode === 'system' ? 'default' : 'custom',
    };
  }

  private parseBusinessRole(input: unknown) {
    const value = String(input ?? 'MANAGER').toUpperCase();
    if (['OWNER', 'ROP', 'MANAGER'].includes(value)) return value as PlatformBusinessRole;
    return 'MANAGER' as PlatformBusinessRole;
  }

  private parseRecipients(input: unknown, fallbackUserId?: string | null) {
    const value = Array.isArray(input) ? input : typeof input === 'string' && input ? input.split(',') : [];
    const recipients = value.map((item) => String(item).trim()).filter(Boolean);
    if (!recipients.length && fallbackUserId) recipients.push(fallbackUserId);
    return Array.from(new Set(recipients));
  }

  private parseAlertOperator(input: unknown) {
    const value = String(input ?? 'GTE').toUpperCase();
    if (['GT', 'GTE', 'LT', 'LTE', 'EQ', 'NEQ'].includes(value)) return value as AlertOperator;
    return 'GTE' as AlertOperator;
  }

  private parsePlanPeriodType(input: unknown) {
    const value = String(input ?? 'MONTH').toUpperCase();
    if (['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR', 'CUSTOM'].includes(value)) return value as PlanPeriodType;
    return 'MONTH' as PlanPeriodType;
  }

  private parsePlanTargetType(input: unknown) {
    const value = String(input ?? 'COMPANY').toUpperCase();
    if (['COMPANY', 'GROUP', 'MANAGER'].includes(value)) return value as PlanTargetType;
    return 'COMPANY' as PlanTargetType;
  }

  private parseQualitySeverity(input: unknown) {
    const value = String(input ?? 'WARNING').toUpperCase();
    if (['INFO', 'WARNING', 'CRITICAL'].includes(value)) return value as QualitySeverity;
    return 'WARNING' as QualitySeverity;
  }

  private parseScheduleFrequency(input: unknown) {
    const value = String(input ?? 'DAILY').toUpperCase();
    if (['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM_CRON'].includes(value)) return value as ReportScheduleFrequency;
    return 'DAILY' as ReportScheduleFrequency;
  }

  private optionalString(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    return String(value);
  }

  private optionalDecimal(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = String(value)
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^\d,.\-+]/g, '')
      .replace(',', '.');
    if (!/^[-+]?\d+(\.\d+)?$/.test(normalized)) {
      throw new BadRequestException('Введите число');
    }
    return new Prisma.Decimal(normalized);
  }

  private clampInt(value: unknown, min: number, max: number, fallback: number) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  private parseRopDashboardV2Query(query: RopDashboardV2Query): RopSelectedFilters {
    const departmentValues = this.queryValues(query.department, query.departments)
      .map((value) => ropDepartmentKeyFromInput(value))
      .filter((value): value is RopDepartmentKey => Boolean(value));
    const pipelineId = this.queryValues(query.pipelineId)[0] ?? null;
    const periodPreset = this.parseRopPeriodPreset(this.queryValues(query.periodPreset)[0]);

    return {
      departments: new Set(departmentValues),
      groupIds: new Set(this.queryValues(query.groupId, query.groupIds)),
      managerIds: new Set(this.queryValues(query.managerId, query.managerIds)),
      pipelineId,
      stageIds: new Set(this.queryValues(query.stageId, query.stageIds)),
      periodPreset,
    };
  }

  private parseRopPeriodPreset(value?: string | null): RopPeriodPreset {
    if (value === 'yesterday' || value === 'this_week' || value === 'this_month') return value;
    return 'today';
  }

  private resolveRopPeriod(preset: RopPeriodPreset, now: Date) {
    const parts = moscowParts(now);
    if (preset === 'yesterday') {
      const startAt = moscowDate(parts.year, parts.month, parts.day - 1, 0);
      return {
        preset,
        label: 'Вчера',
        startAt,
        endAt: moscowDate(parts.year, parts.month, parts.day, 0),
      };
    }
    if (preset === 'this_week') {
      const mondayOffset = parts.dayOfWeek === 0 ? -6 : 1 - parts.dayOfWeek;
      const startAt = moscowDate(parts.year, parts.month, parts.day + mondayOffset, 0);
      return {
        preset,
        label: 'Эта неделя',
        startAt,
        endAt: now,
      };
    }
    if (preset === 'this_month') {
      return {
        preset,
        label: 'Этот месяц',
        startAt: moscowDate(parts.year, parts.month, 1, 0),
        endAt: now,
      };
    }
    return {
      preset,
      label: 'Сегодня',
      startAt: moscowDate(parts.year, parts.month, parts.day, 0),
      endAt: moscowDate(parts.year, parts.month, parts.day + 1, 0),
    };
  }

  private queryValues(...values: unknown[]) {
    return values
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .flatMap((value) => String(value ?? '').split(','))
      .map((value) => value.trim())
      .filter(Boolean);
  }

  private ropDepartmentFromGroupName(name?: string | null) {
    const key = ropDepartmentKeyFromInput(name);
    return key ? ROP_DEPARTMENTS.find((department) => department.key === key) ?? null : null;
  }

  private ropManagerMatchesFilters(manager: RopManagerMeta, filters: RopSelectedFilters) {
    if (filters.departments.size && !filters.departments.has(manager.departmentKey)) return false;
    if (filters.groupIds.size && !filters.groupIds.has(manager.groupId)) return false;
    if (filters.managerIds.size && !filters.managerIds.has(manager.managerId)) return false;
    return true;
  }

  private async visiblePendingEmailThreadsFromStates<T extends EmailThreadStateView>(
    states: T[],
    now: Date,
    domain: string,
  ) {
    const dealIds = [...new Set(states.map((state) => state.dealId))];
    const dismissals = dealIds.length
      ? await this.prisma.emailThreadDismissal.findMany({
        where: { dealId: { in: dealIds } },
        select: { dealId: true, threadId: true, lastIncomingNoteExternalId: true },
      })
      : [];
    const dismissedKeys = new Set(
      dismissals.map((item) => this.emailDismissalKey(item.dealId, item.threadId, item.lastIncomingNoteExternalId)),
    );

    const latestStatesByDealId = new Map<string, T>();
    for (const state of states) {
      const current = latestStatesByDealId.get(state.dealId);
      if (!current || (state.lastIncomingAt?.getTime() ?? 0) > (current.lastIncomingAt?.getTime() ?? 0)) {
        latestStatesByDealId.set(state.dealId, state);
      }
    }

    const visible = [];
    for (const state of latestStatesByDealId.values()) {
      const thread = this.serializePendingEmailThreadState(state, now, domain, dismissedKeys);
      if (thread) visible.push({ state, thread });
    }
    return visible;
  }

  private resolveRopStageSla(
    departmentKey: RopDepartmentKey,
    stageId: string,
    pipelineName: string | null | undefined,
    stageName: string | null | undefined,
    configuredRules: Map<string, RopStageSlaRuleConfig>,
  ) {
    const configured = configuredRules.get(this.ropStageSlaKey(departmentKey, stageId));
    if (configured) {
      if (!configured.isEnabled) {
        return {
          days: null,
          reason: configured.reason || 'SLA отключён в настройках этапов.',
        };
      }
      const fallback = resolveDefaultRopStageSla(departmentKey, pipelineName, stageName);
      return {
        days: configured.slaDays ?? fallback.days,
        reason: configured.reason || fallback.reason,
      };
    }
    return resolveDefaultRopStageSla(departmentKey, pipelineName, stageName);
  }

  private ropStageSlaKey(departmentKey: string, stageId: string) {
    return `${departmentKey}:${stageId}`;
  }

  private isRopTouchNote(note: { type: string; raw?: unknown }) {
    if (note.type === 'call_out' || note.type === 'common') return true;
    if (note.type !== 'amomail_message') return false;
    const params = (note.raw as { params?: Record<string, any> } | null)?.params ?? {};
    return params.income === false;
  }

  private isRopOfferSentStage(stageName?: string | null) {
    const normalized = this.normalizeName(String(stageName ?? ''));
    return normalized.includes('кп') ||
      normalized.includes('предлож') ||
      normalized.includes('offer') ||
      normalized.includes('proposal') ||
      normalized.includes('коммерчес');
  }

  private qualitySeverityPriority(severity: QualitySeverity): RopActionPriority {
    if (severity === 'CRITICAL') return 'critical';
    if (severity === 'WARNING') return 'warning';
    return 'info';
  }

  private sortRopActions(items: RopActionQueueItem[]) {
    return items
      .sort((a, b) => this.actionPriorityRank(a.priority) - this.actionPriorityRank(b.priority) || (b.ageHours ?? 0) - (a.ageHours ?? 0))
      .slice(0, ROP_ACTION_LIMIT);
  }

  private ropManagerAttention(row: {
    offerTouches: number;
    pendingEmails: number;
    overdueTasks: number;
    taskReschedules: number;
    noNextStep: number;
    stuckDeals: number;
    crmIssues: number;
    riskDeals: number;
  }) {
    return row.offerTouches + row.pendingEmails + row.overdueTasks + row.taskReschedules + row.noNextStep + row.stuckDeals + row.crmIssues + row.riskDeals;
  }

  private ropGroupOptions(managers: RopManagerMeta[]) {
    const groups = new Map<string, { id: string; name: string; managerCount: number }>();
    for (const manager of managers) {
      const group = groups.get(manager.groupId) ?? { id: manager.groupId, name: manager.groupName, managerCount: 0 };
      group.managerCount += 1;
      groups.set(manager.groupId, group);
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  private ropDepartmentSummary(rows: Array<{
    openDeals: number;
    openAmount: number;
    tasksTodayTotal: number;
    tasksTodayDone: number;
    tasksTodayOpen: number;
    overdueTasks: number;
    taskReschedules: number;
    noNextStep: number;
    offerTouches: number;
    pendingEmails: number;
    stuckDeals: number;
    crmIssues: number;
    riskDeals: number;
    crmQualityPercent: number;
  }>) {
    return {
      managers: rows.length,
      openDeals: rows.reduce((sum, row) => sum + row.openDeals, 0),
      openAmount: this.roundMetric(rows.reduce((sum, row) => sum + row.openAmount, 0)),
      tasksTodayTotal: rows.reduce((sum, row) => sum + row.tasksTodayTotal, 0),
      tasksTodayDone: rows.reduce((sum, row) => sum + row.tasksTodayDone, 0),
      tasksTodayOpen: rows.reduce((sum, row) => sum + row.tasksTodayOpen, 0),
      overdueTasks: rows.reduce((sum, row) => sum + row.overdueTasks, 0),
      taskReschedules: rows.reduce((sum, row) => sum + row.taskReschedules, 0),
      noNextStep: rows.reduce((sum, row) => sum + row.noNextStep, 0),
      offerTouches: rows.reduce((sum, row) => sum + row.offerTouches, 0),
      pendingEmails: rows.reduce((sum, row) => sum + row.pendingEmails, 0),
      stuckDeals: rows.reduce((sum, row) => sum + row.stuckDeals, 0),
      crmIssues: rows.reduce((sum, row) => sum + row.crmIssues, 0),
      riskDeals: rows.reduce((sum, row) => sum + row.riskDeals, 0),
      crmQualityPercent: this.roundMetric(rows.reduce((sum, row) => sum + row.crmQualityPercent, 0) / Math.max(1, rows.length)),
    };
  }

  private ropCrmQualityPercent(openDeals: number, riskDeals: number) {
    if (openDeals <= 0) return 100;
    return this.roundMetric(Math.max(0, Math.min(100, ((openDeals - riskDeals) / openDeals) * 100)));
  }

  private ropEventEntityId(event: { raw?: unknown }) {
    const raw = event.raw as Record<string, any> | null;
    const value = raw?.entity_id ?? raw?._embedded?.entity?.id;
    return value == null ? null : String(value);
  }

  private ropEventActorExternalId(event: { raw?: unknown }) {
    const raw = event.raw as Record<string, any> | null;
    const rawCreatedBy = raw?.created_by;
    if (rawCreatedBy && typeof rawCreatedBy === 'object' && rawCreatedBy.id != null) {
      return String(rawCreatedBy.id);
    }
    const value = (rawCreatedBy && typeof rawCreatedBy !== 'object' ? rawCreatedBy : null) ??
      raw?.created_by_id ??
      raw?.created_by_user_id;
    return value == null ? '' : String(value);
  }

  private ropFilterDepartments(
    managers: RopManagerMeta[],
    openDeals: Array<{ responsibleId: string | null; pipeline: { id: string; name: string } }>,
  ) {
    const managersById = new Map(managers.map((manager) => [manager.managerId, manager]));
    return ROP_DEPARTMENTS.map((department) => {
      const departmentManagers = managers
        .filter((manager) => manager.departmentKey === department.key)
        .sort((a, b) => a.managerName.localeCompare(b.managerName, 'ru'));
      const pipelines = new Map<string, { id: string; name: string; openDeals: number }>();
      for (const deal of openDeals) {
        const manager = managersById.get(deal.responsibleId ?? '');
        if (!manager || manager.departmentKey !== department.key) continue;
        const pipeline = pipelines.get(deal.pipeline.id) ?? { id: deal.pipeline.id, name: deal.pipeline.name, openDeals: 0 };
        pipeline.openDeals += 1;
        pipelines.set(deal.pipeline.id, pipeline);
      }
      return {
        id: department.key,
        key: department.key,
        name: department.label,
        label: department.label,
        groups: this.ropGroupOptions(departmentManagers),
        managers: departmentManagers.map((manager) => ({
          id: manager.managerId,
          name: manager.managerName,
          groupId: manager.groupId,
          groupName: manager.groupName,
        })),
        pipelines: [...pipelines.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      };
    });
  }

  private ropFilterStages(
    managers: RopManagerMeta[],
    openDeals: Array<{
      responsibleId: string | null;
      pipeline: { id: string; name: string };
      stage: { id: string; name: string; position: number };
    }>,
  ) {
    const managersById = new Map(managers.map((manager) => [manager.managerId, manager]));
    const stages = new Map<string, {
      id: string;
      name: string;
      pipelineId: string;
      pipelineName: string;
      stagePosition: number;
      openDeals: number;
    }>();
    for (const deal of openDeals) {
      if (!managersById.has(deal.responsibleId ?? '')) continue;
      const key = `${deal.pipeline.id}:${deal.stage.id}`;
      const stage = stages.get(key) ?? {
        id: deal.stage.id,
        name: deal.stage.name,
        pipelineId: deal.pipeline.id,
        pipelineName: deal.pipeline.name,
        stagePosition: deal.stage.position,
        openDeals: 0,
      };
      stage.openDeals += 1;
      stages.set(key, stage);
    }
    return [...stages.values()].sort(
      (left, right) => left.pipelineName.localeCompare(right.pipelineName, 'ru') || left.stagePosition - right.stagePosition,
    );
  }

  private numberValue(value: unknown) {
    if (value === null || value === undefined) return 0;
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private ageHours(start: Date, end: Date) {
    if (end <= start) return 0;
    return this.roundMetric((end.getTime() - start.getTime()) / 3_600_000);
  }

  private ageDays(start: Date, end: Date) {
    if (end <= start) return 0;
    return (end.getTime() - start.getTime()) / 86_400_000;
  }

  private actionPriorityRank(priority: RopActionPriority) {
    if (priority === 'critical') return 0;
    if (priority === 'warning') return 1;
    return 2;
  }

  private json(value: unknown) {
    return value as Prisma.InputJsonValue;
  }
}
