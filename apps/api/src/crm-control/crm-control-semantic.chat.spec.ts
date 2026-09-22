import { appendCrmControlArchivedChatSources } from './crm-control-semantic.chat';
import { buildCrmControlSemanticRequest, CrmControlSemanticObservation, CrmControlSemanticRule } from './crm-control-semantic.request';
import { CRM_CONTROL_SEMANTIC_FACTS, validateCrmControlSemanticResponse } from './crm-control-semantic.validation';
import { assessCrmControlSemantic } from './crm-control-semantic.policy';

function fixture() {
  const start = '2026-09-22T14:00:00.000Z', finish = '2026-09-22T14:05:00.000Z';
  const connection = { id: 'connection-1', accountId: '42' };
  const snapshot: any = { observedAt: '2026-09-22T16:00:00.000Z', stageEnteredAt: '2026-09-21T08:00:00.000Z',
    sourceCompleteness: { deal: true, notes: true, tasks: true, communications: false },
    deal: { id: 'deal-1', responsibleId: 'owner-1', raw: { id: 123, account_id: 42, responsible_user_id: 12, _embedded: { contacts: [{ id: 55 }] } } },
    notes: [{ id: 'note-1', externalId: '901', type: 'common', createdAt: '2026-09-22T13:00:00.000Z',
      text: 'По просьбе клиента переносим презентацию на 23.09.2026 в 15:30.', raw: { created_by: 12 } }],
    browserSources: { connectionId: connection.id, accountExternalId: '42', dealExternalId: '123', startedAt: start, finishedAt: finish,
      manifest: { storageKey: 'a'.repeat(64) + '.browser-history.json', sha256: 'a'.repeat(64), size: 1000 } } };
  const observation: CrmControlSemanticObservation = { id: 'observation-1', dealId: 'deal-1', dealExternalId: '123', managerId: 'owner-1',
    observedAt: new Date(snapshot.observedAt), stageName: 'КП презентовано', snapshot, snapshotHash: 'b'.repeat(64), run: { config: { timeZone: 'Europe/Moscow' } } };
  const result: CrmControlSemanticRule = { id: 'result-1', ruleCode: 'stage_duration', status: 'REVIEW', subjectId: '', details: { maximumDueAt: '2026-09-22T12:00:00.000Z' } };
  const talk = { talk_id: 11, account_id: 42, chat_id: 'chat-1', contact_id: 55, entity_type: 'lead', entity_id: 123,
    _embedded: { contacts: [{ id: 55 }], leads: [{ id: 123 }], customers: [] } };
  const body = { id: 'message-1', chat_id: 'chat-1', dialog: { id: 11 }, created_at: Date.parse('2026-09-22T13:00:00.000Z') / 1000,
    author: { id: 'customer-1', bot: false }, recipient: { id: 'staff-1' }, message: { type: 'text', text: 'Да, согласен перенести презентацию на 23.09.2026 в 15:30.' } };
  const manifest: any = { schemaVersion: 1, kind: 'crm-browser-history', dealExternalId: '123', connectionId: connection.id, accountExternalId: '42',
    startedAt: start, finishedAt: finish, history: { dealExternalId: '123', entries: [] }, documents: [],
    chatAccount: { accountExternalId: '42', capturedAt: start, accountUsers: [{ amojoId: 'staff-1', crmUserId: '12' }] },
    chatExternalContacts: [{ chatId: 'chat-1', contactId: '55', amojoId: 'customer-1' }],
    chatMessages: [{ text: 'UNTRUSTED NORMALIZED TEXT', eligibleAsSemanticSource: true, actorKind: 'external' }],
    chatHistory: { schemaVersion: 1, accountExternalId: '42', dealExternalId: '123', startedAt: start, finishedAt: finish, readComplete: false, reasonCodes: [],
      chats: [{ chatId: 'chat-1', messages: [{ capture: { requestedChatId: 'chat-1', capturedAt: '2026-09-22T14:01:00.000Z', value: body },
        binding: { status: 'BOUND', proof: { messageSourceHash: 'fake-proof' } } }],
        talks: [{ requestedTalkId: '11', httpStatus: 200, capturedAt: '2026-09-22T14:02:00.000Z', value: talk }],
        confirmations: [{ requestedTalkId: '11', httpStatus: 200, capturedAt: '2026-09-22T14:03:00.000Z', value: structuredClone(talk) }] }] } };
  const request = buildCrmControlSemanticRequest(observation, result)!;
  return { observation, snapshot, result, manifest, connection, body, request,
    run: () => appendCrmControlArchivedChatSources(observation, request, manifest, connection) };
}

