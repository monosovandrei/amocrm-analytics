import { CRM_CONTROL_RULE_CATALOG, evaluateCrmControlDeal } from './crm-control.rules';
import { CrmControlRuleInput, DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';

const date = (iso: string) => new Date(iso);

function fixture(): CrmControlRuleInput {
  return {
    deal: { id: 'deal', externalId: '123', title: 'Клиент', amount: 12000, createdAt: date('2026-09-15T08:00:00Z'), pipelineId: 'sales', stageId: 'working', responsibleId: 'user', customFields: {}, raw: {} },
    tasks: [{ id: 'task-1', externalId: '401', title: 'Позвонить и согласовать предложение', typeId: 1, dueAt: date('2026-09-19T12:00:00Z'), isCompleted: false, raw: {} }],
    notes: [],
    communications: [],
    observedAt: date('2026-09-18T16:05:00Z'),
    stageEnteredAt: date('2026-09-18T08:00:00Z'),
    sourceCompleteness: { deal: true, tasks: true, notes: true, stageHistory: true, communications: true },
    config: { ...DEFAULT_CRM_CONTROL_CONFIG, scopes: [] },
    scope: { pipelineId: 'sales', department: 'sales', assignedStageId: 'assigned', preparedProposalStageId: 'prepared', stageRules: { working: { allowedTaskTypeIds: [1], maxDurationHours: 48 } } },
  };
}

function csmFixture(stageId: string): CrmControlRuleInput {
  const input = fixture();
  input.deal.pipelineId = 'csm';
  input.deal.stageId = stageId;
  input.scope = { pipelineId: 'csm', department: 'csm', newClientStageId: 'new', baseStageId: 'base', preparedProposalStageId: 'prepared', priceRequestedStageId: 'price' };
  return input;
}

function result(input: CrmControlRuleInput, ruleCode: string) {
  return evaluateCrmControlDeal(input).find((item) => item.ruleCode === ruleCode)!;
}

function note(iso: string, text = 'Презентация согласована на завтра') {
  return { id: 'note-1', externalId: '501', type: 'common', text, createdAt: date(iso), raw: {} };
}

describe('CRM control deterministic rules', () => {
  it('covers every clause of both department letters in its catalog', () => {
    const clauses = new Set(CRM_CONTROL_RULE_CATALOG.flatMap((item) => item.clauses));
    for (let n = 1; n <= 8; n++) expect(clauses.has(`ОПНК ${n}`)).toBe(true);
    for (let n = 1; n <= 10; n++) expect(clauses.has(`ОППК ${n}`)).toBe(true);
  });

  it('uses 19:00 local creation cutoff only for the assigned sales stage', () => {
    const input = fixture();
    input.deal.stageId = 'assigned';
    input.deal.createdAt = date('2026-09-18T15:59:59.999Z');
    expect(result(input, 'intake_stage').status).toBe('FAIL');
    input.deal.createdAt = date('2026-09-18T16:00:00Z');
    expect(result(input, 'intake_stage').status).toBe('NA');
    const csm = csmFixture('new');
    csm.deal.createdAt = date('2026-09-18T16:01:00Z');
    expect(result(csm, 'intake_stage').status).toBe('FAIL');
  });

  it('does not pretend another stage is assigned when its configuration is missing', () => {
    const input = fixture();
    delete input.scope.assignedStageId;
    expect(result(input, 'intake_stage').status).toBe('UNKNOWN');
  });

  it('distinguishes explicit absence from missing mappings without declaring old violations fixed', () => {
    for (const [department, binding, rule] of [
      ['sales', 'assignedStageId', 'intake_stage'], ['csm', 'newClientStageId', 'intake_stage'],
      ['csm', 'preparedProposalStageId', 'proposal_note'], ['csm', 'priceRequestedStageId', 'price_requested_duration'],
    ] as const) {
      const input = department === 'sales' ? fixture() : csmFixture('working');
      delete input.scope[binding];
      expect(result(input, rule).status).toBe('UNKNOWN');
      input.scope[binding] = '';
      expect(result(input, rule).status).toBe('UNKNOWN');
      input.scope[binding] = null;
      expect(result(input, rule)).toMatchObject({ status: 'NA', details: { configuredAbsent: true } });
      expect(result(input, rule).details?.resolvesPrior).not.toBe(true);
    }
    const input = csmFixture('working');
    input.scope.baseStageId = null;
    input.tasks = [];
    expect(result(input, 'task_count').status).toBe('FAIL');
  });

  it('marks proven non-applicability as resolving a prior case but never missing configuration or stale data', () => {
    const input = fixture();
    expect(result(input, 'intake_stage')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
    expect(result(input, 'proposal_note')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
    const csm = csmFixture('working');
    expect(result(csm, 'price_requested_duration')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
    delete csm.scope.priceRequestedStageId;
    expect(result(csm, 'price_requested_duration')).toMatchObject({ status: 'UNKNOWN' });
    expect(result(csm, 'price_requested_duration').details?.resolvesPrior).not.toBe(true);
    input.sourceCompleteness.deal = false;
    expect(result(input, 'intake_stage').details?.resolvesPrior).not.toBe(true);
  });

  it('flags today at 23:59 even when the deadline has not expired', () => {
    const input = fixture();
    input.tasks[0].dueAt = date('2026-09-18T20:59:00Z');
    const deadline = result(input, 'task_deadline');
    expect(deadline.status).toBe('FAIL');
    expect(deadline.clauses).toEqual(['ОПНК 2']);
    expect(deadline.details).toMatchObject({ dueToday: true, overdue: false });
  });

  it('does not accuse either department of an unprocessed intake before 19:00', () => {
    const input = fixture();
    input.observedAt = date('2026-09-18T09:00:00Z');
    input.deal.stageId = 'assigned';
    expect(result(input, 'intake_stage').status).toBe('UNKNOWN');
    const csm = csmFixture('new');
    csm.observedAt = input.observedAt;
    expect(result(csm, 'intake_stage').status).toBe('UNKNOWN');
    input.deal.stageId = 'working';
    expect(result(input, 'intake_stage')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
  });

  it('keeps a morning task recheck unresolved until day-end unless it is already overdue', () => {
    const input = fixture();
    input.observedAt = date('2026-09-18T09:00:00Z');
    input.tasks[0].dueAt = date('2026-09-18T12:00:00Z');
    expect(result(input, 'task_deadline')).toMatchObject({ status: 'UNKNOWN', clauses: ['ОПНК 2'] });
    input.tasks[0].dueAt = date('2026-09-18T08:59:59Z');
    expect(result(input, 'task_deadline')).toMatchObject({ status: 'FAIL', clauses: ['ОПНК 3'] });
    input.tasks[0].dueAt = date('2026-09-19T12:00:00Z');
    expect(result(input, 'task_deadline').status).toBe('PASS');
  });

  it('does not assert a missing proposal explanation before the presentation day has ended', () => {
    const input = fixture();
    input.observedAt = date('2026-09-18T09:00:00Z');
    input.deal.stageId = 'prepared';
    expect(result(input, 'proposal_note').status).toBe('UNKNOWN');
    input.deal.stageId = 'working';
    expect(result(input, 'proposal_note')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
  });

  it('combines today and overdue for one task with both clauses and one stable subject', () => {
    const input = fixture();
    input.tasks[0].dueAt = date('2026-09-18T12:00:00Z');
    const matches = evaluateCrmControlDeal(input).filter((item) => item.ruleCode === 'task_deadline');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ status: 'FAIL', subjectId: '401', clauses: ['ОПНК 2', 'ОПНК 3'] });
  });

  it('separates today from yesterday using the company timezone at midnight', () => {
    const input = fixture();
    input.observedAt = date('2026-09-18T21:05:00Z'); // 00:05 on September 19 in Moscow.
    input.tasks[0].dueAt = date('2026-09-18T20:59:00Z');
    expect(result(input, 'task_deadline').clauses).toEqual(['ОПНК 3']);
    input.tasks[0].dueAt = date('2026-09-18T21:30:00Z');
    expect(result(input, 'task_deadline').clauses).toEqual(['ОПНК 2']);
  });

  it('does not count completed tasks and reports missing tasks outside Base', () => {
    const input = fixture();
    input.tasks[0].isCompleted = true;
    input.tasks[0].dueAt = date('2020-01-01T00:00:00Z');
    expect(result(input, 'task_count')).toMatchObject({ status: 'FAIL', details: { activeTaskCount: 0 } });
    expect(result(input, 'task_deadline').status).toBe('PASS');
    expect(result(input, 'task_type').status).toBe('NA');
  });

  it('allows zero or one task only in CSM Base and flags two distinct tasks', () => {
    const input = csmFixture('base');
    input.tasks = [];
    expect(result(input, 'task_count').status).toBe('PASS');
    input.tasks = fixture().tasks;
    expect(result(input, 'task_count').status).toBe('PASS');
    input.tasks.push({ ...input.tasks[0], id: 'task-2', externalId: '402' });
    expect(result(input, 'task_count').status).toBe('FAIL');
  });

  it('does not count a repeated copy of the same task twice', () => {
    const input = fixture();
    input.tasks.push({ ...input.tasks[0] });
    expect(result(input, 'task_count').status).toBe('PASS');
  });

  it('does not assert task absence or completion with an incomplete or stale task source', () => {
    const input = fixture();
    input.tasks = [];
    input.sourceCompleteness.tasks = false;
    const taskResults = evaluateCrmControlDeal(input).filter((item) => item.ruleCode.startsWith('task_'));
    expect(taskResults.every((item) => item.status === 'UNKNOWN')).toBe(true);
  });

  it('requires approved task types and stage duration without fallback values', () => {
    const input = fixture();
    input.scope.stageRules = {};
    expect(result(input, 'task_type').status).toBe('UNKNOWN');
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
    input.scope.stageRules.working = { allowedTaskTypeIds: [2] };
    expect(result(input, 'task_type').status).toBe('FAIL');
  });

  it('does not treat a sync display fallback as real task text', () => {
    const input = fixture();
    input.tasks[0].title = 'Задача 401';
    input.tasks[0].raw = { text: '' };
    expect(result(input, 'task_text').status).toBe('FAIL');
    input.tasks[0].raw = { text: 'Позвонить' };
    expect(result(input, 'task_text').status).toBe('REVIEW');
  });

  it('checks stage deadline from entry and requires a note before accepting an exception for review', () => {
    const input = fixture();
    input.scope.stageRules!.working.maxDurationHours = 24;
    input.tasks[0].dueAt = date('2026-09-19T08:00:00Z');
    expect(result(input, 'task_stage_deadline').status).toBe('PASS');
    input.tasks[0].dueAt = date('2026-09-19T08:00:00.001Z');
    expect(result(input, 'task_stage_deadline').status).toBe('FAIL');
    input.notes = [note('2026-09-18T10:00:00Z')];
    expect(result(input, 'task_stage_deadline').status).toBe('REVIEW');
    input.sourceCompleteness.notes = false;
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
  });

  it('does not infer stage entry from deal creation or stale stage history', () => {
    const input = fixture();
    input.stageEnteredAt = null;
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
    input.stageEnteredAt = date('2026-09-18T08:00:00Z');
    input.sourceCompleteness.stageHistory = false;
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
  });

  it('does not accept old unrelated or system notes for the current proposal', () => {
    const input = fixture();
    input.deal.stageId = 'prepared';
    input.notes = [note('2026-09-17T10:00:00Z'), { ...note('2026-09-18T10:00:00Z'), type: 'call_out' }];
    expect(result(input, 'proposal_note').status).toBe('FAIL');
    input.notes.push(note('2026-09-18T11:00:00Z'));
    expect(result(input, 'proposal_note').status).toBe('REVIEW');
  });

  it('requires complete notes and stage history when deciding whether existing text is current', () => {
    const input = fixture();
    input.deal.stageId = 'prepared';
    input.sourceCompleteness.notes = false;
    expect(result(input, 'proposal_note').status).toBe('UNKNOWN');
    input.sourceCompleteness.notes = true;
    input.stageEnteredAt = null;
    expect(result(input, 'proposal_note').status).toBe('FAIL'); // A complete empty list proves absence without stage history.
    input.notes = [note('2026-09-17T10:00:00Z')];
    expect(result(input, 'proposal_note').status).toBe('UNKNOWN');
  });

  it('clamps a calendar month at month end and uses a strict older-than boundary', () => {
    const input = fixture();
    input.observedAt = date('2026-02-28T16:05:00Z');
    input.deal.createdAt = date('2026-01-31T16:05:00Z');
    expect(result(input, 'deal_age').status).toBe('PASS');
    input.observedAt = date('2026-02-28T16:05:00.001Z');
    expect(result(input, 'deal_age').status).toBe('FAIL');
  });

  it('clamps leap-year February and distinguishes the explicit 30-day option', () => {
    const input = fixture();
    input.observedAt = date('2024-02-29T16:05:00Z');
    input.deal.createdAt = date('2024-01-31T16:05:00Z');
    expect(result(input, 'deal_age').status).toBe('PASS');
    input.observedAt = date('2026-03-29T16:05:00Z');
    input.deal.createdAt = date('2026-02-28T16:05:00Z');
    expect(result(input, 'deal_age').status).toBe('FAIL');
    input.config.maxDealAge = '30_days';
    expect(result(input, 'deal_age').status).toBe('PASS');
  });

  it('excludes Base from age by default and supports an explicit stricter setting', () => {
    const input = csmFixture('base');
    input.deal.createdAt = date('2020-01-01T00:00:00Z');
    expect(result(input, 'deal_age').status).toBe('NA');
    input.config.excludeBaseFromAge = false;
    expect(result(input, 'deal_age').status).toBe('FAIL');
  });

  it('uses local calendar time across daylight-saving changes for a one-month deadline', () => {
    const input = fixture();
    input.config.timeZone = 'America/New_York';
    input.deal.createdAt = date('2026-02-08T15:00:00Z'); // 10:00 EST.
    input.observedAt = date('2026-03-08T14:00:00Z'); // 10:00 EDT, exactly one calendar month.
    expect(result(input, 'deal_age').status).toBe('PASS');
    input.observedAt = date('2026-03-08T14:00:00.001Z');
    expect(result(input, 'deal_age').status).toBe('FAIL');
  });

  it('does not report unsupported offer checks as passed', () => {
    const input = fixture();
    expect(result(input, 'offer_budget').status).toBe('UNKNOWN');
    expect(result(input, 'proposal_file').status).toBe('UNKNOWN');
  });

  it('requires strictly more than 24 hours in Price requested and checks possible evidence', () => {
    const input = csmFixture('price');
    input.stageEnteredAt = date('2026-09-17T16:05:00Z');
    expect(result(input, 'price_requested_duration').status).toBe('PASS');
    input.stageEnteredAt = date('2026-09-17T16:04:59.999Z');
    expect(result(input, 'price_requested_duration').status).toBe('FAIL');
    input.notes = [note('2026-09-18T10:00:00Z')];
    expect(result(input, 'price_requested_duration').status).toBe('REVIEW');
  });

  it('does not assert missing delay evidence without complete communications', () => {
    const input = csmFixture('price');
    input.stageEnteredAt = date('2026-09-17T15:00:00Z');
    input.sourceCompleteness.communications = false;
    expect(result(input, 'price_requested_duration').status).toBe('UNKNOWN');
    input.communications = [{ id: 'message-1', createdAt: date('2026-09-18T10:00:00Z'), text: 'Ждём ответ завода' }];
    expect(result(input, 'price_requested_duration').status).toBe('REVIEW');
  });

  it('does not reuse evidence from a previous visit to Price requested', () => {
    const input = csmFixture('price');
    input.stageEnteredAt = date('2026-09-17T15:00:00Z');
    input.notes = [note('2026-09-16T10:00:00Z')];
    input.communications = [{ id: 'old-message', createdAt: date('2026-09-16T11:00:00Z') }];
    expect(result(input, 'price_requested_duration').status).toBe('FAIL');
    input.stageEnteredAt = null;
    expect(result(input, 'price_requested_duration').status).toBe('UNKNOWN');
  });

  it('handles invalid dates without crashing or passing time-based checks', () => {
    const input = fixture();
    input.deal.createdAt = new Date(NaN);
    input.tasks[0].dueAt = new Date(NaN);
    input.stageEnteredAt = new Date(NaN);
    expect(result(input, 'deal_age').status).toBe('UNKNOWN');
    expect(result(input, 'task_deadline').status).toBe('UNKNOWN');
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
    input.observedAt = new Date(NaN);
    expect(evaluateCrmControlDeal(input).every((item) => item.status === 'UNKNOWN')).toBe(true);
  });

  it('rejects invalid note timestamps when testing absence', () => {
    const input = fixture();
    input.deal.stageId = 'prepared';
    input.notes = [note('invalid')];
    expect(result(input, 'proposal_note').status).toBe('UNKNOWN');
  });

  it('does not crash on an out-of-range configured stage duration', () => {
    const input = fixture();
    input.scope.stageRules!.working.maxDurationHours = Number.MAX_VALUE;
    expect(result(input, 'task_stage_deadline').status).toBe('UNKNOWN');
  });

  it('does not evaluate stale deals, wrong scopes, or invalid timezones as clean', () => {
    const input = fixture();
    input.sourceCompleteness.deal = false;
    expect(evaluateCrmControlDeal(input).every((item) => item.status === 'UNKNOWN')).toBe(true);
    input.sourceCompleteness.deal = true;
    input.config.timeZone = 'not/a-zone';
    expect(evaluateCrmControlDeal(input).every((item) => item.status === 'UNKNOWN')).toBe(true);
    input.config.timeZone = 'Europe/Moscow';
    input.scope.pipelineId = 'other';
    expect(evaluateCrmControlDeal(input).every((item) => item.status === 'UNKNOWN')).toBe(true);
  });

  it('checks actual dwell even when no task exists, allowing only current documented exceptions for review', () => {
    const input = fixture();
    input.tasks = [];
    input.scope.stageRules!.working.maxDurationHours = 8;
    input.observedAt = date('2026-09-18T16:00:00Z');
    expect(result(input, 'stage_duration').status).toBe('PASS');
    input.observedAt = date('2026-09-18T16:00:00.001Z');
    expect(result(input, 'stage_duration').status).toBe('FAIL');
    input.notes = [note('2026-09-17T10:00:00Z')];
    expect(result(input, 'stage_duration').status).toBe('FAIL');
    input.notes.push(note('2026-09-18T10:00:00Z'));
    expect(result(input, 'stage_duration').status).toBe('REVIEW');
    input.sourceCompleteness.notes = false;
    expect(result(input, 'stage_duration').status).toBe('UNKNOWN');
  });

  it('shares the business deadline between actual dwell and task deadlines, independently of audit workdays', () => {
    const input = fixture();
    input.config.workdays = [7];
    input.scope.stageRules!.working = { deadlineMode: 'business_days', maxBusinessDays: 3 };
    input.observedAt = date('2026-09-23T08:00:00Z');
    input.tasks[0].dueAt = input.observedAt;
    expect(result(input, 'stage_duration')).toMatchObject({ status: 'PASS', details: { maximumDueAt: '2026-09-23T08:00:00.000Z' } });
    expect(result(input, 'task_stage_deadline').status).toBe('PASS');
    input.observedAt = date('2026-09-23T08:00:00.001Z');
    input.tasks[0].dueAt = input.observedAt;
    expect(result(input, 'stage_duration').status).toBe('FAIL');
    expect(result(input, 'task_stage_deadline').status).toBe('FAIL');
  });

  it('enforces end of entry day strictly at 19:00 with no note exceptions, even when notes are unavailable', () => {
    const input = fixture();
    input.scope.stageRules!.working = { deadlineMode: 'end_of_day' };
    input.notes = [note('2026-09-18T10:00:00Z')];
    input.sourceCompleteness.notes = false;
    input.observedAt = date('2026-09-18T15:59:59.999Z');
    expect(result(input, 'stage_duration').status).toBe('PASS');
    input.observedAt = date('2026-09-18T16:00:00Z');
    expect(result(input, 'stage_duration').status).toBe('FAIL');
    expect(result(input, 'task_stage_deadline').status).toBe('FAIL');
    input.stageEnteredAt = date('2026-09-18T17:00:00Z');
    input.observedAt = date('2026-09-18T17:01:00Z');
    expect(result(input, 'stage_duration')).toMatchObject({ status: 'FAIL', details: { maximumDueAt: '2026-09-18T16:00:00.000Z' } });
    input.stageEnteredAt = null;
    expect(result(input, 'stage_duration').status).toBe('UNKNOWN');
  });

  it('keeps unlimited duration independent from task duties and age, without requiring stage or task history', () => {
    const input = fixture();
    input.scope.stageRules!.working = { deadlineMode: 'unlimited' };
    input.stageEnteredAt = null;
    input.deal.createdAt = date('2020-01-01T00:00:00Z');
    expect(result(input, 'stage_duration')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
    expect(result(input, 'task_stage_deadline').status).toBe('NA');
    expect(result(input, 'deal_age').status).toBe('FAIL');
    input.tasks = [];
    expect(result(input, 'task_count').status).toBe('FAIL');
    input.sourceCompleteness.tasks = false;
    expect(result(input, 'task_stage_deadline')).toMatchObject({ status: 'NA', details: { resolvesAllSubjects: true } });
    expect(result(input, 'task_count').status).toBe('UNKNOWN');
  });

  it('disables the age limit for the whole configured scope while keeping the legacy default', () => {
    const input = csmFixture('working');
    input.deal.createdAt = date('2020-01-01T00:00:00Z');
    expect(result(input, 'deal_age').status).toBe('FAIL');
    input.scope.checkDealAge = false;
    expect(result(input, 'deal_age')).toMatchObject({ status: 'NA', details: { resolvesPrior: true } });
    input.scope.checkDealAge = true;
    expect(result(input, 'deal_age').status).toBe('FAIL');
  });

  it('uses the configured business-day price deadline without duplicate dwell violations', () => {
    const input = csmFixture('price');
    input.stageEnteredAt = date('2026-09-18T08:00:00Z');
    input.scope.stageRules = { price: { deadlineMode: 'business_days', maxBusinessDays: 1 } };
    input.observedAt = date('2026-09-21T08:00:00Z');
    expect(result(input, 'price_requested_duration')).toMatchObject({ status: 'PASS', details: { maximumDueAt: '2026-09-21T08:00:00.000Z', maxBusinessDays: 1 } });
    input.observedAt = date('2026-09-21T08:00:00.001Z');
    expect(result(input, 'price_requested_duration').status).toBe('FAIL');
    expect(result(input, 'stage_duration')).toMatchObject({ status: 'NA', details: { delegatedTo: 'price_requested_duration' } });
    input.communications = [{ id: 'message', createdAt: date('2026-09-21T07:00:00Z'), text: 'Завод ответит завтра' }];
    expect(result(input, 'price_requested_duration').status).toBe('REVIEW');
    input.scope.stageRules.price = { deadlineMode: 'unlimited' };
    expect(result(input, 'price_requested_duration').status).toBe('NA');
    expect(result(input, 'stage_duration').status).toBe('NA');
  });
});
