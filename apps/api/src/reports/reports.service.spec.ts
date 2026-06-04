import { ReportsService } from './reports.service';

type Where = Record<string, any>;

const stages = {
  lead: { id: 'stage-lead', name: 'Лид', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  qualified: { id: 'stage-qualified', name: 'Квалифицирован', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  kp: { id: 'stage-kp', name: 'КП отправлено', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  invoice: { id: 'stage-invoice', name: 'Счет выставлен', pipelineId: 'pipe-sales', isWon: false, isLost: false },
  paid: { id: 'stage-paid', name: 'Оплата', pipelineId: 'pipe-sales', isWon: true, isLost: false },
};

const managers = {
  first: { id: 'manager-1', name: 'Иван', groupId: 'group-1', isVisible: true, group: { id: 'group-1', name: 'Отдел А' } },
  second: { id: 'manager-2', name: 'Ольга', groupId: 'group-1', isVisible: true, group: { id: 'group-1', name: 'Отдел А' } },
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
    customFields: { sla: { value: 15 }, margin: { value: 300 }, source: { value: 'Принят' } },
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
    customFields: { sla: { value: 30 }, margin: { value: 500 }, source: { value: 'Принят' } },
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
    customFields: { sla: { value: 10 }, margin: { value: 1000 }, source: { value: 'Реклама' } },
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
    customFields: { sla: { value: 5 }, margin: { value: 2000 }, source: { value: 'Принят' } },
    createdAt: new Date('2026-02-01T10:00:00.000Z'),
    updatedAt: new Date('2026-02-02T10:00:00.000Z'),
    deletedAt: null,
  },
];

const history = [
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
];

describe('ReportsService data contract', () => {
  let service: ReportsService;

  beforeEach(() => {
    service = new ReportsService(createPrismaMock() as any);
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
    expect(row.durations.kpDuration).toMatchObject({ avgDays: 1.5, sampleSize: 2 });
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
});

function createPrismaMock() {
  return {
    deal: {
      findMany: jest.fn(({ where, include, orderBy, take }: any = {}) => {
        const rows = deals
          .filter((deal) => matchesDealWhere(deal, where ?? {}))
          .sort((a, b) => {
            if (!orderBy) return 0;
            return b.updatedAt.getTime() - a.updatedAt.getTime();
          })
          .slice(0, take ?? deals.length);

        return Promise.resolve(
          rows.map((deal) => (include ? deal : { id: deal.id, amount: deal.amount })),
        );
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
    crmUser: {
      findMany: jest.fn(() => Promise.resolve(Object.values(managers).map((manager) => ({ id: manager.id })))),
    },
  };
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