describe('private archived chat inputs for local semantic analysis', () => {
  it('rebuilds exact relation and actor from raw captures, keeping channel coverage false', () => {
    const f = fixture(), before = JSON.stringify(f.manifest), request = f.run();
    expect(request.sources).toHaveLength(2);
    expect(request.sources[1]).toMatchObject({ id: 'chat:chat-1:message-1', text: f.body.message.text, actor: 'customer',
      actorId: 'customer-1', direction: 'incoming', kind: 'customer_message', ownerId: 'owner-1', dealId: 'deal-1' });
    expect(request.coverage.communications).toBe(false);
    expect(JSON.stringify(request)).not.toContain('UNTRUSTED'); expect(JSON.stringify(request)).not.toContain('fake-proof');
    expect(JSON.stringify(f.manifest)).toBe(before); expect(f.request.sources).toHaveLength(1);
  });
  it('can prove the existing agreement rule from positive partial history without proving absence', () => {
    const f = fixture(), request = f.run();
    const answer = { schemaVersion: 1, requestId: request.requestId, check: request.check, subjectId: request.subjectId,
      inspectedSourceIds: request.sources.map(source => source.id), findings: CRM_CONTROL_SEMANTIC_FACTS[request.check].map(fact => {
        const source = request.sources[fact === 'manager_note' ? 0 : 1];
        return { fact, state: 'present', evidence: [{ sourceId: source.id, sourceHash: source.sourceHash, quote: source.text }] };
      }) };
    const validated = validateCrmControlSemanticResponse(request, answer);
    expect(validated.status).toBe('VALIDATED'); expect(assessCrmControlSemantic(request, validated, 'stage_duration').status).toBe('PASS');
    answer.findings[1] = { fact: 'customer_agreement', state: 'absent', evidence: [] };
    expect(validateCrmControlSemanticResponse(request, answer).status).toBe('UNKNOWN');
  });
  it.each(['db-account', 'db-connection', 'manifest-account', 'manifest-connection', 'history-deal', 'history-account', 'catalog-account',
    'snapshot-owner', 'snapshot-deal', 'raw-deal', 'raw-account', 'future-finish', 'future-message', 'old-message', 'future-capture',
    'missing-scope', 'different-contact', 'talk-account', 'talk-deal', 'changed-confirmation', 'duplicate-talk', 'duplicate-message',
    'bot', 'unknown-actor', 'unverified-target', 'unverified-deal'])('refuses untrusted archived evidence: %s', variant => {
    const f = fixture(), chat = f.manifest.chatHistory.chats[0];
    if (variant === 'db-account') f.connection.accountId = '99';
    if (variant === 'db-connection') f.connection.id = 'other';
    if (variant === 'manifest-account') f.manifest.accountExternalId = '99';
    if (variant === 'manifest-connection') f.manifest.connectionId = 'other';
    if (variant === 'history-deal') f.manifest.chatHistory.dealExternalId = '999';
    if (variant === 'history-account') f.manifest.chatHistory.accountExternalId = '99';
    if (variant === 'catalog-account') f.manifest.chatAccount.accountExternalId = '99';
    if (variant === 'snapshot-owner') f.snapshot.deal.responsibleId = 'other';
    if (variant === 'snapshot-deal') f.snapshot.deal.id = 'other';
    if (variant === 'raw-deal') f.snapshot.deal.raw.id = 999;
    if (variant === 'raw-account') f.snapshot.deal.raw.account_id = 99;
    if (variant === 'future-finish') f.manifest.finishedAt = f.snapshot.browserSources.finishedAt = '2026-09-23T14:00:00.000Z';
    if (variant === 'future-message') f.body.created_at = Date.parse('2026-09-23T13:00:00.000Z') / 1000;
    if (variant === 'old-message') f.body.created_at = Date.parse('2026-09-20T13:00:00.000Z') / 1000;
    if (variant === 'future-capture') chat.messages[0].capture.capturedAt = '2026-09-23T14:01:00.000Z';
    if (variant === 'missing-scope') delete f.snapshot.browserSources.connectionId;
    if (variant === 'different-contact') f.snapshot.deal.raw._embedded.contacts = [{ id: 999 }];
    if (variant === 'talk-account') chat.talks[0].value.account_id = 99;
    if (variant === 'talk-deal') { chat.talks[0].value.entity_id = 999; chat.talks[0].value._embedded.leads = [{ id: 999 }]; }
    if (variant === 'changed-confirmation') chat.confirmations[0].value.contact_id = 999;
    if (variant === 'duplicate-talk') chat.talks.push(chat.talks[0]);
    if (variant === 'duplicate-message') chat.messages.push(structuredClone(chat.messages[0]));
    if (variant === 'bot') f.body.author.bot = true;
    if (variant === 'unknown-actor') f.body.author.id = 'stranger';
    if (variant === 'unverified-target') f.manifest.chatExternalContacts = [];
    if (variant === 'unverified-deal') f.snapshot.sourceCompleteness.deal = false;
    expect(f.run().sources).toEqual(f.request.sources);
  });
  it('does not elevate another employee to the owner of the observation', () => {
    const f = fixture(); f.body.author.id = 'staff-1'; f.body.recipient.id = 'customer-1';
    expect(f.run().sources[1]).toMatchObject({ actor: 'manager', actorId: '12', kind: 'message' });
    f.manifest.chatAccount.accountUsers[0].crmUserId = '99';
    expect(f.run().sources).toEqual(f.request.sources);
  });
  it('does not load chat content into a task or proposal-note-only request', () => {
    const f = fixture(); f.request.check = 'proposal_note';
    expect(f.run()).toBe(f.request);
  });
});
