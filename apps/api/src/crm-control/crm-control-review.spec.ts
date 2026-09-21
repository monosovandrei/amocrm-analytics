import { controlCompletion, controlManualReviewAllowed, emptyControlCounts, observationCounts } from './crm-control.logic';
import { CrmControlService } from './crm-control.service';
import { evaluateCrmControlDeal } from './crm-control.rules';
import { DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';

const actor = { id: 'reviewer', email: 'owner@example.test', role: 'ADMIN' as const, businessRole: 'OWNER' as const };
const observedAt = new Date('2026-09-21T16:05:00Z');
const reason = 'Сверил сумму отправленного предложения с бюджетом на момент проверки.';
const body = { outcome: 'PASS' as const, reason, evidence: 'https://example.amocrm.ru/leads/detail/123', expectedDecisionId: null as string | null };

function reviewFixture(options: { role?: string; status?: string; ruleCode?: string; existingCase?: boolean; visible?: boolean } = {}) {
  const result: any = { id: 'result', observationId: 'observation', ruleCode: options.ruleCode ?? 'offer_budget',
    status: options.status ?? 'UNKNOWN', subjectId: '', caseId: options.existingCase ? 'case' : null, message: 'Не подключён источник', details: {} };
  const row: any = { id: 'observation', runId: 'run', dealId: 'deal', managerId: 'manager', groupId: 'group', observedAt,
    snapshot: { recorded: 'unchanged' }, snapshotHash: 'abcdef', counts: { unknown: 1 }, results: [result] };
  const decisions: any[] = [];
  const caseValue = { id: 'case', caseKey: 'canonical', activeKey: 'deal:offer_budget:', status: 'REVIEW', latestObservationId: row.id };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: result.id }]),
    crmControlResult: {
      findUnique: jest.fn(async () => result),
      updateMany: jest.fn(async ({ data }) => { Object.assign(result, data); return { count: 1 }; }),
    },
    crmControlCase: {
      create: jest.fn(async ({ data }) => ({ id: 'review-case', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(caseValue),
    },
    crmControlDecision: {
      findFirst: jest.fn(async () => decisions.at(-1) ?? null),
      create: jest.fn(async ({ data }) => { const value = { id: `decision-${decisions.length + 1}`, ...data }; decisions.push(value); return value; }),
    },
  };
  const prisma = { ...tx,
    user: { findUnique: jest.fn().mockResolvedValue({ id: actor.id, name: 'Руководитель', isActive: true,
      businessRole: options.role ?? 'OWNER', crmUserId: 'manager', crmUser: { groupId: 'group' } }) },
    crmControlObservation: { findFirst: jest.fn().mockResolvedValue(options.visible === false ? null : row) },
    $transaction: jest.fn(async (callback) => callback(tx)),
  };
  const service = new CrmControlService(prisma as any, {} as any, {} as any);
  return { service, prisma, tx, row, result, decisions };
}

describe('CRM control completion', () => {
  it('marks a fully checked report with known violations as checked, independently of the old PARTIAL state', () => {
    const counts = observationCounts([{ status: 'FAIL' } as any]);
    expect(controlCompletion('PARTIAL', counts)).toMatchObject({ status: 'CHECKED', remainingResults: 0, remainingDeals: 0, reasons: [] });
  });

  it.each(['UNKNOWN', 'REVIEW'])('never calls %s a checked result', (status) => {
    const completion = controlCompletion('COMPLETED', observationCounts([{ status } as any]));
    expect(completion).toMatchObject({ status: 'UNCHECKED', remainingResults: 1, remainingDeals: 1 });
    expect(completion.reasons[0].code).toBe(`${status}_RESULTS`);
  });

  it('requires completed coverage, observations and actual results', () => {
    const checked = observationCounts([{ status: 'PASS' } as any]);
    expect(controlCompletion('RUNNING', checked)).toMatchObject({ status: 'UNCHECKED', canRecheck: false });
    expect(controlCompletion('ERROR', checked).status).toBe('UNCHECKED');
    expect(controlCompletion('COMPLETED', emptyControlCounts()).status).toBe('UNCHECKED');
    expect(controlCompletion('PARTIAL', checked, ['Часть сделок недоступна']).status).toBe('UNCHECKED');
    expect(controlCompletion('COMPLETED', observationCounts([]))).toMatchObject({ status: 'UNCHECKED', reasons: [{ code: 'MISSING_RESULTS', count: 1, message: expect.any(String) }] });
  });
});

describe('CRM control manual review', () => {
  it('records a source-backed decision without overwriting the source status, counts or snapshot', async () => {
    const fixture = reviewFixture();
    const snapshot = JSON.stringify({ snapshot: fixture.row.snapshot, counts: fixture.row.counts });
    const response = await fixture.service.reviewResult(actor, 'observation', 'result', body);
    expect(response).toMatchObject({ decisionId: 'decision-1', outcome: 'PASS', reviewedBy: 'Руководитель', reason: `${reason}\nИсточник: ${body.evidence}` });
    expect(fixture.result.status).toBe('UNKNOWN');
    expect(JSON.stringify({ snapshot: fixture.row.snapshot, counts: fixture.row.counts })).toBe(snapshot);
    expect(fixture.tx.crmControlResult.updateMany).toHaveBeenCalledWith({ where: { id: 'result', caseId: null }, data: { caseId: 'review-case' } });
    expect(fixture.tx.crmControlCase.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ caseKey: 'review:result', activeKey: null }) }));
    expect(fixture.tx.crmControlCase.updateMany).not.toHaveBeenCalled();
    const view = { ...fixture.result, case: { status: 'REVIEW', decisions: fixture.decisions } };
    expect((fixture.service as any).effectiveStatus(view, observedAt)).toBe('PASS');
    expect((fixture.service as any).effectiveCounts([view], observedAt).checkedDeals).toBe(1);
  });

  it('never transfers manual conclusions to another observation, even when facts share an existing case', async () => {
    const fixture = reviewFixture({ existingCase: true, status: 'REVIEW' });
    await fixture.service.reviewResult(actor, 'observation', 'result', { ...body, outcome: 'FAIL' });
    const value = { ...fixture.result, case: { status: 'REVIEW', decisions: fixture.decisions } };
    expect((fixture.service as any).effectiveStatus(value, observedAt)).toBe('FAIL');
    expect((fixture.service as any).effectiveStatus({ ...value, observationId: 'tomorrow' }, new Date('2030-01-01'))).toBe('REVIEW');
    expect((fixture.service as any).effectiveStatus({ ...value, observationId: 'yesterday' }, new Date('2020-01-01'))).toBe('REVIEW');
    expect(fixture.tx.crmControlCase.create).not.toHaveBeenCalled();
    expect(fixture.tx.crmControlCase.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a stale decision and orders a replacement strictly after the previous decision under the lock', async () => {
    const fixture = reviewFixture({ existingCase: true });
    fixture.decisions.push({ id: 'previous', action: 'VERIFY_FAIL', observationId: 'observation', createdAt: new Date(Date.now() + 10_000), validUntil: null });
    await expect(fixture.service.reviewResult(actor, 'observation', 'result', body)).rejects.toMatchObject({ status: 409 });
    expect(fixture.tx.crmControlDecision.create).not.toHaveBeenCalled();
    const response = await fixture.service.reviewResult(actor, 'observation', 'result', { ...body, expectedDecisionId: 'previous' });
    expect(response.reviewedAt.getTime()).toBe(fixture.decisions[0].createdAt.getTime() + 1);
    expect(fixture.decisions).toHaveLength(2);
  });

  it('does not present an earlier manual conclusion as current after a later decision supersedes it', () => {
    const fixture = reviewFixture({ existingCase: true, status: 'FAIL' });
    const value = { ...fixture.result, case: { status: 'OPEN', decisions: [
      { id: 'manual', action: 'VERIFY_PASS', observationId: 'observation', createdAt: new Date('2026-09-21T17:00:00Z'), validUntil: null },
      { id: 'confirmed', action: 'CONFIRM', observationId: 'observation', createdAt: new Date('2026-09-21T18:00:00Z'), validUntil: null },
    ] } };
    expect((fixture.service as any).effectiveStatus(value, observedAt)).toBe('FAIL');
    expect((fixture.service as any).manualReviewState(value)).toMatchObject({ current: null, expectedDecisionId: 'confirmed' });
  });

  it.each(['javascript:alert(1)', 'data:text/plain,ok', 'not-a-url', 'https://user:password@example.test/private'])('rejects an invalid evidence URL: %s', async (evidence) => {
    const fixture = reviewFixture();
    await expect(fixture.service.reviewResult(actor, 'observation', 'result', { ...body, evidence })).rejects.toMatchObject({ status: 400 });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('requires an explanation and explicit expected-decision version, not a blind checkbox', async () => {
    const fixture = reviewFixture();
    await expect(fixture.service.reviewResult(actor, 'observation', 'result', { ...body, reason: 'Проверено' })).rejects.toMatchObject({ status: 400 });
    await expect(fixture.service.reviewResult(actor, 'observation', 'result', { ...body, expectedDecisionId: undefined } as any)).rejects.toMatchObject({ status: 400 });
    expect(fixture.tx.crmControlDecision.create).not.toHaveBeenCalled();
  });

  it('enforces the observation scope and rejects managers or a result from another observation', async () => {
    const manager = reviewFixture({ role: 'MANAGER' });
    await expect(manager.service.reviewResult(actor, 'observation', 'result', body)).rejects.toMatchObject({ status: 403 });
    const outside = reviewFixture({ role: 'ROP', visible: false });
    await expect(outside.service.reviewResult(actor, 'observation', 'result', body)).rejects.toMatchObject({ status: 404 });
    expect(outside.prisma.crmControlObservation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'observation', groupId: 'group' } }));
    const owner = reviewFixture();
    await expect(owner.service.reviewResult(actor, 'observation', 'another-result', body)).rejects.toMatchObject({ status: 404 });
    expect(owner.tx.crmControlDecision.create).not.toHaveBeenCalled();
  });

  it('does not allow future day-end facts to be signed off manually, including older saved snapshots', async () => {
    const fixture = reviewFixture({ ruleCode: 'proposal_note' });
    fixture.result.message = 'Итог рабочего дня ещё не наступил: презентация может быть оформлена сегодня.';
    expect(controlManualReviewAllowed(fixture.result)).toBe(false);
    await expect(fixture.service.reviewResult(actor, 'observation', 'result', body)).rejects.toMatchObject({ status: 400 });
    fixture.result.message = 'Не проверено';
    fixture.result.details = { awaitingDayEnd: true };
    expect(controlManualReviewAllowed(fixture.result)).toBe(false);
  });

  it('blocks the old confirm/exempt endpoint as a shortcut around reviewing UNKNOWN or REVIEW', async () => {
    const fixture = reviewFixture({ existingCase: true, status: 'REVIEW' });
    for (const action of ['CONFIRM', 'EXEMPT'] as const) {
      await expect(fixture.service.decide(actor, 'case', { action, reason: 'Примечание проверено', validUntil: '2099-01-01' })).rejects.toThrow('ручную допроверку');
    }
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps manually verified UNKNOWN results on the manual-review path even when the outcome is FAIL', async () => {
    const fixture = reviewFixture({ existingCase: true });
    fixture.result.case = { status: 'REVIEW', decisions: [{ id: 'manual', action: 'VERIFY_FAIL', observationId: 'observation',
      createdAt: new Date('2026-09-21T17:00:00Z'), validUntil: null }] };
    expect((fixture.service as any).effectiveStatus(fixture.result, observedAt)).toBe('FAIL');
    for (const action of ['CONFIRM', 'EXEMPT'] as const) {
      await expect(fixture.service.decide(actor, 'case', { action, reason: 'Подтверждение проверено', validUntil: '2099-01-01' })).rejects.toThrow('ручную допроверку');
    }
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['PASS', 'NA'])('does not let legacy confirmation override a manual %s conclusion without a new review', async (outcome) => {
    const fixture = reviewFixture({ existingCase: true, status: 'REVIEW' });
    fixture.result.case = { status: 'REVIEW', decisions: [{ id: 'manual', action: `VERIFY_${outcome}`, observationId: 'observation',
      createdAt: new Date('2026-09-21T17:00:00Z'), validUntil: null }] };
    await expect(fixture.service.decide(actor, 'case', { action: 'CONFIRM', reason: 'Согласен' })).rejects.toMatchObject({ status: 400 });
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a legacy decision when manual review changes after the card is read, before mutating case lifecycle', async () => {
    const fixture = reviewFixture({ existingCase: true, status: 'FAIL' });
    fixture.result.case = { status: 'OPEN', decisions: [] };
    // The immutable card was read before another reviewer committed this decision.
    fixture.decisions.push({ id: 'concurrent-manual-pass', action: 'VERIFY_PASS', observationId: 'observation',
      createdAt: new Date('2026-09-21T17:00:00Z'), validUntil: null });
    await expect(fixture.service.decide(actor, 'case', { action: 'CONFIRM', reason: 'Согласен' })).rejects.toMatchObject({ status: 409 });
    expect(fixture.tx.crmControlCase.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.crmControlDecision.create).not.toHaveBeenCalled();
  });
});

