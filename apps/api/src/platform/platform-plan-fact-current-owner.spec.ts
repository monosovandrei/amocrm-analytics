import { PlatformService } from './platform.service';

describe('PlatformService plan-fact current responsible scope', () => {
  it('keeps Sales pipeline deals under their current responsible even outside the Sales group', async () => {
    const managers = [
      { id: 'sales-manager', name: 'Sales Manager' },
      { id: 'support-manager', name: 'Support Manager' },
    ];
    const prisma = {
      crmUser: {
        findMany: jest.fn().mockResolvedValue(managers),
      },
    };
    const report = {
      summaryRows: [{ metrics: { sales_qualified_leads: { value: 2 } } }],
      rows: managers.map((manager) => ({
        groupId: manager.id,
        metrics: { sales_qualified_leads: { value: 1 } },
      })),
    };
    const reports = { compute: jest.fn().mockResolvedValue(report) };
    const service = new PlatformService(prisma as any, reports as any, {} as any, {} as any, {} as any, {} as any);
    const refs = {
      name: 'Продажи',
      group: { id: 'group-sales' },
      pipelineIds: ['pipeline-sales'],
      marketingFieldId: 'marketing-field',
      stages: { kp: null, invoice: null, paid: null },
    };
    const calendar = {
      monthStart: new Date('2026-08-01T00:00:00.000Z'),
      monthEnd: new Date('2026-08-31T23:59:59.999Z'),
      todayStart: new Date('2026-08-27T00:00:00.000Z'),
      todayEnd: new Date('2026-08-27T23:59:59.999Z'),
      isCurrentMonth: true,
      isTodayWorkday: true,
      workdaysInMonth: 21,
      workedDays: 19,
      remainingWorkdaysIncludingToday: 3,
    };

    const result = await (service as any).buildPlanFactTeam(
      'sales',
      refs,
      null,
      [],
      calendar,
      { id: 'admin', role: 'ADMIN' },
    );

    expect(prisma.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isActive: true,
        isVisible: true,
        OR: [
          { groupId: 'group-sales' },
          { deals: { some: { pipelineId: { in: ['pipeline-sales'] }, deletedAt: null } } },
        ],
      }),
    }));
    expect(reports.compute).toHaveBeenCalledTimes(3);
    for (const [request] of reports.compute.mock.calls) {
      expect(request.filters).toEqual(expect.objectContaining({
        pipelineIds: ['pipeline-sales'],
        groupIds: undefined,
      }));
    }
    expect(result.rows.map((row: any) => row.targetId)).toEqual(['sales-manager', 'support-manager']);
    expect(result.total.values.sales_qualified_leads.factMonth).toBe(2);
  });
});
