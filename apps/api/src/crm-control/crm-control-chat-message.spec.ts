import { createHash } from 'node:crypto';
import { bindCrmControlChatMessage, CrmControlChatBindingInput } from './crm-control-chat-binding';
import { CrmControlChatMessageInput, normalizeCrmControlChatMessage } from './crm-control-chat-message';

const SOURCE_TIME = Date.parse('2026-09-22T15:00:00.000Z') / 1000;
const time = (second: number) => `2026-09-22T16:05:${String(second).padStart(2, '0')}.000Z`;
function fixture(change?: (body: any) => void): CrmControlChatMessageInput {
  const body = { id: 'message-a', dialog: { id: 11 }, created_at: SOURCE_TIME, msec_created_at: SOURCE_TIME * 1000,
    author: { id: 'customer-a', bot: false, origin: 'telegram' }, recipient: { id: 'staff-a', bot: false },
    message: { type: 'text', text: 'Да, согласен перенести\nна 25.09.2026.' } };
  change?.(body);
  const talk = { talk_id: 11, account_id: 22, chat_id: 'chat-a', contact_id: 33, entity_type: 'lead', entity_id: 44,
    created_at: SOURCE_TIME + 20, _embedded: { contacts: [{ id: 33 }], leads: [{ id: 44 }], customers: [] } };
  const capture: CrmControlChatBindingInput = {
    scope: { connectionId: 'connection-a', accountExternalId: '22', dealExternalId: '44', chatId: 'chat-a', observedAt: time(10) },
    collectionStartedAt: time(0), collectionFinishedAt: time(8),
    message: { requestedChatId: 'chat-a', capturedAt: time(1), value: body },
    talk: { requestedTalkId: '11', capturedAt: time(2), httpStatus: 200, value: talk },
    confirmation: { requestedTalkId: '11', capturedAt: time(7), httpStatus: 200, value: structuredClone(talk) },
  };
  return { value: body, binding: bindCrmControlChatMessage(capture), accountUsers: [{ amojoId: 'staff-a', crmUserId: '101' }],
    externalContact: { chatId: 'chat-a', contactId: '33', amojoId: 'customer-a' } };
}

