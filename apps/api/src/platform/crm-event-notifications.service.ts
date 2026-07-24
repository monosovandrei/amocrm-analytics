import { Injectable, Logger } from '@nestjs/common';
import { DeliveryStatus, PlatformBusinessRole, Prisma, UserRole } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import {
  addMoscowBusinessTime,
  isMoscowBusinessDay,
  isMoscowWorkingTime,
  MOSCOW_WORKDAY_LABEL,
  moscowBusinessElapsedMs,
  moscowDate,
  moscowParts,
  moscowWeekdayElapsedMs,
  nextMoscowBusinessStart,
} from '../common/date.util';

type AppUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  businessRole: PlatformBusinessRole;
  crmUserId?: string | null;
  crmUser?: { id: string; name: string; group?: { name: string } | null } | null;
  telegramAccount?: { username: string | null; chatId: string } | null;
};

type StageWithPipeline = {
  id: string;
  externalId: string;
  name: string;
  pipeline: {
    externalId: string;
    name: string;
  };
};

type TelegramTemplateRecipient = {
  kind: 'platform_user' | 'crm_user';
  id: string;
};

type TelegramDeliveryMode = 'system' | 'direct_responsible' | 'selected' | 'group' | 'all_connected' | 'disabled';

const TELEGRAM_DELIVERY_MODE_KIND = 'delivery_mode';
const TELEGRAM_DELIVERY_MODES = new Set<TelegramDeliveryMode>([
  'system',
  'direct_responsible',
  'selected',
  'group',
  'all_connected',
  'disabled',
]);
const PERSONAL_TELEGRAM_EVENTS = new Set(['amo_new_assigned_lead', 'amo_assigned_lead_10m', 'amo_take_to_work_enabled']);

const PAYMENT_NOTIFICATION_ROUTES = [
  {
    pipelineNames: ['\u0412\u043e\u0440\u043e\u043d\u043a\u0430 \u041f\u0440\u043e\u0434\u0430\u0436\u0438'],
    recipientCrmExternalIds: ['13930346'],
  },
  {
    pipelineNames: ['\u0411\u0430\u0437\u0430', '\u0417\u0430\u043a\u0440\u0435\u043f\u043b\u0435\u043d\u043d\u044b\u0435 \u041a\u043e\u043c\u043f\u0430\u043d\u0438\u0438'],
    recipientCrmExternalIds: ['7462243'],
  },
] as const;

