import { crmControlAttachmentUrl, indexCrmControlSourcesForDeals, normalizeCrmControlWebhook, normalizeCrmControlWebhookRows } from './crm-control-source.normalizer';
import { CrmControlSourceService } from './crm-control-source.service';
import { CrmControlTalkBindingProof, CrmControlWebhookSourceRow } from './crm-control-source.types';

const occurredAt = new Date('2026-09-22T10:00:00Z');
const receivedAt = new Date('2026-09-22T10:00:01Z');
const observedAt = new Date('2026-09-22T16:05:00Z');
function row(payload: Record<string, unknown> = {}, overrides: Partial<CrmControlWebhookSourceRow> = {}): CrmControlWebhookSourceRow {
  return {
    id: 'row-1', connectionId: 'connection-1', entity: 'outgoing_message', action: 'add', receivedAt,
    payload: {
      id: 'message-1', created_at: occurredAt.getTime() / 1000, type: 'outgoing',
      text: 'Предложение во вложении.', author: { id: 'sender-1', user_id: '55', type: 'internal' },
      recipient: { id: 'client-1', type: 'external' }, entity_id: '123', entity_type: 'lead',
      element_id: '123', element_type: '2', contact_id: '456', talk_id: '789', ...payload,
    }, ...overrides,
  };
}
const normalize = (payload: Record<string, unknown> = {}, overrides: Partial<CrmControlWebhookSourceRow> = {}) => normalizeCrmControlWebhook(row(payload, overrides))!;
const indexOptions = { connectionId: 'connection-1', dealExternalIds: ['123', '124'], observedAt };
const talkProof: CrmControlTalkBindingProof = {
  connectionId: 'connection-1', talkId: '789', leadExternalId: '123',
  validFrom: new Date('2026-09-21T00:00:00Z'), validTo: new Date('2026-09-23T00:00:00Z'), sourceReference: 'event:binding-1',
};

