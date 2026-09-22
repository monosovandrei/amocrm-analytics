import path from 'node:path';
import { CrmControlService } from './crm-control.service';

const actor = { id: 'owner', email: 'owner@example.test', role: 'ADMIN' as const, businessRole: 'OWNER' as const };
const observedAt = new Date('2026-09-21T16:05:00Z');
const access = { role: 'OWNER', actorId: actor.id, actorName: 'Owner' };
const result = (ruleCode: string, status: string, observationId = 'one', extra: Record<string, unknown> = {}) => ({
  id: `${observationId}-${ruleCode}-${status}`, observationId, ruleCode, ruleName: ruleCode,
  status, message: status, case: null, ...extra,
});
const observation = (id: string, managerId: string | null, results: any[], department = 'sales') => ({
  id, runId: 'run', dealId: `deal-${id}`, dealExternalId: id, dealTitle: `Deal ${id}`, dealUrl: `https://crm.example/leads/detail/${id}`,
  managerId, managerName: managerId, department, groupId: 'team', groupName: 'Team', observedAt,
  results: results.map(item => ({ ...item, observationId: id })), evidence: [], snapshot: {}, snapshotHash: 'hash', counts: {},
});
function fixture(rows: any[]) {
  const prisma: any = {
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'owner', isActive: true, name: 'Owner', businessRole: 'OWNER' }) },
    crmControlObservation: { findMany: jest.fn().mockResolvedValue(rows) },
    crmControlAnalysisBatch: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const service = new CrmControlService(prisma, {} as any, {} as any);
  return { prisma, service };
}

describe('CRM control rule breakdown', () => {
  it('counts unique deals per rule, manager and department rather than duplicated bad tasks', async () => {
    const { service } = fixture([
      observation('1', 'A', [result('task_type', 'FAIL'), result('task_type', 'FAIL'), result('offer_budget', 'UNKNOWN')]),
      observation('2', 'A', [result('task_type', 'FAIL'), result('task_type', 'REVIEW')]),
      observation('3', 'B', [result('task_type', 'PASS'), result('offer_budget', 'UNKNOWN')]),
      observation('4', 'A', [result('task_type', 'FAIL')], 'csm'),
      observation('5', null, [result('task_type', 'REVIEW')]),
    ]);
    const summary = await (service as any).summary('run', access);
    expect(summary.counts.deals).toBe(5);
    expect(summary.counts.violations).toBe(4);
    expect(summary.ruleBreakdown.find((rule: any) => rule.ruleCode === 'task_type')).toEqual({
      ruleCode: 'task_type', ruleName: 'task_type', failedDeals: 3, reviewDeals: 2, unknownDeals: 0,
      byManager: [
        { managerId: 'A', department: 'sales', failedDeals: 2, reviewDeals: 1, unknownDeals: 0 },
        { managerId: 'B', department: 'sales', failedDeals: 0, reviewDeals: 0, unknownDeals: 0 },
        { managerId: 'A', department: 'csm', failedDeals: 1, reviewDeals: 0, unknownDeals: 0 },
        { managerId: null, department: 'sales', failedDeals: 0, reviewDeals: 1, unknownDeals: 0 },
      ],
    });
    expect(summary.ruleBreakdown.find((rule: any) => rule.ruleCode === 'offer_budget').unknownDeals).toBe(2);
  });

  it('uses the same temporal exemption projection in the breakdown and deal counts', async () => {
    const caseValue = { status: 'EXEMPTED', decisions: [{ action: 'EXEMPT', observationId: '1',
      createdAt: new Date('2026-09-22T12:00:00Z'), validUntil: new Date('2026-09-30T12:00:00Z') }] };
    const { service } = fixture([observation('1', 'A', [result('task_type', 'FAIL', '1', { case: caseValue })])]);
    const summary = await (service as any).summary('run', access);
    expect(summary.counts.failedDeals).toBe(0);
    expect(summary.ruleBreakdown[0].failedDeals).toBe(0);
    expect(summary.ruleBreakdown[0].byManager[0].failedDeals).toBe(0);
  });

  it('restricts summary rows to the calling manager or group', async () => {
    const { service, prisma } = fixture([]);
    await (service as any).summary('run', { ...access, role: 'MANAGER', managerId: 'mine' });
    expect(prisma.crmControlObservation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { runId: 'run', managerId: 'mine' } }));
    await (service as any).summary('run', { ...access, role: 'ROP', groupId: 'team' });
    expect(prisma.crmControlObservation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { runId: 'run', groupId: 'team' } }));
  });

  it('keeps decisions with equal timestamps consistent between summary and deal drilldown', async () => {
    const caseValue = { status: 'REVIEW', decisions: [
      { id: 'decision-z', action: 'VERIFY_PASS', observationId: '1', createdAt: observedAt, validUntil: null },
      { id: 'decision-a', action: 'VERIFY_FAIL', observationId: '1', createdAt: observedAt, validUntil: null },
    ] };
    const { service, prisma } = fixture([observation('1', 'A', [result('offer_budget', 'UNKNOWN', '1', { case: caseValue })])]);
    const summary = await (service as any).summary('run', access);
    expect(prisma.crmControlObservation.findMany.mock.calls[0][0].select.results.select.case.select.decisions.select.id).toBe(true);
    expect(summary.ruleBreakdown[0]).toMatchObject({ failedDeals: 0, reviewDeals: 0, unknownDeals: 0 });
    jest.spyOn(service, 'run').mockResolvedValue({} as any);
    const page = await service.deals(actor, 'run', { ruleCode: 'offer_budget', status: 'FAIL' });
    expect(page.items).toEqual([]);
  });
});

