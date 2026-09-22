import { CrmControlService } from './crm-control.service';
import { controlScheduleSlot, nextControlCaseState, observationCounts } from './crm-control.logic';
import { CrmControlRuleInput, CrmControlRuleResult, DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';
import { CRM_CONTROL_RULE_VERSION, evaluateCrmControlDeal } from './crm-control.rules';
import { CrmControlProposalSourceCollector, CrmControlProposalSources } from './crm-control-proposal-sources';

const actor = { id: 'actor', email: 'owner@example.test', role: 'ADMIN' as const, businessRole: 'OWNER' as const };
const result = (status: CrmControlRuleResult['status'], extra: Partial<CrmControlRuleResult> = {}): CrmControlRuleResult => ({
  ruleCode: 'task_count', ruleName: 'Количество задач', status, message: status, clauses: ['ОПНК 5'], ...extra,
});
const observedAt = new Date('2026-09-18T16:05:00Z');
const input = (): CrmControlRuleInput => ({
  deal: { id: 'amo:12', externalId: '12', title: 'Сделка', amount: 450, createdAt: new Date('2026-09-01T12:00:00Z'), pipelineId: 'pipeline', stageId: 'stage',
    responsibleId: 'manager', customFields: [], raw: { id: 12, price: 450 } },
  tasks: [], notes: [], observedAt, stageEnteredAt: null,
  sourceCompleteness: { deal: true, tasks: true, notes: true, stageHistory: false },
  scope: { department: 'sales', pipelineId: 'pipeline' }, config: { ...DEFAULT_CRM_CONTROL_CONFIG },
});

function memory() {
  const observations: any[] = [], cases: any[] = [], results: any[] = [], evidence: any[] = [];
  let next = 0;
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'lease' }]),
    crmControlObservation: {
      findUnique: jest.fn(({ where }) => observations.find((row) => row.runId === where.runId_dealId.runId && row.dealId === where.runId_dealId.dealId) ?? null),
      create: jest.fn(({ data }) => { const row = { id: `observation-${++next}`, ...data }; observations.push(row); return row; }),
    },
    crmControlCase: {
      findUnique: jest.fn(({ where }) => cases.find((row) => row.activeKey === where.activeKey) ?? null),
      upsert: jest.fn(({ where, create, update }) => {
        let row = cases.find((row) => row.activeKey === where.activeKey);
        if (row) Object.assign(row, update);
        else { row = { id: `case-${++next}`, ...create }; cases.push(row); }
        return row;
      }),
      update: jest.fn(({ where, data }) => { const row = cases.find((row) => row.id === where.id); Object.assign(row, data); return row; }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    crmControlResult: { create: jest.fn(({ data }) => { results.push({ ...data }); return data; }) },
    crmControlEvidence: { create: jest.fn(({ data }) => { evidence.push({ ...data }); return data; }) },
  };
  const prisma = { ...tx, $transaction: jest.fn((fn) => fn(tx)) };
  const service = new CrmControlService(prisma as any, {} as any, { capabilities: () => ({ screenshots: false, message: 'Не подключено' }) } as any);
  const persist = (runId: string, value: CrmControlRuleInput, rows: CrmControlRuleResult[]) => (service as any).persistObservation(runId, value, rows,
    { deal: value.deal, tasks: value.tasks, observedAt: value.observedAt },
    { pipelineName: 'Продажи', stageName: 'В работе', managerName: 'Менеджер', groupId: 'group', groupName: 'ОПНК', dealUrl: 'https://example.amocrm.ru/leads/detail/12' }, observedAt);
  return { service, tx, observations, cases, results, evidence, persist };
}

