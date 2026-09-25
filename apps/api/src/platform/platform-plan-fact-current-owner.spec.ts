import { PlatformService } from './platform.service';

describe('PlatformService plan-fact shared report definitions', () => {
  const calendar = {
    monthStart: new Date('2026-07-31T21:00:00.000Z'),
    monthEnd: new Date('2026-08-31T20:59:59.999Z'),
    todayStart: new Date('2026-08-26T21:00:00.000Z'),
    todayEnd: new Date('2026-08-27T20:59:59.999Z'),
    isCurrentMonth: true,
    isTodayWorkday: true,
    workdaysInMonth: 21,
    workedDays: 19,
    remainingWorkdaysIncludingToday: 3,
  };
  const noShipping = { month: null, today: null, beforeToday: null };

  function definition(team: 'sales' | 'csm') {
    const filters = {
      pipelineIds: team === 'sales' ? ['pipeline-sales'] : ['pipeline-base', 'pipeline-assigned'],
      ...(team === 'csm' ? { groupIds: ['group-csm'] } : {}),
    };
    const config = {
      metric: 'contract',
      filters,
      contract: {
        groupBy: 'manager',
        metrics: [{ id: team === 'sales' ? 'kp_presented' : 'offer_made', stageIds: ['canonical-offer-stage'] }],
        includeSummaryRow: true,
      },
    };
    return {
      name: team === 'sales' ? 'Sales: шаги и конверсии' : 'CSM: воронка',
      sourceType: team === 'sales' ? 'EVENT' : 'CURRENT',
      group: { id: `group-${team}` },
      pipelineIds: filters.pipelineIds,
      filters,
      config,
    };
  }

  function metrics(values: Record<string, number | null>) {
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }]));
  }

  function createService(report: any, managers: Array<{ id: string; name: string }> = []) {
    const prisma = { crmUser: { findMany: jest.fn().mockResolvedValue(managers) } };
    const reports = {
      compute: jest.fn().mockResolvedValue(report),
      getTeamFunnelDefinition: jest.fn(async (team: 'sales' | 'csm') => definition(team)),
    };
    const service = new PlatformService(prisma as any, reports as any, {} as any, {} as any, {} as any, {} as any);
    return { service: service as any, prisma, reports };
  }

  it('keeps Sales pipeline deals under their current responsible even outside the Sales group', async () => {
    const managers = [
      { id: 'sales-manager', name: 'Sales Manager' },
      { id: 'support-manager', name: 'Support Manager' },
    ];
    const report = {
      summaryRows: [{ metrics: metrics({ leads_received: 2, kp_presented: 1 }) }],
      rows: managers.map((manager, index) => ({
        groupId: manager.id,
        groupName: manager.name,
        metrics: metrics({ leads_received: 1, kp_presented: index }),
      })),
    };
    const { service, prisma, reports } = createService(report, managers);
    const refs = definition('sales');
    const user = { id: 'admin', role: 'ADMIN' };

    const result = await (service as any).buildPlanFactTeam(
      'sales',
      refs,
      noShipping,
      [],
      calendar,
      user,
    );

    expect(prisma.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        isActive: true,
        OR: [
          { groupId: 'group-sales' },
          { deals: { some: { pipelineId: { in: ['pipeline-sales'] }, deletedAt: null } } },
        ],
      },
    }));
    expect(reports.compute).toHaveBeenCalledTimes(3);
    for (const [request, actor] of reports.compute.mock.calls) {
      expect(request.name).toBe(refs.name);
      expect(request.sourceType).toBe(refs.sourceType);
      expect(request.config.contract).toBe(refs.config.contract);
      expect(request.config.filters).toEqual(request.filters);
      expect(request.filters.pipelineIds).toEqual(['pipeline-sales']);
      expect(request.filters.groupIds).toBeUndefined();
      expect(actor).toBe(user);
    }
    expect(reports.compute.mock.calls.map(([request]) => [request.filters.dateFrom, request.filters.dateTo])).toEqual([
      [calendar.monthStart.toISOString(), calendar.todayEnd.toISOString()],
      [calendar.todayStart.toISOString(), calendar.todayEnd.toISOString()],
      [calendar.monthStart.toISOString(), '2026-08-26T20:59:59.999Z'],
    ]);
    expect(result.rows.map((row: any) => row.targetId)).toEqual(['sales-manager', 'support-manager']);
    expect(result.total.values.sales_qualified_leads.factMonth).toBe(2);
    expect(result.total.values.sales_conv_lead_to_kp.factMonth).toBe(50);
  });

  it('uses CSM offer_made, not prepared quotes, and preserves missing conversions', async () => {
    const source = metrics({
      taken_to_work: 10,
      kp_prepared: 0,
      offer_made: 7,
      conv_work_to_offer: 70,
      conv_offer_to_invoice: null,
      invoice_sent: 0,
      conv_invoice_to_paid: null,
      paid: 0,
      paid_amount: 0,
    });
    const { service, reports } = createService({
      rows: [{ groupId: 'csm-manager', groupName: 'CSM Manager', metrics: source }],
      summaryRows: [{ metrics: source }],
    });
    const refs = definition('csm');

    const result = await service.buildPlanFactTeam('csm', refs, noShipping, [], calendar, { id: 'admin', role: 'ADMIN' });

    expect(reports.compute.mock.calls[0][0].config.contract).toBe(refs.config.contract);
    expect(reports.compute.mock.calls[0][0].filters.groupIds).toEqual(['group-csm']);
    for (const row of [result.total, ...result.rows]) {
      expect(row.values.csm_kp_count.factMonth).toBe(7);
      expect(row.values.csm_conv_work_to_kp.factMonth).toBe(70);
      expect(row.values.csm_conv_kp_to_invoice.factMonth).toBeNull();
      expect(row.values.csm_conv_invoice_to_paid.factMonth).toBeNull();
      expect(row.values.csm_paid_count.factMonth).toBe(0);
    }
  });

  it('partitions each actual shipment into CSM or Sales and includes shipment-only owners', async () => {
    const report = { rows: [], summaryRows: [{ metrics: {} }] };
    const { service } = createService(report);
    const actualShipping = {
      csmGroupId: 'group-csm',
      entries: [
        ['sales-owner', 'Sales Owner', 'group-sales', 1200],
        ['csm-owner', 'CSM Owner', 'group-csm', 2500],
        ['support-owner', 'Support Owner', 'group-support', 300],
      ].map(([id, name, groupId, amount]) => ({
        deal: { id: `deal-${id}`, responsibleId: id, responsible: { name, group: { id: groupId } }, amount },
        shippedAt: calendar.todayStart,
      })),
    };
    const shipping = { month: actualShipping, today: actualShipping, beforeToday: null };
    const [sales, csm] = await Promise.all(['sales', 'csm'].map((team) =>
      service.buildPlanFactTeam(team, definition(team as 'sales' | 'csm'), shipping, [], calendar, { id: 'admin', role: 'ADMIN' }),
    ));

    expect(sales.rows.map((row: any) => row.targetId)).toEqual(['sales-owner', 'support-owner']);
    expect(csm.rows.map((row: any) => row.targetId)).toEqual(['csm-owner']);
    expect(sales.total.values.sales_shipped_count.factMonth).toBe(2);
    expect(sales.total.values.sales_shipped_amount.factMonth).toBe(1500);
    expect(csm.total.values.csm_shipped_count.factMonth).toBe(1);
    expect(csm.total.values.csm_shipped_amount.factMonth).toBe(2500);
    for (const team of [sales, csm]) {
      for (const suffix of ['shipped_count', 'shipped_amount']) {
        const key = `${team.key}_${suffix}`;
        expect(team.total.values[key].factMonth).toBe(team.rows.reduce((sum: number, row: any) => sum + row.values[key].factMonth, 0));
      }
      const first = team.rows[0];
      expect(first.values[`${team.key}_kp_count`].factMonth).toBe(0);
      expect(first.values[`${team.key}_conv_kp_to_invoice`].factMonth).toBeNull();
    }
    expect(sales.total.values.sales_shipped_count.factMonth + csm.total.values.csm_shipped_count.factMonth).toBe(actualShipping.entries.length);
  });

  it('includes fact-only current owners so additive totals reconcile to manager rows', async () => {
    const rows = [
      { groupId: 'sales-manager', groupName: 'Sales Manager', metrics: metrics({ leads_received: 2, paid: 1, payment_amount: 1000 }) },
      { groupId: 'transferred-manager', groupName: 'Transferred Manager', metrics: metrics({ leads_received: 3, paid: 2, payment_amount: 2400 }) },
    ];
    const { service } = createService({
      rows,
      summaryRows: [{ metrics: metrics({ leads_received: 5, paid: 3, payment_amount: 3400 }) }],
    }, [{ id: 'sales-manager', name: 'Sales Manager' }]);

    const result = await service.buildPlanFactTeam('sales', definition('sales'), noShipping, [], calendar, { id: 'admin', role: 'ADMIN' });

    expect(result.rows.map((row: any) => row.targetId)).toContain('transferred-manager');
    for (const key of ['sales_qualified_leads', 'sales_paid_count', 'sales_paid_amount']) {
      expect(result.total.values[key].factMonth).toBe(result.rows.reduce((sum: number, row: any) => sum + row.values[key].factMonth, 0));
    }
  });

  it.each(['ADMIN', 'ROP'])('uses the same manager visibility as reports for %s', async (role) => {
    const { service, prisma } = createService({ rows: [], summaryRows: [] });

    await service.buildPlanFactTeam('csm', definition('csm'), noShipping, [], calendar, { id: role, role });

    expect(prisma.crmUser.findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
      groupId: 'group-csm',
      ...(role === 'ROP' ? { isVisible: true } : {}),
    });
  });

  it.each([null, undefined, NaN])('does not coerce absent or invalid values (%s) into zero', (value) => {
    const { service } = createService(null);
    const report = { rows: [{ groupId: 'manager', metrics: { conversion: { value } } }], summaryRows: [{ metrics: { conversion: { value } } }] };

    expect(service.reportMetricValue(report, 'manager', 'MANAGER', 'conversion')).toBeNull();
    expect(service.reportMetricValue(report, 'group', 'GROUP', 'conversion')).toBeNull();
  });

  it('uses zero for an owner omitted from a period without activity, but not for explicitly missing facts', () => {
    const { service } = createService(null);
    const report = {
      rows: [{ groupId: 'known-owner', metrics: { sales_paid_count: { value: null } } }],
      summaryRows: [{ metrics: { sales_paid_count: { value: null } } }],
    };

    expect(service.reportMetricValue(report, 'no-activity-owner', 'MANAGER', 'sales_paid_count')).toBe(0);
    expect(service.reportMetricValue(report, 'no-activity-owner', 'MANAGER', 'sales_paid_amount')).toBe(0);
    expect(service.reportMetricValue(report, 'no-activity-owner', 'MANAGER', 'sales_conv_invoice_to_paid')).toBeNull();
    expect(service.reportMetricValue(report, 'known-owner', 'MANAGER', 'sales_paid_count')).toBeNull();
    expect(service.reportMetricValue(report, 'group', 'GROUP', 'sales_paid_count')).toBeNull();
    expect(service.reportMetricValue(null, 'no-activity-owner', 'MANAGER', 'sales_paid_count')).toBeNull();
  });

  it('resolves both teams directly from Reports without duplicating stage lookup', async () => {
    const { service, reports } = createService(null);

    const refs = await service.resolvePlanFactRefs();

    expect(reports.getTeamFunnelDefinition.mock.calls).toEqual([['sales'], ['csm']]);
    expect(refs.sales).toEqual(definition('sales'));
    expect(refs.csm).toEqual(definition('csm'));
    expect(refs.warnings).toEqual([]);
  });
});