describe('CRM control unrestricted Base task type', () => {
  it('treats missing Base task types as not applicable without relaxing task deadlines or counts', () => {
    const input: any = { deal: { id: 'deal', externalId: '123', title: 'Клиент', amount: 1, createdAt: observedAt, pipelineId: 'csm', stageId: 'base', responsibleId: 'manager' },
      tasks: [{ id: 'task', externalId: '1', title: 'Позвонить', typeId: 99, dueAt: new Date('2026-09-21T10:00:00Z'), isCompleted: false }], notes: [],
      stageEnteredAt: observedAt, observedAt, sourceCompleteness: { deal: true, tasks: true, notes: true, stageHistory: true },
      config: DEFAULT_CRM_CONTROL_CONFIG, scope: { department: 'csm', pipelineId: 'csm', baseStageId: 'base', stageRules: { base: { deadlineMode: 'unlimited' } } } };
    const results = evaluateCrmControlDeal(input);
    expect(results.find((item) => item.ruleCode === 'task_type')?.status).toBe('NA');
    expect(results.find((item) => item.ruleCode === 'task_deadline')?.status).toBe('FAIL');
    expect(results.find((item) => item.ruleCode === 'task_count')?.status).toBe('PASS');
    input.deal.stageId = 'other-unlimited';
    expect(evaluateCrmControlDeal(input).find((item) => item.ruleCode === 'task_type')?.status).toBe('UNKNOWN');
    input.deal.stageId = 'base';
    input.scope.stageRules.base.allowedTaskTypeIds = [1];
    expect(evaluateCrmControlDeal(input).find((item) => item.ruleCode === 'task_type')?.status).toBe('FAIL');
  });
});