describe('CRM control webhook evidence', () => {
  it('retains exact lead and numeric type 2 without confusing the contact ID', () => {
    const evidence = normalize();
    expect(evidence).toMatchObject({ direction: 'outgoing', actorKind: 'internal', authorUserId: '55',
      contactId: '456', eligibleAsOutgoingEvidence: true, binding: { kind: 'exact_lead', leadExternalId: '123' },
      occurredAt, deliveryStatus: 'UNVERIFIED', issues: [] });
    expect(normalize({ entity_type: undefined, entity_id: undefined, element_type: 2 }).binding).toEqual({ kind: 'exact_lead', leadExternalId: '123' });
  });

  it('keeps Salesbot sends as bot evidence without attributing a manager', () => {
    expect(normalize({ author: { id: 'bot-1', type: 'bot', user_id: '55' } })).toMatchObject({
      direction: 'outgoing', actorKind: 'bot', authorUserId: null, eligibleAsOutgoingEvidence: true,
    });
  });

  it('never classifies an incoming webhook as outgoing, even with outgoing-looking fields', () => {
    expect(normalize({}, { entity: 'message' })).toMatchObject({ direction: 'unverified', eligibleAsOutgoingEvidence: false });
    expect(normalize({ type: 'incoming', author: { id: 'client', type: 'external' }, recipient: undefined }, { entity: 'message' }))
      .toMatchObject({ direction: 'incoming', actorKind: 'external', eligibleAsOutgoingEvidence: false });
    expect(normalize({ author: { id: 'client', type: 'external' } })).toMatchObject({ direction: 'unverified', eligibleAsOutgoingEvidence: false });
  });

  it('requires an external recipient and participant IDs for outgoing proof', () => {
    expect(normalize({ recipient: { id: 'staff', type: 'internal' } }).eligibleAsOutgoingEvidence).toBe(false);
    expect(normalize({ recipient: { type: 'external' } }).issues).toContain('MISSING_PARTICIPANT_ID');
    expect(normalize({ author: { type: 'internal' } }).eligibleAsOutgoingEvidence).toBe(false);
  });

  it('does not infer a deal from a contact or an ID without its entity type', () => {
    const contact = normalize({ entity_type: 'contacts', entity_id: '456', element_type: '1', element_id: '456', talk_id: undefined });
    expect(contact.binding).toEqual({ kind: 'contact_ambiguous', leadExternalId: null });
    const untyped = normalize({ entity_type: undefined, element_type: undefined, talk_id: undefined });
    expect(untyped.binding.leadExternalId).toBeNull();
    const index = indexCrmControlSourcesForDeals([contact, untyped], indexOptions);
    expect(index.unresolved).toHaveLength(2);
    expect([...index.byDeal.values()]).toEqual([[], []]);
  });

  it.each([
    { element_id: '124' }, { element_type: '1' },
  ])('retains conflicting entity bindings for investigation', (payload) => {
    const evidence = normalize(payload);
    expect(evidence.binding.kind).toBe('conflict');
    expect(evidence.eligibleAsOutgoingEvidence).toBe(false);
    expect(indexCrmControlSourcesForDeals([evidence], indexOptions).unresolved).toHaveLength(1);
  });

  it.each([null, '', 'not-a-date', -1, 0, 1.5, Date.now(), Number.NaN])('does not replace invalid source time %s with receipt time', (value) => {
    const evidence = normalize({ created_at: value });
    expect(evidence.occurredAt).toBeNull();
    expect(evidence.eligibleAsOutgoingEvidence).toBe(false);
    expect(evidence.issues).toContain('INVALID_SOURCE_TIME');
  });

  it('flags a source timestamp after its receipt and an invalid receipt', () => {
    expect(normalize({ created_at: receivedAt.getTime() / 1000 + 60 })).toMatchObject({ eligibleAsOutgoingEvidence: false, issues: ['SOURCE_TIME_AFTER_RECEIPT'] });
    expect(normalize({}, { receivedAt: new Date(Number.NaN) }).issues).toContain('INVALID_RECEIPT_TIME');
  });

  it('preserves identical deliveries once, but never overwrites a changed payload for the same message ID', () => {
    const initial = row();
    const before = JSON.stringify(initial);
    const identical = { ...initial, id: 'row-2', payload: Object.fromEntries(Object.entries(initial.payload as object).reverse()) };
    const merged = normalizeCrmControlWebhookRows([initial, identical]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceRefs.map((item) => item.inboxId)).toEqual(['row-1', 'row-2']);
    expect(merged[0].eligibleAsOutgoingEvidence).toBe(true);
    const changed = normalizeCrmControlWebhookRows([initial, row({ text: 'Другое предложение.' }, { id: 'row-3' })]);
    expect(changed).toHaveLength(2);
    expect(changed.every((item) => item.issues.includes('MESSAGE_ID_CONFLICT') && !item.eligibleAsOutgoingEvidence)).toBe(true);
    expect(indexCrmControlSourcesForDeals(changed, indexOptions).unresolved).toHaveLength(2);
    expect(JSON.stringify(initial)).toBe(before);
  });

  it('does not merge the same message ID across accounts', () => {
    const messages = normalizeCrmControlWebhookRows([row(), row({}, { connectionId: 'other' })]);
    expect(messages).toHaveLength(2);
    expect(indexCrmControlSourcesForDeals(messages, indexOptions).byDeal.get('123')).toHaveLength(1);
  });

  it('keeps URL UUIDs and declared identifiers as hints, never as a verified version or file hash', () => {
    const uuid = '9905db7c-3a29-4d30-8953-bac68c05e8e8';
    const evidence = normalize({ attachment: { link: `https://drive-a.amocrm.ru/files/${uuid}/download?token=example`,
      file_name: 'КП.pdf', type: 'file', file_uuid: uuid } });
    expect(evidence.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.attachments[0]).toMatchObject({ urlStatus: 'HTTPS_CANDIDATE', contentSha256: null,
      identifierHints: { fileUuid: uuid, versionUuid: null, urlUuidCandidates: [uuid] } });
  });

  it.each([
    'http://drive-a.amocrm.ru/file', 'file:///etc/passwd', 'javascript:alert(1)',
    'https://user:password@drive-a.amocrm.ru/file', 'https://localhost/file', 'https://host.internal/file',
    'https://127.0.0.1/file', 'https://127.1/file', 'https://0x7f000001/file', 'https://[::1]/file',
    'https://169.254.169.254/file', 'https://drive-a.amocrm.ru:8443/file', 'https://drive-a.amocrm.ru\n/file',
    'https://drive-a.amocrm.ru\\@evil.example.com/file',
  ])('rejects an unsafe attachment URL without exposing it as a download candidate: %s', (url) => {
    expect(crmControlAttachmentUrl(url)).toBeNull();
    const evidence = normalize({ attachment: { link: url, file_name: 'КП.pdf' } });
    expect(evidence.attachments[0]).toMatchObject({ url: null, urlStatus: 'REJECTED', contentSha256: null });
    expect(evidence.issues).toContain('REJECTED_ATTACHMENT_URL');
  });

  it('requires time-scoped, account-scoped talk proof and rejects conflicting talk assignments', () => {
    const message = normalize({ entity_type: undefined, element_type: undefined });
    expect(indexCrmControlSourcesForDeals([message], indexOptions).unresolved).toHaveLength(1);
    const linked = indexCrmControlSourcesForDeals([message], { ...indexOptions, talkBindings: [talkProof] });
    expect(linked.byDeal.get('123')?.[0].bindingProof).toEqual({ kind: 'talk', sourceReference: talkProof.sourceReference });
    for (const proof of [
      { ...talkProof, connectionId: 'other' }, { ...talkProof, validFrom: observedAt },
      { ...talkProof, validTo: occurredAt },
    ]) expect(indexCrmControlSourcesForDeals([message], { ...indexOptions, talkBindings: [proof] }).unresolved).toHaveLength(1);
    expect(indexCrmControlSourcesForDeals([normalize()], { ...indexOptions, talkBindings: [{ ...talkProof, leadExternalId: '124' }] }).unresolved).toHaveLength(1);
  });

  it('separates out-of-scope and post-observation facts and never claims coverage', () => {
    const index = indexCrmControlSourcesForDeals([
      normalize({ entity_id: '999', element_id: '999' }),
      normalize({ created_at: observedAt.getTime() / 1000 + 1 }, { receivedAt: new Date(observedAt.getTime() + 2000) }),
    ], indexOptions);
    expect(index).toMatchObject({ outOfScopeCount: 1, excludedAfterObservationCount: 1, sourceCoverage: 'UNVERIFIED' });
  });
});