describe('native chat message normalization', () => {
  it('keeps exact customer text and assigns incoming only through the native external contact proof', () => {
    const input = fixture(), result = normalizeCrmControlChatMessage(input), text = (input.value as any).message.text;
    expect(result).toMatchObject({ status: 'NORMALIZED', reasonCodes: [], message: {
      direction: 'incoming', actorKind: 'external', authorId: 'customer-a', authorUserId: null, contactId: '33',
      text, textSha256: createHash('sha256').update(text, 'utf8').digest('hex'), occurredAt: '2026-09-22T15:00:00.000Z',
      eligibleAsSemanticSource: true, eligibleAsOutgoingEvidence: false, deliveryStatus: 'UNVERIFIED',
    } });
  });
  it('maps a verified account author to the exact CRM user without guessing the deal owner', () => {
    const input = fixture(body => { body.author = { id: 'staff-a', bot: false }; body.recipient = { id: 'customer-a' }; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'internal', authorUserId: '101',
      direction: 'outgoing', eligibleAsSemanticSource: true, eligibleAsOutgoingEvidence: true });
  });
  it('keeps bots out of manager/customer semantic roles even when their send direction is established', () => {
    const input = fixture(body => { body.author = { id: 'bot-a', bot: true }; body.recipient = { id: 'customer-a' }; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'bot', authorUserId: null,
      direction: 'outgoing', eligibleAsSemanticSource: false, eligibleAsOutgoingEvidence: true });
  });
  it('preserves the live initial bot-message shape with neither participant equal to the external target', () => {
    const input = fixture(body => { body.author = { id: 'bot-a', bot: true }; body.recipient = { id: 'another-participant' }; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'bot', direction: 'unverified',
      eligibleAsSemanticSource: false, eligibleAsOutgoingEvidence: false });
  });
  it('does not promote a bot to a human just because its UUID is in the account catalog', () => {
    const input = fixture(body => { body.author = { id: 'staff-a', bot: true }; body.recipient = { id: 'customer-a' }; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'bot', authorUserId: null, eligibleAsSemanticSource: false });
  });
  it.each([
    { id: 'unmapped', origin: 'amocrm', admin: true, name: 'Manager', user_id: 101 },
    { id: 'unmapped', origin: 'telegram', bot: false },
    {},
  ])('does not infer a sender from display/origin/admin/unmapped fields', author => {
    const input = fixture(body => { body.author = author; body.recipient = { id: 'customer-a' }; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'unknown', authorUserId: null,
      direction: 'unverified', eligibleAsSemanticSource: false, eligibleAsOutgoingEvidence: false });
  });
  it('does not identify someone as external just because they are absent from account users', () => {
    const input = fixture(); input.externalContact = null; input.accountUsers = [];
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'unknown', direction: 'unverified', eligibleAsSemanticSource: false });
  });
  it('accepts the native external-target author match independently of a recipient catalog entry', () => {
    const input = fixture(); input.accountUsers = [];
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'external', direction: 'incoming', eligibleAsSemanticSource: true });
  });
  it('does not mistake an unresolved native account member for the customer', () => {
    const input = fixture(); input.accountUnknownActorIds = ['customer-a'];
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'unknown', direction: 'unverified', eligibleAsSemanticSource: false });
  });
  it('keeps an exact manager mapping when an unrelated service identity has no CRM user ID', () => {
    const input = fixture(body => { body.author = { id: 'staff-a' }; body.recipient = { id: 'customer-a' }; });
    input.accountUnknownActorIds = ['service-a'];
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'internal', authorUserId: '101', direction: 'outgoing', eligibleAsSemanticSource: true });
  });
  it.each(['contactId', 'chatId'])('rejects an external-contact proof from another %s', field => {
    const input = fixture(); (input.externalContact as any)[field] = 'different';
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'unknown', direction: 'unverified', eligibleAsSemanticSource: false });
  });
  it('detects a participant claimed as both the account employee and external customer', () => {
    const input = fixture(); input.accountUsers = [{ amojoId: 'customer-a', crmUserId: '101' }];
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'unknown', direction: 'unverified', eligibleAsSemanticSource: false });
    expect(normalizeCrmControlChatMessage(input).reasonCodes).toContain('CHAT_PARTICIPANT_ROLE_CONFLICT');
  });
  it('rejects conflicting catalog mappings for this author while allowing exact duplicate rows', () => {
    const input = fixture(body => { body.author = { id: 'staff-a' }; body.recipient = { id: 'customer-a' }; });
    input.accountUsers = [...input.accountUsers, { amojoId: 'staff-a', crmUserId: '102' }];
    expect(normalizeCrmControlChatMessage(input).message?.actorKind).toBe('unknown');
    input.accountUsers = [{ amojoId: 'staff-a', crmUserId: '101' }, { amojoId: 'staff-a', crmUserId: '101' }];
    expect(normalizeCrmControlChatMessage(input).message?.actorKind).toBe('internal');
  });
  it('does not derive customer agreement from a bot external participant', () => {
    const input = fixture(body => { body.author.bot = true; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ actorKind: 'bot', direction: 'incoming', eligibleAsSemanticSource: false });
  });
  it('does not call a self-addressed message an incoming customer exchange', () => {
    const input = fixture(body => { body.recipient.id = body.author.id; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ direction: 'unverified', eligibleAsSemanticSource: false });
  });
  it('uses agreeing milliseconds for precision without changing the documented seconds unit', () => {
    const input = fixture(body => { body.msec_created_at += 123; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ occurredAt: '2026-09-22T15:00:00.123Z', timestampUnit: 'SECONDS' });
  });
  it('accepts explicit milliseconds but never guesses the unit from magnitude', () => {
    const input = fixture(body => { body.created_at *= 1000; });
    expect(normalizeCrmControlChatMessage(input).message?.occurredAt).toBeNull();
    input.createdAtUnit = 'MILLISECONDS';
    expect(normalizeCrmControlChatMessage(input).message?.occurredAt).toBe('2026-09-22T15:00:00.000Z');
  });
  it.each([0, -1, NaN, Infinity, '1780000000', 1780000000.5])('rejects invalid/unverified created_at %p', value => {
    const input = fixture(body => { body.created_at = value; delete body.msec_created_at; });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ occurredAt: null, eligibleAsSemanticSource: false });
  });
  it('rejects contradictory timestamp fields', () => {
    const input = fixture(body => { body.msec_created_at += 1000; });
    expect(normalizeCrmControlChatMessage(input).message?.occurredAt).toBeNull();
    expect(normalizeCrmControlChatMessage(input).reasonCodes).toContain('CHAT_TIMESTAMP_FIELDS_CONFLICT');
  });
  it('rejects an otherwise valid message timestamp after its capture', () => {
    const input = fixture(body => { body.created_at = Date.parse(time(2)) / 1000; body.msec_created_at = body.created_at * 1000; });
    expect(normalizeCrmControlChatMessage(input).reasonCodes).toContain('CHAT_TIMESTAMP_AFTER_CAPTURE');
  });
  it('does not truncate a long text into a false complete source', () => {
    const input = fixture(body => { body.message.text = 'x'.repeat(50_001); });
    expect(normalizeCrmControlChatMessage(input).message).toMatchObject({ text: null, textSha256: null, eligibleAsSemanticSource: false });
    expect(normalizeCrmControlChatMessage(input).reasonCodes).toContain('CHAT_TEXT_INVALID_OR_TOO_LARGE');
  });
  it('keeps media as candidate metadata without turning filename/URL into identity or a file hash', () => {
    const input = fixture(body => { body.message = { type: 'file', text: '', file_name: 'offer.pdf',
      media: 'https://files.example.org/a1b2c3d4-1111-2222-3333-444455556666.pdf' }; });
    expect(normalizeCrmControlChatMessage(input).message?.attachments).toEqual([expect.objectContaining({ name: 'offer.pdf', type: 'file',
      urlStatus: 'HTTPS_CANDIDATE', contentSha256: null, identifierHints: { fileUuid: null, versionUuid: null, urlUuidCandidates: [] } })]);
  });
  it.each(['http://files.example.org/a.pdf', 'https://127.0.0.1/a.pdf', 'https://user:secret@files.example.org/a.pdf'])('rejects unsafe attachment URL', media => {
    const input = fixture(body => { body.message = { type: 'file', media }; });
    expect(normalizeCrmControlChatMessage(input).message?.attachments[0]).toMatchObject({ url: null, urlStatus: 'REJECTED', contentSha256: null });
  });
  it('flags a media message with no attachment reference and an attachment limit', () => {
    const missing = fixture(body => { body.message = { type: 'file', media: '' }; });
    expect(normalizeCrmControlChatMessage(missing).reasonCodes).toContain('CHAT_ATTACHMENT_REFERENCE_MISSING');
    const many = fixture(body => { body.message = { type: 'file', attachments: Array.from({ length: 33 }, (_, index) => ({ link: `https://files.example.org/${index}.pdf` })) }; });
    expect(normalizeCrmControlChatMessage(many).message?.attachments).toHaveLength(32);
    expect(normalizeCrmControlChatMessage(many).reasonCodes).toContain('CHAT_ATTACHMENT_LIMIT');
  });
  it('requires the exact binding/source instead of accepting another captured payload', () => {
    const input = fixture(); (input.value as any).message.text = 'Changed source';
    expect(normalizeCrmControlChatMessage(input)).toMatchObject({ status: 'UNVERIFIED', message: null, reasonCodes: ['CHAT_MESSAGE_SOURCE_CHANGED'] });
    input.binding.status = 'OTHER_DEAL';
    expect(normalizeCrmControlChatMessage(input).reasonCodes).toEqual(['CHAT_BINDING_REQUIRED']);
  });
  it('accepts JSONB key reordering without weakening the message-source check', () => {
    const input = fixture(); input.value = Object.fromEntries(Object.entries(input.value as any).reverse());
    expect(normalizeCrmControlChatMessage(input).message?.eligibleAsSemanticSource).toBe(true);
  });
});