describe('CRM control immutable observations and case episodes', () => {
  it('fences a writer from an earlier attempt before creating an observation or changing a case', async () => {
    const fixture = memory();
    const latestAttempt = new Date(observedAt.getTime() + 1);
    fixture.tx.$queryRaw.mockImplementation(async (sql: TemplateStringsArray, ...values: unknown[]) => {
      if (sql.join('?').includes('"CrmControlRun"')) {
        expect(sql.join('?')).toContain('"startedAt" = ?');
        return values[values.length - 1] === latestAttempt ? [{ id: 'run' }] : [];
      }
      return [];
    });
    await expect(fixture.persist('run', input(), [result('FAIL')])).rejects.toThrow('Проверка больше не выполняется');
    expect(fixture.tx.crmControlObservation.create).not.toHaveBeenCalled();
    expect(fixture.tx.crmControlCase.upsert).not.toHaveBeenCalled();
  });

  it('keeps an unresolved violation in one episode across daily observations', async () => {
    const fixture = memory();
    await fixture.persist('day-1', input(), [result('FAIL')]);
    await fixture.persist('day-2', { ...input(), observedAt: new Date('2026-09-19T16:05:00Z') }, [result('FAIL')]);
    expect(fixture.cases).toHaveLength(1);
    expect(fixture.results[0].caseId).toBe(fixture.results[1].caseId);
    expect(fixture.cases[0].firstDetectedAt).toEqual(observedAt);
    expect(fixture.cases[0].resolvedAt).toBeNull();
  });

  it('does not overwrite a completed observation when a page is repeated', async () => {
    const fixture = memory();
    await fixture.persist('same-run', input(), [result('FAIL')]);
    const snapshot = JSON.stringify(fixture.observations[0]);
    await fixture.persist('same-run', { ...input(), notes: [] }, [result('PASS')]);
    expect(fixture.observations).toHaveLength(1);
    expect(fixture.results).toHaveLength(1);
    expect(JSON.stringify(fixture.observations[0])).toBe(snapshot);
    expect(fixture.observations[0].snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('starts a new episode after correction without reopening old history', async () => {
    const fixture = memory();
    await fixture.persist('first', input(), [result('FAIL')]);
    const firstId = fixture.cases[0].id;
    await fixture.persist('fixed', input(), [result('PASS')]);
    await fixture.persist('again', input(), [result('FAIL')]);
    expect(fixture.cases).toHaveLength(2);
    expect(fixture.cases[0]).toMatchObject({ id: firstId, status: 'RESOLVED', activeKey: null });
    expect(fixture.results[2].caseId).not.toBe(firstId);
    expect(fixture.results[0].status).toBe('FAIL');
  });

  it('does not resolve or accuse anyone when the source cannot be verified', async () => {
    const fixture = memory();
    await fixture.persist('first', input(), [result('FAIL')]);
    await fixture.persist('unknown', { ...input(), sourceCompleteness: { deal: false, tasks: false, notes: false, stageHistory: false } }, [result('UNKNOWN')]);
    expect(fixture.cases[0].status).toBe('OPEN');
    expect(fixture.tx.crmControlCase.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.evidence).toHaveLength(1);
    const clean = memory();
    await clean.persist('unavailable', input(), [result('UNKNOWN')]);
    expect(clean.cases).toHaveLength(0);
  });

  it('stores disabled screenshots honestly and never creates a fake file', async () => {
    const fixture = memory();
    await fixture.persist('first', input(), [result('FAIL')]);
    expect(fixture.evidence[0]).toMatchObject({ status: 'DISABLED', error: 'Не подключено' });
    expect(fixture.evidence[0].storageKey).toBeUndefined();
  });

  it('fences all writes when the run has lost its durable lease', async () => {
    const fixture = memory();
    fixture.tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(fixture.persist('expired', input(), [result('FAIL')])).rejects.toThrow('больше не выполняется');
    expect(fixture.tx.crmControlObservation.create).not.toHaveBeenCalled();
  });

  it('requires a fresh review after the facts behind a confirmation change', async () => {
    const fixture = memory();
    await fixture.persist('first', input(), [result('REVIEW', { ruleCode: 'task_text', subjectId: '1', details: { taskText: 'Позвонить' } })]);
    fixture.cases[0].confirmedAt = observedAt;
    fixture.cases[0].status = 'OPEN';
    await fixture.persist('changed', input(), [result('REVIEW', { ruleCode: 'task_text', subjectId: '1', details: { taskText: 'Согласовать спецификацию с клиентом' } })]);
    expect(fixture.cases).toHaveLength(2);
    expect(fixture.cases[0]).toMatchObject({ status: 'SUPERSEDED', activeKey: null });
    expect(fixture.cases[1].status).toBe('REVIEW');
    expect(fixture.cases[1].confirmedAt).toBeUndefined();
  });

  it('retires prior task-stage limits after an explicit unlimited policy even if current tasks cannot be read', async () => {
    const fixture = memory();
    const value = input();
    value.scope.stageRules = { stage: { deadlineMode: 'unlimited' } };
    value.sourceCompleteness.tasks = false;
    await fixture.persist('policy-change', value, evaluateCrmControlDeal(value));
    expect(fixture.tx.crmControlCase.updateMany).toHaveBeenCalledWith({
      where: { dealId: value.deal.id, ruleCode: 'task_stage_deadline', activeKey: { not: null } },
      data: { status: 'RESOLVED', activeKey: null, resolvedAt: observedAt, latestObservationId: fixture.observations[0].id },
    });
    expect(fixture.results.find((row) => row.ruleCode === 'task_deadline').status).toBe('UNKNOWN');
    expect(fixture.results.find((row) => row.ruleCode === 'task_stage_deadline').status).toBe('NA');
  });

  it('keeps an existing violation open when a stage is configured as absent', async () => {
    const fixture = memory();
    await fixture.persist('before', input(), [result('FAIL', { ruleCode: 'intake_stage' })]);
    const caseId = fixture.cases[0].id;
    const value = input();
    value.scope.assignedStageId = null;
    await fixture.persist('mapping-change', value, evaluateCrmControlDeal(value));
    expect(fixture.cases.find((item) => item.id === caseId).status).toBe('OPEN');
    expect(fixture.results[0].status).toBe('FAIL');
    expect(fixture.results.find((item) => item.observationId !== fixture.results[0].observationId && item.ruleCode === 'intake_stage').status).toBe('NA');
  });
});

describe('CRM control source coverage, access and scheduling', () => {
  it('uses the current business role from the database, not a legacy ADMIN role', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, name: 'Менеджер', isActive: true,
      businessRole: 'MANAGER', crmUserId: 'manager', crmUser: { groupId: 'group' } }) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    expect(await service.access(actor)).toMatchObject({ role: 'MANAGER', managerId: 'manager' });
    await expect(service.saveSettings(actor, DEFAULT_CRM_CONTROL_CONFIG)).rejects.toThrow('только владелец');
  });

  it('fails closed for an unbound manager or ROP without a CRM group', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, isActive: true, businessRole: 'MANAGER', crmUserId: null }) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    await expect(service.access(actor)).rejects.toThrow('свяжите');
    prisma.user.findUnique.mockResolvedValue({ id: actor.id, isActive: true, businessRole: 'ROP', crmUserId: 'manager', crmUser: { groupId: null } } as any);
    await expect(service.access(actor)).rejects.toThrow('группа');
  });

  it('checks observation access before reading a screenshot from storage', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, name: 'Менеджер', isActive: true, businessRole: 'MANAGER', crmUserId: 'my-manager' }) },
      crmControlEvidence: { findUnique: jest.fn().mockResolvedValue({ id: 'file', observationId: 'foreign', status: 'READY', storageKey: 'secret' }) },
      crmControlObservation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { read: jest.fn() };
    const service = new CrmControlService(prisma as any, {} as any, storage as any);
    await expect(service.evidenceFile(actor, 'file')).rejects.toThrow('не найдена');
    expect(prisma.crmControlObservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign', managerId: 'my-manager' } }));
    expect(storage.read).not.toHaveBeenCalled();
  });

  it('uses Moscow workdays and never starts before the configured evening time', () => {
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, enabled: true };
    expect(controlScheduleSlot(new Date('2026-09-18T16:04:59Z'), config)).toBeNull();
    expect(controlScheduleSlot(new Date('2026-09-18T16:05:00Z'), config)).toBe('2026-09-18');
    expect(controlScheduleSlot(new Date('2026-09-19T16:05:00Z'), config)).toBeNull();
    expect(controlScheduleSlot(new Date('2026-09-18T16:05:00Z'), { ...config, enabled: false })).toBeNull();
  });

  it('records the new rule version for both manual and scheduled runs', async () => {
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, enabled: true, scopes: [{ department: 'sales', pipelineId: 'pipeline' }] };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, name: 'Владелец', isActive: true, businessRole: 'OWNER' }) },
      crmControlSettings: { findUnique: jest.fn().mockResolvedValue({ version: 7, config }) },
      crmControlRun: { upsert: jest.fn(async ({ create }) => ({ id: 'new-run', ...create })) },
    };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    const run = await service.enqueue(actor);
    expect(run.ruleVersion).toBe(CRM_CONTROL_RULE_VERSION);
    await service.schedule(observedAt);
    expect(prisma.crmControlRun.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      create: expect.objectContaining({ ruleVersion: CRM_CONTROL_RULE_VERSION, configVersion: 7 }),
    }));
  });

  it('does not execute another run while a durable global lease is held', async () => {
    const prisma = { crmControlRun: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 0 }), count: jest.fn().mockResolvedValue(1), findFirst: jest.fn() } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    await service.processQueue();
    expect(prisma.crmControlRun.findFirst).not.toHaveBeenCalled();
  });

  it('keeps confirmation on unchanged facts and does not resolve UNKNOWN or bare NA', () => {
    const previous = { status: 'OPEN', confirmedAt: observedAt };
    expect(nextControlCaseState(previous, result('REVIEW'), observedAt)).toBe('OPEN');
    expect(nextControlCaseState(previous, result('UNKNOWN'), observedAt)).toBeNull();
    expect(nextControlCaseState(previous, result('NA'), observedAt)).toBeNull();
    expect(nextControlCaseState(previous, result('NA', { details: { resolvesPrior: true } }), observedAt)).toBe('RESOLVED');
  });

  it('separates counts of deals from counts of rule results and exposes incomplete coverage', () => {
    const counts = observationCounts([result('FAIL'), result('FAIL'), result('UNKNOWN'), result('REVIEW')]);
    expect(counts).toMatchObject({ deals: 1, failedDeals: 1, violations: 2, unknownDeals: 1, reviewDeals: 1, checkedDeals: 0 });
  });

  it('keeps an accepted historical exception after its term expires', () => {
    const service = new CrmControlService({} as any, {} as any, {} as any);
    const item = { status: 'REVIEW', observationId: 'day-1', case: { status: 'REVIEW', confirmedAt: null, decisions: [
      { observationId: 'day-1', action: 'EXEMPT', createdAt: new Date('2026-09-18T17:00:00Z'), validUntil: new Date('2026-09-19T18:00:00Z') },
    ] } };
    expect((service as any).effectiveStatus(item, observedAt)).toBe('NA');
    expect((service as any).effectiveStatus({ ...item, observationId: 'day-3' }, new Date('2026-09-20T16:05:00Z'))).toBe('REVIEW');
    expect((service as any).effectiveStatus(item, observedAt)).toBe('NA');
  });

  it('projects a later exemption over confirmation without changing raw results', () => {
    const service = new CrmControlService({} as any, {} as any, {} as any);
    const item = { status: 'REVIEW', observationId: 'day-1', case: { status: 'EXEMPTED', confirmedAt: observedAt, decisions: [
      { observationId: 'day-1', action: 'CONFIRM', createdAt: new Date('2026-09-18T16:10:00Z'), validUntil: null },
      { observationId: 'day-1', action: 'EXEMPT', createdAt: new Date('2026-09-18T17:00:00Z'), validUntil: new Date('2026-09-19T18:00:00Z') },
      { observationId: 'day-3', action: 'CONFIRM', createdAt: new Date('2026-09-20T16:10:00Z'), validUntil: null },
    ] } };
    expect((service as any).effectiveStatus(item, observedAt)).toBe('NA');
    expect((service as any).effectiveStatus({ ...item, observationId: 'day-3' }, new Date('2026-09-20T16:05:00Z'))).toBe('FAIL');
    expect(item.status).toBe('REVIEW');
  });

  it('returns a validation error for null scopes or rules rather than throwing a server error', async () => {
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([{ id: 'pipeline', stages: [{ id: 'stage' }] }]) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    await expect((service as any).validateConfig({ ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [null] })).rejects.toMatchObject({ status: 400 });
    await expect((service as any).validateConfig({ ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: null } }] })).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    { deadlineMode: 'business_days', maxBusinessDays: 0 },
    { deadlineMode: 'business_days', maxBusinessDays: 1.5 },
    { deadlineMode: 'business_days', maxBusinessDays: 3651 },
    { deadlineMode: 'business_days', maxBusinessDays: '3' },
    { deadlineMode: 'business_days' },
    { deadlineMode: 'business_days', maxBusinessDays: 1, maxDurationHours: 24 },
    { deadlineMode: 'elapsed' },
    { deadlineMode: 'elapsed', maxDurationHours: 24, maxBusinessDays: 1 },
    { maxBusinessDays: 3 },
    { deadlineMode: 'end_of_day', maxDurationHours: 24 },
    { deadlineMode: 'unlimited', maxBusinessDays: 1 },
    { deadlineMode: 'unknown' },
  ])('rejects invalid or conflicting stage deadline settings: %j', async (rule) => {
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([{ id: 'pipeline', stages: [{ id: 'stage' }] }]) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    await expect((service as any).validateConfig({ ...DEFAULT_CRM_CONTROL_CONFIG,
      scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: rule } }] })).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    {}, { maxDurationHours: 24 }, { deadlineMode: 'elapsed', maxDurationHours: 0.5 },
    { deadlineMode: 'business_days', maxBusinessDays: 3650 }, { deadlineMode: 'end_of_day' }, { deadlineMode: 'unlimited' },
  ])('preserves supported stage deadline settings and per-scope age policy: %j', async (rule) => {
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([{ id: 'pipeline', stages: [{ id: 'stage' }] }]) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG,
      scopes: [{ pipelineId: 'pipeline', department: 'sales', checkDealAge: false, stageRules: { stage: rule } }] };
    await expect((service as any).validateConfig(config)).resolves.toEqual(config);
    await expect((service as any).validateConfig({ ...config, scopes: [{ ...config.scopes[0], checkDealAge: 'false' }] })).rejects.toMatchObject({ status: 400 });
  });

  it('recognizes configured calendar and unlimited deadlines as complete settings', () => {
    const service = new CrmControlService({} as any, {} as any, {} as any);
    for (const rule of [{ deadlineMode: 'business_days', maxBusinessDays: 1 }, { deadlineMode: 'end_of_day' }, { deadlineMode: 'unlimited' }]) {
      const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: rule } }] };
      const issues = (service as any).configurationIssues(config, [{ id: 'pipeline', name: 'Продажи', stages: [{ id: 'stage' }] }]);
      expect(issues).not.toContain('Продажи: сроки для части этапов не настроены.');
    }
  });

  it('accepts explicit absent stage mappings without warnings while rejecting nonexistent IDs', async () => {
    const pipeline = { id: 'pipeline', name: 'Закреплённые компании', stages: [{ id: 'stage' }] };
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([pipeline]) } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    const scope = { pipelineId: 'pipeline', department: 'csm', assignedStageId: null, newClientStageId: null,
      baseStageId: null, preparedProposalStageId: null, priceRequestedStageId: null, stageRules: { stage: { deadlineMode: 'unlimited' } } };
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [scope] };
    await expect((service as any).validateConfig(config)).resolves.toEqual(config);
    expect((service as any).configurationIssues(config, [pipeline]).some((issue: string) => issue.includes('не настроен этап'))).toBe(false);
    const unconfigured = { ...config, scopes: [{ ...scope, newClientStageId: undefined }] };
    expect((service as any).configurationIssues(unconfigured, [pipeline])).toContain('Закреплённые компании: не настроен этап «Новый клиент».');
    await expect((service as any).validateConfig({ ...config, scopes: [{ ...scope, newClientStageId: 'missing' }] })).rejects.toMatchObject({ status: 400 });
  });

  it('excludes three unsorted buckets from completeness warnings without losing the 25 working stages', () => {
    const pipelines = [8, 9, 8].map((count, index) => ({ id: `pipeline-${index}`, name: `Воронка ${index}`, stages: [
      { id: `unsorted-${index}`, isWon: false, isLost: false, raw: { type: 1 } },
      ...Array.from({ length: count }, (_, stage) => ({ id: `stage-${index}-${stage}`, isWon: false, isLost: false, raw: { type: 0 } })),
    ] }));
    const scopes = pipelines.map((pipeline, index) => ({ pipelineId: pipeline.id, department: index === 0 ? 'sales' : 'csm',
      assignedStageId: null, newClientStageId: null, baseStageId: null, preparedProposalStageId: null, priceRequestedStageId: null,
      stageRules: Object.fromEntries(pipeline.stages.slice(1).map((stage, stageIndex) => [stage.id, {
        deadlineMode: 'business_days', maxBusinessDays: 1, ...(index < 2 && stageIndex === 0 ? {} : { allowedTaskTypeIds: [1] }),
      }])),
    }));
    const service = new CrmControlService({} as any, {} as any, {} as any);
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes };
    // Previous open-stage filtering treated all 3 buckets as missing task types + deadlines.
    const previousOpenWarnings = pipelines.flatMap((pipeline, index) => [
      pipeline.stages.some((stage) => !scopes[index].stageRules[stage.id]?.allowedTaskTypeIds?.length),
      pipeline.stages.some((stage) => !scopes[index].stageRules[stage.id]?.maxBusinessDays),
    ]).filter(Boolean);
    expect(previousOpenWarnings).toHaveLength(6);
    expect(scopes.reduce((count, scope) => count + Object.keys(scope.stageRules).length, 0)).toBe(25);
    expect((service as any).configurationIssues(config, pipelines)).toEqual([
      'Воронка 0: типы задач для части этапов не настроены.', 'Воронка 1: типы задач для части этапов не настроены.',
    ]);
  });

  it('rejects bindings and norms on unsorted or terminal stages and flags existing invalid configuration', async () => {
    const pipeline = { id: 'pipeline', name: 'Продажи', stages: [
      { id: 'working', raw: { type: 0 } }, { id: 'unsorted', raw: { type: 1 } },
      { id: 'won', isWon: true }, { id: 'lost', isLost: true },
    ] };
    const service = new CrmControlService({ pipeline: { findMany: jest.fn().mockResolvedValue([pipeline]) } } as any, {} as any, {} as any);
    for (const stageId of ['unsorted', 'won', 'lost']) {
      const scope = { pipelineId: 'pipeline', department: 'sales', assignedStageId: stageId };
      await expect((service as any).validateConfig({ ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [scope] })).rejects.toMatchObject({ status: 400 });
      const ruleScope = { ...scope, assignedStageId: null, stageRules: { [stageId]: { deadlineMode: 'unlimited' } } };
      await expect((service as any).validateConfig({ ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [ruleScope] })).rejects.toMatchObject({ status: 400 });
      expect((service as any).configurationIssues({ ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [ruleScope] }, [pipeline])).toContain('Продажи: нормативы заданы для этапов вне проверки.');
    }
  });
});

