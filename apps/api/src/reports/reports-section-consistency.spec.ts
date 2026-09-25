import { ReportsService } from './reports.service';
import { RevenueForecastEngine } from './revenue-forecast-engine';

describe('shared section metrics', () => {
  const group = { id: 'csm', name: 'CSM' };
  const salesGroup = { id: 'sales', name: 'Sales' };
  const stage = (id: string, name = id, isWon = false) => ({ id, name, isWon, isLost: false, position: 10 });
  const refs = {
    ready: true, warnings: [], csmGroup: group,
    assemblyPipeline: { id: 'assembly' }, shippingDoneStage: stage('shipped'),
    salesPipeline: { id: 'sales-pipe' }, invoiceStage: stage('invoice'), quoteStages: [stage('quote')],
    salesWonStages: [stage('paid', 'Оплачено', true)], salesLossStages: [], repeatPipelines: [],
    assemblyStages: [stage('assembly-open')], assemblyStartStage: stage('assembly-open'),
    itemsInTransitStage: stage('transit'), assemblyLossStages: [],
  };
  const fixture = () => {
    const db = {
      factStageTransition: { findMany: jest.fn().mockResolvedValue([]) },
      factDealCurrent: { findMany: jest.fn().mockResolvedValue([]) },
      crmGroup: { findMany: jest.fn().mockResolvedValue([salesGroup, group]) },
      crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'manager' }]) },
    };
    const service = new ReportsService(db as any, {} as any);
    jest.spyOn(service as any, 'resolveRevenueForecastRefs').mockResolvedValue(refs);
    return { service, db };
  };

  it('returns the exact built-in funnel contract and request identity', async () => {
    const { service } = fixture();
    const template = {
      name: 'Sales: шаги и конверсии за месяц', sourceType: 'EVENT',
      config: { builtinKey: 'sales_funnel_steps', filters: { pipelineIds: ['sales-pipe'] }, contract: { metrics: [] } },
    };
    jest.spyOn(service as any, 'buildSalesReportTemplates').mockResolvedValue([template]);
    expect(await service.getTeamFunnelDefinition('sales')).toEqual({
      name: template.name, sourceType: template.sourceType, config: template.config,
      group: salesGroup, pipelineIds: ['sales-pipe'], filters: template.config.filters,
    });
  });

  it('uses first-ever current-owner deals for every CSM count and payment amount', async () => {
    const { service } = fixture();
    const csmStages = {
      work: stage('work'), offer: stage('offer'), invoice: stage('invoice'),
      paid: stage('paid'), success: [stage('paid')],
    };
    jest.spyOn(service as any, 'resolveCsmRefs').mockResolvedValue({
      csmGroup: group, basePipeline: { id: 'base' }, assignedPipeline: { id: 'assigned' },
      assemblyPipeline: { id: 'assembly' }, assemblyStages: [], baseStages: csmStages, assignedStages: csmStages,
    });
    const definition = await service.getTeamFunnelDefinition('csm');
    expect(definition!.filters).toEqual({ pipelineIds: ['base', 'assigned'], groupIds: ['csm'] });
    const metrics = definition!.config.contract!.metrics!.filter((metric) => metric.type === 'stage_reached');
    expect(metrics.map((metric) => metric.id)).toEqual(['taken_to_work', 'offer_made', 'invoice_sent', 'paid', 'paid_amount']);
    expect(metrics.every((metric) => metric.stageEntryMode === 'first_ever_deal')).toBe(true);
    expect(metrics.find((metric) => metric.id === 'paid')!.stageIds).toEqual(metrics.find((metric) => metric.id === 'paid_amount')!.stageIds);
  });

  it('keeps transferred Sales owners while excluding CSM from Sales assembly', async () => {
    const { service } = fixture();
    jest.spyOn(service as any, 'resolveSalesRefs').mockResolvedValue({
      salesGroup, salesPipeline: { id: 'sales-pipe' }, assemblyPipeline: { id: 'assembly' }, assemblyStages: [stage('open')],
      stages: { assigned: stage('assigned'), kpPrepared: stage('prepared'), kp: stage('kp'), objections: null, invoice: stage('invoice'), paid: stage('paid'), success: [stage('paid')] },
    });
    jest.spyOn(service as any, 'resolveLeadFieldExternalId').mockResolvedValue('marketing');
    const templates = await (service as any).buildSalesReportTemplates();
    expect(templates.every((template: any) => !template.config.filters.groupIds)).toBe(true);
    const assemblyMetrics = templates.find((template: any) => template.config.builtinKey === 'sales_weighted_funnel')
      .config.contract.metrics.filter((metric: any) => ['count_assembly', 'sum_assembly'].includes(metric.id));
    expect(assemblyMetrics).toHaveLength(2);
    expect(assemblyMetrics.every((metric: any) => metric.excludeGroupIds.join(',') === 'csm')).toBe(true);
    const salesDeal = { id: 'one', responsible: { group: salesGroup } };
    const csmDeal = { id: 'two', responsible: { group } };
    const ungroupedDeal = { id: 'three', responsible: { group: null } };
    expect(await (service as any).applyMetricDealFilters([salesDeal, csmDeal, ungroupedDeal], assemblyMetrics[0])).toEqual([salesDeal, ungroupedDeal]);
  });

  it('does not reapply Sales group scope to built-ins but preserves custom report behavior', async () => {
    const { service, db } = fixture();
    const builtin = { id: 'builtin', config: { builtinKey: 'sales_funnel_steps', filters: { pipelineIds: ['sales-pipe'] } } };
    const custom = { id: 'custom', config: { filters: {} } };
    const templates = { findMany: jest.fn().mockResolvedValue([builtin, custom]), update: jest.fn() };
    (db as any).reportTemplate = templates;
    await (service as any).applyTeamScopeToTemplates('Sales:', 'sales', ['sales-pipe'], true);
    expect(templates.update).toHaveBeenCalledTimes(1);
    expect(templates.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'custom' }, data: { config: expect.objectContaining({ filters: { pipelineIds: ['sales-pipe'], groupIds: ['sales'] } }) } }));
  });

  it('normalizes stale built-in clients before caching while preserving explicit selections and custom reports', async () => {
    const { service } = fixture();
    const template = {
      name: 'Sales: шаги и конверсии за месяц', sourceType: 'EVENT',
      config: { builtinKey: 'sales_funnel_steps', lockTeamFilter: true, lockPipelineFilter: true, filters: { pipelineIds: ['sales-pipe'] }, contract: { metrics: [{ id: 'canonical' }] } },
    };
    const builder = jest.spyOn(service as any, 'buildSalesReportTemplates').mockResolvedValue([template]);
    const stale = {
      name: 'stale', sourceType: 'CURRENT',
      filters: { dateFrom: '2026-09-01', dateTo: '2026-09-24', groupIds: ['sales'], pipelineIds: ['wrong'], managerIds: ['manager'], amountTo: 100000, customFields: [] },
      config: { builtinKey: 'sales_funnel_steps', contract: { metrics: [{ stageEntryMode: 'event' }] }, compare: true },
    };
    const custom = { ...stale, config: { metric: 'contract', contract: { metrics: [{ id: 'user-defined' }] } } };
    const [normalized, equivalent, untouched] = await (service as any).normalizeBuiltinRequests([
      stale,
      { ...stale, filters: { ...stale.filters, dateFrom: '2026-08-31T21:00:00.000Z', dateTo: '2026-09-24T20:59:59.999Z' } },
      custom,
    ]);
    expect(builder).toHaveBeenCalledTimes(1);
    expect(untouched).toBe(custom);
    expect(normalized.config.contract).toBe(template.config.contract);
    expect(normalized.config.compare).toBe(true);
    expect(normalized.filters).toEqual({
      dateFrom: '2026-08-31T21:00:00.000Z', dateTo: '2026-09-24T20:59:59.999Z',
      pipelineIds: ['sales-pipe'], managerIds: ['manager'], amountTo: 100000, customFields: [],
    });
    expect(normalized.config.filters).toEqual(normalized.filters);
    expect((service as any).reportCacheKey(normalized, { role: 'ADMIN' })).toEqual((service as any).reportCacheKey(equivalent, { role: 'ADMIN' }));
    const cached = jest.spyOn(service as any, 'getCachedReport').mockResolvedValue({ payload: { ok: true }, sourceSyncAt: null });
    jest.spyOn(service as any, 'latestReportSourceSyncAt').mockResolvedValue(null);
    await service.compute(stale as any, { id: 'admin', role: 'ADMIN' });
    expect(cached).toHaveBeenCalledWith((service as any).reportCacheKey(normalized, { role: 'ADMIN' }));
  });

  it('keeps Sales zero columns and real transferred-owner rows without unrelated empty teams', async () => {
    const { service, db } = fixture();
    db.crmUser.findMany.mockResolvedValue([
      { id: 'sales-zero', name: 'Sales zero', groupId: 'sales' },
      { id: 'csm-zero', name: 'CSM zero', groupId: 'csm' },
      { id: 'csm-fact', name: 'CSM fact', groupId: 'csm' },
    ] as any);
    jest.spyOn(service as any, 'findDealsForContractMetric').mockResolvedValue([
      { id: 'transferred', amount: 100, responsibleId: 'csm-fact', responsible: { name: 'CSM fact' } },
    ]);
    const report = await (service as any).computeDataContract({}, {
      groupBy: 'manager', emptyManagerGroupIds: ['sales'], metrics: [{ id: 'paid', label: 'Paid', type: 'stage_reached', measure: 'deal_count' }],
    }, 'ADMIN');
    expect(report.rows.map((row: any) => row.groupId).sort()).toEqual(['csm-fact', 'sales-zero']);
    expect(report.rows.find((row: any) => row.groupId === 'csm-fact').metrics.paid.value).toBe(1);
  });

  it.each([null, { type: 'pending' }])('does not return a queued snapshot placeholder as computed data: %p', async (payload) => {
    const { service } = fixture();
    const dto = { name: 'report', sourceType: 'CURRENT' as const, filters: {}, config: { metric: 'count' } };
    jest.spyOn(service as any, 'latestReportSourceSyncAt').mockResolvedValue(null);
    jest.spyOn(service as any, 'getCachedReport').mockResolvedValue({ payload, sourceSyncAt: null });
    const fresh = jest.spyOn(service as any, 'computeFresh').mockResolvedValue({ type: 'current', summary: { count: 7 } });
    jest.spyOn(service as any, 'saveCachedReport').mockResolvedValue(undefined);
    expect(await service.compute(dto, { id: 'admin', role: 'ADMIN' })).toEqual({ type: 'current', summary: { count: 7 } });
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it('moves an old queued built-in snapshot to its canonical key and finishes the old job', async () => {
    const { service, db } = fixture();
    const oldDto = { name: 'old', sourceType: 'CURRENT', filters: {}, config: {} };
    const canonicalDto = { ...oldDto, name: 'canonical' };
    const user = { id: 'admin', role: 'ADMIN' };
    (db as any).$queryRaw = jest.fn().mockResolvedValue([{ id: 'job', cache_key: 'old-key', report_config: { dto: oldDto, user } }]);
    (db as any).$executeRawUnsafe = jest.fn().mockResolvedValue(1);
    for (const name of ['ensureReportCacheTable', 'pruneInvalidReportCacheJobs', 'requeueStaleReportCacheLocks']) {
      jest.spyOn(service as any, name).mockResolvedValue(undefined);
    }
    jest.spyOn(service as any, 'normalizeBuiltinRequests').mockResolvedValue([canonicalDto]);
    jest.spyOn(service as any, 'latestReportSourceSyncAt').mockResolvedValue(null);
    jest.spyOn(service as any, 'computeFresh').mockResolvedValue({ type: 'contract', rows: [] });
    jest.spyOn(service as any, 'reportCacheKey').mockReturnValue('canonical-key');
    const save = jest.spyOn(service as any, 'saveCachedReport').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'compactHeap').mockImplementation(() => {});
    jest.spyOn(service as any, 'recycleWorkerIfNeeded').mockResolvedValue(false);
    expect(await service.processReportCacheRefreshJobs()).toEqual({ processed: 1 });
    expect(save).toHaveBeenCalledWith('canonical-key', 'canonical', { type: 'contract', rows: [] }, null, canonicalDto, user);
    expect((db as any).$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("report_config = NULL, refresh_status = 'IDLE'"), 'old-key');
    expect((db as any).$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("status = 'SUCCESS'"), 'job');
  });

  it('deduplicates actual shipping and applies current ownership and all user filters', async () => {
    const { service, db } = fixture();
    const first = new Date('2026-09-02T10:00:00Z');
    db.factStageTransition.findMany.mockResolvedValue([
      { dealId: 'deal-1', movedAt: first }, { dealId: 'deal-1', movedAt: new Date('2026-09-03T10:00:00Z') },
      { dealId: 'deal-2', movedAt: first },
    ] as never);
    db.factDealCurrent.findMany.mockResolvedValue([
      { dealId: 'deal-1', responsibleId: 'manager', groupId: 'csm', amount: 100, customFields: { flag: { value: 'yes' } } },
      { dealId: 'deal-2', responsibleId: 'manager', groupId: 'csm', amount: 100, customFields: { flag: { value: 'no' } } },
    ] as never);
    const filters = {
      dateFrom: '2026-09-01', dateTo: '2026-09-30', managerIds: ['manager', 'hidden'], groupIds: ['csm'],
      amountTo: 100000, tagIncludes: ['tag'], customFields: [{ fieldId: 'flag', operator: 'equals' as const, value: 'yes' }],
    };
    const result = await service.getActualShipping(filters, 'ADMIN');
    expect(result.csmGroupId).toBe('csm');
    expect(result.entries.map(({ deal, shippedAt }) => [deal.id, shippedAt])).toEqual([['deal-1', first]]);
    expect(db.factDealCurrent.findMany).toHaveBeenCalledWith({ where: expect.objectContaining({
      deletedAt: null, responsibleId: { in: ['manager'] }, pipelineId: { in: ['assembly'] },
      amount: { lte: 100000 }, tags: { hasSome: ['tag'] }, dealId: { in: ['deal-1', 'deal-2'] },
    }) });
    expect(db.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: { in: ['csm'] } }) }));
    expect(db.factStageTransition.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      toStageId: 'shipped', pipelineId: 'assembly', movedAt: { gte: new Date('2026-08-31T21:00:00Z'), lte: new Date('2026-09-30T20:59:59.999Z') },
    } }));
  });

  it('returns an honest empty result but fails on missing shipping configuration', async () => {
    const { service, db } = fixture();
    expect(await service.getActualShipping({}, 'ADMIN')).toEqual({ entries: [], csmGroupId: 'csm' });
    expect(db.factDealCurrent.findMany).not.toHaveBeenCalled();
    (service as any).resolveRevenueForecastRefs.mockResolvedValue({ ...refs, csmGroup: null });
    await expect(service.getActualShipping({}, 'ADMIN')).rejects.toThrow('Не настроены');
  });

  it('uses the same current-month forecast snapshot for plan-fact shipping without live re-querying', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00Z'));
    try {
      const { service } = fixture();
      const compute = jest.spyOn(service, 'compute').mockResolvedValue({
        type: 'revenueProfitForecast', ready: true,
        rows: [
          { id: 'salesShippedThisMonth', deals: [{ dealId: 'sales-deal', managerId: 'sales-owner', manager: 'Same name', groupId: 'sales', amount: 1000.50, predictedShipAt: '2026-09-24T10:00:00Z' }] },
          { id: 'repeatShippedThisMonth', deals: [{ dealId: 'repeat-deal', managerId: 'csm-owner', manager: 'Same name', groupId: 'csm', amount: 200, predictedShipAt: '2026-09-25T10:00:00Z' }] },
          { id: 'salesShippingThisMonth', deals: [{ dealId: 'not-actual', amount: 99999 }] },
        ],
      } as any);
      const raw = jest.spyOn(service, 'getActualShipping');
      const result = await service.getPlanFactShipping(new Date('2026-08-31T21:00:00Z'), new Date('2026-09-25T20:59:59.999Z'), { id: 'admin', role: 'ADMIN' });
      expect(raw).not.toHaveBeenCalled();
      expect(compute).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ builtinKey: 'revenue_profit_forecast' }) }), { id: 'admin', role: 'ADMIN' });
      expect(result.entries.map(({ deal }) => [deal.id, deal.responsibleId, deal.responsible.group.id, deal.amount])).toEqual([
        ['sales-deal', 'sales-owner', 'sales', 1000.5], ['repeat-deal', 'csm-owner', 'csm', 200],
      ]);
      expect(result.csmGroupId).toBe('csm');
      expect(result.entries[1].shippedAt).toEqual(new Date('2026-09-25T10:00:00Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps historical plan-fact shipping separate from the current-month forecast', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00Z'));
    try {
      const { service } = fixture();
      const raw = jest.spyOn(service, 'getActualShipping').mockResolvedValue({ entries: [], csmGroupId: 'csm' });
      const compute = jest.spyOn(service, 'compute');
      await service.getPlanFactShipping(new Date('2026-07-31T21:00:00Z'), new Date('2026-08-31T20:59:59.999Z'), { id: 'admin', role: 'ADMIN' });
      expect(compute).not.toHaveBeenCalled();
      expect(raw).toHaveBeenCalledWith({ dateFrom: '2026-07-31T21:00:00.000Z', dateTo: '2026-08-31T20:59:59.999Z' }, 'ADMIN');
    } finally {
      jest.useRealTimers();
    }
  });

  it('canonicalizes every forecast date selection to the current Moscow month and retains user filters', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-25T12:00:00Z'));
    try {
      const { service } = fixture();
      const dto = { name: 'forecast', sourceType: 'CURRENT', filters: { dateFrom: '2026-08-01', dateTo: '2026-08-31', amountTo: 100000, managerIds: ['manager'] }, config: { builtinKey: 'revenue_profit_forecast' } };
      const [august, september] = await (service as any).normalizeBuiltinRequests([
        dto, { ...dto, filters: { ...dto.filters, dateFrom: '2026-09-01', dateTo: '2026-09-30' } },
      ]);
      expect(august.filters).toEqual({ dateFrom: '2026-08-31T21:00:00.000Z', dateTo: '2026-09-25T20:59:59.999Z', amountTo: 100000, managerIds: ['manager'] });
      expect((service as any).reportCacheKey(august, { role: 'ADMIN' })).toEqual((service as any).reportCacheKey(september, { role: 'ADMIN' }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves selection filters in both active forecast and actual shipping and counts reopened shipments once', async () => {
    const { service } = fixture();
    const deal = { id: 'shipped', amount: 1000.50, responsibleId: 'manager', responsible: { id: 'manager', name: 'Manager', group: salesGroup }, stage: stage('open') };
    const shipping = jest.spyOn(service, 'getActualShipping').mockResolvedValue({ entries: [{ deal, shippedAt: new Date() }], csmGroupId: 'csm' });
    jest.spyOn(service as any, 'saveRevenueForecastSnapshot').mockResolvedValue(undefined);
    const current = jest.spyOn(service as any, 'findCurrentStageDealsFromFacts').mockImplementation(async (filters: any) => filters.pipelineIds[0] === 'assembly' ? [deal] : []);
    const engine = jest.spyOn(RevenueForecastEngine.prototype, 'compute').mockResolvedValue({ predictions: new Map(), model: {}, warnings: [] } as any);
    try {
      const filters = { managerIds: ['manager'], groupIds: ['sales'], amountTo: 100000, tagIncludes: ['tag'], customFields: [{ fieldId: 'flag', operator: 'equals', value: 'yes' }] };
      const report = await (service as any).computeRevenueProfitForecast(filters, 'ADMIN');
      expect(shipping).toHaveBeenCalledWith(expect.objectContaining(filters), 'ADMIN');
      expect(current.mock.calls.every(([filter]: any[]) => Object.keys(filters).every((key) => JSON.stringify(filter[key]) === JSON.stringify((filters as any)[key])))).toBe(true);
      expect(engine).toHaveBeenCalledWith(expect.objectContaining({ assemblyDeals: [] }));
      expect(report.summary.actualRevenue).toBe(1000.50);
      expect(report.summary.revenue).toBe(1000.50);
      expect(report.rows.find((row: any) => row.id === 'salesShippedThisMonth').revenue).toBe(1000.50);
      expect(report.totals.find((row: any) => row.id === 'totalShippedThisMonth').revenue).toBe(1000.50);
      expect(report.rows.find((row: any) => row.id === 'salesShippedThisMonth').deals[0]).toEqual(expect.objectContaining({ managerId: 'manager', groupId: 'sales', amount: 1000.50 }));
    } finally {
      engine.mockRestore();
    }
  });
});