describe('CRM control breakdown with configured local analysis', () => {
  const keys = ['CRM_CONTROL_LOCAL_AI_ORIGIN', 'CRM_CONTROL_LOCAL_AI_MODEL', 'CRM_CONTROL_LOCAL_AI_MODEL_SHA256',
    'CRM_CONTROL_LOCAL_AI_CACHE_DIR', 'CRM_CONTROL_LOCAL_AI_TIMEOUT_MS'] as const;
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  beforeEach(() => {
    process.env.CRM_CONTROL_LOCAL_AI_ORIGIN = 'http://127.0.0.1:18080';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL = 'synthetic-breakdown-model';
    process.env.CRM_CONTROL_LOCAL_AI_MODEL_SHA256 = 'a'.repeat(64);
    process.env.CRM_CONTROL_LOCAL_AI_CACHE_DIR = path.resolve('tmp/synthetic-breakdown-cache');
    process.env.CRM_CONTROL_LOCAL_AI_TIMEOUT_MS = '120000';
  });
  afterEach(() => {
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  });

  it.each([
    [{ ...access, role: 'OWNER' }, {}, {}],
    [{ ...access, role: 'ROP', groupId: 'team' }, { groupId: 'team' }, { OR: [{ scopeRole: 'OWNER' }, { groupId: 'team' }] }],
    [{ ...access, role: 'MANAGER', managerId: 'mine' }, { managerId: 'mine' }, { OR: [{ scopeRole: 'OWNER' }, { managerId: 'mine' }] }],
  ])('reads only the preparation queue visible to %j when local analysis is configured', async (scope, rowScope, queueScope) => {
    const { service, prisma } = fixture([observation('1', 'mine', [result('offer_budget', 'UNKNOWN')])]);
    prisma.crmControlAnalysisBatch.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'batch' });
    const idle = await (service as any).summary('run', scope);
    expect(idle.analysis.preparing).toBe(false);
    expect(idle.counts.unknownDeals).toBe(1);
    const preparing = await (service as any).summary('run', scope);
    expect(preparing.analysis.preparing).toBe(true);
    expect(preparing.counts.unknownDeals).toBe(1); // Queue presence does not turn an unverified result into a checked one.
    expect(prisma.crmControlObservation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { runId: 'run', ...rowScope } }));
    expect(prisma.crmControlAnalysisBatch.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.crmControlAnalysisBatch.findFirst).toHaveBeenLastCalledWith({ where: {
      runId: 'run', status: { in: ['QUEUED', 'RUNNING'] }, ...queueScope,
    }, select: { id: true } });
  });

  it('does not read preparation batches when local analysis is disabled', async () => {
    delete process.env.CRM_CONTROL_LOCAL_AI_MODEL;
    const { service, prisma } = fixture([]);
    expect((await (service as any).summary('run', access)).analysis.preparing).toBe(false);
    expect(prisma.crmControlAnalysisBatch.findFirst).not.toHaveBeenCalled();
  });
});

describe('CRM control rule drilldown', () => {
  it('requires the selected rule itself to match the status, not a different failing rule on the deal', async () => {
    const { service, prisma } = fixture([
      observation('1', 'A', [result('task_type', 'FAIL'), result('task_type', 'FAIL')]),
      observation('2', 'A', [result('task_type', 'PASS'), result('task_count', 'FAIL')]),
      observation('3', 'A', [result('task_type', 'REVIEW')]),
    ]);
    jest.spyOn(service, 'run').mockResolvedValue({} as any);
    const page = await service.deals(actor, 'run', { ruleCode: 'task_type', status: 'FAIL', managerId: 'A', department: 'sales' });
    expect(page.items.map(row => row.id)).toEqual(['1']);
    expect(prisma.crmControlObservation.findMany.mock.calls[0][0].where.AND).toEqual(expect.arrayContaining([
      { runId: 'run' }, { managerId: 'A' }, { department: 'sales' }, { results: { some: { ruleCode: 'task_type' } } },
    ]));
  });

  it('returns all matching deals through pagination beyond the first 50 without duplication', async () => {
    const rows = Array.from({ length: 123 }, (_, index) => observation(String(index + 1).padStart(3, '0'), 'A', [result('task_type', 'FAIL')]));
    const { service, prisma } = fixture(rows);
    jest.spyOn(service, 'run').mockResolvedValue({} as any);
    prisma.crmControlObservation.findMany.mockImplementation(({ cursor, take }: any) => {
      const start = cursor ? rows.findIndex(row => row.id === cursor.id) + 1 : 0;
      return Promise.resolve(rows.slice(start, start + take));
    });
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.deals(actor, 'run', { ruleCode: 'task_type', status: 'FAIL', cursor });
      ids.push(...page.items.map(row => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(rows.map(row => row.id));
    expect(new Set(ids).size).toBe(123);
  });

  it('preserves access scope for the drilldown and rejects unknown rule filters', async () => {
    const { service, prisma } = fixture([]);
    jest.spyOn(service, 'run').mockResolvedValue({} as any);
    prisma.user.findUnique.mockResolvedValue({ id: 'owner', isActive: true, name: 'Manager', businessRole: 'MANAGER', crmUserId: 'mine' });
    await service.deals(actor, 'run', { ruleCode: 'task_type', status: 'UNKNOWN', managerId: 'other' });
    expect(prisma.crmControlObservation.findMany.mock.calls[0][0].where.AND).toEqual(expect.arrayContaining([{ managerId: 'mine' }, { managerId: 'other' }]));
    await expect(service.deals(actor, 'run', { ruleCode: 'unknown-rule' })).rejects.toThrow('Неверный тип проверки');
  });
});