describe('CRM control direct source reads', () => {
  afterEach(() => jest.restoreAllMocks());

  function sourceFixture(total = 1) {
    const pipeline = { id: 'pipeline', externalId: '100', name: 'Продажи', stages: [
      { id: 'stage', externalId: '200', name: 'Назначен ответственный', isWon: false, isLost: false },
      { id: 'unsorted', externalId: '199', name: 'Неразобранное', isWon: false, isLost: false, raw: { type: 1 } },
      { id: 'won', externalId: '201', name: 'Успешно', isWon: true, isLost: false },
    ] };
    const leads = Array.from({ length: total }, (_, index) => ({ id: index + 1, name: `Сделка ${index + 1}`, pipeline_id: 100, status_id: 200,
      responsible_user_id: 300, updated_at: 1700000000, created_at: 1700000000, price: 450 }));
    const readLead = jest.fn<Promise<any>, [number]>(async (id) => leads[id - 1]);
    const client = { domain: 'example.amocrm.ru', get: jest.fn(async (path: string) => {
      if (path === '/account') return { id: 1, drive_url: 'https://drive.amocrm.ru' };
      if (/^\/leads\/\d+$/.test(path)) return readLead(Number(path.split('/').pop()));
      throw new Error(`Unexpected test source path: ${path}`);
    }),
      paginate: jest.fn(async () => []),
      paginateBatch: jest.fn(async (_path, _key, _params, callback) => {
        for (let offset = 0; offset < leads.length; offset += 250) await callback(leads.slice(offset, offset + 250));
      }),
    };
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([pipeline]) },
      crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'manager', externalId: '300', name: 'Менеджер', groupId: 'group', group: { name: 'ОПНК' } }]) },
      crmControlRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      crmControlObservation: { findMany: jest.fn().mockResolvedValue([]) },
      crmControlCase: { findMany: jest.fn().mockResolvedValue([]) },
      rawAmoEventInbox: { findMany: jest.fn().mockResolvedValue([]) },
      customFieldDefinition: { findMany: jest.fn().mockResolvedValue([{ externalId: '900', name: 'КП' }]) },
    };
    const service = new CrmControlService(prisma as any, { getActiveConnectionOrFail: jest.fn().mockResolvedValue({ id: 'connection', config: {} }),
      getClient: jest.fn().mockResolvedValue(client) } as any, {} as any);
    const persist = jest.spyOn(service as any, 'persistObservation').mockResolvedValue({});
    const run = { id: 'run', startedAt: new Date(), scheduledFor: new Date(), config: { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', assignedStageId: 'stage' }] } };
    return { client, readLead, prisma, service, persist, run, leads };
  }

  function addMessageSource(fixture: ReturnType<typeof sourceFixture>) {
    const receivedAt = new Date(Date.now() - 1000);
    const message = { id: 'inbox-1', connectionId: 'connection', entity: 'outgoing_message', action: 'add', receivedAt,
      payload: { id: 'message-1', created_at: Math.floor(receivedAt.getTime() / 1000) - 1, type: 'outgoing', text: 'Предложение во вложении.',
        author: { id: 'sender', user_id: '300', type: 'internal' }, recipient: { id: 'customer', type: 'external' },
        entity_type: 'lead', entity_id: '1', element_type: 2, element_id: '1' } };
    fixture.prisma.rawAmoEventInbox.findMany.mockResolvedValue([message]);
    return message;
  }

  function archivedProposal(): CrmControlProposalSources {
    return { fieldId: '900', fieldReadComplete: true, fieldFiles: [], sentHistoryComplete: false, problems: [],
      sentAttachments: [{ messageId: 'message-1', sentAt: new Date().toISOString(), name: 'test-proposal.pdf',
        artifact: { sha256: 'a'.repeat(64), size: 100, storageKey: `${'a'.repeat(64)}.bin`, contentType: 'application/pdf', capturedAt: new Date().toISOString() } }] };
  }

  it('collects and archives proposal sources before the final card read while retaining unverified communication coverage', async () => {
    const fixture = sourceFixture();
    addMessageSource(fixture);
    const events: string[] = [];
    fixture.readLead.mockImplementation(async () => { events.push(events.includes('initial') ? 'final' : 'initial'); return fixture.leads[0]; });
    const archive = archivedProposal();
    const collect = jest.spyOn(CrmControlProposalSourceCollector.prototype, 'collect').mockImplementation(async () => {
      events.push('collect'); return archive;
    });
    fixture.persist.mockImplementation(async () => { events.push('persist'); return {}; });
    await (fixture.service as any).executeRun(fixture.run);
    expect(events).toEqual(['initial', 'collect', 'final', 'persist']);
    expect(collect).toHaveBeenCalledWith([], '900', [expect.objectContaining({ message: expect.objectContaining({ messageId: 'message-1' }) })]);
    expect(fixture.prisma.rawAmoEventInbox.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ connectionId: 'connection', entity: { in: ['message', 'outgoing_message'] } }),
    }));
    const input = fixture.persist.mock.calls[0][1] as CrmControlRuleInput;
    const snapshot = fixture.persist.mock.calls[0][3] as any;
    expect(input.communications).toEqual([expect.objectContaining({ id: 'message-1', type: 'outgoing', text: 'Предложение во вложении.' })]);
    expect(input.sourceCompleteness.communications).toBe(false);
    expect(snapshot.proposalSources).toEqual(archive);
    expect(snapshot.communicationSources).toMatchObject({ datasetReadComplete: true, sourceCoverage: 'UNVERIFIED',
      messages: [expect.objectContaining({ message: expect.objectContaining({ messageId: 'message-1', rawSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) })] });
    expect(snapshot.sourceReadFinishedAt.getTime()).toBeGreaterThanOrEqual(snapshot.sourceReadStartedAt.getTime());
  });

  it('never attaches collected documents or message sources to the former owner after a transfer', async () => {
    const fixture = sourceFixture();
    addMessageSource(fixture);
    const collect = jest.spyOn(CrmControlProposalSourceCollector.prototype, 'collect').mockResolvedValue(archivedProposal());
    fixture.readLead.mockResolvedValueOnce(fixture.leads[0]).mockResolvedValueOnce({ ...fixture.leads[0], responsible_user_id: 999 });
    await (fixture.service as any).executeRun(fixture.run);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.prisma.crmControlRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PARTIAL' }) }));
  });

  it('omits collected documents and messages when the final ownership read is unavailable', async () => {
    const fixture = sourceFixture();
    addMessageSource(fixture);
    jest.spyOn(CrmControlProposalSourceCollector.prototype, 'collect').mockResolvedValue(archivedProposal());
    fixture.readLead.mockResolvedValueOnce(fixture.leads[0]).mockRejectedValueOnce(new Error('source unavailable'));
    await (fixture.service as any).executeRun(fixture.run);
    const input = fixture.persist.mock.calls[0][1] as CrmControlRuleInput;
    const results = fixture.persist.mock.calls[0][2] as CrmControlRuleResult[];
    const snapshot = fixture.persist.mock.calls[0][3] as any;
    expect(input.communications).toEqual([]);
    expect(input.sourceCompleteness.deal).toBe(false);
    expect(input.sourceCompleteness.communications).toBe(false);
    expect(results.every((result) => result.status === 'UNKNOWN')).toBe(true);
    expect(snapshot.proposalSources).toBeNull();
    expect(snapshot.communicationSources).toBeNull();
  });

  it('does not equate a complete empty inbox read with complete CRM conversation history', async () => {
    const fixture = sourceFixture();
    await (fixture.service as any).executeRun(fixture.run);
    const input = fixture.persist.mock.calls[0][1] as CrmControlRuleInput;
    const snapshot = fixture.persist.mock.calls[0][3] as any;
    expect(input.communications).toEqual([]);
    expect(input.sourceCompleteness.communications).toBe(false);
    expect(snapshot.communicationSources).toMatchObject({ datasetReadComplete: true, sourceCoverage: 'UNVERIFIED', messages: [] });
    expect(snapshot.proposalSources).toMatchObject({ fieldId: '900', fieldReadComplete: true, sentHistoryComplete: false });
  });

  it('keeps the communication source incomplete and reports an inbox read failure', async () => {
    const fixture = sourceFixture();
    fixture.prisma.rawAmoEventInbox.findMany.mockRejectedValue(new Error('database source unavailable'));
    await (fixture.service as any).executeRun(fixture.run);
    const snapshot = fixture.persist.mock.calls[0][3] as any;
    expect(snapshot.communicationSources).toMatchObject({ datasetReadComplete: false, sourceCoverage: 'UNVERIFIED', messages: [] });
    expect((fixture.persist.mock.calls[0][1] as CrmControlRuleInput).sourceCompleteness.communications).toBe(false);
    const finish = fixture.prisma.crmControlRun.updateMany.mock.calls.at(-1)![0] as any;
    expect(finish.data.issues).toContain('Не удалось прочитать сохранённые сообщения amoCRM. Сверка отправленных документов не завершена.');
  });

  it('reads all source pages beyond 1000 deals and limits the query to configured open stages', async () => {
    const fixture = sourceFixture(1001);
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).toHaveBeenCalledTimes(1001);
    expect(fixture.client.paginateBatch).toHaveBeenCalledWith('/leads', 'leads', {
      'order[id]': 'asc', 'filter[statuses][0][pipeline_id]': '100', 'filter[statuses][0][status_id]': '200',
    }, expect.any(Function));
    expect(fixture.readLead).toHaveBeenCalledTimes(2002);
    expect(fixture.client.get).toHaveBeenCalledWith('/account', { with: 'drive_url' });
  });

  it('reads three deals and their independent sources concurrently without starting a fourth', async () => {
    const fixture = sourceFixture(4);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fixture.client.paginate.mockImplementation(async () => { await blocked; return []; });
    const running = (fixture.service as any).executeRun(fixture.run);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    expect(fixture.readLead).toHaveBeenCalledTimes(3);
    expect(fixture.client.paginate).toHaveBeenCalledTimes(9);
    expect(fixture.persist).not.toHaveBeenCalled();
    release(); await running;
    expect(fixture.persist).toHaveBeenCalledTimes(4);
    expect(fixture.readLead).toHaveBeenCalledTimes(8);
  });

  it('resumes only missing deals and retains prior UNKNOWN observations and their original counts', async () => {
    const fixture = sourceFixture(2);
    const saved = { id: 'saved', dealExternalId: '1', counts: observationCounts([result('UNKNOWN')]), observedAt };
    const before = JSON.stringify(saved);
    fixture.prisma.crmControlObservation.findMany.mockResolvedValueOnce([saved] as never).mockResolvedValue([]);
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.client.get).not.toHaveBeenCalledWith('/leads/1');
    expect(fixture.persist).toHaveBeenCalledTimes(1);
    expect((fixture.persist.mock.calls[0][1] as CrmControlRuleInput).deal.externalId).toBe('2');
    expect(JSON.stringify(saved)).toBe(before);
    const finish = fixture.prisma.crmControlRun.updateMany.mock.calls.at(-1)![0] as any;
    expect(finish.where.startedAt).toEqual(fixture.run.startedAt);
    expect(finish.data.counts.deals).toBe(2);
    expect(finish.data.counts.unknown).toBeGreaterThanOrEqual(1);
    expect(fixture.prisma.crmControlObservation.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: 'saved' }, skip: 1 }));
  });

  it('deduplicates repeated deal IDs inside a concurrent source batch', async () => {
    const fixture = sourceFixture(2);
    fixture.leads[1] = fixture.leads[0];
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).toHaveBeenCalledTimes(1);
    expect(fixture.readLead).toHaveBeenCalledTimes(2);
    expect((fixture.prisma.crmControlRun.updateMany.mock.calls.at(-1)![0] as any).data.counts.deals).toBe(1);
  });

  it('waits for other in-flight readers before propagating a failed write', async () => {
    const fixture = sourceFixture(3);
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => { finish = resolve; });
    fixture.persist.mockImplementation(async (...args: any[]) => {
      if (args[1].deal.externalId === '1') throw new Error('temporary database failure');
      await blocked;
      return {};
    });
    let settled = false;
    const running = (fixture.service as any).executeRun(fixture.run).catch((error: Error) => { settled = true; return error; });
    for (let i = 0; i < 60; i += 1) await Promise.resolve();
    expect(fixture.persist).toHaveBeenCalledTimes(3);
    expect(settled).toBe(false);
    finish();
    expect((await running).message).toBe('temporary database failure');
  });

  it('marks task coverage unknown when its source request fails', async () => {
    const fixture = sourceFixture();
    fixture.client.paginate.mockImplementation(async (...args: any[]) => { if (args[0] === '/tasks') throw new Error('connection failed'); return []; });
    await (fixture.service as any).executeRun(fixture.run);
    const passedInput = fixture.persist.mock.calls[0][1] as CrmControlRuleInput;
    const evaluated = fixture.persist.mock.calls[0][2] as CrmControlRuleResult[];
    expect(passedInput.sourceCompleteness.tasks).toBe(false);
    expect(evaluated.find((row) => row.ruleCode === 'task_count')?.status).toBe('UNKNOWN');
  });

  it('never evaluates unsorted deals returned by the source despite the working-stage filter', async () => {
    const fixture = sourceFixture(2);
    fixture.leads[0].status_id = 199;
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).toHaveBeenCalledTimes(1);
    expect((fixture.persist.mock.calls[0][1] as CrmControlRuleInput).deal.externalId).toBe('2');
    expect(fixture.client.get).not.toHaveBeenCalledWith('/leads/1');
    expect(fixture.client.paginateBatch).toHaveBeenCalledWith('/leads', 'leads', {
      'order[id]': 'asc', 'filter[statuses][0][pipeline_id]': '100', 'filter[statuses][0][status_id]': '200',
    }, expect.any(Function));
  });

  it.each(['binding', 'norm'])('refuses an old stored configuration that assigns an unsorted %s before reading any deals', async (kind) => {
    const fixture = sourceFixture();
    const scope = fixture.run.config.scopes[0] as any;
    if (kind === 'binding') scope.assignedStageId = 'unsorted';
    else scope.stageRules = { unsorted: { deadlineMode: 'unlimited' } };
    await expect((fixture.service as any).executeRun(fixture.run)).rejects.toThrow('системный или закрытый этап');
    expect(fixture.client.paginateBatch).not.toHaveBeenCalled();
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  it.each(['initial', 'final'])('does not evaluate a deal moved to unsorted during its %s source reread', async (phase) => {
    const fixture = sourceFixture();
    if (phase === 'final') fixture.readLead.mockResolvedValueOnce(fixture.leads[0]);
    fixture.readLead.mockResolvedValueOnce({ ...fixture.leads[0], status_id: 199 });
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).not.toHaveBeenCalled();
  });

  it('does not write mixed source facts as an accusation when the lead changes during collection', async () => {
    const fixture = sourceFixture();
    fixture.readLead.mockResolvedValueOnce(fixture.leads[0]).mockResolvedValueOnce({ ...fixture.leads[0], updated_at: 1800000000 });
    await (fixture.service as any).executeRun(fixture.run);
    const evaluated = fixture.persist.mock.calls[0][2] as CrmControlRuleResult[];
    expect(evaluated.every((row) => row.status === 'UNKNOWN')).toBe(true);
  });

  it('never archives the new owner’s raw card under the previous owner after a transfer', async () => {
    const fixture = sourceFixture();
    fixture.readLead.mockResolvedValueOnce(fixture.leads[0]).mockResolvedValueOnce({ ...fixture.leads[0], responsible_user_id: 999 });
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).not.toHaveBeenCalled();
    expect(fixture.prisma.crmControlRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'PARTIAL' }) }));
  });
});

