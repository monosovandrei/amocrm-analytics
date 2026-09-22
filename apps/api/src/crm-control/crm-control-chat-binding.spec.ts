import { createHash } from 'node:crypto';
import { bindCrmControlChatMessage, CrmControlChatBindingInput, crmControlChatSourceHash } from './crm-control-chat-binding';

const T = (second: number) => `2026-09-22T16:05:${String(second).padStart(2, '0')}.000Z`;
function fixture(): CrmControlChatBindingInput {
  const talk = { talk_id: 11, account_id: 22, chat_id: 'chat-a', contact_id: 33, entity_type: 'lead', entity_id: 44,
    created_at: 1780000100, updated_at: 1780000200, is_read: false, status: 'closed',
    _embedded: { contacts: [{ id: 33 }], leads: [{ id: 44 }], customers: [] } };
  return {
    scope: { connectionId: 'connection-a', accountExternalId: '22', dealExternalId: '44', chatId: 'chat-a', observedAt: T(10) },
    collectionStartedAt: T(0), collectionFinishedAt: T(8),
    message: { requestedChatId: 'chat-a', capturedAt: T(1), value: { id: 'message-a', dialog: { id: 11 },
      created_at: 1780000000, author: { bot: true }, message: { type: 'text', text: 'Synthetic message' } } },
    talk: { requestedTalkId: '11', capturedAt: T(2), httpStatus: 200, value: talk },
    confirmation: { requestedTalkId: '11', capturedAt: T(7), httpStatus: 200, value: structuredClone(talk) },
  };
}

