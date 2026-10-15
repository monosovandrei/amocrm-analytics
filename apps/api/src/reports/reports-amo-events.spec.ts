import { ReportsService } from './reports.service';

describe('amoCRM activity report semantics', () => {
  const sqlText = (value: any): string => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(sqlText).join('')
      : value?.strings ? value.strings.map((part: string, index: number) => part + sqlText(value.values[index])).join('') : '';
  function fixture() {
    const current = { id: 'current', name: 'Current owner', groupId: 'sales', isActive: true };
    const former = { id: 'former', name: 'Former employee', groupId: 'csm', isActive: false };
    const deal = {
      dealId: 'deal', dealExternalId: '123', title: 'Historical customer request', amount: 100,
      responsibleId: current.id, responsibleName: current.name, groupId: 'sales', groupName: 'Sales',
      pipelineId: 'sales-pipeline', stageId: 'paid', deletedAt: new Date('2026-10-10T12:00:00Z'),
      createdAt: new Date('2026-08-01T00:00:00Z'), updatedAt: new Date('2026-10-10T12:00:00Z'),
    };
    const db = {
      crmUser: { findMany: jest.fn(({ where }) => Promise.resolve([current, former].filter((u) => !where.isActive || u.isActive))) },
      pipelineStage: { findMany: jest.fn().mockResolvedValue([{ externalId: 'stage-external', pipeline: { externalId: 'pipeline-external' } }]) },
      factDealCurrent: { findMany: jest.fn().mockResolvedValue([deal]) },
      $queryRaw: jest.fn().mockResolvedValue([
        { occurrenceId: 'event-1', dealId: deal.dealId, occurredAt: new Date('2026-10-01T10:00:00Z'), responsibleId: former.id, responsibleName: former.name, groupId: 'csm', groupName: 'CSM' },
        { occurrenceId: 'event-2', dealId: deal.dealId, occurredAt: new Date('2026-10-02T10:00:00Z'), responsibleId: former.id, responsibleName: former.name, groupId: 'csm', groupName: 'CSM' },
      ]),
    };
    const service = new ReportsService(db as any, {} as any);
    return { db, service, deal };
  }

  it('keeps repeated monthly actions and the original executor after deletion, reassignment, or deactivation', async () => {
    const { db, service } = fixture();
    const result = await (service as any).computeDataContract({ dateFrom: '2026-10-01T00:00:00Z', dateTo: '2026-10-14T23:59:59Z' }, {
      groupBy: 'manager', metrics: [{ id: 'kp', label: 'КП', type: 'stage_reached', stageIds: ['quote'], stageEntryMode: 'amo_event', measure: 'deal_count' }],
    }, 'ADMIN');
    const former = result.rows.find((row: any) => row.groupId === 'former');
    const current = result.rows.find((row: any) => row.groupId === 'current');
    expect(former.metrics.kp.value).toBe(2);
    expect(current.metrics.kp.value).toBe(0);
    expect(former.metrics.kp.samples.map((s: any) => s.occurrenceId).sort()).toEqual(['event-1', 'event-2']);
    expect(db.factDealCurrent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { dealId: { in: ['deal'] } } }));
    expect(db.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    const sql = sqlText(db.$queryRaw.mock.calls[0]);
    expect(sql).not.toContain('deal."deleted_at" IS NULL');
    expect(sql).not.toContain('COALESCE(event_manager."id", deal."responsible_id")');
  });

  it('reports automation separately and uses the same action set for counts and amounts', async () => {
    const { db, service } = fixture();
    db.$queryRaw.mockResolvedValue([{ occurrenceId: 'automation-event', dealId: 'deal', occurredAt: new Date('2026-10-01T10:00:00Z'),
      responsibleId: 'amo-automation', responsibleName: 'Автоматизация amoCRM', groupId: null, groupName: null }]);
    const result = await (service as any).computeDataContract({}, { groupBy: 'manager', metrics: [
      { id: 'count', label: 'Счета', type: 'stage_reached', stageIds: ['invoice'], stageEntryMode: 'amo_event', measure: 'deal_count' },
      { id: 'amount', label: 'Сумма', type: 'stage_reached', stageIds: ['invoice'], stageEntryMode: 'amo_event', measure: 'field_sum' },
    ] }, 'ADMIN');
    const automation = result.rows.find((row: any) => row.groupId === 'amo-automation');
    expect(automation.metrics.count.value).toBe(1);
    expect(automation.metrics.amount.value).toBe(100);
    expect(result.rows.find((row: any) => row.groupId === 'current').metrics.count.value).toBe(0);
  });

  it('excludes system-created payments without silently assigning them to the current owner', async () => {
    const { db, service } = fixture();
    await (service as any).findDealsForContractMetric({ type: 'stage_reached', stageIds: ['paid'], stageEntryMode: 'amo_event', includeSystemStageEvents: false }, {}, 'ROP');
    const sql = sqlText(db.$queryRaw.mock.calls[0]);
    expect(sql).toContain('event."raw"->>\'created_by\' <> \'0\'');
    expect(db.crmUser.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { isVisible: true } }));
  });
});