describe('CRM control complete task-type catalog', () => {
  function catalogFixture(response: unknown) {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, name: 'Владелец', isActive: true, businessRole: 'OWNER' }) },
      crmControlSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      pipeline: { findMany: jest.fn().mockResolvedValue([{ id: 'pipeline', name: 'Продажи', stages: [{ id: 'stage', name: 'В работе', isWon: false, isLost: false }] }]) },
      task: { findMany: jest.fn().mockResolvedValue([{ typeId: 1, typeName: 'Старое название' }]) },
    };
    const get = jest.fn().mockResolvedValue(response);
    const amo = { getActiveConnectionOrFail: jest.fn().mockResolvedValue({ id: 'connection' }), getClient: jest.fn().mockResolvedValue({ get }) };
    const service = new CrmControlService(prisma as any, amo as any, { capabilities: () => ({ screenshots: false }) } as any);
    return { prisma, get, service };
  }

  it('includes real unused task types and validates them without requiring existing tasks', async () => {
    const fixture = catalogFixture({ _embedded: { task_types: [{ id: 1, name: 'Звонок' }, { id: 9876, name: 'Презентовать КП' }] } });
    const settings = await fixture.service.settings(actor);
    expect(settings.options.taskTypes).toEqual([{ id: 1, name: 'Звонок' }, { id: 9876, name: 'Презентовать КП' }]);
    expect(settings.capabilities.taskTypes).toBe(true);
    expect(fixture.get).toHaveBeenCalledWith('/account', { with: 'task_types' });
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: { allowedTaskTypeIds: [9876] } } }] };
    await expect((fixture.service as any).validateConfig(config)).resolves.toMatchObject(config);
    expect(fixture.prisma.task.findMany).not.toHaveBeenCalled();
  });

  it('does not present locally observed types as a full catalog when the API omits the catalog', async () => {
    const fixture = catalogFixture({ id: 1, name: 'Аккаунт' });
    const settings = await fixture.service.settings(actor);
    expect(settings.options.taskTypes).toEqual([]);
    expect(settings.capabilities.taskTypes).toBe(false);
    expect(settings.configurationIssues).toContain('Справочник типов задач amoCRM недоступен. Обновите страницу после восстановления подключения.');
    expect(fixture.prisma.task.findMany).not.toHaveBeenCalled();
  });

  it('offers only working stages, excluding unsorted and both terminal states', async () => {
    const fixture = catalogFixture({ _embedded: { task_types: [] } });
    fixture.prisma.pipeline.findMany.mockResolvedValue([{ id: 'pipeline', name: 'Продажи', stages: [
      { id: 'stage', name: 'В работе', isWon: false, isLost: false, raw: { type: 0 } },
      { id: 'unsorted', name: 'Неразобранное', isWon: false, isLost: false, raw: { type: 1 } },
      { id: 'won', name: 'Успешно', isWon: true, isLost: false },
      { id: 'lost', name: 'Отказ', isWon: false, isLost: true },
    ] }] as any);
    const settings = await fixture.service.settings(actor);
    expect(settings.options.pipelines[0].stages.map((stage) => stage.id)).toEqual(['stage']);
  });

  it('rejects absent types using the account catalog and reports source failures explicitly', async () => {
    const fixture = catalogFixture({ _embedded: { task_types: [{ id: 1, name: 'Звонок' }] } });
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: { allowedTaskTypeIds: [9876] } } }] };
    await expect((fixture.service as any).validateConfig(config)).rejects.toThrow('отсутствует в справочнике');
    fixture.get.mockRejectedValue(new Error('Private network detail omitted'));
    await expect((fixture.service as any).validateConfig(config)).rejects.toThrow('Не удалось проверить справочник');
  });
});