@Injectable()
export class CrmEventNotificationsService {
  private readonly logger = new Logger(CrmEventNotificationsService.name);
  private readonly workSlaMinutes = 20;
  private readonly assignedLeadReminderMinutes = 10;
  private readonly offHoursFirstPingHour = 10;
  private readonly offHoursFirstPingMinute = 30;
  private readonly massTaskMoveThreshold = 5;
  private readonly massTaskMoveWindowMinutes = 15;
  private readonly overdueTasksThreshold = 5;
  private readonly csmDailyCheckHour = 13;
  private readonly highValueIdleAmount = 20_000;
  private readonly highValueIdleHours = 24;

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramService,
  ) {}

  async processRecentAmoEvents(
    options: { since?: Date; domain?: string; includeEventDriven?: boolean; includeStateScans?: boolean } = {},
  ) {
    const since = options.since ?? new Date(Date.now() - 15 * 60_000);
    const domain = options.domain ?? (await this.resolveAmoDomain());
    const includeEventDriven = options.includeEventDriven ?? true;
    const includeStateScans = options.includeStateScans ?? true;
    const workField = includeEventDriven || includeStateScans
      ? await this.resolveLeadCustomFieldByName('\u0412\u0437\u044f\u0442\u044c \u0432 \u0440\u0430\u0431\u043e\u0442\u0443')
      : null;
    const eventTypes = ['lead_status_changed', 'task_deadline_changed'];
    if (workField) eventTypes.push(`custom_field_${workField.externalId}_value_changed`);

    const [events, paidStages, users] = await Promise.all([
      includeEventDriven ? this.prisma.crmEvent.findMany({
        where: {
          createdAt: { gte: since },
          type: { in: eventTypes },
        },
        include: {
          deal: {
            select: {
              id: true,
              externalId: true,
              title: true,
              amount: true,
              createdAt: true,
              updatedAt: true,
              stageId: true,
              responsibleId: true,
              responsible: { select: { id: true, name: true, group: { select: { name: true } } } },
              pipeline: { select: { id: true, name: true } },
              stage: { select: { id: true, name: true, isWon: true, isLost: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 500,
      }) : Promise.resolve([]),
      includeEventDriven ? this.resolvePaymentStages() : Promise.resolve(new Map<string, StageWithPipeline>()),
      this.prisma.user.findMany({
        where: { isActive: true },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          businessRole: true,
          crmUserId: true,
          crmUser: { select: { id: true, name: true, group: { select: { name: true } } } },
          telegramAccount: { select: { username: true, chatId: true } },
        },
      }),
    ]);

    const result = {
      checked: events.length,
      payment: 0,
      workAccepted: 0,
      skipped: 0,
      dueWorkAcceptedChecked: 0,
      assignedLeadNew: 0,
      assignedLeadReminder: 0,
      taskMassMove: 0,
      dealMassMove: 0,
      csmTaskMassMove: 0,
      csmDealMassMove: 0,
      csmOverdueTasks: 0,
      csmZeroTakenToWork: 0,
      csmZeroOfferMade: 0,
      invoiceNoPayment: 0,
      proposalStale: 0,
      highValueIdle: 0,
    };
    const leaders = this.salesLeaderUsers(users);
    const csmLeaders = this.csmLeaderUsers(users);

    if (includeEventDriven) {
      for (const event of events) {
        try {
          if (event.type === 'lead_status_changed') {
            if (!event.deal) continue;
            const paidStage = this.stageFromStatusEvent(event.valueAfter, paidStages);
            if (paidStage) {
              const sent = await this.notifyPayment(event, paidStage, users, domain);
              if (sent) result.payment += 1;
              else result.skipped += 1;
              continue;
            }
            continue;
          }

          if (workField && event.type === `custom_field_${workField.externalId}_value_changed`) {
            if (!this.customFieldIsEnabled(event.valueAfter) || !event.deal) continue;
            const sent = await this.notifyWorkAccepted(event, leaders, domain);
            if (sent) result.workAccepted += 1;
            else result.skipped += 1;
          }
        } catch (error: any) {
          this.logger.warn(`CRM notification failed for event ${event.externalId}: ${error.message}`);
          result.skipped += 1;
        }
      }

      const massTaskMove = await this.notifyMassTaskDeadlineChanges(events, leaders, 'sales', 'amo_task_mass_reschedule');
      result.taskMassMove += massTaskMove.sent;
      result.skipped += massTaskMove.skipped;

      const csmTaskMassMove = await this.notifyMassTaskDeadlineChanges(events, csmLeaders, 'csm', 'amo_csm_task_mass_reschedule');
      result.csmTaskMassMove += csmTaskMassMove.sent;
      result.skipped += csmTaskMassMove.skipped;

      const dealMassMove = await this.notifyMassDealStageChanges(events, leaders, 'sales', 'amo_deal_mass_move');
      result.dealMassMove += dealMassMove.sent;
      result.skipped += dealMassMove.skipped;

      const csmDealMassMove = await this.notifyMassDealStageChanges(events, csmLeaders, 'csm', 'amo_csm_deal_mass_move');
      result.csmDealMassMove += csmDealMassMove.sent;
      result.skipped += csmDealMassMove.skipped;
    }

    if (includeStateScans) {
      if (workField) {
        const dueResult = await this.notifyDueWorkAcceptedDeals(workField.externalId, leaders, domain);
        result.dueWorkAcceptedChecked = dueResult.checked;
        result.workAccepted += dueResult.sent;
        result.skipped += dueResult.skipped;
      }

      const csmOverdueTasks = await this.notifyCsmOverdueTasks(csmLeaders);
      result.csmOverdueTasks += csmOverdueTasks.sent;
      result.skipped += csmOverdueTasks.skipped;

      const csmDailyZeroMetrics = await this.notifyCsmDailyZeroFunnelMetrics(users);
      result.csmZeroTakenToWork += csmDailyZeroMetrics.zeroTakenToWork;
      result.csmZeroOfferMade += csmDailyZeroMetrics.zeroOfferMade;
      result.skipped += csmDailyZeroMetrics.skipped;

      const stateAlerts = await this.notifyStateBasedAlerts(users, leaders, domain);
      result.assignedLeadNew += stateAlerts.assignedLeadNew;
      result.assignedLeadReminder += stateAlerts.assignedLeadReminder;
      result.invoiceNoPayment += stateAlerts.invoiceNoPayment;
      result.proposalStale += stateAlerts.proposalStale;
      result.highValueIdle += stateAlerts.highValueIdle;
      result.skipped += stateAlerts.skipped;
    }

    return result;
  }

  private async notifyPayment(event: any, stage: StageWithPipeline, _users: AppUser[], domain: string) {
    const deal = event.deal;
    if (!deal.responsibleId) {
      return false;
    }
    const managerMention = await this.telegram.mentionForCrmUser(deal.responsibleId, deal.responsible?.name);
    const payload = {
      type: 'amo_payment_received',
      eventId: event.externalId,
      dealId: deal.id,
      dealExternalId: deal.externalId,
      managerCrmUserId: deal.responsibleId,
      stageId: stage.id,
    };
    const message = await this.renderNotification('amo_payment_received', payload.type, {
      amount: this.formatMoney(deal.amount),
      deal: deal.title,
      dealUrl: this.dealUrl(domain, deal.externalId),
      group: deal.responsible?.group?.name ?? '-',
      manager: deal.responsible?.name ?? '-',
      managerMention,
      pipeline: stage.pipeline.name,
      stage: stage.name,
    });

    const eventKey = `amo:payment:${event.externalId}:${deal.responsibleId}`;
    const routeDeliveries = await this.sendPaymentNotificationByPipeline(stage, message, payload, eventKey);
    if (routeDeliveries) return routeDeliveries.some((delivery) => delivery?.status === 'SENT');

    const configuredDeliveries = await this.sendConfiguredNotification('amo_payment_received', message, payload, eventKey);
    if (configuredDeliveries) return configuredDeliveries.some((delivery) => delivery?.status === 'SENT');

    const delivery = await this.telegram.sendDirectMessageToCrmUser(deal.responsibleId, message, payload, undefined, eventKey);
    return delivery.status === 'SENT';
  }

  private async sendPaymentNotificationByPipeline(
    stage: StageWithPipeline,
    message: string,
    payload: Record<string, unknown>,
    eventKey: string,
  ) {
    const route = PAYMENT_NOTIFICATION_ROUTES.find((item) => {
      const pipelineName = this.normalizeText(stage.pipeline.name);
      return item.pipelineNames.some((name) => this.normalizeText(name) === pipelineName);
    });
    if (!route) return null;

    const recipients = await this.prisma.crmUser.findMany({
      where: {
        externalId: { in: [...route.recipientCrmExternalIds] },
        isActive: true,
        isVisible: true,
        telegramAccount: { is: { isActive: true } },
      },
      select: { id: true },
    });

    if (!recipients.length) {
      return [
        await this.recordSkipped(
          `${eventKey}:payment-route`,
          message,
          {
            ...payload,
            paymentRoute: 'pipeline',
            paymentPipeline: stage.pipeline.name,
            reason: '\u041f\u043e\u043b\u0443\u0447\u0430\u0442\u0435\u043b\u044c Telegram \u0434\u043b\u044f \u0432\u043e\u0440\u043e\u043d\u043a\u0438 \u043d\u0435 \u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0451\u043d',
          },
        ),
      ];
    }

    return this.telegram.sendDirectMessageToCrmUsers(
      recipients.map((recipient) => recipient.id),
      message,
      {
        ...payload,
        paymentRoute: 'pipeline',
        paymentPipeline: stage.pipeline.name,
      },
      undefined,
      `${eventKey}:payment-route`,
    );
  }

  private async notifyWorkAccepted(event: any, leaders: AppUser[], domain: string) {
    const deal = event.deal;
    if (!this.workSlaIsDue(deal, new Date())) return false;
    return this.notifyWorkAcceptedDeal(deal, leaders, domain, event.externalId);
  }

  private async notifyDueWorkAcceptedDeals(workFieldExternalId: string, leaders: AppUser[], domain: string) {
    const salesPipelineIds = await this.salesPipelineIds();
    if (!salesPipelineIds.length) return { checked: 0, sent: 0, skipped: 0 };

    const now = new Date();
    let checked = 0;
    let sent = 0;
    let skipped = 0;
    const maxDeals = 1000;
    const batchSize = 200;
    for (let skip = 0; skip < maxDeals; skip += batchSize) {
      const factDeals = await this.prisma.factDealCurrent.findMany({
        where: {
          deletedAt: null,
          createdAt: { lte: now },
          pipelineId: { in: salesPipelineIds },
          stageIsWon: false,
          stageIsLost: false,
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: batchSize,
      });
      const deals = factDeals.map((deal) => this.factDealToNotificationDeal(deal));
      if (deals.length === 0) break;

      for (const deal of deals) {
        if (!this.customFieldIsEnabled((deal.customFields as Record<string, unknown>)?.[workFieldExternalId])) continue;
        if (!this.workSlaIsDue(deal, now)) continue;
        checked += 1;
        const delivered = await this.notifyWorkAcceptedDeal(deal, leaders, domain);
        if (delivered) sent += 1;
        else skipped += 1;
      }
      this.compactHeap();
    }

    return { checked, sent, skipped };
  }

  private async notifyMassTaskDeadlineChanges(
    events: any[],
    leaders: AppUser[],
    team: 'sales' | 'csm',
    eventType: 'amo_task_mass_reschedule' | 'amo_csm_task_mass_reschedule',
  ) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    const taskEvents = events.filter((event) => event.type === 'task_deadline_changed');
    if (!taskEvents.length) return { sent: 0, skipped: 0 };

    const groups = new Map<string, { createdBy: string; bucket: number; taskIds: Set<string>; eventIds: string[] }>();
    for (const event of taskEvents) {
      const createdBy = this.eventActorExternalId(event);
      if (!createdBy || createdBy === '0') continue;
      const taskId = this.eventEntityId(event);
      if (!taskId) continue;
      const bucket = Math.floor(event.createdAt.getTime() / (this.massTaskMoveWindowMinutes * 60_000));
      const key = `${createdBy}:${bucket}`;
      const group = groups.get(key) ?? { createdBy, bucket, taskIds: new Set<string>(), eventIds: [] };
      group.taskIds.add(taskId);
      group.eventIds.push(event.externalId);
      groups.set(key, group);
    }

    const managerExternalIds = Array.from(new Set(Array.from(groups.values()).map((group) => group.createdBy)));
    const managers = await this.prisma.crmUser.findMany({
      where: { externalId: { in: managerExternalIds } },
      select: { externalId: true, name: true, group: { select: { name: true } } },
    });
    const managersByExternalId = new Map(managers.map((manager) => [manager.externalId, manager]));

    let sent = 0;
    let skipped = 0;
    for (const group of groups.values()) {
      const managerRecord = managersByExternalId.get(group.createdBy);
      if (!this.isTeamGroup(managerRecord?.group?.name, team)) continue;
      const taskCount = group.taskIds.size;
      if (taskCount < this.massTaskMoveThreshold) continue;
      const manager = managerRecord?.name ?? `amoCRM user ${group.createdBy}`;
      const eventKey = `amo:task-mass-move:${team}:${group.createdBy}:${group.bucket}`;
      const message = await this.renderNotification(eventType, eventType, {
        manager,
        taskCount: String(taskCount),
      });
      const configuredDeliveries = await this.sendConfiguredNotification(eventType, message, {
        type: eventType,
        team,
        manager,
        managerExternalId: group.createdBy,
        taskCount,
      }, eventKey);
      if (configuredDeliveries) {
        if (configuredDeliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
        else skipped += 1;
        continue;
      }
      const deliveries = await this.telegram.sendDirectMessageToUsers(
        leaders.map((leader) => leader.id),
        message,
        {
          type: eventType,
          team,
          manager,
          managerExternalId: group.createdBy,
          taskCount,
        },
        undefined,
        eventKey,
      );
      if (deliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
      else skipped += 1;
    }

    return { sent, skipped };
  }

  private async notifyMassDealStageChanges(
    events: any[],
    leaders: AppUser[],
    team: 'sales' | 'csm',
    eventType: 'amo_deal_mass_move' | 'amo_csm_deal_mass_move',
  ) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    const stageEvents = events.filter((event) => event.type === 'lead_status_changed');
    if (!stageEvents.length) return { sent: 0, skipped: 0 };

    const groups = new Map<string, { createdBy: string; bucket: number; dealIds: Set<string> }>();
    for (const event of stageEvents) {
      const createdBy = this.eventActorExternalId(event);
      if (!createdBy || createdBy === '0') continue;
      const dealId = event.deal?.id ?? this.eventEntityId(event);
      if (!dealId) continue;
      const bucket = Math.floor(event.createdAt.getTime() / (this.massTaskMoveWindowMinutes * 60_000));
      const key = `${createdBy}:${bucket}`;
      const group = groups.get(key) ?? { createdBy, bucket, dealIds: new Set<string>() };
      group.dealIds.add(String(dealId));
      groups.set(key, group);
    }

    const managerExternalIds = Array.from(new Set(Array.from(groups.values()).map((group) => group.createdBy)));
    const managers = await this.prisma.crmUser.findMany({
      where: { externalId: { in: managerExternalIds } },
      select: { externalId: true, name: true, group: { select: { name: true } } },
    });
    const managersByExternalId = new Map(managers.map((manager) => [manager.externalId, manager]));

    let sent = 0;
    let skipped = 0;
    for (const group of groups.values()) {
      const managerRecord = managersByExternalId.get(group.createdBy);
      if (!this.isTeamGroup(managerRecord?.group?.name, team)) continue;
      const dealCount = group.dealIds.size;
      if (dealCount < this.massTaskMoveThreshold) continue;
      const manager = managerRecord?.name ?? `amoCRM user ${group.createdBy}`;
      const eventKey = `amo:deal-mass-move:${team}:${group.createdBy}:${group.bucket}`;
      const message = await this.renderNotification(eventType, eventType, {
        manager,
        dealCount: String(dealCount),
      });
      const configuredDeliveries = await this.sendConfiguredNotification(eventType, message, {
        type: eventType,
        team,
        manager,
        managerExternalId: group.createdBy,
        dealCount,
      }, eventKey);
      if (configuredDeliveries) {
        if (configuredDeliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
        else skipped += 1;
        continue;
      }
      const deliveries = await this.telegram.sendDirectMessageToUsers(
        leaders.map((leader) => leader.id),
        message,
        {
          type: eventType,
          team,
          manager,
          managerExternalId: group.createdBy,
          dealCount,
        },
        undefined,
        eventKey,
      );
      if (deliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
      else skipped += 1;
    }

    return { sent, skipped };
  }

  private async notifyCsmOverdueTasks(leaders: AppUser[]) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    const now = new Date();
    const tasks = await this.prisma.task.findMany({
      where: {
        isCompleted: false,
        dueAt: { lt: now },
        responsibleId: { not: null },
      },
      include: {
        responsible: { include: { group: true } },
        deal: { select: { id: true, externalId: true, title: true } },
      },
      orderBy: { dueAt: 'asc' },
      take: 5000,
    });

    const byManager = new Map<string, { managerName: string; taskIds: string[] }>();
    for (const task of tasks) {
      if (!this.isTeamGroup(task.responsible?.group?.name, 'csm') || !task.responsibleId) continue;
      const group = byManager.get(task.responsibleId) ?? {
        managerName: task.responsible?.name ?? '-',
        taskIds: [],
      };
      group.taskIds.push(task.id);
      byManager.set(task.responsibleId, group);
    }

    let sent = 0;
    let skipped = 0;
    const dayKey = this.moscowDateKey(now);
    for (const [managerId, group] of byManager.entries()) {
      const taskCount = group.taskIds.length;
      if (taskCount <= this.overdueTasksThreshold) continue;
      const eventKey = `amo:csm-overdue-tasks:${managerId}:${dayKey}`;
      const message = await this.renderNotification('amo_csm_overdue_tasks', 'amo_csm_overdue_tasks', {
        manager: group.managerName,
        taskCount: String(taskCount),
      });
      const configuredDeliveries = await this.sendConfiguredNotification('amo_csm_overdue_tasks', message, {
        type: 'amo_csm_overdue_tasks',
        team: 'csm',
        managerId,
        manager: group.managerName,
        taskCount,
      }, eventKey);
      if (configuredDeliveries) {
        if (configuredDeliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
        else skipped += 1;
        continue;
      }
      const deliveries = await this.telegram.sendDirectMessageToUsers(
        leaders.map((leader) => leader.id),
        message,
        {
          type: 'amo_csm_overdue_tasks',
          team: 'csm',
          managerId,
          manager: group.managerName,
          taskCount,
        },
        undefined,
        eventKey,
      );
      if (deliveries.some((delivery) => delivery?.status === 'SENT')) sent += 1;
      else skipped += 1;
    }

    return { sent, skipped };
  }

  private async notifyCsmDailyZeroFunnelMetrics(users: AppUser[]) {
    const now = new Date();
    if (!this.shouldRunCsmDailyCheck(now)) {
      return { zeroTakenToWork: 0, zeroOfferMade: 0, skipped: 0 };
    }

    const refs = await this.resolveCsmFunnelRefs();
    if (!refs) return { zeroTakenToWork: 0, zeroOfferMade: 0, skipped: 0 };

    const managers = await this.prisma.crmUser.findMany({
      where: { isActive: true, isVisible: true, groupId: refs.csmGroupId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (!managers.length) return { zeroTakenToWork: 0, zeroOfferMade: 0, skipped: 0 };

    const window = this.moscowDayWindowUntil(now, this.csmDailyCheckHour);
    const [takenToWorkCounts, offerMadeCounts] = await Promise.all([
      this.countFirstStageReachedByManager([refs.baseStages.work.id, refs.assignedStages.work.id], refs, window.startAt, window.endAt),
      this.countFirstStageReachedByManager([refs.baseStages.offer.id, refs.assignedStages.offer.id], refs, window.startAt, window.endAt),
    ]);

    let zeroTakenToWork = 0;
    let zeroOfferMade = 0;
    let skipped = 0;
    const dayKey = this.moscowDateKey(now);

    for (const manager of managers) {
      const takenToWork = takenToWorkCounts.get(manager.id) ?? 0;
      const offerMade = offerMadeCounts.get(manager.id) ?? 0;
      const managerMention = await this.telegram.mentionForCrmUser(manager.id, manager.name);

      if (takenToWork === 0) {
        const delivered = await this.notifyCsmManagerDailyZeroMetric(
          manager,
          'amo_csm_zero_taken_to_work_13',
          'taken_to_work',
          dayKey,
          { managerMention, manager: manager.name },
        );
        if (delivered) zeroTakenToWork += 1;
        else skipped += 1;
      }

      if (offerMade === 0) {
        const delivered = await this.notifyCsmManagerDailyZeroMetric(
          manager,
          'amo_csm_zero_offer_made_13',
          'offer_made',
          dayKey,
          { managerMention, manager: manager.name },
        );
        if (delivered) zeroOfferMade += 1;
        else skipped += 1;
      }
    }

    return { zeroTakenToWork, zeroOfferMade, skipped };
  }

  private async notifyCsmManagerDailyZeroMetric(
    manager: { id: string; name: string },
    eventType: 'amo_csm_zero_taken_to_work_13' | 'amo_csm_zero_offer_made_13',
    metricKey: 'taken_to_work' | 'offer_made',
    dayKey: string,
    variables: Record<string, string>,
  ) {
    const eventKey = `amo:csm-daily-zero:${metricKey}:${manager.id}:${dayKey}`;
    const message = await this.renderNotification(eventType, eventType, variables);
    const payload = {
      type: eventType,
      team: 'csm',
      metricKey,
      managerCrmUserId: manager.id,
      dayKey,
    };
    const configuredDeliveries = await this.sendConfiguredNotification(eventType, message, payload, eventKey);
    if (configuredDeliveries) return configuredDeliveries.some((delivery) => delivery?.status === 'SENT');

    const delivery = await this.telegram.sendDirectMessageToCrmUser(
      manager.id,
      message,
      payload,
      undefined,
      eventKey,
    );
    return delivery.status === 'SENT';
  }

  private async notifyStateBasedAlerts(users: AppUser[], leaders: AppUser[], domain: string) {
    const salesPipelineIds = await this.salesPipelineIds();
    if (!salesPipelineIds.length) {
      return { assignedLeadNew: 0, assignedLeadReminder: 0, invoiceNoPayment: 0, proposalStale: 0, highValueIdle: 0, skipped: 0 };
    }

    const now = new Date();
    const result = { assignedLeadNew: 0, assignedLeadReminder: 0, invoiceNoPayment: 0, proposalStale: 0, highValueIdle: 0, skipped: 0 };
    const maxDeals = 2000;
    const batchSize = 200;
    for (let skip = 0; skip < maxDeals; skip += batchSize) {
      const factDeals = await this.prisma.factDealCurrent.findMany({
        where: {
          deletedAt: null,
          pipelineId: { in: salesPipelineIds },
          stageIsWon: false,
          stageIsLost: false,
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take: batchSize,
      });
      const deals = await this.attachNotificationActivity(factDeals.map((deal) => this.factDealToNotificationDeal(deal)));
      if (deals.length === 0) break;

      for (const deal of deals) {
        if (this.isAssignedResponsibleStage(deal.stage?.name)) {
          const delivered = await this.notifyAssignedLeadManagerAlerts(deal, users, domain, now);
          result.assignedLeadNew += delivered.newLead;
          result.assignedLeadReminder += delivered.reminder;
          result.skipped += delivered.skipped;
        }

        if (this.isInvoiceSentStage(deal.stage?.name)) {
          const delivered = await this.notifyInvoiceNoPayment(deal, leaders, domain, now);
          result.invoiceNoPayment += delivered.sent;
          result.skipped += delivered.skipped;
        }

        if (this.isProposalOrObjectionStage(deal.stage?.name)) {
          const delivered = await this.notifyProposalStale(deal, leaders, domain, now);
          result.proposalStale += delivered.sent;
          result.skipped += delivered.skipped;
        }

        const highValueIdle = await this.notifyHighValueIdle(deal, leaders, domain, now);
        result.highValueIdle += highValueIdle.sent;
        result.skipped += highValueIdle.skipped;
      }
      this.compactHeap();
    }

    return result;
  }

  private async notifyAssignedLeadManagerAlerts(deal: any, users: AppUser[], domain: string, now: Date) {
    if (!deal.responsibleId) return { newLead: 0, reminder: 0, skipped: 0 };
    const managerMention = await this.telegram.mentionForCrmUser(deal.responsibleId, deal.responsible?.name);

    const managerTask = (deal.tasks ?? []).find((task: any) => task.responsibleId === deal.responsibleId && !task.isCompleted);
    if (!managerTask) return { newLead: 0, reminder: 0, skipped: 0 };

    const triggerAt = this.assignedLeadTriggerAt(deal, managerTask);
    const schedule = this.assignedLeadPingSchedule(triggerAt);
    const firstKey = `amo:assigned-lead-new:${deal.id}:${managerTask.id}`;
    const reminderKey = `amo:assigned-lead-10m:${deal.id}:${managerTask.id}`;
    let newLead = 0;
    let reminder = 0;
    let skipped = 0;

    const firstRecorded = await this.deliveryExists(firstKey);
    if (now >= schedule.firstPingAt && !firstRecorded) {
      const message = await this.renderNotification('amo_new_assigned_lead', 'amo_new_assigned_lead', {
        deal: deal.title,
        dealUrl: this.dealUrl(domain, deal.externalId),
        manager: deal.responsible?.name ?? '-',
        managerMention,
      });
      const payload = {
        type: 'amo_new_assigned_lead',
        dealId: deal.id,
        dealExternalId: deal.externalId,
        managerCrmUserId: deal.responsibleId,
        taskId: managerTask.id,
      };
      const configuredDeliveries = await this.sendConfiguredNotification('amo_new_assigned_lead', message, payload, firstKey);
      if (configuredDeliveries) {
        if (configuredDeliveries.some((delivery) => delivery?.status === 'SENT')) newLead += 1;
        else skipped += 1;
        return { newLead, reminder, skipped };
      }
      const delivery = await this.telegram.sendDirectMessageToCrmUser(
        deal.responsibleId,
        message,
        payload,
        undefined,
        firstKey,
      );
      if (delivery.status === 'SENT') newLead += 1;
      else skipped += 1;
      return { newLead, reminder, skipped };
    }

    if (now >= schedule.reminderPingAt && firstRecorded && !(await this.deliveryExists(reminderKey))) {
      const message = await this.renderNotification('amo_assigned_lead_10m', 'amo_assigned_lead_10m', {
        deal: deal.title,
        dealUrl: this.dealUrl(domain, deal.externalId),
        manager: deal.responsible?.name ?? '-',
        managerMention,
      });
      const payload = {
        type: 'amo_assigned_lead_10m',
        dealId: deal.id,
        dealExternalId: deal.externalId,
        managerCrmUserId: deal.responsibleId,
        taskId: managerTask.id,
      };
      const configuredDeliveries = await this.sendConfiguredNotification('amo_assigned_lead_10m', message, payload, reminderKey);
      if (configuredDeliveries) {
        if (configuredDeliveries.some((delivery) => delivery?.status === 'SENT')) reminder += 1;
        else skipped += 1;
        return { newLead, reminder, skipped };
      }
      const delivery = await this.telegram.sendDirectMessageToCrmUser(
        deal.responsibleId,
        message,
        payload,
        undefined,
        reminderKey,
      );
      if (delivery.status === 'SENT') reminder += 1;
      else skipped += 1;
    }

    return { newLead, reminder, skipped };
  }

  private async notifyInvoiceNoPayment(deal: any, leaders: AppUser[], domain: string, now: Date) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    const enteredAt = this.currentStageEnteredAt(deal);
    if (moscowWeekdayElapsedMs(enteredAt, now) < 3 * 24 * 60 * 60_000) return { sent: 0, skipped: 0 };

    const eventKey = `amo:invoice-no-payment-3d:${deal.id}:${deal.stageId}`;
    const message = await this.renderNotification('amo_invoice_no_payment_3d', 'amo_invoice_no_payment_3d', {
      deal: deal.title,
      dealUrl: this.dealUrl(domain, deal.externalId),
      amount: this.formatMoney(deal.amount),
      manager: deal.responsible?.name ?? '-',
    });
    const payload = { type: 'amo_invoice_no_payment_3d', dealId: deal.id, dealExternalId: deal.externalId };
    const configuredDeliveries = await this.sendConfiguredNotification('amo_invoice_no_payment_3d', message, payload, eventKey);
    if (configuredDeliveries) {
      return configuredDeliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
    }
    const deliveries = await this.telegram.sendDirectMessageToUsers(
      leaders.map((leader) => leader.id),
      message,
      payload,
      undefined,
      eventKey,
    );
    return deliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
  }

  private async notifyProposalStale(deal: any, leaders: AppUser[], domain: string, now: Date) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    const enteredAt = this.currentStageEnteredAt(deal);
    if (moscowWeekdayElapsedMs(enteredAt, now) < 24 * 60 * 60_000) return { sent: 0, skipped: 0 };

    const eventKey = `amo:proposal-stale-24h:${deal.id}:${deal.stageId}`;
    const message = await this.renderNotification('amo_proposal_stale_24h', 'amo_proposal_stale_24h', {
      deal: deal.title,
      dealUrl: this.dealUrl(domain, deal.externalId),
      amount: this.formatMoney(deal.amount),
      manager: deal.responsible?.name ?? '-',
    });
    const payload = { type: 'amo_proposal_stale_24h', dealId: deal.id, dealExternalId: deal.externalId };
    const configuredDeliveries = await this.sendConfiguredNotification('amo_proposal_stale_24h', message, payload, eventKey);
    if (configuredDeliveries) {
      return configuredDeliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
    }
    const deliveries = await this.telegram.sendDirectMessageToUsers(
      leaders.map((leader) => leader.id),
      message,
      payload,
      undefined,
      eventKey,
    );
    return deliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
  }

  private async notifyHighValueIdle(deal: any, leaders: AppUser[], domain: string, now: Date) {
    if (!leaders.length) return { sent: 0, skipped: 0 };
    if (Number(deal.amount ?? 0) <= this.highValueIdleAmount) return { sent: 0, skipped: 0 };

    const lastActivityAt = this.lastDealActivityAt(deal);
    const idleMs = moscowWeekdayElapsedMs(lastActivityAt, now);
    if (idleMs < this.highValueIdleHours * 60 * 60_000) return { sent: 0, skipped: 0 };

    const eventKey = `amo:high-value-idle-24h:${deal.id}:${deal.stageId}:${lastActivityAt.toISOString()}`;
    const message = await this.renderNotification('amo_high_value_idle_24h', 'amo_high_value_idle_24h', {
      deal: deal.title,
      dealUrl: this.dealUrl(domain, deal.externalId),
      amount: this.formatMoney(deal.amount),
      manager: deal.responsible?.name ?? '-',
      pipeline: deal.pipeline?.name ?? '-',
      stage: deal.stage?.name ?? '-',
    });
    const payload = {
      type: 'amo_high_value_idle_24h',
      dealId: deal.id,
      dealExternalId: deal.externalId,
      amount: Number(deal.amount ?? 0),
      managerCrmUserId: deal.responsibleId,
      lastActivityAt: lastActivityAt.toISOString(),
    };
    const configuredDeliveries = await this.sendConfiguredNotification('amo_high_value_idle_24h', message, payload, eventKey);
    if (configuredDeliveries) {
      return configuredDeliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
    }
    const deliveries = await this.telegram.sendDirectMessageToUsers(
      leaders.map((leader) => leader.id),
      message,
      payload,
      undefined,
      eventKey,
    );
    return deliveries.some((delivery) => delivery?.status === 'SENT') ? { sent: 1, skipped: 0 } : { sent: 0, skipped: 1 };
  }

  private async notifyWorkAcceptedDeal(deal: any, leaders: AppUser[], domain: string, eventId?: string | null) {
    const managerMention = await this.telegram.mentionForCrmUser(deal.responsibleId, deal.responsible?.name);
    const payload = {
      type: 'amo_take_to_work_enabled',
      eventId: eventId ?? null,
      dealId: deal.id,
      dealExternalId: deal.externalId,
      managerCrmUserId: deal.responsibleId,
      slaDueAt: this.workSlaDueAt(deal.createdAt).toISOString(),
    };
    const message = await this.renderNotification('amo_take_to_work_enabled', payload.type, {
      amount: this.formatMoney(deal.amount),
      deal: deal.title,
      dealUrl: this.dealUrl(domain, deal.externalId),
      group: deal.responsible?.group?.name ?? '-',
      manager: deal.responsible?.name ?? '-',
      managerMention,
      pipeline: deal.pipeline?.name ?? '-',
      stage: deal.stage?.name ?? '-',
    });

    const eventKey = `amo:work-sla:${deal.id}`;
    const configuredDeliveries = await this.sendConfiguredNotification('amo_take_to_work_enabled', message, payload, eventKey);
    if (configuredDeliveries) return configuredDeliveries.some((delivery) => delivery?.status === 'SENT');

    const managerDelivery = deal.responsibleId
      ? await this.telegram.sendDirectMessageToCrmUser(deal.responsibleId, message, payload, undefined, eventKey)
      : null;
    const managerSent = managerDelivery?.status === 'SENT';

    if (!leaders.length) {
      if (managerSent) return true;
      await this.recordSkipped(`amo:work-sla:${deal.id}:no-leader`, message, {
        ...payload,
        reason: 'Нет активного руководителя в платформе',
      });
      return false;
    }

    const leaderDeliveries = await this.telegram.sendDirectMessageToUsers(
      leaders.map((leader) => leader.id),
      message,
      payload,
      undefined,
      `${eventKey}:sales-rop`,
    );
    return managerSent || leaderDeliveries.some((delivery) => delivery?.status === 'SENT');
  }

  private eventEntityId(event: any) {
    const value = event.raw?.entity_id ?? event.raw?._embedded?.entity?.id ?? event.entity_id;
    return value == null ? null : String(value);
  }

  private eventActorExternalId(event: any) {
    const rawCreatedBy = event.raw?.created_by;
    if (rawCreatedBy && typeof rawCreatedBy === 'object' && rawCreatedBy.id != null) {
      return String(rawCreatedBy.id);
    }
    const value = (rawCreatedBy && typeof rawCreatedBy !== 'object' ? rawCreatedBy : null) ??
      event.raw?.created_by_id ??
      event.raw?.created_by_user_id;
    return value == null ? '' : String(value);
  }

  private async deliveryExists(eventKey: string) {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { eventKey },
      select: { id: true },
    });
    return Boolean(delivery);
  }

  private compactHeap() {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    if (typeof gc === 'function') gc();
  }

  private assignedLeadTriggerAt(deal: any, task: any) {
    const stageEnteredAt = this.currentStageEnteredAt(deal);
    const taskCreatedAt = this.taskCreatedAt(task);
    return new Date(Math.max(deal.createdAt.getTime(), stageEnteredAt.getTime(), taskCreatedAt.getTime()));
  }

  private assignedLeadPingSchedule(triggerAt: Date) {
    if (this.isMoscowWorkingTime(triggerAt)) {
      const firstPingAt = triggerAt;
      const reminderPingAt = addMoscowBusinessTime(firstPingAt, this.assignedLeadReminderMinutes * 60_000);
      return { firstPingAt, reminderPingAt };
    }

    const workStart = this.workSlaStartAt(triggerAt);
    const parts = this.moscowParts(workStart);
    const firstPingAt = this.moscowDate(
      parts.year,
      parts.month,
      parts.day,
      this.offHoursFirstPingHour,
      this.offHoursFirstPingMinute,
      0,
      0,
    );
    const reminderPingAt = new Date(firstPingAt.getTime() + this.assignedLeadReminderMinutes * 60_000);
    return { firstPingAt, reminderPingAt };
  }

  private isMoscowWorkingTime(date: Date) {
    return isMoscowWorkingTime(date);
  }

  private currentStageEnteredAt(deal: any) {
    const currentStageHistory = (deal.stageHistory ?? [])
      .filter((item: any) => item.toStageId === deal.stageId)
      .sort((a: any, b: any) => b.movedAt.getTime() - a.movedAt.getTime())[0];
    return currentStageHistory?.movedAt ?? deal.createdAt;
  }

  private lastDealActivityAt(deal: any) {
    const dates = [
      deal.updatedAt,
      deal.stageHistory?.[0]?.movedAt,
      deal.notes?.[0]?.createdAt,
      deal.events?.[0]?.createdAt,
      ...(deal.tasks ?? []).flatMap((task: any) => [task.createdAt, task.updatedAt, task.completedAt].filter(Boolean)),
    ].filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));
    if (!dates.length) return deal.createdAt;
    return new Date(Math.max(...dates.map((date) => date.getTime())));
  }

  private taskCreatedAt(task: { createdAt: Date; raw?: unknown }) {
    const rawCreatedAt = (task.raw as any)?.created_at;
    if (rawCreatedAt) {
      const rawDate = new Date(Number(rawCreatedAt) * 1000);
      if (!Number.isNaN(rawDate.getTime())) return rawDate;
    }
    return task.createdAt;
  }

  private salesLeaderUsers(users: AppUser[]) {
    return this.teamLeaderUsers(users, 'sales');
  }

  private csmLeaderUsers(users: AppUser[]) {
    return this.teamLeaderUsers(users, 'csm');
  }

  private csmManagerUsers(users: AppUser[]) {
    return users.filter((user) =>
      user.businessRole === 'MANAGER' &&
      Boolean(user.crmUserId) &&
      this.isCsmGroup(user.crmUser?.group?.name),
    );
  }

  private teamLeaderUsers(users: AppUser[], team: 'sales' | 'csm') {
    return users.filter((user) => user.businessRole === 'ROP' && this.isTeamGroup(user.crmUser?.group?.name, team));
  }

  private isTeamGroup(name: string | null | undefined, team: 'sales' | 'csm') {
    return team === 'sales' ? this.isSalesGroup(name) : this.isCsmGroup(name);
  }

  private isSalesGroup(name?: string | null) {
    const normalized = this.normalizeText(name ?? '');
    return normalized.includes('sales') || normalized.includes(this.normalizeText('\u043f\u0440\u043e\u0434\u0430\u0436'));
  }

  private isCsmGroup(name?: string | null) {
    const normalized = this.normalizeText(name ?? '');
    return normalized.includes('csm') || normalized.includes(this.normalizeText('\u043a\u0441\u043c'));
  }

  private shouldRunCsmDailyCheck(now: Date) {
    const parts = this.moscowParts(now);
    if (!this.isMoscowBusinessDay(parts)) return false;
    const checkAt = this.moscowDate(parts.year, parts.month, parts.day, this.csmDailyCheckHour, 0, 0, 0);
    return now >= checkAt;
  }

  private moscowDayWindowUntil(now: Date, hour: number) {
    const parts = this.moscowParts(now);
    return {
      startAt: this.moscowDate(parts.year, parts.month, parts.day, 0, 0, 0, 0),
      endAt: this.moscowDate(parts.year, parts.month, parts.day, hour, 0, 0, 0),
    };
  }

  private async resolveCsmFunnelRefs() {
    const pipelines = await this.prisma.pipeline.findMany({
      where: { isArchived: false },
      include: { stages: { orderBy: { position: 'asc' } } },
    });
    const groups = await this.prisma.crmGroup.findMany({ select: { id: true, name: true } });
    const csmGroup = groups.find((group) => this.normalizeText(group.name) === 'csm') ??
      groups.find((group) => this.isCsmGroup(group.name)) ??
      null;
    const basePipeline = pipelines.find((pipeline) => this.normalizeText(pipeline.name) === this.normalizeText('\u0431\u0430\u0437\u0430')) ?? null;
    const assignedPipeline = pipelines.find((pipeline) =>
      this.normalizeText(pipeline.name).includes(this.normalizeText('\u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0435\u043d')),
    ) ?? null;
    if (!csmGroup || !basePipeline || !assignedPipeline) return null;

    const stageByName = (
      stages: Array<{ id: string; name: string }>,
      needles: string[],
    ) => stages.find((stage) => {
      const name = this.normalizeText(stage.name);
      return needles.every((needle) => name.includes(this.normalizeText(needle)));
    }) ?? null;

    const baseStages = {
      work: stageByName(basePipeline.stages, ['\u0432\u0437\u044f\u0442', '\u0440\u0430\u0431\u043e\u0442']),
      offer: stageByName(basePipeline.stages, ['\u0441\u0434\u0435\u043b\u0430\u043d\u043e', '\u043f\u0440\u0435\u0434\u043b\u043e\u0436']),
    };
    const assignedStages = {
      work: stageByName(assignedPipeline.stages, ['\u0432\u0437\u044f\u0442', '\u0440\u0430\u0431\u043e\u0442']),
      offer: stageByName(assignedPipeline.stages, ['\u0441\u0434\u0435\u043b\u0430\u043d\u043e', '\u043f\u0440\u0435\u0434\u043b\u043e\u0436']),
    };
    if (!baseStages.work || !baseStages.offer || !assignedStages.work || !assignedStages.offer) return null;

    return {
      pipelineIds: [basePipeline.id, assignedPipeline.id],
      csmGroupId: csmGroup.id,
      baseStages: baseStages as { work: { id: string }; offer: { id: string } },
      assignedStages: assignedStages as { work: { id: string }; offer: { id: string } },
    };
  }

  private async countFirstStageReachedByManager(
    stageIds: string[],
    refs: { pipelineIds: string[]; csmGroupId: string },
    startAt: Date,
    endAt: Date,
  ) {
    const csmManagers = await this.prisma.crmUser.findMany({
      where: { isActive: true, groupId: refs.csmGroupId },
      select: { id: true },
    });
    const csmManagerIds = csmManagers.map((manager) => manager.id);
    if (!csmManagerIds.length) return new Map<string, number>();

    const history = await this.prisma.$queryRaw<Array<{ dealId: string; movedAt: Date; responsibleId: string | null }>>`
      SELECT
        transition."deal_id" AS "dealId",
        transition."moved_at" AS "movedAt",
        deal."responsible_id" AS "responsibleId"
      FROM "fact_stage_transition" transition
      JOIN "fact_deal_current" deal ON deal."deal_id" = transition."deal_id"
      WHERE transition."to_stage_id" IN (${Prisma.join(stageIds)})
        AND transition."moved_at" <= ${endAt}
        AND deal."deleted_at" IS NULL
        AND deal."pipeline_id" IN (${Prisma.join(refs.pipelineIds)})
        AND deal."responsible_id" IN (${Prisma.join(csmManagerIds)})
      ORDER BY transition."deal_id" ASC, transition."moved_at" ASC
    `;

    const firstEntryByDeal = new Map<string, { movedAt: Date; responsibleId: string | null }>();
    for (const entry of history) {
      if (!firstEntryByDeal.has(entry.dealId)) {
        firstEntryByDeal.set(entry.dealId, {
          movedAt: entry.movedAt,
          responsibleId: entry.responsibleId,
        });
      }
    }

    const counts = new Map<string, number>();
    for (const entry of firstEntryByDeal.values()) {
      if (!entry.responsibleId || entry.movedAt < startAt || entry.movedAt > endAt) continue;
      counts.set(entry.responsibleId, (counts.get(entry.responsibleId) ?? 0) + 1);
    }
    return counts;
  }

  private isInvoiceSentStage(name?: string | null) {
    const normalized = this.normalizeText(name ?? '');
    return (normalized.includes(this.normalizeText('\u0441\u0447\u0435\u0442')) ||
      normalized.includes(this.normalizeText('\u0441\u0447\u0451\u0442'))) &&
      (normalized.includes(this.normalizeText('\u043e\u0442\u043f\u0440\u0430\u0432')) ||
        normalized.includes(this.normalizeText('\u0432\u044b\u0441\u0442\u0430\u0432')));
  }

  private isProposalOrObjectionStage(name?: string | null) {
    const normalized = this.normalizeText(name ?? '');
    const isProposal = normalized.includes(this.normalizeText('\u043a\u043f')) &&
      (normalized.includes(this.normalizeText('\u043e\u0442\u043f\u0440\u0430\u0432')) ||
        normalized.includes(this.normalizeText('\u043f\u0440\u0435\u0437\u0435\u043d\u0442')));
    return isProposal || normalized.includes(this.normalizeText('\u0432\u043e\u0437\u0440\u0430\u0436'));
  }

  async leadSlaCards(options: { domain?: string } = {}) {
    const domain = options.domain ?? (await this.resolveAmoDomain());
    const salesPipelineIds = await this.salesPipelineIds();
    if (!salesPipelineIds.length) {
      return this.emptyLeadSlaResult(domain, 'Не найдена группа Sales');
    }

    const now = new Date();
    const factDeals = await this.prisma.factDealCurrent.findMany({
      where: {
        deletedAt: null,
        pipelineId: { in: salesPipelineIds },
        stageIsWon: false,
        stageIsLost: false,
      },
      orderBy: { createdAt: 'asc' },
      take: 1000,
    });

    const cards = factDeals
      .map((deal) => this.factDealToNotificationDeal(deal))
      .filter((deal) => this.isAssignedResponsibleStage(deal.stage?.name))
      .map((deal) => this.leadSlaCard(deal, now, domain))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));

    return {
      now: now.toISOString(),
      timezone: 'Europe/Moscow',
      slaMinutes: this.workSlaMinutes,
      workTime: MOSCOW_WORKDAY_LABEL,
      summary: {
        total: cards.length,
        waiting: cards.filter((card) => card.status === 'waiting').length,
        active: cards.filter((card) => card.status === 'active').length,
        warning: cards.filter((card) => card.status === 'warning').length,
        overdue: cards.filter((card) => card.status === 'overdue').length,
      },
      cards,
    };
  }

  private emptyLeadSlaResult(domain: string, warning: string) {
    return {
      now: new Date().toISOString(),
      timezone: 'Europe/Moscow',
      slaMinutes: this.workSlaMinutes,
      workTime: MOSCOW_WORKDAY_LABEL,
      warning,
      summary: { total: 0, waiting: 0, active: 0, warning: 0, overdue: 0 },
      cards: [],
      domain,
    };
  }

  private factDealToNotificationDeal(deal: Prisma.FactDealCurrentGetPayload<Record<string, never>>) {
    return {
      id: deal.dealId,
      externalId: deal.dealExternalId,
      title: deal.title,
      amount: deal.amount,
      createdAt: deal.createdAt,
      updatedAt: deal.updatedAt,
      customFields: deal.customFields,
      stageId: deal.stageId,
      responsibleId: deal.responsibleId,
      responsible: deal.responsibleId || deal.responsibleName || deal.groupName
        ? {
            id: deal.responsibleId,
            name: deal.responsibleName ?? 'Без менеджера',
            group: deal.groupName ? { name: deal.groupName } : null,
          }
        : null,
      pipeline: { id: deal.pipelineId, name: deal.pipelineName },
      stage: { id: deal.stageId, name: deal.stageName, isWon: deal.stageIsWon, isLost: deal.stageIsLost },
    };
  }

  private async attachNotificationActivity(deals: any[]) {
    if (!deals.length) return deals;
    const dealIds = deals.map((deal) => deal.id).filter(Boolean);
    if (!dealIds.length) return deals;

    const [tasks, latestNotes, latestEvents, currentIntervals] = await Promise.all([
      this.prisma.task.findMany({
        where: { dealId: { in: dealIds }, isCompleted: false },
        select: {
          id: true,
          dealId: true,
          responsibleId: true,
          isCompleted: true,
          createdAt: true,
          updatedAt: true,
          completedAt: true,
          raw: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.$queryRaw<Array<{ dealId: string; createdAt: Date }>>`
        SELECT DISTINCT ON ("dealId") "dealId", "createdAt"
        FROM "Note"
        WHERE "dealId" IN (${Prisma.join(dealIds)})
        ORDER BY "dealId" ASC, "createdAt" DESC
      `,
      this.prisma.$queryRaw<Array<{ dealId: string; createdAt: Date }>>`
        SELECT DISTINCT ON ("dealId") "dealId", "createdAt"
        FROM "CrmEvent"
        WHERE "dealId" IN (${Prisma.join(dealIds)})
        ORDER BY "dealId" ASC, "createdAt" DESC
      `,
      this.prisma.$queryRaw<Array<{ dealId: string; stageId: string; enteredAt: Date }>>`
        SELECT "deal_id" AS "dealId", "stage_id" AS "stageId", "entered_at" AS "enteredAt"
        FROM "fact_deal_stage_interval"
        WHERE "deal_id" IN (${Prisma.join(dealIds)}) AND "is_current" = true
      `,
    ]);

    const tasksByDeal = new Map<string, typeof tasks>();
    for (const task of tasks) {
      if (!task.dealId) continue;
      if (!tasksByDeal.has(task.dealId)) tasksByDeal.set(task.dealId, []);
      tasksByDeal.get(task.dealId)!.push(task);
    }
    const noteByDeal = new Map(latestNotes.map((note) => [note.dealId, note]));
    const eventByDeal = new Map(latestEvents.map((event) => [event.dealId, event]));
    const intervalByDeal = new Map(currentIntervals.map((interval) => [interval.dealId, interval]));

    return deals.map((deal) => {
      const note = noteByDeal.get(deal.id);
      const event = eventByDeal.get(deal.id);
      const interval = intervalByDeal.get(deal.id);
      return {
        ...deal,
        tasks: tasksByDeal.get(deal.id) ?? [],
        notes: note ? [{ createdAt: note.createdAt }] : [],
        events: event ? [{ createdAt: event.createdAt }] : [],
        stageHistory: interval ? [{ toStageId: interval.stageId, movedAt: interval.enteredAt }] : [],
      };
    });
  }

  private leadSlaCard(deal: any, now: Date, domain: string) {
    const schedule = this.workSlaSchedule(deal.createdAt);
    const elapsedSeconds = this.clampSeconds(
      moscowBusinessElapsedMs(schedule.startAt, now) / 1000,
      0,
      Number.POSITIVE_INFINITY,
    );
    const remainingSeconds = this.clampSeconds(schedule.allowedSeconds - elapsedSeconds, 0, schedule.allowedSeconds);
    const progressPercent = schedule.allowedSeconds > 0
      ? Math.min(100, Math.round((elapsedSeconds / schedule.allowedSeconds) * 100))
      : 100;
    const status = this.leadSlaStatus(now, schedule);

    return {
      dealId: deal.id,
      dealExternalId: deal.externalId,
      title: deal.title,
      amount: Number(deal.amount ?? 0),
      managerId: deal.responsibleId,
      managerName: deal.responsible?.name ?? 'Без менеджера',
      groupName: deal.responsible?.group?.name ?? '-',
      pipelineName: deal.pipeline?.name ?? '-',
      stageName: deal.stage?.name ?? '-',
      createdAt: deal.createdAt.toISOString(),
      startAt: schedule.startAt.toISOString(),
      dueAt: schedule.dueAt.toISOString(),
      elapsedSeconds,
      remainingSeconds,
      progressPercent,
      status,
      statusLabel: this.leadSlaStatusLabel(status),
      dealUrl: this.dealUrl(domain, deal.externalId),
    };
  }

  private leadSlaStatus(now: Date, schedule: { startAt: Date; dueAt: Date; allowedSeconds: number }) {
    if (now < schedule.startAt) return 'waiting';
    const elapsedSeconds = moscowBusinessElapsedMs(schedule.startAt, now) / 1000;
    const remainingSeconds = schedule.allowedSeconds - elapsedSeconds;
    if (remainingSeconds <= 0) return 'overdue';
    if (remainingSeconds <= 5 * 60) return 'warning';
    return 'active';
  }

  private leadSlaStatusLabel(status: string) {
    if (status === 'waiting') return 'Ждёт рабочего времени';
    if (status === 'overdue') return 'Просрочен';
    if (status === 'warning') return 'Скоро просрочится';
    return 'В работе';
  }

  private workSlaIsDue(deal: any, now: Date) {
    if (!this.isSalesPipeline(deal.pipeline?.name)) return false;
    if (!this.isAssignedResponsibleStage(deal.stage?.name)) return false;
    const schedule = this.workSlaSchedule(deal.createdAt);
    return moscowBusinessElapsedMs(schedule.startAt, now) >= schedule.allowedSeconds * 1000;
  }

  private workSlaDueAt(createdAt: Date) {
    return this.workSlaSchedule(createdAt).dueAt;
  }

  private workSlaSchedule(createdAt: Date) {
    const startAt = this.workSlaStartAt(createdAt);
    const dueAt = addMoscowBusinessTime(startAt, this.workSlaMinutes * 60_000);
    const allowedSeconds = this.workSlaMinutes * 60;
    return { startAt, dueAt, allowedSeconds };
  }

  private workSlaStartAt(createdAt: Date) {
    return nextMoscowBusinessStart(createdAt);
  }

  private isMoscowBusinessDay(parts: { dayOfWeek: number }) {
    return isMoscowBusinessDay(parts);
  }

  private moscowParts(date: Date) {
    return moscowParts(date);
  }

  private moscowDateKey(date: Date) {
    const parts = this.moscowParts(date);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  private moscowDate(year: number, month: number, day: number, hour: number, minute: number, second: number, ms: number) {
    return moscowDate(year, month, day, hour, minute, second, ms);
  }

  private clampSeconds(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.round(value)));
  }

  private isSalesPipeline(name?: string | null) {
    return this.normalizeText(name ?? '').includes(this.normalizeText('\u043f\u0440\u043e\u0434\u0430\u0436'));
  }

  private isAssignedResponsibleStage(name?: string | null) {
    const normalized = this.normalizeText(name ?? '');
    return normalized.includes(this.normalizeText('\u043d\u0430\u0437\u043d\u0430\u0447\u0435\u043d')) &&
      normalized.includes(this.normalizeText('\u043e\u0442\u0432\u0435\u0442\u0441\u0442\u0432\u0435\u043d\u043d\u044b\u0439'));
  }

  private async sendConfiguredNotification(
    eventType: string,
    message: string,
    payload: Record<string, unknown>,
    eventKey?: string,
  ) {
    const config = await this.configuredTelegramDelivery(eventType);
    if (config.mode === 'system') return null;
    if (!this.telegramDeliveryModeAllowed(eventType, config.mode)) return null;
    if (config.mode === 'disabled') return [];

    if (config.mode === 'direct_responsible') {
      const responsibleId = this.payloadCrmUserId(payload);
      if (!responsibleId) return [];
      return [
        await this.telegram.sendDirectMessageToCrmUser(
          responsibleId,
          message,
          { ...payload, deliveryMode: config.mode },
          undefined,
          eventKey ? `${eventKey}:direct-responsible` : undefined,
        ),
      ];
    }

    if (config.mode === 'group') {
      return this.telegram.sendMessageToGroups(
        [],
        message,
        { ...payload, deliveryMode: config.mode },
        undefined,
        eventKey ? `${eventKey}:telegram-group` : undefined,
      );
    }

    if (config.mode === 'all_connected') {
      return this.telegram.sendDirectMessageToAllConnected(
        message,
        { ...payload, deliveryMode: config.mode },
        undefined,
        eventKey ? `${eventKey}:all-connected` : undefined,
      );
    }

    if (!config.recipients.length) return [];

    const deliveries = [];
    for (const recipient of config.recipients) {
      const recipientEventKey = eventKey ? `${eventKey}:configured:${recipient.kind}:${recipient.id}` : undefined;
      if (recipient.kind === 'platform_user') {
        deliveries.push(await this.telegram.sendDirectMessageToUser(
          recipient.id,
          message,
          { ...payload, configuredRecipient: recipient, deliveryMode: config.mode },
          undefined,
          recipientEventKey,
        ));
      } else {
        deliveries.push(await this.telegram.sendDirectMessageToCrmUser(
          recipient.id,
          message,
          { ...payload, configuredRecipient: recipient, deliveryMode: config.mode },
          undefined,
          recipientEventKey,
        ));
      }
    }
    return deliveries;
  }

  private async configuredTelegramDelivery(eventType: string): Promise<{ mode: TelegramDeliveryMode; recipients: TelegramTemplateRecipient[] }> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { eventType },
      select: { recipients: true },
    });
    const raw = template?.recipients;
    if (!Array.isArray(raw)) return { mode: 'system', recipients: [] };
    const disabled = raw.some((item) => {
      const record = item as Record<string, unknown>;
      return record?.kind === 'none' && record?.id === 'none';
    });
    if (disabled) return { mode: 'disabled', recipients: [] };
    const deliveryMode = raw.find((item) => {
      const record = item as Record<string, unknown>;
      return record?.kind === TELEGRAM_DELIVERY_MODE_KIND && TELEGRAM_DELIVERY_MODES.has(String(record.id) as TelegramDeliveryMode);
    }) as Record<string, unknown> | undefined;
    const recipients = raw
      .map((item) => ({
        kind: String((item as Record<string, unknown>)?.kind ?? ''),
        id: String((item as Record<string, unknown>)?.id ?? ''),
      }))
      .filter((item): item is TelegramTemplateRecipient =>
        (item.kind === 'platform_user' || item.kind === 'crm_user') && Boolean(item.id),
      );
    if (deliveryMode) return { mode: String(deliveryMode.id) as TelegramDeliveryMode, recipients };
    return recipients.length ? { mode: 'selected', recipients } : { mode: 'system', recipients: [] };
  }

  private telegramDeliveryModeAllowed(eventType: string, mode: TelegramDeliveryMode) {
    if (PERSONAL_TELEGRAM_EVENTS.has(eventType)) {
      return mode === 'system' || mode === 'direct_responsible' || mode === 'disabled';
    }
    if (mode === 'direct_responsible') return eventType === 'amo_payment_received';
    return true;
  }

  private payloadCrmUserId(payload: Record<string, unknown>) {
    const raw = payload.managerCrmUserId ?? payload.crmUserId ?? payload.responsibleCrmUserId;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  private async renderNotification(eventType: string, fallbackType: string, variables: Record<string, string>) {
    const template = await this.prisma.notificationTemplate.findUnique({ where: { eventType } });
    const body = template?.isActive && template.body.trim()
      ? template.body
      : this.defaultNotificationBody(fallbackType);
    return body.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => variables[key] ?? '');
  }

  private defaultNotificationBody(type: string) {
    if (type === 'amo_new_assigned_lead') {
      return '{managerMention}, \u0442\u0435\u0431\u0435 \u043f\u0440\u0438\u0448\u0435\u043b \u043d\u043e\u0432\u044b\u0439 \u043b\u0438\u0434! \u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}';
    }
    if (type === 'amo_assigned_lead_10m') {
      return '{managerMention}, \u043b\u0438\u0434 \u0432\u0438\u0441\u0438\u0442 10 \u043c\u0438\u043d\u0443\u0442! \u0411\u0435\u0440\u0438: {dealUrl}';
    }
    if (type === 'amo_task_mass_reschedule') {
      return '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {taskCount} \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.';
    }
    if (type === 'amo_deal_mass_move') {
      return '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {dealCount} \u0441\u0434\u0435\u043b\u043e\u043a, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.';
    }
    if (type === 'amo_csm_task_mass_reschedule') {
      return '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {taskCount} \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.';
    }
    if (type === 'amo_csm_deal_mass_move') {
      return '{manager} \u043f\u0435\u0440\u0435\u043d\u0435\u0441 {dealCount} \u0441\u0434\u0435\u043b\u043e\u043a, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.';
    }
    if (type === 'amo_csm_overdue_tasks') {
      return '\u0423 {manager} {taskCount} \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u0435\u043d\u043d\u044b\u0445 \u0437\u0430\u0434\u0430\u0447, \u043f\u0440\u043e\u0432\u0435\u0440\u044c.';
    }
    if (type === 'amo_csm_zero_taken_to_work_13') {
      return '{managerMention}, \u043a 13:00 \u0443 \u0442\u0435\u0431\u044f 0 \u043b\u0438\u0434\u043e\u0432 \u0432\u0437\u044f\u0442\u043e \u0432 \u0440\u0430\u0431\u043e\u0442\u0443. \u041f\u0440\u043e\u0432\u0435\u0440\u044c CSM-\u0432\u043e\u0440\u043e\u043d\u043a\u0443.';
    }
    if (type === 'amo_csm_zero_offer_made_13') {
      return '{managerMention}, \u043a 13:00 \u0443 \u0442\u0435\u0431\u044f 0 \u041a\u041f \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e. \u041f\u0440\u043e\u0432\u0435\u0440\u044c CSM-\u0432\u043e\u0440\u043e\u043d\u043a\u0443.';
    }
    if (type === 'amo_invoice_no_payment_3d') {
      return '\u0421\u0447\u0435\u0442 {deal} \u0431\u0435\u0437 \u043e\u043f\u043b\u0430\u0442\u044b \u0442\u0440\u0438 \u0434\u043d\u044f. {dealUrl}';
    }
    if (type === 'amo_proposal_stale_24h') {
      return '\u0421\u0434\u0435\u043b\u043a\u0430 \u043d\u0430 {amount} \u0441\u0442\u043e\u0438\u0442 \u0432\u0442\u043e\u0440\u043e\u0439 \u0434\u0435\u043d\u044c - {dealUrl}';
    }
    if (type === 'amo_high_value_idle_24h') {
      return '\u041a\u0440\u0443\u043f\u043d\u0430\u044f \u0441\u0434\u0435\u043b\u043a\u0430 \u0431\u0435\u0437 \u0434\u0432\u0438\u0436\u0435\u043d\u0438\u044f 24 \u0447\u0430\u0441\u0430.\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u042d\u0442\u0430\u043f: {stage}\n\u0421\u0441\u044b\u043b\u043a\u0430: {dealUrl}';
    }
    if (type === 'amo_take_to_work_enabled') {
      return '{managerMention}, \u0443 \u0442\u0435\u0431\u044f \u0432\u0445\u043e\u0434\u044f\u0449\u0438\u0439 \u043b\u0438\u0434 \u043f\u0440\u043e\u0441\u0440\u043e\u0447\u0435\u043d! \u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443: {dealUrl}';
    }
    return '\u041e\u043f\u043b\u0430\u0442\u0430 \u043f\u043e\u043b\u0443\u0447\u0435\u043d\u0430\n\u0421\u0434\u0435\u043b\u043a\u0430: {deal}\n\u041c\u0435\u043d\u0435\u0434\u0436\u0435\u0440: {manager}\n\u0421\u0443\u043c\u043c\u0430: {amount}\n\u0421\u0441\u044b\u043b\u043a\u0430 \u043d\u0430 \u0441\u0434\u0435\u043b\u043a\u0443: {dealUrl}';
  }

  private async resolvePaymentStages() {
    const stages = await this.prisma.pipelineStage.findMany({
      include: { pipeline: true },
    });
    const paidStages = stages.filter((stage) => this.isPaymentStage(stage.name));
    return new Map(paidStages.map((stage) => [`${stage.pipeline.externalId}_${stage.externalId}`, stage]));
  }

  private async resolveLeadCustomFieldByName(name: string) {
    const fields = await this.prisma.customFieldDefinition.findMany({
      where: { entityType: 'LEAD' },
      select: { externalId: true, name: true },
    });
    const target = this.normalizeText(name);
    const exact = fields.find((field) => this.normalizeText(field.name) === target);
    if (exact) return exact;

    const workFieldAliases = [
      '\u0412\u0437\u044f\u0442\u044c \u0432 \u0440\u0430\u0431\u043e\u0442\u0443',
      'take to work',
    ].map((alias) => this.normalizeText(alias));
    return fields.find((field) => workFieldAliases.includes(this.normalizeText(field.name))) ?? null;
  }

  private stageFromStatusEvent(valueAfter: unknown, stages: Map<string, StageWithPipeline>) {
    const status = this.extractStatusFromEventValue(valueAfter);
    if (!status?.pipelineId || !status.statusId) return null;
    return stages.get(`${status.pipelineId}_${status.statusId}`) ?? null;
  }

  private extractStatusFromEventValue(value: unknown): { pipelineId?: string; statusId?: string } | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Record<string, any>;
    const status = candidate.lead_status ?? candidate.status ?? candidate;
    const statusId = status?.id ?? status?.status_id;
    const pipelineId = status?.pipeline_id ?? status?.pipeline?.id;
    if (!statusId) return null;
    return {
      statusId: String(statusId),
      pipelineId: pipelineId == null ? undefined : String(pipelineId),
    };
  }

  private customFieldIsEnabled(valueAfter: unknown) {
    const values = Array.isArray(valueAfter) ? valueAfter : valueAfter ? [valueAfter] : [];
    return values.some((item) => {
      const raw = (item as any)?.custom_field_value ?? item;
      const value = raw?.text ?? raw?.value ?? raw?.checked ?? raw;
      if (value === true) return true;
      const normalized = this.normalizeText(String(value ?? '').trim());
      return ['1', 'true', 'yes', '\u0434\u0430', '\u0435\u0441\u0442\u044c', 'on'].includes(normalized);
    });
  }

  private isPaymentStage(name: string) {
    const normalized = this.normalizeText(name);
    if (normalized.includes('not fully paid')) return false;
    return normalized.includes(this.normalizeText('\u0441\u0447\u0435\u0442 \u043e\u043f\u043b\u0430\u0447\u0435\u043d')) ||
      normalized.includes(this.normalizeText('\u0441\u0447\u0451\u0442 \u043e\u043f\u043b\u0430\u0447\u0435\u043d')) ||
      normalized === 'paid' ||
      normalized === 'paid!' ||
      normalized.includes(this.normalizeText('\u043e\u043f\u043b\u0430\u0447\u0435\u043d\u043e'));
  }

  private async salesPipelineIds() {
    const pipelines = await this.prisma.pipeline.findMany({
      where: { isArchived: false },
      select: { id: true, name: true },
    });
    return pipelines.filter((pipeline) => this.isSalesPipeline(pipeline.name)).map((pipeline) => pipeline.id);
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

  private normalizeEmail(email?: string | null) {
    return String(email ?? '').trim().toLowerCase();
  }

  private normalizeText(value: string) {
    return String(value ?? '').trim().toLowerCase().replace(/\u0451/g, '\u0435');
  }

  private formatMoney(value: unknown) {
    const amount = Math.round(Number(value ?? 0));
    return `${amount.toLocaleString('ru-RU')} \u20ac`;
  }

  private async recordSkipped(eventKey: string, message: string, payload: Record<string, unknown>) {
    const existing = await this.prisma.notificationDelivery.findUnique({ where: { eventKey } });
    if (existing) return existing;

    try {
      return await this.prisma.notificationDelivery.create({
        data: {
          eventKey,
          status: 'SKIPPED' as DeliveryStatus,
          message,
          payload: payload as Prisma.InputJsonValue,
        },
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        return this.prisma.notificationDelivery.findUnique({ where: { eventKey } });
      }
      throw error;
    }
  }
}
