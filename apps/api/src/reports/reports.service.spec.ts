import { ReportsService } from './reports.service';

type Where = Record<string, any>;

const stages = {
  lead: { id: 'stage-lead', name: 'Лид', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  qualified: { id: 'stage-qualified', name: 'Квалифицирован', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  kp: { id: 'stage-kp', name: 'КП отправлено', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  invoice: { id: 'stage-invoice', name: 'Счет выставлен', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  paid: { id: 'stage-paid', name: 'Оплата', pipelineId: 'pipe-sales', isWon: true, isLost: false },
  lost: { id: 'stage-lost', name: 'Отказ', pipelineId: 'pipe-sales', isWon: false, isLost: true },
};

const lossReasons = {
  price: { id: 'loss-price', pipelineId: 'pipe-sales', externalId: '1', name: 'Дорого' },
};

const managers = {
  first: { id: 'manager-1', name: 'Иван', groupId: 'group-1', isActive: true, isVisible: true, group: { id: 'group-1', name: 'Отдел А' } },
  second: { id: 'manager-2', name: 'Ольга', groupId: 'group-1', isActive: true, isVisible: true, group: { id: 'group-1', name: 'Отдел А' } },
};

const deals = [
  {
    id: 'deal-1',
    title: 'Сделка 1',
    amount: 1000,
    pipelineId: 'pipe-sales',
    stageId: stages.paid.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.paid,
    lossReasonId: null,
    lossReason: null,
    customFields: { sla: { value: 15 }, margin: { value: 300 }, source: { value: 'Принят' }, marketing: { value: 'Принято' } },
    createdAt: new Date('2026-01-02T10:00:00.000Z'),
    updatedAt: new Date('2026-01-08T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-2',
    title: 'Сделка 2',
    amount: 2000,
    pipelineId: 'pipe-sales',
    stageId: stages.invoice.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.invoice,
    lossReasonId: null,
    lossReason: null,
    customFields: { sla: { value: 30 }, margin: { value: 500 }, source: { value: 'Принят' }, marketing: { value: 'Принято' } },
    createdAt: new Date('2026-01-03T10:00:00.000Z'),
    updatedAt: new Date('2026-01-09T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-3',
    title: 'Сделка 3',
    amount: 3000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.second.id,
    responsible: managers.second,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: { sla: { value: 10 }, margin: { value: 1000 }, source: { value: 'Реклама' }, marketing: { value: 'Не принято' } },
    createdAt: new Date('2026-01-04T10:00:00.000Z'),
    updatedAt: new Date('2026-01-12T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-4',
    title: 'Вне периода',
    amount: 9000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.second.id,
    responsible: managers.second,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: { sla: { value: 5 }, margin: { value: 2000 }, source: { value: 'Принят' }, marketing: { value: 'Принято' } },
    createdAt: new Date('2026-02-01T10:00:00.000Z'),
    updatedAt: new Date('2026-02-02T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-5',
    title: 'Отказ',
    amount: 5000,
    pipelineId: 'pipe-sales',
    stageId: stages.lost.id,
    responsibleId: managers.second.id,
    responsible: managers.second,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.lost,
    lossReasonId: null,
    lossReason: null,
    customFields: {
      sla: { value: 40 },
      margin: { value: 1500 },
      source: { value: 'Принят' },
      loss_reason_field: { name: 'Причины отказа', value: lossReasons.price.name },
    },
    createdAt: new Date('2026-03-01T10:00:00.000Z'),
    updatedAt: new Date('2026-03-05T10:00:00.000Z'),
    closedAt: new Date('2026-03-05T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-6',
    title: 'Создана до периода',
    amount: 6000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: { sla: { value: 20 }, margin: { value: 1200 }, source: { value: 'Принят' } },
    createdAt: new Date('2026-02-28T10:00:00.000Z'),
    updatedAt: new Date('2026-03-02T10:00:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-7',
    title: 'Быстро взяли 1',
    amount: 1000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: {},
    createdAt: new Date('2026-04-01T09:55:00.000Z'),
    updatedAt: new Date('2026-04-01T10:01:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-8',
    title: 'Быстро взяли 2',
    amount: 1000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: {},
    createdAt: new Date('2026-04-01T09:55:00.000Z'),
    updatedAt: new Date('2026-04-01T10:01:00.000Z'),
    deletedAt: null,
  },
  {
    id: 'deal-9',
    title: 'Долго брали',
    amount: 1000,
    pipelineId: 'pipe-sales',
    stageId: stages.kp.id,
    responsibleId: managers.first.id,
    responsible: managers.first,
    pipeline: { id: 'pipe-sales', name: 'Продажи' },
    stage: stages.kp,
    lossReasonId: null,
    lossReason: null,
    customFields: {},
    createdAt: new Date('2026-04-01T09:55:00.000Z'),
    updatedAt: new Date('2026-04-01T10:18:00.000Z'),
    deletedAt: null,
  },
];

const history = [
  { id: 'h0', dealId: 'deal-4', fromStageId: stages.lead.id, toStageId: stages.kp.id, movedAt: new Date('2025-12-20T10:00:00.000Z') },
  { id: 'h1', dealId: 'deal-1', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-01-05T10:00:00.000Z') },
  { id: 'h2', dealId: 'deal-1', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-01-06T10:00:00.000Z') },
  { id: 'h3', dealId: 'deal-1', fromStageId: stages.kp.id, toStageId: stages.invoice.id, movedAt: new Date('2026-01-07T10:00:00.000Z') },
  { id: 'h4', dealId: 'deal-1', fromStageId: stages.invoice.id, toStageId: stages.paid.id, movedAt: new Date('2026-01-08T10:00:00.000Z') },
  { id: 'h5', dealId: 'deal-2', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-01-05T12:00:00.000Z') },
  { id: 'h6', dealId: 'deal-2', fromStageId: stages.qualified.id, toStageId: stages.invoice.id, movedAt: new Date('2026-01-07T12:00:00.000Z') },
  { id: 'h7', dealId: 'deal-2', fromStageId: stages.invoice.id, toStageId: stages.invoice.id, movedAt: new Date('2026-01-09T12:00:00.000Z') },
  { id: 'h8', dealId: 'deal-3', fromStageId: stages.lead.id, toStageId: stages.kp.id, movedAt: new Date('2026-01-10T10:00:00.000Z') },
  { id: 'h9', dealId: 'deal-3', fromStageId: stages.kp.id, toStageId: stages.invoice.id, movedAt: new Date('2026-01-12T10:00:00.000Z') },
  { id: 'h10', dealId: 'deal-4', fromStageId: stages.lead.id, toStageId: stages.kp.id, movedAt: new Date('2026-02-02T10:00:00.000Z') },
  { id: 'h11', dealId: 'deal-5', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-03-02T10:00:00.000Z') },
  { id: 'h12', dealId: 'deal-5', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-03-03T10:00:00.000Z') },
  { id: 'h13', dealId: 'deal-5', fromStageId: stages.kp.id, toStageId: stages.lost.id, movedAt: new Date('2026-03-05T10:00:00.000Z') },
  { id: 'h14', dealId: 'deal-6', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-02-28T10:00:00.000Z') },
  { id: 'h15', dealId: 'deal-6', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-03-02T10:00:00.000Z') },
  { id: 'h16', dealId: 'deal-7', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-04-01T10:00:00.000Z') },
  { id: 'h17', dealId: 'deal-7', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-04-01T10:01:00.000Z') },
  { id: 'h18', dealId: 'deal-8', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-04-01T10:00:00.000Z') },
  { id: 'h19', dealId: 'deal-8', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-04-01T10:01:00.000Z') },
  { id: 'h20', dealId: 'deal-9', fromStageId: stages.lead.id, toStageId: stages.qualified.id, movedAt: new Date('2026-04-01T10:00:00.000Z') },
  { id: 'h21', dealId: 'deal-9', fromStageId: stages.qualified.id, toStageId: stages.kp.id, movedAt: new Date('2026-04-01T10:18:00.000Z') },
];

const responsibleHistory = [
  {
    id: 'rh1',
    dealId: 'deal-5',
    fromUserId: null,
    toUserId: managers.second.id,
    changedAt: new Date('2026-03-02T18:00:00.000Z'),
  },
];

const tasks = [
  {
    id: 'task-1',
    dealId: 'deal-5',
    responsibleId: managers.second.id,
    createdAt: new Date('2026-03-03T09:00:00.000Z'),
    raw: { created_at: Date.parse('2026-03-02T22:00:00.000Z') / 1000 },
  },
  {
    id: 'task-2',
    dealId: 'deal-7',
    responsibleId: managers.first.id,
    createdAt: new Date('2026-04-01T09:59:00.000Z'),
    raw: {},
  },
  {
    id: 'task-3',
    dealId: 'deal-8',
    responsibleId: managers.first.id,
    createdAt: new Date('2026-04-01T09:59:00.000Z'),
    raw: {},
  },
  {
    id: 'task-4',
    dealId: 'deal-9',
    responsibleId: managers.first.id,
    createdAt: new Date('2026-04-01T09:59:00.000Z'),
    raw: {},
  },
];

describe('ReportsService data contract', () => {
  let service: ReportsService;
  let audit: { record: jest.Mock };

  beforeEach(() => {
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    service = new ReportsService(createPrismaMock() as any, audit as any);
  });

  it('queues stale cached report refresh instead of recomputing inside API', async () => {
    const cachedPayload = { rows: [{ id: 'cached-row' }] };
    const db = {
      $executeRawUnsafe: jest.fn(() => Promise.resolve(1)),
      $queryRaw: jest.fn(() => Promise.resolve([{ payload: cachedPayload, source_sync_at: new Date('2026-01-01T00:00:00.000Z') }])),
      amoConnection: {
        findFirst: jest.fn(() =>
          Promise.resolve({ lastIncrementalSyncAt: new Date('2026-01-02T00:00:00.000Z'), lastFullSyncAt: null }),
        ),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const result = await localService.compute(
      {
        name: 'Cached report',
        sourceType: 'CURRENT' as any,
        filters: {},
        config: { metric: 'contract', contract: { groupBy: 'none', metrics: [] } },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    expect(result).toBe(cachedPayload);
    expect(
      db.$executeRawUnsafe.mock.calls.some(
        (call: any[]) => String(call[0]).includes('WHERE cache_key = $1') && String(call[0]).includes("ELSE 'QUEUED'"),
      ),
    ).toBe(true);
  });

  it('computes count, stage transitions, field conditions, sums, conversion and durations in one contract', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: { dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-01-31T23:59:59.999Z' },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'none',
            metrics: [
              { id: 'created', label: 'Лиды получены', type: 'created_deals', measure: 'deal_count', display: 'number' },
              {
                id: 'sla',
                label: 'SLA < 20',
                type: 'field_condition',
                fieldId: 'sla',
                fieldOperator: 'lt',
                fieldValue: 20,
                measure: 'deal_count',
                display: 'number',
              },
              {
                id: 'qualified',
                label: 'Квалифицированы',
                type: 'stage_reached',
                stageIds: [stages.qualified.id],
                measure: 'deal_count',
                display: 'number',
              },
              {
                id: 'kpFromQualified',
                label: 'КП после квалификации',
                type: 'stage_reached',
                fromStageId: stages.qualified.id,
                stageIds: [stages.kp.id],
                measure: 'deal_count',
                display: 'number',
              },
              {
                id: 'invoiceAmount',
                label: 'Сумма счетов',
                type: 'current_stage',
                stageIds: [stages.invoice.id],
                measure: 'field_sum',
                display: 'money',
                valueFieldId: 'margin',
              },
              {
                id: 'avgMargin',
                label: 'Средняя маржа',
                type: 'created_deals',
                measure: 'field_avg',
                display: 'money',
                valueFieldId: 'margin',
              },
              {
                id: 'conversion',
                label: 'Лид → квалификация',
                type: 'conversion',
                fromMetricId: 'created',
                toMetricId: 'qualified',
                display: 'percent',
              },
            ],
            durations: [{ id: 'kpDuration', label: 'Время в КП', stageId: stages.kp.id }],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.groupId === 'all');

    expect(row.metrics.created).toMatchObject({ value: 3, unit: 'number', dealCount: 3 });
    expect(row.metrics.sla).toMatchObject({ value: 2, unit: 'number', dealCount: 2 });
    expect(row.metrics.qualified).toMatchObject({ value: 2, unit: 'number', dealCount: 2 });
    expect(row.metrics.kpFromQualified).toMatchObject({ value: 1, unit: 'number', dealCount: 1 });
    expect(row.metrics.invoiceAmount).toMatchObject({ value: 500, unit: 'money', dealCount: 1 });
    expect(row.metrics.avgMargin).toMatchObject({ value: 600, unit: 'money', dealCount: 3 });
    expect(row.metrics.conversion).toMatchObject({ value: 66.67, unit: 'percent', dealCount: 2 });
    expect(row.metrics.created.samples.map((sample: any) => sample.dealId)).toEqual(['deal-3', 'deal-2', 'deal-1']);
    expect(row.metrics.conversion.fromSamples.map((sample: any) => sample.dealId)).toEqual(['deal-3', 'deal-2', 'deal-1']);
    expect(row.metrics.conversion.toSamples.map((sample: any) => sample.dealId)).toEqual(['deal-2', 'deal-1']);
    expect(row.durations.kpDuration).toMatchObject({ sampleSize: 2 });
    expect(row.durations.kpDuration.avgDays).toBeCloseTo(0.770833, 6);
  });

  it('counts received leads by creation date and current Marketing = accepted field', async () => {
    const result = await service.compute(
      {
        sourceType: 'CURRENT' as any,
        filters: { dateFrom: '2026-01-01T00:00:00.000Z', dateTo: '2026-01-31T23:59:59.999Z', pipelineIds: ['pipe-sales'] },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'none',
            metrics: [
              {
                id: 'leads_received',
                label: 'Лиды получены',
                type: 'created_deals',
                measure: 'deal_count',
                display: 'number',
                extraFilters: [
                  {
                    subject: 'deal_field',
                    fieldId: 'marketing',
                    operator: 'equals',
                    value: 'Принято',
                  },
                ],
              },
            ],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.groupId === 'all');
    expect(row.metrics.leads_received).toMatchObject({ value: 2, unit: 'number', dealCount: 2 });
  });

  it('filters current stage and CRM field conditions by selected manager', async () => {
    const result = await service.compute(
      {
        sourceType: 'CURRENT' as any,
        filters: {
          dateFrom: '2026-01-01T00:00:00.000Z',
          dateTo: '2026-01-31T23:59:59.999Z',
          managerIds: [managers.second.id],
        },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'manager',
            metrics: [
              {
                id: 'currentKp',
                label: 'Сейчас в КП',
                type: 'current_stage',
                stageIds: [stages.kp.id],
                measure: 'deal_count',
                display: 'number',
              },
              {
                id: 'sourceAd',
                label: 'Источник реклама',
                type: 'field_condition',
                fieldId: 'source',
                fieldOperator: 'contains',
                fieldValue: 'Рек',
                measure: 'deal_count',
                display: 'number',
              },
            ],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const managerRow = (result as any).rows.find((item: any) => item.groupId === managers.second.id);

    expect(managerRow.groupName).toBe('Ольга');
    expect(managerRow.metrics.currentKp.value).toBe(2);
    expect(managerRow.metrics.sourceAd.value).toBe(1);
  });

  it('sums visible current-stage averages for the row total', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-02T10:00:00.000Z'));

    try {
      const result = await service.compute(
        {
          sourceType: 'CURRENT' as any,
          filters: {
            pipelineIds: ['pipe-sales'],
            groupIds: ['group-1'],
          },
          config: { metric: 'deal_stage_age' },
        } as any,
        { id: 'user-1', role: 'ADMIN' as any },
      );

      const row = (result as any).rows.find((item: any) => item.managerId === managers.first.id);
      const activeStages = row.stages.filter((stage: any) => stage.sampleSize > 0 && stage.avgDays !== null);
      const displayDurationDays = (value: number) => {
        const totalMinutes = Math.round(value * 24 * 60);
        if (totalMinutes < 60) return Math.max(totalMinutes, 1) / 24 / 60;
        const hours = Math.floor(totalMinutes / 60);
        if (hours < 24) return totalMinutes / 24 / 60;
        return hours / 24;
      };
      const stageSum = activeStages.reduce((sum: number, stage: any) => sum + displayDurationDays(stage.avgDays), 0);
      const stageSamples = activeStages.reduce((sum: number, stage: any) => sum + stage.sampleSize, 0);
      const weightedAverage = activeStages.reduce(
        (sum: number, stage: any) => sum + stage.avgDays * stage.sampleSize,
        0,
      ) / stageSamples;

      expect(activeStages.length).toBeGreaterThan(1);
      expect(row.stageTotal.sampleSize).toBe(stageSamples);
      expect(row.stageTotal.avgDays).toBeCloseTo(stageSum, 6);
      expect(row.overallAverage.avgDays).toBeCloseTo(stageSum, 6);
      expect(Math.abs(row.stageTotal.avgDays - weightedAverage)).toBeGreaterThan(1);

      const summary = (result as any).summary;
      const summaryStages = summary.stages.filter((stage: any) => stage.sampleSize > 0 && stage.avgDays !== null);
      const summaryStageSum = summaryStages.reduce(
        (sum: number, stage: any) => sum + displayDurationDays(stage.avgDays),
        0,
      );
      expect(summary.stageTotal.avgDays).toBeCloseTo(summaryStageSum, 6);
    } finally {
      jest.useRealTimers();
    }
  });

  it('writes audit entries when report templates are changed', async () => {
    const saved = await service.saveTemplate(
      {
        name: 'Pipeline report',
        sourceType: 'CURRENT',
        filters: {},
        config: { metric: 'count', order: 1 },
      } as any,
      'user-1',
    );

    await service.deleteTemplate(saved.id, { id: 'user-1', role: 'ADMIN' as any });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'reports.template.create',
        entity: 'ReportTemplate',
        entityId: saved.id,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'reports.template.delete',
        entity: 'ReportTemplate',
        entityId: saved.id,
      }),
    );
  });

  it('keeps sales weighted total formula aligned with current metric labels', async () => {
    const templates = await (service as any).buildSalesReportTemplates();
    const template = templates.find((item: any) => item.config?.builtinKey === 'sales_weighted_funnel');
    const metrics = template.config.contract.metrics;
    const weightedTotal = metrics.find((metric: any) => metric.id === 'weighted_total');
    const metricLabels = new Set(metrics.map((metric: any) => metric.label));
    const formulaRefs = [...weightedTotal.formula.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);

    expect(formulaRefs).toEqual([
      'КП презентовано x конверсия',
      'Есть возражения x конверсия',
      'Счета x конверсия',
      'Сборка x 100%',
    ]);
    expect(formulaRefs.every((label) => metricLabels.has(label))).toBe(true);
    expect(weightedTotal.formula).not.toContain('КП x 30%');
    expect(weightedTotal.formula).not.toContain('Счета x 90%');
  });

  it('keeps already shipped forecast buckets separate for sales and repeat sales', () => {
    const buckets = (service as any).createRevenueForecastBuckets();
    const refs = { csmGroup: { id: 'group-csm', name: 'CSM' } };
    const salesDeal = { responsible: { group: { id: 'group-sales', name: 'Sales' } } };
    const repeatDeal = { responsible: { group: { id: 'group-csm', name: 'CSM' } } };

    expect(Object.keys(buckets)).toEqual([
      'salesShippedThisMonth',
      'salesShippingThisMonth',
      'salesInvoiceThisMonth',
      'salesQuoteThisMonth',
      'salesNotThisMonth',
      'repeatShippedThisMonth',
      'repeatShippingThisMonth',
      'repeatInvoiceThisMonth',
      'repeatQuoteThisMonth',
      'repeatNotThisMonth',
    ]);
    expect(buckets.salesShippedThisMonth.label).toBe('Продажи: уже отгружено');
    expect(buckets.repeatShippedThisMonth.label).toBe('Повторные продажи: уже отгружено');
    expect((service as any).revenueForecastShippedBucket(salesDeal, refs)).toBe('salesShippedThisMonth');
    expect((service as any).revenueForecastShippedBucket(repeatDeal, refs)).toBe('repeatShippedThisMonth');
    expect((service as any).revenueForecastShippingBucket(salesDeal, refs, true)).toBe('salesShippingThisMonth');
    expect((service as any).revenueForecastShippingBucket(repeatDeal, refs, true)).toBe('repeatShippingThisMonth');
  });

  it('calculates stage success probability from the last 30 days', async () => {
    const now = new Date('2026-07-08T12:00:00.000Z');
    const pipelineId = 'pipeline-sales';
    const stageId = 'stage-kp-30d';
    const successStageId = 'stage-paid-30d';
    const lossStageId = 'stage-lost-30d';
    const managerId = 'manager-30d';
    const stageEntries = Array.from({ length: 10 }, (_, index) => ({
      dealId: `deal-30d-${index}`,
      toStageId: stageId,
      movedAt: new Date(`2026-06-${18 + index}T10:00:00.000Z`),
      deal: { pipelineId, responsibleId: managerId },
    }));
    const successEntries = stageEntries.slice(0, 4).map((entry, index) => ({
      dealId: entry.dealId,
      fromStageId: stageId,
      toStageId: successStageId,
      movedAt: new Date(`2026-06-${20 + index}T10:00:00.000Z`),
      deal: { pipelineId, responsibleId: managerId },
    }));
    const lossEntries = stageEntries.slice(4).map((entry, index) => ({
      dealId: entry.dealId,
      fromStageId: stageId,
      toStageId: lossStageId,
      movedAt: new Date(`2026-06-${24 + index}T10:00:00.000Z`),
      deal: { pipelineId, responsibleId: managerId },
    }));
    const outOfWindowEntry = {
      dealId: 'deal-old',
      toStageId: stageId,
      movedAt: new Date('2026-05-20T10:00:00.000Z'),
      deal: { pipelineId, responsibleId: managerId },
    };
    const db = {
      pipelineStage: {
        findMany: jest.fn().mockResolvedValue([
          { id: stageId, pipelineId, name: 'KP', isLost: false, pipeline: { name: 'Sales' } },
          { id: successStageId, pipelineId, name: 'Paid', isLost: false, pipeline: { name: 'Sales' } },
          { id: lossStageId, pipelineId, name: 'Lost', isLost: true, pipeline: { name: 'Sales' } },
        ]),
      },
      dealStageHistory: {
        findMany: jest.fn()
          .mockResolvedValueOnce([...successEntries, ...lossEntries])
          .mockResolvedValueOnce([...stageEntries, ...successEntries, ...lossEntries, outOfWindowEntry]),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const model = await (localService as any).computeStageSuccessProbabilityModel({
      pipelineIds: [pipelineId],
      stageIds: [stageId],
      successStageByPipelineId: { [pipelineId]: successStageId },
      defaultProbability: 0.3,
      now,
    });

    const probability = model.probability(stageId, managerId);
    expect(db.dealStageHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        movedAt: {
          gte: new Date('2026-06-08T12:00:00.000Z'),
          lte: now,
        },
        deal: { deletedAt: null },
      }),
    }));
    expect(probability).toMatchObject({
      source: 'personal',
      personalSample: 10,
      personalWins: 4,
    });
    expect(probability.probability).toBeCloseTo(0.4, 6);
  });

  it('uses historical sales stages even when a won deal is no longer in the sales pipeline', async () => {
    const now = new Date('2026-07-08T12:00:00.000Z');
    const salesPipelineId = 'pipeline-sales';
    const currentPipelineId = 'pipeline-assembly';
    const stageId = 'stage-kp-sales';
    const successStageId = 'stage-won-sales';
    const managerId = 'manager-sales';
    const stageEntries = Array.from({ length: 10 }, (_, index) => ({
      dealId: `deal-moved-${index}`,
      toStageId: stageId,
      movedAt: new Date(`2026-06-${18 + index}T10:00:00.000Z`),
      deal: { pipelineId: currentPipelineId, responsibleId: managerId },
    }));
    const successEntries = stageEntries.slice(0, 6).map((entry, index) => ({
      dealId: entry.dealId,
      toStageId: successStageId,
      movedAt: new Date(`2026-06-${20 + index}T10:00:00.000Z`),
      deal: { pipelineId: currentPipelineId, responsibleId: managerId },
    }));
    const db = {
      pipelineStage: {
        findMany: jest.fn().mockResolvedValue([
          { id: stageId, pipelineId: salesPipelineId },
          { id: successStageId, pipelineId: salesPipelineId },
        ]),
      },
      dealStageHistory: {
        findMany: jest.fn().mockResolvedValue([...stageEntries, ...successEntries]),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const model = await (localService as any).computeStageSuccessProbabilityModel({
      pipelineIds: [salesPipelineId],
      stageIds: [stageId],
      successStageIdsByPipelineId: { [salesPipelineId]: [successStageId] },
      defaultProbability: 0.3,
      now,
    });

    const probability = model.probability(stageId, managerId);
    expect(db.dealStageHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        deal: { deletedAt: null },
      }),
    }));
    expect(probability).toMatchObject({
      source: 'personal',
      personalSample: 10,
      personalWins: 6,
    });
    expect(probability.probability).toBeCloseTo(0.6, 6);
  });

  it('counts CSM success across sibling repeat-sale pipelines', async () => {
    const now = new Date('2026-07-08T12:00:00.000Z');
    const basePipelineId = 'pipeline-base';
    const assignedPipelineId = 'pipeline-assigned';
    const offerStageId = 'stage-base-offer';
    const assignedSuccessStageId = 'stage-assigned-paid';
    const managerId = 'manager-csm';
    const stageEntries = Array.from({ length: 10 }, (_, index) => ({
      dealId: `deal-csm-${index}`,
      toStageId: offerStageId,
      movedAt: new Date(`2026-06-${18 + index}T10:00:00.000Z`),
      deal: { pipelineId: assignedPipelineId, responsibleId: managerId },
    }));
    const successEntries = stageEntries.slice(0, 7).map((entry, index) => ({
      dealId: entry.dealId,
      toStageId: assignedSuccessStageId,
      movedAt: new Date(`2026-06-${20 + index}T10:00:00.000Z`),
      deal: { pipelineId: assignedPipelineId, responsibleId: managerId },
    }));
    const db = {
      pipelineStage: {
        findMany: jest.fn().mockResolvedValue([
          { id: offerStageId, pipelineId: basePipelineId },
          { id: assignedSuccessStageId, pipelineId: assignedPipelineId },
        ]),
      },
      dealStageHistory: {
        findMany: jest.fn().mockResolvedValue([...stageEntries, ...successEntries]),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const model = await (localService as any).computeStageSuccessProbabilityModel({
      pipelineIds: [basePipelineId],
      stageIds: [offerStageId],
      successStageIdsByPipelineId: { [basePipelineId]: [assignedSuccessStageId] },
      defaultProbability: 0.3,
      now,
    });

    const probability = model.probability(offerStageId, managerId);
    expect(probability).toMatchObject({
      source: 'personal',
      personalSample: 10,
      personalWins: 7,
    });
    expect(probability.probability).toBeCloseTo(0.7, 6);
  });

  it('merges sibling CSM stages into one metric-level probability sample', async () => {
    const now = new Date('2026-07-08T12:00:00.000Z');
    const basePipelineId = 'pipeline-base';
    const assignedPipelineId = 'pipeline-assigned';
    const baseOfferStageId = 'stage-base-offer';
    const assignedOfferStageId = 'stage-assigned-offer';
    const baseSuccessStageId = 'stage-base-paid';
    const managerId = 'manager-csm';
    const stageEntries = Array.from({ length: 10 }, (_, index) => ({
      dealId: `deal-csm-merged-${index}`,
      toStageId: baseOfferStageId,
      movedAt: new Date(`2026-06-${18 + index}T10:00:00.000Z`),
      deal: { pipelineId: assignedPipelineId, responsibleId: managerId },
    }));
    const duplicateSiblingStageEntry = {
      dealId: 'deal-csm-merged-0',
      toStageId: assignedOfferStageId,
      movedAt: new Date('2026-06-19T10:00:00.000Z'),
      deal: { pipelineId: assignedPipelineId, responsibleId: managerId },
    };
    const successEntries = stageEntries.slice(0, 6).map((entry, index) => ({
      dealId: entry.dealId,
      toStageId: baseSuccessStageId,
      movedAt: new Date(`2026-06-${20 + index}T10:00:00.000Z`),
      deal: { pipelineId: assignedPipelineId, responsibleId: managerId },
    }));
    const db = {
      pipelineStage: {
        findMany: jest.fn().mockResolvedValue([
          { id: baseOfferStageId, pipelineId: basePipelineId },
          { id: assignedOfferStageId, pipelineId: assignedPipelineId },
          { id: baseSuccessStageId, pipelineId: basePipelineId },
        ]),
      },
      dealStageHistory: {
        findMany: jest.fn().mockResolvedValue([...stageEntries, duplicateSiblingStageEntry, ...successEntries]),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const model = await (localService as any).computeStageSuccessProbabilityModel({
      pipelineIds: [basePipelineId, assignedPipelineId],
      stageIds: [baseOfferStageId, assignedOfferStageId],
      successStageIdsByPipelineId: {
        [basePipelineId]: [baseSuccessStageId],
        [assignedPipelineId]: [baseSuccessStageId],
      },
      groupStageIds: true,
      defaultProbability: 0.3,
      now,
    });

    const probability = model.probability(baseOfferStageId, managerId);
    expect(probability).toMatchObject({
      source: 'personal',
      personalSample: 10,
      personalWins: 6,
    });
    expect(probability.probability).toBeCloseTo(0.6, 6);
    expect(model.probability(assignedOfferStageId, managerId).probability).toBeCloseTo(0.6, 6);
  });

  it('uses terminal outcomes and treats Base free-base returns as losses', async () => {
    const now = new Date('2026-07-08T12:00:00.000Z');
    const basePipelineId = 'pipeline-base';
    const offerStageId = 'stage-base-offer';
    const successStageId = 'stage-base-paid';
    const freeBaseStageId = 'stage-free-base';
    const managerId = 'manager-csm';
    const successEntries = Array.from({ length: 6 }, (_, index) => ({
      dealId: `deal-paid-without-history-${index}`,
      fromStageId: null,
      toStageId: successStageId,
      movedAt: new Date(`2026-06-${18 + index}T10:00:00.000Z`),
      deal: { pipelineId: basePipelineId, responsibleId: managerId },
    }));
    const freeBaseEntries = Array.from({ length: 4 }, (_, index) => ({
      dealId: `deal-returned-free-base-${index}`,
      fromStageId: offerStageId,
      toStageId: freeBaseStageId,
      movedAt: new Date(`2026-06-${24 + index}T10:00:00.000Z`),
      deal: { pipelineId: basePipelineId, responsibleId: managerId },
    }));
    const historyEntries = [
      ...successEntries,
      ...freeBaseEntries.map((entry) => ({
        dealId: entry.dealId,
        fromStageId: null,
        toStageId: offerStageId,
        movedAt: new Date(entry.movedAt.getTime() - 60_000),
      })),
      ...freeBaseEntries,
    ];
    const db = {
      pipelineStage: {
        findMany: jest.fn().mockResolvedValue([
          { id: offerStageId, pipelineId: basePipelineId, name: 'сделано предложение', isLost: false, pipeline: { name: 'База' } },
          { id: successStageId, pipelineId: basePipelineId, name: 'Счет оплачен', isLost: false, pipeline: { name: 'База' } },
          { id: freeBaseStageId, pipelineId: basePipelineId, name: 'свободная база', isLost: false, pipeline: { name: 'База' } },
        ]),
      },
      dealStageHistory: {
        findMany: jest.fn()
          .mockResolvedValueOnce([...successEntries, ...freeBaseEntries])
          .mockResolvedValueOnce(historyEntries),
      },
    };
    const localService = new ReportsService(db as any, audit as any);

    const model = await (localService as any).computeStageSuccessProbabilityModel({
      pipelineIds: [basePipelineId],
      stageIds: [offerStageId],
      successStageIdsByPipelineId: { [basePipelineId]: [successStageId] },
      reachedStageIds: [offerStageId],
      inferSuccessAsReached: true,
      defaultProbability: 0.3,
      now,
    });

    const probability = model.probability(offerStageId, managerId);
    expect(probability).toMatchObject({
      source: 'personal',
      personalSample: 10,
      personalWins: 6,
    });
    expect(probability.probability).toBeCloseTo(0.6, 6);
  });

  it('counts only the first-ever transition into a selected stage', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: { dateFrom: '2026-02-01T00:00:00.000Z', dateTo: '2026-02-28T23:59:59.999Z' },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'none',
            metrics: [
              {
                id: 'kp',
                label: 'КП',
                type: 'stage_reached',
                stageIds: [stages.kp.id],
                measure: 'deal_count',
                display: 'number',
              },
            ],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.groupId === 'all');
    expect(row.metrics.kp).toMatchObject({ value: 0, dealCount: 0 });
  });

  it('computes deal cycle durations from stage entry to stage exit', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: {
          dateFrom: '2026-03-01T00:00:00.000Z',
          dateTo: '2026-03-31T23:59:59.999Z',
          pipelineIds: ['pipe-sales'],
          groupIds: ['group-1'],
        },
        config: { metric: 'deal_cycle' },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.managerId === managers.second.id);
    const previousPeriodCreatedRow = (result as any).rows.find((item: any) => item.managerId === managers.first.id);
    const qualified = row.stages.find((stage: any) => stage.stageId === stages.qualified.id);
    const kp = row.stages.find((stage: any) => stage.stageId === stages.kp.id);
    const qualifiedFromPreviousPeriodDeal = previousPeriodCreatedRow.stages.find((stage: any) => stage.stageId === stages.qualified.id);

    expect(result).toMatchObject({ type: 'dealCycle' });
    expect(qualified).toMatchObject({ avgDays: 1, sampleSize: 1 });
    expect(kp).toMatchObject({ avgDays: 2, sampleSize: 1 });
    expect(qualifiedFromPreviousPeriodDeal.sampleSize).toBe(1);
    expect(qualifiedFromPreviousPeriodDeal.avgDays).toBeCloseTo(13 / 24, 6);
    expect(previousPeriodCreatedRow.totalDeals).toBe(1);
    expect(row.lostCycle.sampleSize).toBe(1);
    expect(row.lostCycle.avgDays).toBeCloseTo(85 / 24, 6);
    expect((result as any).summary.lostCycle.sampleSize).toBe(1);
    expect((result as any).summary.lostCycle.avgDays).toBeCloseTo(85 / 24, 6);
    expect((result as any).summary.stageAverage.sampleSize).toBe(3);
    expect((result as any).summary.stageAverage.avgDays).toBeCloseTo((13 / 24 + 1 + 2) / 3, 6);
  });

  it('segments deals sent to lost by loss reason and sales manager', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: {
          dateFrom: '2026-03-01T00:00:00.000Z',
          dateTo: '2026-03-31T23:59:59.999Z',
          pipelineIds: ['pipe-sales'],
          groupIds: ['group-1'],
        },
        config: { metric: 'loss_reasons', display: 'table' },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    expect(result).toMatchObject({
      type: 'lossReasons',
      summary: { total: 1, values: { [managers.first.id]: 0, [managers.second.id]: 1 } },
    });
    expect((result as any).rows).toEqual([
      {
        reasonId: 'custom:дорого',
        reasonName: lossReasons.price.name,
        total: 1,
        totalPercent: 100,
        values: { [managers.first.id]: 0, [managers.second.id]: 1 },
        percentages: { [managers.first.id]: 0, [managers.second.id]: 100 },
      },
    ]);
    expect((result as any).tableRows).toEqual([
      {
        'Причина отказа': lossReasons.price.name,
        [managers.first.name]: '0 (0%)',
        [managers.second.name]: '1 (100%)',
        Всего: '1 (100%)',
      },
    ]);
  });

  it('computes assigned-stage speed from sales responsibility and manager task to stage exit', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: {
          dateFrom: '2026-03-01T00:00:00.000Z',
          dateTo: '2026-03-31T23:59:59.999Z',
          pipelineIds: ['pipe-sales'],
          groupIds: ['group-1'],
        },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'manager',
            metrics: [],
            durations: [
              {
                id: 'assigned_stage_speed',
                label: 'Среднее время до взятия',
                stageId: stages.qualified.id,
                onlyExited: true,
                startMode: 'sales_responsible_task',
              },
            ],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.groupId === managers.second.id);
    const emptyRow = (result as any).rows.find((item: any) => item.groupId === managers.first.id);

    expect(row.durations.assigned_stage_speed).toMatchObject({
      sampleSize: 1,
      samples: [
        {
          dealId: 'deal-5',
          dealTitle: 'Отказ',
          durationDays: 0.125,
        },
      ],
    });
    expect(row.durations.assigned_stage_speed.avgDays).toBeCloseTo(0.125, 6);
    expect(emptyRow.durations.assigned_stage_speed).toMatchObject({ avgDays: null, sampleSize: 0 });
  });

  it('keeps minute-level precision for assigned-stage speed averages', async () => {
    const result = await service.compute(
      {
        sourceType: 'EVENT' as any,
        filters: {
          dateFrom: '2026-04-01T00:00:00.000Z',
          dateTo: '2026-04-30T23:59:59.999Z',
          pipelineIds: ['pipe-sales'],
          groupIds: ['group-1'],
        },
        config: {
          metric: 'contract',
          contract: {
            groupBy: 'manager',
            metrics: [],
            durations: [
              {
                id: 'assigned_stage_speed',
                label: 'Среднее время до взятия',
                stageId: stages.qualified.id,
                onlyExited: true,
                startMode: 'sales_responsible_task',
              },
            ],
          },
        },
      } as any,
      { id: 'user-1', role: 'ADMIN' as any },
    );

    const row = (result as any).rows.find((item: any) => item.groupId === managers.first.id);
    const value = row.durations.assigned_stage_speed;

    expect(value.sampleSize).toBe(3);
    expect(value.avgDays).toBeCloseTo(20 / 3 / 60 / 24, 6);
    expect(value.samples.map((sample: any) => Math.round(sample.durationDays * 24 * 60))).toEqual([18, 1, 1]);
  });
});

function createPrismaMock() {
  const templates: any[] = [];
  const reportPipelines = [
    {
      id: 'pipe-sales',
      externalId: '1278508',
      name: 'Воронка Продажи',
      isArchived: false,
      stages: [
        { ...stages.qualified, externalId: '20959402', name: 'Назначен ответственный' },
        { ...stages.kp, externalId: '20959408', name: 'КП презентовано' },
        { id: 'stage-objections', externalId: '57732446', name: 'Есть возражения', pipelineId: 'pipe-sales', isWon: false, isLost: false },
        { ...stages.invoice, externalId: '20959411', name: 'Счет отправлен' },
        { ...stages.paid, externalId: '142', name: 'Счет оплачен' },
      ],
    },
    {
      id: 'pipe-assembly',
      externalId: '1278793',
      name: 'Воронка Сборка',
      isArchived: false,
      stages: [
        { id: 'stage-assembly', externalId: 'assembly-1', name: 'Сборка', pipelineId: 'pipe-assembly', isWon: false, isLost: false },
      ],
    },
  ];
  return {
    $transaction: jest.fn(function (this: any, callback: any) {
      return callback(this);
    }),
    $executeRawUnsafe: jest.fn(() => Promise.resolve(undefined)),
    $queryRaw: jest.fn(() => Promise.resolve([])),
    amoConnection: {
      findFirst: jest.fn(() => Promise.resolve(null)),
    },
    crmGroup: {
      findMany: jest.fn(() => Promise.resolve([{ id: 'group-sales', name: 'Sales' }])),
    },
    customFieldDefinition: {
      findMany: jest.fn(() => Promise.resolve([{ externalId: '809047', name: 'Маркетинг' }])),
    },
    pipeline: {
      findMany: jest.fn(() => Promise.resolve(reportPipelines)),
    },
    reportTemplate: {
      create: jest.fn(({ data }: any) => {
        const template = {
          id: `template-${templates.length + 1}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        templates.push(template);
        return Promise.resolve(template);
      }),
      update: jest.fn(({ where, data }: any) => {
        const index = templates.findIndex((template) => template.id === where.id);
        const template = { ...templates[index], ...data };
        templates[index] = template;
        return Promise.resolve(template);
      }),
      delete: jest.fn(({ where }: any) => {
        const index = templates.findIndex((template) => template.id === where.id);
        const [template] = templates.splice(index, 1);
        return Promise.resolve(template);
      }),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(templates.find((template) => template.id === where.id) ?? null)),
      findFirst: jest.fn(({ where }: any = {}) =>
        Promise.resolve(
          templates.find((template) => {
            if (where?.name && template.name !== where.name) return false;
            return true;
          }) ?? null,
        ),
      ),
      findMany: jest.fn(() => Promise.resolve(templates)),
    },
    deal: {
      findMany: jest.fn(({ where, select, include, orderBy, take }: any = {}) => {
        const rows = deals
          .filter((deal) => matchesDealWhere(deal, where ?? {}))
          .sort((a, b) => {
            if (!orderBy) return 0;
            return b.updatedAt.getTime() - a.updatedAt.getTime();
          })
          .slice(0, take ?? deals.length);

        return Promise.resolve(rows.map((deal) => {
          if (select) return selectShape(deal, select);
          return include ? deal : { id: deal.id, amount: deal.amount };
        }));
      }),
    },
    dealStageHistory: {
      findMany: jest.fn(({ where, distinct, select, include, orderBy }: any = {}) => {
        let rows = history.filter((entry) => matchesHistoryWhere(entry, where ?? {}));
        if (distinct?.includes('dealId')) {
          const seen = new Set<string>();
          rows = rows.filter((entry) => {
            if (seen.has(entry.dealId)) return false;
            seen.add(entry.dealId);
            return true;
          });
        }
        if (orderBy) {
          rows = [...rows].sort((a, b) => a.dealId.localeCompare(b.dealId) || a.movedAt.getTime() - b.movedAt.getTime());
        }
        return Promise.resolve(
          rows.map((entry) => {
            if (select) return pick(entry, Object.keys(select));
            if (include?.deal) return { ...entry, deal: deals.find((deal) => deal.id === entry.dealId)! };
            return entry;
          }),
        );
      }),
    },
    dealResponsibleHistory: {
      findMany: jest.fn(({ where, select, orderBy }: any = {}) => {
        let rows = responsibleHistory.filter((entry) => matchesResponsibleHistoryWhere(entry, where ?? {}));
        if (orderBy) rows = [...rows].sort((a, b) => a.dealId.localeCompare(b.dealId) || a.changedAt.getTime() - b.changedAt.getTime());
        return Promise.resolve(rows.map((entry) => (select ? selectShape(entry, select) : entry)));
      }),
    },
    task: {
      findMany: jest.fn(({ where, select, orderBy }: any = {}) => {
        let rows = tasks.filter((task) => matchesTaskWhere(task, where ?? {}));
        if (orderBy) rows = [...rows].sort((a, b) => a.dealId.localeCompare(b.dealId) || a.createdAt.getTime() - b.createdAt.getTime());
        return Promise.resolve(rows.map((task) => (select ? selectShape(task, select) : task)));
      }),
    },
    pipelineStage: {
      findMany: jest.fn(({ where, select }: any = {}) => {
        const rows = Object.values(stages).filter((stage) => matchesStageWhere(stage, where ?? {}));
        return Promise.resolve(rows.map((stage) => (select ? selectShape(stage, select) : stage)));
      }),
    },
    crmUser: {
      findMany: jest.fn(({ where, select }: any = {}) => {
        const rows = Object.values(managers).filter((manager) => matchesCrmUserWhere(manager, where ?? {}));
        return Promise.resolve(rows.map((manager) => (select ? selectShape(manager, select) : manager)));
      }),
    },
  };
}

function matchesCrmUserWhere(manager: (typeof managers)[keyof typeof managers], where: Where) {
  if (where.isActive !== undefined && manager.isActive !== where.isActive) return false;
  if (where.isVisible !== undefined && manager.isVisible !== where.isVisible) return false;
  if (where.groupId && !matchesValue(manager.groupId, where.groupId)) return false;
  if (where.id && !matchesValue(manager.id, where.id)) return false;
  return true;
}

function matchesResponsibleHistoryWhere(entry: (typeof responsibleHistory)[number], where: Where) {
  if (where.dealId && !matchesValue(entry.dealId, where.dealId)) return false;
  return true;
}

function matchesTaskWhere(task: (typeof tasks)[number], where: Where) {
  if (where.dealId && !matchesValue(task.dealId, where.dealId)) return false;
  if (where.responsibleId && !matchesValue(task.responsibleId, where.responsibleId)) return false;
  return true;
}

function matchesStageWhere(stage: (typeof stages)[keyof typeof stages], where: Where) {
  if (where.pipelineId && !matchesValue(stage.pipelineId, where.pipelineId)) return false;
  if (where.isVisible !== undefined && 'isVisible' in stage && stage.isVisible !== where.isVisible) return false;
  return true;
}

function matchesHistoryWhere(entry: (typeof history)[number], where: Where) {
  if (where.toStageId && !matchesValue(entry.toStageId, where.toStageId)) return false;
  if (where.fromStageId !== undefined && !matchesValue(entry.fromStageId, where.fromStageId)) return false;
  if (where.movedAt && !matchesDate(entry.movedAt, where.movedAt)) return false;
  if (where.NOT?.some((condition: Where) => matchesHistoryWhere(entry, condition))) return false;
  if (where.deal) {
    const deal = deals.find((item) => item.id === entry.dealId);
    if (!deal || !matchesDealWhere(deal, where.deal)) return false;
  }
  if (where.dealId && !matchesValue(entry.dealId, where.dealId)) return false;
  return true;
}

function matchesDealWhere(deal: (typeof deals)[number], where: Where) {
  if (where.deletedAt === null && deal.deletedAt !== null) return false;
  if (where.id && !matchesValue(deal.id, where.id)) return false;
  if (where.pipelineId && !matchesValue(deal.pipelineId, where.pipelineId)) return false;
  if (where.stageId && !matchesValue(deal.stageId, where.stageId)) return false;
  if (where.responsibleId && !matchesValue(deal.responsibleId, where.responsibleId)) return false;
  if (where.lossReasonId && !matchesValue(deal.lossReasonId, where.lossReasonId)) return false;
  if (where.createdAt && !matchesDate(deal.createdAt, where.createdAt)) return false;
  return true;
}

function matchesValue(value: unknown, filter: unknown) {
  if (filter && typeof filter === 'object' && 'in' in (filter as any)) return (filter as any).in.includes(value);
  if (filter && typeof filter === 'object' && 'notIn' in (filter as any)) return !(filter as any).notIn.includes(value);
  return value === filter;
}

function matchesDate(value: Date, range: { gte?: Date; lte?: Date }) {
  if (range.gte && value < range.gte) return false;
  if (range.lte && value > range.lte) return false;
  return true;
}

function pick<T extends Record<string, any>>(source: T, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function selectShape(source: Record<string, any>, select: Record<string, any>): Record<string, any> {
  return Object.fromEntries(
    Object.entries(select).map(([key, value]) => {
      if (value === true) return [key, source[key]];
      if (value && typeof value === 'object' && 'select' in value) {
        const nested = source[key];
        return [key, nested ? selectShape(nested, (value as any).select) : nested];
      }
      return [key, source[key]];
    }),
  );
}
