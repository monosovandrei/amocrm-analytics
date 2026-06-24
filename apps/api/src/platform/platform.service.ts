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
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from '../reports/reports.service';
import { TelegramService } from './telegram.service';
import { CrmEventNotificationsService } from './crm-event-notifications.service';

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
    this.ensureAdmin(actor);
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
    this.ensureAdmin(actor);
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

  async listTelegramTemplates() {
    await this.ensureTelegramTemplates();
    const templates = await this.prisma.notificationTemplate.findMany({ orderBy: { name: 'asc' } });
    return templates.map((template) => this.serializeTelegramTemplate(template));
  }

  async updateTelegramTemplate(actor: AuthUser, eventType: string, body: Record<string, any>) {
    this.ensureAdmin(actor);
    const defaults = this.defaultTelegramTemplates().find((template) => template.eventType === eventType);
    if (!defaults) throw new NotFoundException('Шаблон не найден');
    const text = String(body.body ?? '').trim();
    if (!text) throw new BadRequestException('Текст уведомления обязателен');
    const recipients = body.recipients === undefined ? undefined : await this.parseTelegramRecipients(body.recipients);
    const recipientsMode = this.parseTelegramRecipientMode(body.recipientsMode, recipients === undefined ? 'default' : 'custom');
    const storedRecipients = recipients === undefined ? undefined : this.telegramRecipientsForStorage(recipientsMode, recipients);
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

  async planFact(planSetId?: string) {
    const planSet = planSetId
      ? await this.prisma.planSet.findUnique({ where: { id: planSetId }, include: { items: true } })
      : await this.prisma.planSet.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' }, include: { items: true } });
    if (!planSet) return { planSet: null, rows: [] };

    const rows = [];
    for (const item of planSet.items) {
      const fact = await this.computePlanFact(item);
      const plan = Number(item.value);
      rows.push({
        id: item.id,
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        targetType: item.targetType,
        targetId: item.targetId,
        targetName: item.targetName,
        metricKey: item.metricKey,
        metricName: item.metricName,
        plan,
        fact,
        delta: fact == null ? null : Number((fact - plan).toFixed(2)),
        completionPercent: fact == null || plan === 0 ? null : Number(((fact / plan) * 100).toFixed(2)),
      });
    }
    return { planSet, rows };
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

  private async crmTelegramAccessWhere(actor: AuthUser): Promise<Prisma.CrmUserWhereInput> {
    const base: Prisma.CrmUserWhereInput = { isActive: true, isVisible: true };
    if (actor.role === 'ADMIN') return base;
    if (actor.businessRole !== 'ROP') throw new ForbiddenException('Нет доступа');

    const actorUser = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { crmUser: { select: { groupId: true } } },
    });
    const groupId = actorUser?.crmUser?.groupId;
    if (!groupId) throw new ForbiddenException('Сначала админ должен связать ваш аккаунт с пользователем amoCRM');
    return { ...base, groupId };
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

  private parseTelegramRecipientMode(input: unknown, fallback: 'default' | 'custom') {
    return String(input ?? fallback) === 'custom' ? 'custom' : 'default';
  }

  private telegramRecipientsForStorage(mode: 'default' | 'custom', recipients: Array<{ kind: string; id: string }>) {
    if (mode === 'default') return [];
    return recipients.length ? recipients : [{ kind: 'none', id: 'none' }];
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
    return {
      ...template,
      recipients,
      recipientsMode: disabled || recipients.length ? 'custom' : 'default',
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
    return new Prisma.Decimal(String(value).replace(',', '.'));
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
