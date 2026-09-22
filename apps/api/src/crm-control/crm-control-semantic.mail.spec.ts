import { appendCrmControlArchivedMailSources as append } from './crm-control-semantic.mail';

function fixture() {
  const start = '2026-09-22T14:00:00.000Z', finish = '2026-09-22T14:01:00.000Z';
  const connection = { id: 'connection', accountId: '42' };
  const observation: any = { dealExternalId: '123', dealId: 'deal', managerId: 'manager', observedAt: new Date('2026-09-22T14:02:00.000Z'),
    snapshot: { sourceCompleteness: { deal: true }, deal: { id: 'deal', responsibleId: 'manager', raw: { id: 123, account_id: 42, _embedded: { contacts: [{ id: 55 }] } } },
      browserSources: { connectionId: 'connection', accountExternalId: '42', startedAt: start, finishedAt: finish } } };
  const request: any = { check: 'deadline_agreement', dealId: 'deal', ownerId: 'manager', stageEnteredAt: '2026-09-22T10:00:00.000Z',
    observedAt: observation.observedAt.toISOString(), coverage: { communications: false }, sources: [] };
  const sender = { email: 'customer@example.test', name: 'Customer', type: 'contact', id: '55' };
  const message: any = { id: '901', occurredAt: '2026-09-22T12:00:00.000Z', sent: false, content: '<p>Да, переносим на 25.09.2026.</p>',
    participants: { from: [sender], to: [], cc: [], reasonCodes: [] } };
  const thread: any = { id: '801', binding: 'DEAL', messages: [message] };
  const manifest: any = { connectionId: 'connection', accountExternalId: '42', dealExternalId: '123', startedAt: start, finishedAt: finish,
    history: { dealExternalId: '123', entries: [], threads: [thread] } };
  return { observation, request, manifest, connection, message, sender, thread, read: () => append(observation, request, manifest, connection) };
}
describe('archived email attribution', () => {
  it('appends a current incoming message with native contact binding, without addresses or quoted history', () => {
    const f = fixture(); f.message.content += '<blockquote>PRIVATE OLD TEXT</blockquote>';
    const result = f.read();
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({ actor: 'customer', actorId: 'contact:55', direction: 'incoming', text: 'Да, переносим на 25.09.2026.' });
    expect(JSON.stringify(result)).not.toMatch(/customer@example|PRIVATE OLD TEXT/);
    expect(result.coverage.communications).toBe(false);
  });
  it.each(['unbound','otherContact','outgoing','mailbox','multipleSenders','unknownParticipants','future','beforeStage','otherAccount','otherOwner','otherDeal','lateCapture','quotedOnly'])
    ('excludes ineligible source %s', reason => {
      const f = fixture();
      if (reason === 'unbound') f.thread.binding = 'RELATED_ENTITY';
      if (reason === 'otherContact') f.sender.id = '99';
      if (reason === 'outgoing') f.message.sent = true;
      if (reason === 'mailbox') f.sender.type = 'mailbox';
      if (reason === 'multipleSenders') f.message.participants.from.push({ ...f.sender });
      if (reason === 'unknownParticipants') delete f.message.participants;
      if (reason === 'future') f.message.occurredAt = '2026-09-23T12:00:00Z';
      if (reason === 'beforeStage') f.message.occurredAt = '2026-09-21T12:00:00Z';
      if (reason === 'otherAccount') f.connection.accountId = '43';
      if (reason === 'otherOwner') f.observation.snapshot.deal.responsibleId = 'other';
      if (reason === 'otherDeal') f.manifest.history.dealExternalId = '124';
      if (reason === 'lateCapture') f.manifest.finishedAt = '2026-09-23T12:00:00Z';
      if (reason === 'quotedOnly') f.message.content = '<blockquote>Да</blockquote>';
      expect(f.read().sources).toEqual([]);
    });
  it('requires exact message reference when the thread is related to a contact', () => {
    const f = fixture(); f.thread.binding = 'RELATED_ENTITY';
    f.manifest.history.entries.push({ binding: 'DEAL', entityId: '123', mail: { threadId: '801', messageId: '901', sent: false } });
    expect(f.read().sources).toHaveLength(1);
    f.manifest.history.entries[0].mail.messageId = '902'; expect(f.read().sources).toEqual([]);
  });
});
