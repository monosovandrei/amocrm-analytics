import { PlatformService } from './platform.service';

describe('PlatformService ROP dashboard v2', () => {
  const now = new Date('2026-07-23T09:00:00.000Z');
  const actor = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' as const, businessRole: 'OWNER' as const };

  function createService(options?: { dismissPendingEmail?: boolean }) {
    const pipelineName = '\u0412\u043e\u0440\u043e\u043d\u043a\u0430 \u043f\u0440\u043e\u0434\u0430\u0436';
    const salesManager = {
      id: 'manager-sales',
      externalId: '101',
      name: 'Sales Manager',
      groupId: 'group-sales',
      group: { id: 'group-sales', externalId: '660254', name: 'Sales' },
    };
    const csmManager = {
      id: 'manager-csm',
      externalId: '202',
      name: 'CSM Manager',
      groupId: 'group-csm',
      group: { id: 'group-csm', externalId: '660250', name: 'CSM' },
    };

    const dealSales = {
      id: 'deal-sales',
      externalId: '101',
      title: 'Offer deal',
      amount: 100000,
      createdAt: new Date('2026-07-10T09:00:00.000Z'),
      updatedAt: new Date('2026-07-20T09:00:00.000Z'),
      responsibleId: salesManager.id,
      pipeline: { id: 'pipeline-sales', name: pipelineName },
      stage: { id: 'stage-offer', name: 'КП презентовано', position: 2 },
    };
    const dealCsm = {
      id: 'deal-csm',
      externalId: '202',
      title: 'CSM deal',
      amount: 50000,
      createdAt: new Date('2026-07-22T09:00:00.000Z'),
      updatedAt: new Date('2026-07-22T09:00:00.000Z'),
      responsibleId: csmManager.id,
      pipeline: { id: 'pipeline-csm', name: 'Base' },
      stage: { id: 'stage-work', name: 'Work', position: 1 },
    };

    const prisma = {
      amoConnection: {
        findFirst: jest.fn().mockResolvedValue({ subdomain: 'example.amocrm.ru' }),
      },
      amoAccountSnapshot: {
        findFirst: jest.fn(),
      },
      crmUser: {
        findMany: jest.fn().mockResolvedValue([
          salesManager,
          csmManager,
          {
            id: 'manager-demo',
            externalId: 'rop-demo-user',
            name: 'Demo Sales',
            groupId: 'group-demo',
            group: { id: 'group-demo', externalId: 'rop-demo-group-sales', name: 'Sales' },
          },
          {
            id: 'manager-ops',
            externalId: '303',
            name: 'Ops Manager',
            groupId: 'group-ops',
            group: { id: 'group-ops', externalId: '660999', name: 'Ops' },
          },
        ]),
      },
      deal: {
        findMany: jest.fn().mockResolvedValue([dealSales, dealCsm]),
      },
      task: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'task-touch',
            externalId: 'task-touch-external',
            title: 'Touch client',
            dueAt: new Date('2026-07-23T08:00:00.000Z'),
            completedAt: null,
            isCompleted: false,
            deal: dealSales,
          },
        ]),
      },
      note: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      crmEvent: {
        findMany: jest.fn().mockImplementation((args?: any) => {
          if (args?.where?.type === 'task_deadline_changed') {
            return Promise.resolve([
              {
                externalId: 'event-task-reschedule',
                raw: {
                  entity_id: 'task-touch-external',
                  created_by: { id: salesManager.externalId },
                },
                createdAt: new Date('2026-07-23T07:30:00.000Z'),
              },
            ]);
          }
          return Promise.resolve([]);
        }),
      },
      emailThreadState: {
        findMany: jest.fn().mockResolvedValue([
          {
            dealId: dealSales.id,
            threadId: 'thread-1',
            lastIncomingNoteExternalId: 'note-1',
            lastIncomingAt: new Date('2026-07-22T08:00:00.000Z'),
            subject: 'Question',
            summary: null,
            attachCount: 0,
            messages: [],
            deal: {
              ...dealSales,
              contactId: null,
              responsible: { ...salesManager, externalId: 'amo-user-1' },
              contact: null,
            },
          },
        ]),
      },
      emailThreadDismissal: {
        findMany: jest.fn().mockResolvedValue(options?.dismissPendingEmail
          ? [{ dealId: dealSales.id, threadId: 'thread-1', lastIncomingNoteExternalId: 'note-1' }]
          : []),
      },
      qualityViolation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'violation-1',
            managerId: salesManager.id,
            dealId: dealSales.id,
            taskId: null,
            severity: 'WARNING',
            message: 'Required field is empty',
            detectedAt: new Date('2026-07-23T07:00:00.000Z'),
            rule: { code: 'required_field', name: 'Required field' },
          },
          {
            id: 'violation-ignored-no-task',
            managerId: salesManager.id,
            dealId: dealSales.id,
            taskId: null,
            severity: 'CRITICAL',
            message: 'Legacy no-task violation',
            detectedAt: new Date('2026-07-23T07:30:00.000Z'),
            rule: { code: 'open_deal_without_task', name: 'Open deal without task' },
          },
        ]),
      },
      ropStageSlaRule: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      dealStageHistory: {
        findMany: jest.fn().mockResolvedValue([
          { dealId: dealSales.id, toStageId: 'stage-offer', movedAt: new Date('2026-07-16T09:00:00.000Z') },
          { dealId: dealCsm.id, toStageId: 'stage-work', movedAt: new Date('2026-07-22T09:00:00.000Z') },
        ]),
      },
    };

    const service = new PlatformService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { service, prisma };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns concrete v2 queues for active Sales and CSM managers only', async () => {
    const { service, prisma } = createService();

    const result = await service.ropDashboardV2(actor, {});

    expect(prisma.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { isActive: true, isVisible: true },
    }));
    expect(result.filters.departments.flatMap((department) => department.managers.map((manager) => manager.id))).toEqual([
      'manager-sales',
      'manager-csm',
    ]);
    expect(result.filters.departments.flatMap((department) => department.managers.map((manager) => manager.id))).not.toContain('manager-demo');
    expect(result.filters.departments.flatMap((department) => department.managers.map((manager) => manager.id))).not.toContain('manager-ops');

    const sales = result.departments.find((department) => department.key === 'sales');
    expect(sales?.summary).toEqual(expect.objectContaining({
      openDeals: 1,
      offerTouches: 1,
      pendingEmails: 1,
      overdueTasks: 1,
      taskReschedules: 1,
      stuckDeals: 1,
      crmIssues: 1,
      riskDeals: 1,
    }));
    expect(sales?.managerRows[0]).not.toHaveProperty('loadScore');
    expect(sales?.managerRows[0]).not.toHaveProperty('qualityScore');
    expect(sales?.managerRows[0]).not.toHaveProperty('riskAmount');

    expect(result.actionQueues.offerTouches).toHaveLength(1);
    expect(result.actionQueues.pendingEmails).toHaveLength(1);
    expect(result.actionQueues.noNextStep).toHaveLength(1);
    expect(result.actionQueues.noNextStep[0]).toEqual(expect.objectContaining({
      dealId: 'deal-csm',
      priority: 'critical',
      title: 'Нет следующего шага',
    }));
    expect(result.actionQueues.crmIssues).toHaveLength(1);
    expect(result.actionQueues.crmIssues.map((item) => item.ruleCode)).not.toContain('open_deal_without_task');
    expect(result.actionQueues.stuckDeals[0]).toEqual(expect.objectContaining({ slaDays: 5 }));
    expect(result.actionQueues.riskDeals[0].reason).toContain('Письмо клиента без ответа');
    expect(result.funnel.stages[0]).toEqual(expect.objectContaining({
      openDeals: 1,
      stuckDeals: 1,
      slaDays: 5,
    }));
  });

  it('applies department filter and respects dismissed pending emails', async () => {
    const { service } = createService({ dismissPendingEmail: true });

    const result = await service.ropDashboardV2(actor, { department: 'sales' });

    expect(result.departments.map((department) => department.key)).toEqual(['sales']);
    expect(result.departments.find((department) => department.key === 'sales')?.summary.pendingEmails).toBe(0);
    expect(result.actionQueues.pendingEmails).toHaveLength(0);
  });

  it('filters the ROP dashboard by current stage', async () => {
    const { service } = createService();

    const result = await service.ropDashboardV2(actor, { stageId: 'stage-work' });

    expect(result.departments.find((department) => department.key === 'sales')).toBeUndefined();
    expect(result.departments.find((department) => department.key === 'csm')?.summary).toEqual(expect.objectContaining({
      openDeals: 1,
      noNextStep: 1,
      riskDeals: 1,
    }));
    expect(result.actionQueues.offerTouches).toHaveLength(0);
    expect(result.actionQueues.noNextStep).toHaveLength(1);
    expect(result.funnel.stages.map((stage) => stage.stageId)).toEqual(['stage-work']);
    expect(result.filters.stages.map((stage) => stage.id).sort()).toEqual(['stage-offer', 'stage-work']);
  });
});
