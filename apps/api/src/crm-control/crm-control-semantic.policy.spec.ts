import { assessCrmControlSemantic } from './crm-control-semantic.policy';
import { CrmControlSemanticCheck, CrmControlSemanticRequest, CrmControlSemanticValidation } from './crm-control-semantic.validation';

const request = (check: CrmControlSemanticCheck): CrmControlSemanticRequest => ({ schemaVersion: 1, requestId: 'request', check,
  dealId: 'deal', ownerId: 'manager', subjectId: check === 'task_action' ? 'task' : null, observedAt: '2026-09-22T20:59:00Z',
  stageEnteredAt: '2026-09-21T08:00:00Z', timeZone: 'Europe/Moscow', stageName: 'КП презентовано',
  maxDueAt: '2026-09-21T16:00:00Z', taskDueAt: '2026-09-23T08:00:00Z', coverage: { tasks: true, notes: true, communications: true }, sources: [] });
function validation(input: CrmControlSemanticRequest, states: Record<string, string>, date?: { value: string; precision: 'day' | 'minute' }): CrmControlSemanticValidation {
  return { status: 'VALIDATED', requestId: input.requestId, check: input.check, subjectId: input.subjectId, issues: [],
    findings: Object.entries(states).map(([fact, state]) => ({ fact, state, evidence: [], ...(/date|deadline/.test(fact) && date ? { date } : {}) })) as any };
}
describe('local semantic deterministic policy', () => {
  it.each(['UNKNOWN','INVALID'])('never accepts %s findings', status => {
    const input = request('task_action'), answer = validation(input, { action: 'present', stage_relevance: 'present' });
    answer.status = status as any;
    expect(assessCrmControlSemantic(input, answer, 'task_text').status).toBe('UNKNOWN');
  });
  it.each(['requestId','check','subjectId'])('rejects a different %s', key => {
    const input = request('task_action'), answer = validation(input, { action: 'present', stage_relevance: 'present' });
    (answer as any)[key] = 'other';
    expect(assessCrmControlSemantic(input, answer, 'task_text').status).toBe('UNKNOWN');
  });
  it('requires both a next action and relevance to the stage', () => {
    const input = request('task_action');
    for (const fact of ['action','stage_relevance']) {
      const states = { action: 'present', stage_relevance: 'present', [fact]: 'absent' };
      expect(assessCrmControlSemantic(input, validation(input, states), 'task_text').status).toBe('FAIL');
    }
    expect(assessCrmControlSemantic(input, validation(input, { action: 'present', stage_relevance: 'present' }), 'task_text').status).toBe('PASS');
  });
  it('interprets an agreed day in the audit timezone and an agreed minute exactly', () => {
    const input = request('proposal_note');
    const states = { transfer_reason: 'present', presentation_date: 'present' };
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-22', precision: 'day' }), 'proposal_note').status).toBe('PASS');
    input.observedAt = '2026-09-22T21:00:00Z';
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-22', precision: 'day' }), 'proposal_note').status).toBe('FAIL');
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-22T21:00:00Z', precision: 'minute' }), 'proposal_note').status).toBe('PASS');
    input.observedAt = '2026-09-22T21:00:01Z';
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-22T21:00:00Z', precision: 'minute' }), 'proposal_note').status).toBe('FAIL');
  });
  it('requires customer agreement and manager note, and checks the actual scheduled action', () => {
    const input = request('deadline_agreement');
    const states = { manager_note: 'present', customer_agreement: 'present', agreed_deadline: 'present' };
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-22', precision: 'day' }), 'task_stage_deadline').status).toBe('FAIL');
    expect(assessCrmControlSemantic(input, validation(input, states, { value: '2026-09-23', precision: 'day' }), 'task_stage_deadline').status).toBe('PASS');
    for (const fact of Object.keys(states)) expect(assessCrmControlSemantic(input, validation(input, { ...states, [fact]: 'absent' }), 'stage_duration').status).toBe('FAIL');
  });
  it.each([['deadline_agreement','stage_duration'],['price_delay','price_requested_duration']] as const)('does not replace missing normative duration with %s', (check, rule) => {
    const input = request(check); input.maxDueAt = null;
    const answer = validation(input, { manager_note: 'present', customer_agreement: 'present', agreed_deadline: 'present', price_delay_reason: 'present' });
    expect(assessCrmControlSemantic(input, answer, rule).status).toBe('UNKNOWN');
  });
  it('does not apply a valid semantic answer to a different rule', () => {
    const input = request('task_action');
    expect(assessCrmControlSemantic(input, validation(input, { action: 'present', stage_relevance: 'present' }), 'offer_budget').status).toBe('UNKNOWN');
  });
});
