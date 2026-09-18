import { CrmControlService } from './crm-control.service';
import { controlScheduleSlot, nextControlCaseState, observationCounts } from './crm-control.logic';
import { CrmControlRuleInput, CrmControlRuleResult, DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';

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
    { pipelineName: 'Продажи', stageName: 'В работе', managerName: 'Менеджер', groupId: 'group', groupName: 'ОПНК', dealUrl: 'https://example.amocrm.ru/leads/detail/12' });
  return { service, tx, observations, cases, results, evidence, persist };
}

describe('CRM control immutable observations and case episodes', () => {
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

  it('does not execute another run while a durable global lease is held', async () => {
    const prisma = { crmControlRun: { updateMany: jest.fn().mockResolvedValue({ count: 0 }), count: jest.fn().mockResolvedValue(1), findFirst: jest.fn() } };
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
});

describe('CRM control direct source reads', () => {
  function sourceFixture(total = 1) {
    const pipeline = { id: 'pipeline', externalId: '100', name: 'Продажи', stages: [
      { id: 'stage', externalId: '200', name: 'Назначен ответственный', isWon: false, isLost: false },
      { id: 'won', externalId: '201', name: 'Успешно', isWon: true, isLost: false },
    ] };
    const leads = Array.from({ length: total }, (_, index) => ({ id: index + 1, name: `Сделка ${index + 1}`, pipeline_id: 100, status_id: 200,
      responsible_user_id: 300, updated_at: 1700000000, created_at: 1700000000, price: 450 }));
    const client = { domain: 'example.amocrm.ru', get: jest.fn(async (path: string) => leads[Number(path.split('/').pop()) - 1]),
      paginate: jest.fn(async () => []),
      paginateBatch: jest.fn(async (_path, _key, _params, callback) => {
        for (let offset = 0; offset < leads.length; offset += 250) await callback(leads.slice(offset, offset + 250));
      }),
    };
    const prisma = { pipeline: { findMany: jest.fn().mockResolvedValue([pipeline]) },
      crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'manager', externalId: '300', name: 'Менеджер', groupId: 'group', group: { name: 'ОПНК' } }]) },
      crmControlRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      crmControlCase: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CrmControlService(prisma as any, { getActiveConnectionOrFail: jest.fn().mockResolvedValue({ config: {} }),
      getClient: jest.fn().mockResolvedValue(client) } as any, {} as any);
    const persist = jest.spyOn(service as any, 'persistObservation').mockResolvedValue({});
    const run = { id: 'run', scheduledFor: new Date(), config: { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', assignedStageId: 'stage' }] } };
    return { client, prisma, service, persist, run, leads };
  }

  it('reads all source pages beyond 1000 deals and limits the query to configured open stages', async () => {
    const fixture = sourceFixture(1001);
    await (fixture.service as any).executeRun(fixture.run);
    expect(fixture.persist).toHaveBeenCalledTimes(1001);
    expect(fixture.client.paginateBatch).toHaveBeenCalledWith('/leads', 'leads', {
      'order[id]': 'asc', 'filter[statuses][0][pipeline_id]': '100', 'filter[statuses][0][status_id]': '200',
    }, expect.any(Function));
    expect(fixture.client.get).toHaveBeenCalledTimes(2002);
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

  it('does not write mixed source facts as an accusation when the lead changes during collection', async () => {
    const fixture = sourceFixture();
    fixture.client.get.mockResolvedValueOnce(fixture.leads[0]).mockResolvedValueOnce({ ...fixture.leads[0], updated_at: 1800000000 });
    await (fixture.service as any).executeRun(fixture.run);
    const evaluated = fixture.persist.mock.calls[0][2] as CrmControlRuleResult[];
    expect(evaluated.every((row) => row.status === 'UNKNOWN')).toBe(true);
  });

  it('never archives the new owner’s raw card under the previous owner after a transfer', async () => {
    const fixture = sourceFixture();
    fixture.client.get.mockResolvedValueOnce(fixture.leads[0]).mockResolvedValueOnce({ ...fixture.leads[0], responsible_user_id: 999 });
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

  it('rejects absent types using the account catalog and reports source failures explicitly', async () => {
    const fixture = catalogFixture({ _embedded: { task_types: [{ id: 1, name: 'Звонок' }] } });
    const config = { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [{ pipelineId: 'pipeline', department: 'sales', stageRules: { stage: { allowedTaskTypeIds: [9876] } } }] };
    await expect((fixture.service as any).validateConfig(config)).rejects.toThrow('отсутствует в справочнике');
    fixture.get.mockRejectedValue(new Error('Private network detail omitted'));
    await expect((fixture.service as any).validateConfig(config)).rejects.toThrow('Не удалось проверить справочник');
  });
});