describe('current-snapshot chat message binding', () => {
  it('proves the exact dialog → talk → lead relation with source hashes, without global or historical completeness', () => {
    const input = fixture(), value = bindCrmControlChatMessage(input);
    expect(value).toMatchObject({ status: 'BOUND', reasonCodes: [], communicationsComplete: false, sourceCoverage: 'UNVERIFIED',
      proof: { kind: 'TALK_EXPLICIT_CURRENT_SNAPSHOT', messageId: 'message-a', talkId: '11', contactId: '33', historicalBindingIntervalProven: false,
        messageSourceHash: crmControlChatSourceHash(input.message.value) } });
    expect(value.proof?.scope).not.toBe(input.scope);
  });
  it('does not invent a lower message-time boundary from talk.created_at', () => {
    const input = fixture();
    expect((input.message.value as any).created_at).toBeLessThan((input.talk.value as any).created_at);
    expect(bindCrmControlChatMessage(input).status).toBe('BOUND');
  });
  it('does not infer direction or the author role from a bot flag', () => {
    const value = bindCrmControlChatMessage(fixture());
    expect(value.proof).not.toHaveProperty('direction');
    expect(value.proof).not.toHaveProperty('actorKind');
  });
  it('keeps source identity after JSONB key reordering', () => {
    expect(crmControlChatSourceHash({ b: { z: 2, a: 1 }, a: [2, 1] })).toBe(crmControlChatSourceHash({ a: [2, 1], b: { a: 1, z: 2 } }));
    expect(crmControlChatSourceHash({ b: 2, a: 1 })).toBe(createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
    expect(crmControlChatSourceHash({ a: [1, 2] })).not.toBe(crmControlChatSourceHash({ a: [2, 1] }));
  });
  it('accepts read/status/activity updates when the explicit relation is unchanged', () => {
    const input = fixture();
    Object.assign(input.confirmation.value as any, { is_read: true, status: 'in_work', updated_at: 1780000300 });
    expect(bindCrmControlChatMessage(input).status).toBe('BOUND');
  });
  it.each([401, 403, 404, 204, 500])('does not bind when lookup is HTTP%s', status => {
    const input = fixture(); input.confirmation.httpStatus = status;
    expect(bindCrmControlChatMessage(input)).toMatchObject({ status: 'UNVERIFIED', proof: null, reasonCodes: ['TALK_LOOKUP_UNAVAILABLE'] });
  });
  it.each([
    ['account_id', 999, 'TALK_ACCOUNT_CONFLICT'], ['chat_id', 'chat-b', 'TALK_CHAT_CONFLICT'], ['talk_id', 999, 'TALK_MESSAGE_ID_CONFLICT'],
  ])('rejects wrong %s', (field, value, code) => {
    const input = fixture(); (input.talk.value as any)[field] = value;
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual([code]);
  });
  it('requires the collector request path to name this exact message dialog', () => {
    const input = fixture(); input.confirmation.requestedTalkId = '12';
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['TALK_REQUEST_ID_CONFLICT']);
  });
  it('requires the message to have been read from this chat endpoint', () => {
    const input = fixture(); input.message.requestedChatId = 'chat-b';
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_REQUEST_SCOPE_CONFLICT']);
  });
  it('rejects an explicit message chat that contradicts the transport', () => {
    const input = fixture(); (input.message.value as any).chat_id = 'chat-b';
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_MESSAGE_CHAT_CONFLICT']);
  });
  it('does not use current contact membership when the message has no dialog', () => {
    const input = fixture(); delete (input.message.value as any).dialog;
    expect(bindCrmControlChatMessage(input)).toMatchObject({ status: 'NOT_BOUND', proof: null, reasonCodes: ['CHAT_MESSAGE_DIALOG_MISSING'] });
  });
  it('distinguishes a proven relation to another deal from unknown binding', () => {
    const input = fixture();
    for (const capture of [input.talk, input.confirmation]) Object.assign(capture.value as any, { entity_id: 55,
      _embedded: { contacts: [{ id: 33 }], leads: [{ id: 55 }], customers: [] } });
    expect(bindCrmControlChatMessage(input)).toMatchObject({ status: 'OTHER_DEAL', proof: null });
  });
  it('detects a reassignment between the two captures', () => {
    const input = fixture(); Object.assign(input.confirmation.value as any, { entity_id: 55,
      _embedded: { contacts: [{ id: 33 }], leads: [{ id: 55 }], customers: [] } });
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['TALK_RELATION_CHANGED']);
  });
  it('rejects a contradictory embedded lead', () => {
    const input = fixture(); (input.talk.value as any)._embedded.leads[0].id = 55;
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['TALK_EMBEDDED_ENTITY_CONFLICT']);
  });
  it('rejects contradictory/multiple contacts', () => {
    const input = fixture(); (input.talk.value as any)._embedded.contacts[0].id = 55;
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['TALK_CONTACT_CONFLICT']);
    (input.talk.value as any)._embedded.contacts.push({ id: 33 });
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['TALK_EMBEDDED_INVALID']);
  });
  it.each([
    [null, null, [], [], 'NOT_BOUND'], ['customer', 66, [], [{ id: 66 }], 'OTHER_ENTITY'],
  ])('handles non-lead entity %s explicitly', (entityType, entityId, leads, customers, status) => {
    const input = fixture();
    for (const capture of [input.talk, input.confirmation]) Object.assign(capture.value as any, { entity_type: entityType, entity_id: entityId,
      _embedded: { contacts: [{ id: 33 }], leads, customers } });
    expect(bindCrmControlChatMessage(input).status).toBe(status);
  });
  it.each([
    (input: CrmControlChatBindingInput) => { input.message.capturedAt = T(11); },
    (input: CrmControlChatBindingInput) => { input.confirmation.capturedAt = T(1); },
    (input: CrmControlChatBindingInput) => { input.message.capturedAt = T(8); },
    (input: CrmControlChatBindingInput) => { input.scope.observedAt = T(7); },
    (input: CrmControlChatBindingInput) => { input.collectionStartedAt = '2026-02-30T16:05:00Z'; },
  ])('rejects a capture outside the observation or an invalid date', change => {
    const input = fixture(); change(input);
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_CAPTURE_TIME_INVALID']);
  });
  it('requires valid scope and message identity', () => {
    const input = fixture(); input.scope.accountExternalId = '0';
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_SCOPE_INVALID']);
    input.scope.accountExternalId = '22'; (input.message.value as any).id = '';
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_MESSAGE_INVALID']);
  });
  it('rejects an unserializable/oversized source instead of issuing an incomplete proof', () => {
    const input = fixture(); (input.message.value as any).cycle = input.message.value;
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_SOURCE_UNSERIALIZABLE_OR_TOO_LARGE']);
    delete (input.message.value as any).cycle; (input.message.value as any).text = 'x'.repeat(1_048_576);
    expect(bindCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_SOURCE_UNSERIALIZABLE_OR_TOO_LARGE']);
  });
});
