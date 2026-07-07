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
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { DataContractMetric, ReportConfig, ReportFilters } from '../reports/report-types';
import { TelegramService } from './telegram.service';
import { CrmEventNotificationsService } from './crm-event-notifications.service';

type PlanFactTeamKey = 'sales' | 'csm';
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
    responsible: { name: string; externalId: string; group: { name: string } | null } | null;
    contact: { externalId: string; name: string; email: string | null } | null;
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

const EMAIL_PIPELINE_GROUPS: Array<{ key: EmailPipelineKey; label: string }> = [
  { key: 'sales', label: 'Продажи' },
  { key: 'base', label: 'База' },
  { key: 'assignedCompanies', label: 'Закреплённые компании' },
];

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
    const states = await this.prisma.emailThreadState.findMany({
      where: {
        isPending: true,
        lastIncomingAt: { not: null },
        lastIncomingNoteExternalId: { not: null },
        deal: {
          deletedAt: null,
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
            pipeline: { select: { name: true } },
            stage: { select: { name: true } },
            responsible: { select: { name: true, externalId: true, group: { select: { name: true } } } },
            contact: { select: { externalId: true, name: true, email: true } },
          },
        },
      },
    });
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
    const drafts = await this.buildEmailThreadDrafts();
    const rows = drafts
      .map((draft) => this.emailThreadStateData(draft))
      .filter((row): row is Prisma.EmailThreadStateCreateManyInput => Boolean(row));

    await this.prisma.$transaction([
      this.prisma.emailThreadState.deleteMany(),
      ...(rows.length ? [this.prisma.emailThreadState.createMany({ data: rows })] : []),
    ]);

    return {
      total: rows.length,
      pending: rows.filter((row) => row.isPending).length,
    };
  }

  async listTelegramTemplates(actor: AuthUser) {
    this.ensureTelegramOwner(actor);
    await this.ensureTelegramTemplates();
    const templates = await this.prisma.notificationTemplate.findMany({ orderBy: { name: 'asc' } });
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
        eventType: 'amo_loss_without_reason',
        name: '\u041e\u0442\u043a\u0430\u0437 \u0431\u0435\u0437 \u043f\u0440\u0438\u0447\u0438\u043d\u044b',
        body: '\u0421\u0434\u0435\u043b\u043a\u0430 \u0437\u0430\u043a\u0440\u044b\u0442\u0430 \u0432 \u043e\u0442\u043a\u0430\u0437 \u0431\u0435\u0437 \u043f\u0440\u0438\u0447\u0438\u043d\u044b.\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}',
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

    const refs = await this.resolvePlanFactRefs();
    const monthItems = (planSet?.items ?? []).filter((item) =>
      item.periodStart <= calendar.monthEnd && item.periodEnd >= calendar.monthStart,
    );
    const [sales, csm] = await Promise.all([
      refs.sales ? this.buildPlanFactTeam('sales', refs.sales, refs.shipping, monthItems, calendar, user) : null,
      refs.csm ? this.buildPlanFactTeam('csm', refs.csm, refs.shipping, monthItems, calendar, user) : null,
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
    const [pipelines, salesGroup, csmGroup, marketingFieldId] = await Promise.all([
      this.prisma.pipeline.findMany({ include: { stages: { orderBy: { position: 'asc' } } } }),
      this.findPlanFactGroup('Sales'),
      this.findPlanFactGroup('CSM'),
      this.resolvePlanFactFieldExternalId('маркетинг'),
    ]);
    const pipelineByName = (needles: string[]) =>
      pipelines.find((pipeline) => this.nameIncludesAll(pipeline.name, needles)) ?? null;
    const salesPipeline = pipelineByName(['продаж']);
    const assemblyPipeline = pipelineByName(['сбор']);
    const basePipeline = pipelines.find((pipeline) => this.normalizeName(pipeline.name) === this.normalizeName('База')) ?? null;
    const assignedPipeline = pipelineByName(['закреп']);
    const warnings: string[] = [];

    const sales = salesPipeline && salesGroup
      ? {
        key: 'sales' as const,
        name: 'Продажи',
        group: salesGroup,
        pipelineIds: [salesPipeline.id],
        stages: {
          kp: this.findStage(salesPipeline.stages, [['кп', 'презент'], ['кп', 'отправ'], ['предлож']]),
          invoice: this.findStage(salesPipeline.stages, [['счет', 'отправ'], ['счёт', 'отправ']]),
          paid: this.findPaidStage(salesPipeline.stages),
        },
        marketingFieldId,
      }
      : null;
    const csmStages = basePipeline && assignedPipeline
      ? {
        base: this.resolveCsmPlanFactStages(basePipeline.stages),
        assigned: this.resolveCsmPlanFactStages(assignedPipeline.stages),
      }
      : null;
    const csm = basePipeline && assignedPipeline && csmGroup && csmStages?.base && csmStages.assigned
      ? {
        key: 'csm' as const,
        name: 'CSM',
        group: csmGroup,
        pipelineIds: [basePipeline.id, assignedPipeline.id],
        stages: csmStages,
      }
      : null;
    const shipping = assemblyPipeline
      ? {
        pipeline: assemblyPipeline,
        shippedStage: this.findStage(assemblyPipeline.stages, [['отгруж']]) ?? assemblyPipeline.stages.find((stage) => stage.isWon) ?? null,
      }
      : null;

    if (!salesGroup) warnings.push('Не найдена группа Sales.');
    if (!csmGroup) warnings.push('Не найдена группа CSM.');
    if (!salesPipeline) warnings.push('Не найдена воронка продаж.');
    if (!basePipeline) warnings.push('Не найдена воронка База.');
    if (!assignedPipeline) warnings.push('Не найдена воронка Закрепленные компании.');
    if (!assemblyPipeline) warnings.push('Не найдена воронка Сборка.');
    if (sales && (!sales.stages.kp || !sales.stages.invoice || !sales.stages.paid)) warnings.push('Не найдены все этапы Sales для план-факта.');
    if (csm && (!csm.stages.base || !csm.stages.assigned)) warnings.push('Не найдены все этапы CSM для план-факта.');
    if (!shipping?.shippedStage) warnings.push('Не найден этап отгружено.');

    return { sales, csm, shipping, warnings };
  }

  private async buildPlanFactTeam(
    team: PlanFactTeamKey,
    refs: any,
    shipping: any,
    planItems: any[],
    calendar: ReturnType<PlatformService['planFactCalendar']>,
    user: AuthUser,
  ) {
    const metrics = PLAN_FACT_METRICS.filter((metric) => metric.team === team);
    const managers = await this.prisma.crmUser.findMany({
      where: { isActive: true, isVisible: true, groupId: refs.group.id },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    const [monthReport, todayReport, beforeTodayReport] = await Promise.all([
      this.computePlanFactContract(team, refs, shipping, calendar.monthStart, calendar.todayEnd < calendar.monthEnd ? calendar.todayEnd : calendar.monthEnd, user),
      calendar.isCurrentMonth
        ? this.computePlanFactContract(team, refs, shipping, calendar.todayStart, calendar.todayEnd, user)
        : Promise.resolve(null),
      calendar.isCurrentMonth
        ? this.computePlanFactContract(team, refs, shipping, calendar.monthStart, new Date(calendar.todayStart.getTime() - 1), user)
        : Promise.resolve(null),
    ]);

    const rows = managers.map((manager) => this.buildPlanFactTargetRow({
      targetType: 'MANAGER',
      targetId: manager.id,
      targetName: manager.name,
      groupTarget: { targetId: refs.group.id, targetName: refs.name },
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
      targetName: `Итого ${refs.name}`,
      groupTarget: { targetId: refs.group.id, targetName: refs.name },
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
      name: refs.name,
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
    refs: any,
    shipping: any,
    dateFrom: Date,
    dateTo: Date,
    user: AuthUser,
  ) {
    if (dateTo < dateFrom) return null;
    const contractMetrics = this.planFactContractMetrics(team, refs, shipping);
    const filters: ReportFilters = {
      dateFrom: dateFrom.toISOString(),
      dateTo: dateTo.toISOString(),
      groupIds: [refs.group.id],
      pipelineIds: refs.pipelineIds,
    };
    const config: ReportConfig = {
      metric: 'contract',
      display: 'table',
      filters,
      contract: {
        entity: 'deal',
        groupBy: 'manager',
        metrics: contractMetrics,
        conversions: [],
        includeSummaryRow: true,
        summaryRowMode: 'sum',
      },
    };
    return this.reports.compute({
      name: `plan-fact-${team}-${dateFrom.toISOString()}-${dateTo.toISOString()}`,
      sourceType: 'EVENT',
      filters,
      config,
    }, user);
  }

  private planFactContractMetrics(team: PlanFactTeamKey, refs: any, shipping: any): DataContractMetric[] {
    const metric = (id: string, label: string, stageIds: string[], measure: 'deal_count' | 'field_sum' = 'deal_count'): DataContractMetric => ({
      id,
      label,
      type: 'stage_reached',
      measure,
      display: measure === 'field_sum' ? 'money' : 'number',
      stageIds,
    });
    const conversion = (id: string, label: string, fromMetricId: string, toMetricId: string): DataContractMetric => ({
      id,
      label,
      type: 'conversion',
      display: 'percent',
      fromMetricId,
      toMetricId,
    });
    const shippedStageIds = shipping?.shippedStage ? [shipping.shippedStage.id] : [];

    if (team === 'sales') {
      return [
        {
          id: 'sales_qualified_leads',
          label: 'Квал лиды',
          type: 'created_deals',
          measure: 'deal_count',
          display: 'number',
          pipelineId: refs.pipelineIds[0],
          extraFilters: refs.marketingFieldId
            ? [{ id: 'marketing_accepted', subject: 'deal_field', fieldId: refs.marketingFieldId, operator: 'equals', value: 'Принято' }]
            : [],
        },
        conversion('sales_conv_lead_to_kp', 'Конверсия лиды -> КП', 'sales_qualified_leads', 'sales_kp_count'),
        metric('sales_kp_count', 'КП', refs.stages.kp ? [refs.stages.kp.id] : []),
        conversion('sales_conv_kp_to_invoice', 'Конверсия КП -> счёт', 'sales_kp_count', 'sales_invoice_count'),
        metric('sales_invoice_count', 'Счета', refs.stages.invoice ? [refs.stages.invoice.id] : []),
        conversion('sales_conv_invoice_to_paid', 'Конверсия счёт -> оплата', 'sales_invoice_count', 'sales_paid_count'),
        metric('sales_paid_count', 'Оплаты', refs.stages.paid ? [refs.stages.paid.id] : []),
        metric('sales_paid_amount', 'Сумма оплат', refs.stages.paid ? [refs.stages.paid.id] : [], 'field_sum'),
        metric('sales_shipped_count', 'Отгрузки', shippedStageIds),
        metric('sales_shipped_amount', 'Сумма отгрузок', shippedStageIds, 'field_sum'),
      ];
    }

    const workStageIds = [refs.stages.base.work.id, refs.stages.assigned.work.id];
    const offerStageIds = [refs.stages.base.offer.id, refs.stages.assigned.offer.id];
    const invoiceStageIds = [refs.stages.base.invoice.id, refs.stages.assigned.invoice.id];
    const paidStageIds = [refs.stages.base.paid.id, refs.stages.assigned.paid.id];
    return [
      metric('csm_taken_to_work_count', 'Взяты в работу', workStageIds),
      conversion('csm_conv_work_to_kp', 'Конверсия в работу -> КП', 'csm_taken_to_work_count', 'csm_kp_count'),
      metric('csm_kp_count', 'КП', offerStageIds),
      conversion('csm_conv_kp_to_invoice', 'Конверсия КП -> счёт', 'csm_kp_count', 'csm_invoice_count'),
      metric('csm_invoice_count', 'Счета', invoiceStageIds),
      conversion('csm_conv_invoice_to_paid', 'Конверсия счёт -> оплата', 'csm_invoice_count', 'csm_paid_count'),
      metric('csm_paid_count', 'Оплаты', paidStageIds),
      metric('csm_paid_amount', 'Сумма оплат', paidStageIds, 'field_sum'),
      metric('csm_shipped_count', 'Отгрузки', shippedStageIds),
      metric('csm_shipped_amount', 'Сумма отгрузок', shippedStageIds, 'field_sum'),
    ];
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
        .filter((value: unknown): value is number => Number.isFinite(Number(value)))
        .map(Number);
      if (!values.length) return null;
      return this.roundMetric(values.reduce((sum, value) => sum + value, 0));
    }
    return null;
  }

  private reportMetricValue(report: any, targetId: string, targetType: 'MANAGER' | 'GROUP', metricKey: string) {
    if (!report) return null;
    const source = targetType === 'GROUP'
      ? report.summaryRows?.[0]?.metrics?.[metricKey]
      : report.rows?.find((row: any) => row.groupId === targetId)?.metrics?.[metricKey];
    const value = Number(source?.value);
    return Number.isFinite(value) ? this.roundMetric(value) : null;
  }

  private async findPlanFactGroup(name: string) {
    const groups = await this.prisma.crmGroup.findMany({ select: { id: true, name: true } });
    const normalized = this.normalizeName(name);
    return groups.find((group) => this.normalizeName(group.name) === normalized) ?? null;
  }

  private async resolvePlanFactFieldExternalId(name: string) {
    const fields = await this.prisma.customFieldDefinition.findMany({
      where: { entityType: 'LEAD' as any, isVisible: true },
      select: { externalId: true, name: true },
    });
    const normalized = this.normalizeName(name);
    return fields.find((field) => this.normalizeName(field.name) === normalized)?.externalId ??
      fields.find((field) => this.normalizeName(field.name).includes(normalized))?.externalId ??
      null;
  }

  private resolveCsmPlanFactStages(stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>) {
    const work = this.findStage(stages, [['взят', 'работ']]);
    const offer = this.findStage(stages, [['сделано', 'предлож'], ['кп']]);
    const invoice = this.findStage(stages, [['счет', 'отправ'], ['счёт', 'отправ']]);
    const paid = this.findStage(stages, [['счет', 'оплачен'], ['счёт', 'оплачен'], ['оплачен']]) ?? this.findPaidStage(stages);
    if (!work || !offer || !invoice || !paid) return null;
    return { work, offer, invoice, paid };
  }

  private findStage(
    stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>,
    alternatives: string[][],
  ) {
    return stages.find((stage) => alternatives.some((needles) => this.nameIncludesAll(stage.name, needles))) ?? null;
  }

  private findPaidStage(stages: Array<{ id: string; name: string; isWon?: boolean; isLost?: boolean }>) {
    return stages.find((stage) => {
      const name = this.normalizeName(stage.name);
      if (name.includes('not fully paid')) return false;
      return name.includes('оплат') || name === 'paid' || name === 'paid!' || Boolean(stage.isWon);
    }) ?? null;
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
        name: 'Открытая сделка без следующей задачи',
        description: 'У менеджера нет запланированного следующего действия по открытой сделке.',
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
    const deals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        stage: { isWon: false, isLost: false },
      },
      include: {
        responsible: { include: { group: true } },
        tasks: { where: { isCompleted: false } },
      },
      take: 1000,
    });
    return deals
      .filter((deal) => deal.tasks.length === 0)
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
    const deals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        updatedAt: { lt: cutoff },
        stage: { isWon: false, isLost: false },
      },
      include: { responsible: { include: { group: true } } },
      take: 1000,
    });
    return deals.map((deal) => ({
      ...this.dealViolation(null, deal, `Давно не было движения: ${deal.title}`),
      payload: { updatedAt: deal.updatedAt, maxIdleDays },
    }));
  }

  private async findDealsWithoutResponsible() {
    const deals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        responsibleId: null,
        stage: { isWon: false, isLost: false },
      },
      include: { responsible: { include: { group: true } } },
      take: 1000,
    });
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

  private async buildEmailThreadDrafts() {
    const openDeals = await this.prisma.deal.findMany({
      where: {
        deletedAt: null,
        stage: { isWon: false, isLost: false },
      },
      select: {
        id: true,
        externalId: true,
        title: true,
        amount: true,
        contactId: true,
        pipeline: { select: { name: true } },
        stage: { select: { name: true } },
        responsible: { select: { name: true, externalId: true, group: { select: { name: true } } } },
        contact: { select: { externalId: true, name: true, email: true } },
      },
    });

    const drafts = new Map<string, EmailThreadDraft>();
    const storedNoteIds = new Set<string>();
    const internalEmailDomains = await this.emailInternalDomains();
    const openDealsById = new Map(openDeals.map((deal) => [deal.id, deal]));
    const leadExternalToDealId = new Map<string, string>();
    const contactExternalToDealIds = new Map<string, Set<string>>();
    const draftsByDealId = new Map<string, EmailThreadDraft[]>();

    for (const deal of openDeals) {
      leadExternalToDealId.set(deal.externalId, deal.id);
      if (!deal.contact?.externalId) continue;
      if (!contactExternalToDealIds.has(deal.contact.externalId)) {
        contactExternalToDealIds.set(deal.contact.externalId, new Set());
      }
      contactExternalToDealIds.get(deal.contact.externalId)?.add(deal.id);
    }

    const noteEntityIds = [...new Set([...leadExternalToDealId.keys(), ...contactExternalToDealIds.keys()])];
    const noteEntityWhere = noteEntityIds.length
      ? Prisma.sql`("dealId" IS NOT NULL OR raw->>'entity_id' IN (${Prisma.join(noteEntityIds)}))`
      : Prisma.sql`"dealId" IS NOT NULL`;
    const noteRows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM "Note"
      WHERE type = 'amomail_message' AND ${noteEntityWhere}
      ORDER BY "createdAt" ASC
    `);
    const notes = noteRows.length
      ? await this.prisma.note.findMany({
        where: { id: { in: noteRows.map((row) => row.id) } },
        orderBy: { createdAt: 'asc' },
        select: {
          externalId: true,
          dealId: true,
          createdAt: true,
          text: true,
          raw: true,
          deal: {
            select: {
              id: true,
              externalId: true,
              title: true,
              amount: true,
              contactId: true,
              deletedAt: true,
              pipeline: { select: { name: true } },
              stage: { select: { name: true, isWon: true, isLost: true } },
              responsible: { select: { name: true, externalId: true, group: { select: { name: true } } } },
              contact: { select: { externalId: true, name: true, email: true } },
            },
          },
        },
      })
      : [];

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

    for (const note of notes) {
      const targetDeals = new Map<string, EmailThreadDraft['deal']>();
      if (note.deal && !note.deal.deletedAt && !note.deal.stage?.isWon && !note.deal.stage?.isLost) {
        targetDeals.set(note.deal.id, note.deal);
      }

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

        for (const draft of targetDrafts) draft.messages.push({
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

    const mailEvents = await this.prisma.crmEvent.findMany({
      where: { type: { in: ['incoming_mail', 'outgoing_mail'] } },
      orderBy: { createdAt: 'asc' },
      select: {
        externalId: true,
        type: true,
        createdAt: true,
        raw: true,
      },
    });
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
          draft.messages.push({
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

    this.closeEmailDraftsByDealReplies(draftsByDealId);

    for (const draft of drafts.values()) {
      draft.messages.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }

    return [...drafts.values()];
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

        draft.messages.push({
          ...closingOutgoing,
          id: `${closingOutgoing.id}:closes:${draft.threadId}`,
        });
      }
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
      subject: displayMessage.subject,
      summary: displayMessage.summary,
      body: displayMessage.body,
      from: displayMessage.from,
      to: displayMessage.to,
      attachCount: displayMessage.attachCount,
      deliveryStatus: displayMessage.deliveryStatus,
      messages: this.emailThreadStateMessages(messages) as Prisma.InputJsonValue,
      isPending,
    };
  }

  private emailThreadStateMessages(messages: EmailMessageItem[]) {
    return messages.map((message) => ({
      id: message.id,
      noteExternalId: message.noteExternalId ?? null,
      direction: message.direction,
      createdAt: message.createdAt.toISOString(),
      subject: message.subject,
      summary: message.summary,
      body: message.body,
      from: message.from,
      to: message.to,
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

    const waitingSeconds = Math.max(0, Math.floor((now.getTime() - state.lastIncomingAt.getTime()) / 1000));
    return {
      id: dismissalKey,
      pipelineKey,
      dealId: state.deal.id,
      dealExternalId: state.deal.externalId,
      title: state.deal.title,
      amount: Number(state.deal.amount ?? 0),
      managerName: state.deal.responsible?.name ?? 'Р‘РµР· РјРµРЅРµРґР¶РµСЂР°',
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
        subject: this.cleanEmailText(message.subject),
        summary: this.cleanEmailText(message.summary),
        body: typeof message.body === 'string' ? message.body : null,
        from: this.cleanEmailText(message.from),
        to: this.cleanEmailText(message.to),
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

    const waitingSeconds = Math.max(0, Math.floor((now.getTime() - lastIncoming.createdAt.getTime()) / 1000));
    return {
      id: dismissalKey,
      pipelineKey,
      dealId: draft.deal.id,
      dealExternalId: draft.deal.externalId,
      title: draft.deal.title,
      amount: Number(draft.deal.amount ?? 0),
      managerName: draft.deal.responsible?.name ?? 'Без менеджера',
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
      messages: draft.messages.map((message) => ({
        id: message.id,
        direction: message.direction,
        createdAt: message.createdAt.toISOString(),
        subject: message.subject,
        summary: message.summary,
        body: message.body,
        from: message.from,
        to: message.to,
        attachCount: message.attachCount,
        deliveryStatus: message.deliveryStatus,
        source: message.source,
      })),
    };
  }

  private emailNoteParams(raw: unknown, storedText?: string | null) {
    const params = (raw as { params?: Record<string, any> } | null)?.params ?? {};
    const body = this.cleanEmailBody(storedText ?? params.text ?? params.body ?? params.html);
    const from = this.emailParty(params.from);
    const to = this.emailParty(params.to);
    return {
      income: typeof params.income === 'boolean' ? params.income : null,
      threadId: params.thread_id == null ? null : String(params.thread_id),
      subject: this.cleanEmailText(params.subject),
      summary: this.cleanEmailText(params.content_summary ?? body),
      body,
      from: from.label,
      fromEmail: from.email,
      to: to.label,
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

  private json(value: unknown) {
    return value as Prisma.InputJsonValue;
  }
}