describe('CRM control source window reader', () => {
  const request = { connectionId: 'connection-1', receivedFrom: new Date('2026-09-22T00:00:00Z'),
    receivedTo: new Date('2026-09-23T00:00:00Z'), pageSize: 2, maxRows: 10 };
  function fixture(pages: CrmControlWebhookSourceRow[][]) {
    const findMany = jest.fn();
    for (const page of pages) findMany.mockResolvedValueOnce(page);
    return { findMany, service: new CrmControlSourceService({ rawAmoEventInbox: { findMany } } as any) };
  }

  it('reads one connection and bounded receipt window with stable keyset pagination across equal timestamps', async () => {
    const { service, findMany } = fixture([[row(), row({ id: 'message-2' }, { id: 'row-2' })], [row({ id: 'message-3' }, { id: 'row-3' })]]);
    const result = await service.loadForDeals({ ...request, ...indexOptions });
    expect(result.window).toMatchObject({ rowsRead: 3, datasetReadComplete: true, sourceCoverage: 'UNVERIFIED', nextCursor: null });
    expect(result.index.byDeal.get('123')).toHaveLength(3);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: {
      connectionId: 'connection-1',
      receivedAt: { gte: request.receivedFrom, lt: request.receivedTo },
    }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: 2 });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('status');
    expect(findMany.mock.calls[1][0].where.OR).toEqual([
      { receivedAt: { gt: receivedAt } }, { receivedAt, id: { gt: 'row-2' } },
    ]);
  });

  it('marks a reached row cap as incomplete even when it could equal the exact total', async () => {
    const { service, findMany } = fixture([[row(), row({ id: 'message-2' }, { id: 'row-2' })]]);
    expect(await service.loadWindow({ ...request, maxRows: 2 })).toMatchObject({ rowsRead: 2, datasetReadComplete: false,
      nextCursor: { receivedAt, id: 'row-2' }, sourceCoverage: 'UNVERIFIED' });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps an empty window distinct from a complete conversation', async () => {
    const { service } = fixture([[]]);
    expect(await service.loadWindow(request)).toMatchObject({ rowsRead: 0, messages: [], datasetReadComplete: true, sourceCoverage: 'UNVERIFIED' });
  });

  it('does not describe an exhausted cursor suffix as the entire dataset', async () => {
    const { service } = fixture([[]]);
    const after = { id: 'row-2', receivedAt };
    expect(await service.loadWindow({ ...request, after })).toMatchObject({ rowsRead: 0, readAfter: after,
      datasetReadComplete: false, limitReached: false, nextCursor: null, sourceCoverage: 'UNVERIFIED' });
  });

  it('rejects invalid bounds, limits and cursors before querying', async () => {
    const { service, findMany } = fixture([]);
    for (const extra of [
      { connectionId: '' }, { receivedFrom: new Date(Number.NaN) }, { receivedFrom: request.receivedTo },
      { pageSize: 1001 }, { maxRows: 0 }, { maxRows: 50001 },
      { after: { id: 'row', receivedAt: new Date('2026-01-01') } },
    ]) await expect(service.loadWindow({ ...request, ...extra })).rejects.toThrow();
    expect(findMany).not.toHaveBeenCalled();
  });
});
