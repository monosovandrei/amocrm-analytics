import { buildCrmControlSemanticRequest, CrmControlSemanticObservation, CrmControlSemanticRule } from './crm-control-semantic.request';
function fixture() {
  const observation: CrmControlSemanticObservation = { id: 'o', dealId: 'd', managerId: 'm', snapshotHash: 'a'.repeat(64),
    observedAt: new Date('2026-09-22T17:00:00Z'), stageName: 'КП подготовлено', run: { config: { timeZone: 'Europe/Moscow' } },
    snapshot: { sourceCompleteness: { deal: true, notes: true, tasks: true, communications: true }, stageEnteredAt: '2026-09-21T08:00:00Z',
      deal: { raw: { responsible_user_id: 12, _embedded: { contacts: [{ id: 34 }] } } },
      tasks: [{ id: 't', externalId: '77', isCompleted: false, title: 'Позвонить клиенту', raw: { responsible_user_id: 12, created_by: 13, created_at: 1790078400 } }],
      notes: [{ id: 'n', type: 'common', text: 'Клиент просит завтра', createdAt: '2026-09-22T10:00:00Z', raw: { created_by: 12 } }],
      communicationSources: { messages: [{ message: { messageId: 'msg', text: 'Позвоните завтра', occurredAt: '2026-09-22T11:00:00Z',
        direction: 'incoming', actorKind: 'external', authorId: 'participant', contactId: '34' } }] } } };
  const result: CrmControlSemanticRule = { id: 'r', ruleCode: 'task_text', subjectId: '77', status: 'REVIEW', details: {} };
  return { observation, result, snapshot: observation.snapshot as any };
}
describe('trusted semantic request builder', () => {
  it('uses the frozen task and separates author from assignee', () => {
    const f = fixture(), built = buildCrmControlSemanticRequest(f.observation, f.result)!;
    expect(built.sources[0]).toMatchObject({ id: 'task:77', text: 'Позвонить клиенту', actor: 'unknown', assignedManagerId: 'm' });
    f.snapshot.tasks[0].raw.responsible_user_id = 99;
    expect(buildCrmControlSemanticRequest(f.observation, f.result)).toBeNull();
  });
  it('never evaluates a future end-of-day obligation or unfinished source read', () => {
    const f = fixture(); f.result.details = { awaitingDayEnd: true };
    expect(buildCrmControlSemanticRequest(f.observation, f.result)).toBeNull();
    f.result.details = {}; f.snapshot.sourceCompleteness.deal = false;
    expect(buildCrmControlSemanticRequest(f.observation, f.result)).toBeNull();
  });
  it('does not use a customer agreement to override a missing or end-of-day normative deadline', () => {
    const f = fixture(); f.result.ruleCode = 'stage_duration'; f.result.subjectId = '';
    expect(buildCrmControlSemanticRequest(f.observation, f.result)).toBeNull();
    f.result.details = { maximumDueAt: '2026-09-22T16:00:00Z', deadlineMode: 'end_of_day' };
    expect(buildCrmControlSemanticRequest(f.observation, f.result)).toBeNull();
  });
  it('does not certify an arbitrary external participant as the customer', () => {
    const f = fixture(); f.result.ruleCode = 'stage_duration'; f.result.subjectId = ''; f.result.details = { maximumDueAt: '2026-09-22T16:00:00Z' };
    expect(buildCrmControlSemanticRequest(f.observation, f.result)!.sources[1].actor).toBe('customer');
    f.snapshot.communicationSources.messages[0].message.contactId = 'another';
    expect(buildCrmControlSemanticRequest(f.observation, f.result)!.sources[1].actor).toBe('unknown');
  });
  it('limits notes to this stage and marks undated sources incomplete', () => {
    const f = fixture(); f.result.ruleCode = 'proposal_note'; f.result.subjectId = '';
    f.snapshot.notes.push({ id: 'old', type: 'common', text: 'Раньше', createdAt: '2026-09-20T10:00:00Z', raw: { created_by: 12 } },
      { id: 'undated', type: 'common', text: 'Без даты', raw: { created_by: 12 } });
    const built = buildCrmControlSemanticRequest(f.observation, f.result)!;
    expect(built.sources.map(source => source.id)).toEqual(['note:n']);
    expect(built.coverage.notes).toBe(false);
  });
});
