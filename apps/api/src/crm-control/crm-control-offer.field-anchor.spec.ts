import { anchorCrmControlOfferField, CrmControlFieldAnchorAttachment } from './crm-control-offer.field-anchor';

const sha256 = 'a'.repeat(64), otherSha = 'b'.repeat(64);
const fileUuid = 'a1000000-0000-0000-0000-000000000001', versionUuid = 'b1000000-0000-0000-0000-000000000001';
const scope = { dealId: 'amo:1', ownerId: 'manager-1', observationId: 'observation-1', snapshotHash: 'c'.repeat(64) };
const source = (extra: Partial<CrmControlFieldAnchorAttachment> = {}): CrmControlFieldAnchorAttachment => ({
  sourceId: 'mail:thread-1:message-1', threadId: 'thread-1', messageId: 'message-1', attachmentId: 'attachment-1',
  sentAt: '2026-09-22T12:00:00Z', direction: 'outgoing', binding: 'NOT_BOUND', file: { fileUuid, versionUuid, sha256 }, ...extra,
});
const fixture = () => ({ scope, createdAt: '2026-09-22T10:00:00Z', observedAt: '2026-09-22T16:05:00Z',
  fieldFiles: [{ fileUuid, versionUuid, sha256 }], attachments: [source()] });

describe('exact field file to outgoing attachment anchor', () => {
  it('proves identical outgoing bytes but never latest version or complete history', () => {
    const input = fixture(), result = anchorCrmControlOfferField(input);
    expect(result).toMatchObject({ historyStatus: 'UNVERIFIED', issues: [], anchors: [{ status: 'EXACT_FILE_SENT', scope,
      sourceId: source().sourceId, attachmentId: 'attachment-1', fieldIndexes: [0], matchMethod: 'SHA256',
      contentAuthorized: true, latestVerified: false }] });
    expect(input.attachments[0].binding).toBe('NOT_BOUND');
  });
  it('matches copied bytes even when a different UUID pair owns the identical content', () => {
    const input = fixture(); input.attachments[0].file = { fileUuid: 'c1000000-0000-0000-0000-000000000001', versionUuid, sha256 };
    expect(anchorCrmControlOfferField(input).anchors[0].matchMethod).toBe('SHA256');
  });
  it('accepts exact UUID+version as metadata proof without authorizing contact document reading', () => {
    const input = fixture(); input.attachments[0].file!.sha256 = null;
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [{ matchMethod: 'FILE_VERSION', contentAuthorized: false }],
      issues: ['FIELD_ANCHOR_CONTENT_NOT_AUTHORIZED'] });
  });
  it('normalizes the case of verified UUIDs', () => {
    const input = fixture(); input.attachments[0].file = { fileUuid: fileUuid.toUpperCase(), versionUuid: versionUuid.toUpperCase(), sha256: null };
    expect(anchorCrmControlOfferField(input).anchors[0].matchMethod).toBe('FILE_VERSION');
  });
  it('requires the version, not just file UUID or file name', () => {
    const input = fixture(); input.attachments[0].file = { fileUuid, versionUuid: null, sha256: otherSha };
    Object.assign(input.attachments[0], { fileName: 'КП.pdf', url: `https://example.invalid/${versionUuid}` });
    expect(anchorCrmControlOfferField(input).anchors).toEqual([]);
  });
  it('rejects contradictory byte hashes for the same verified UUID+version', () => {
    const input = fixture(); input.attachments[0].file!.sha256 = otherSha;
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [], issues: ['FIELD_ANCHOR_IDENTITY_CONFLICT'] });
  });
  it.each(['incoming', 'unknown'] as const)('never treats %s mail as outgoing', direction => {
    const input = fixture(); input.attachments[0].direction = direction;
    expect(anchorCrmControlOfferField(input).anchors).toEqual([]);
  });
  it.each(['bad-time', '2026-02-30T12:00:00Z', '2026-09-22T09:00:00Z', '2026-09-22T17:00:00Z', '2026-09-22T24:00:00Z'])('rejects an invalid or out-of-window sending time: %s', sentAt => {
    const input = fixture(); input.attachments[0].sentAt = sentAt;
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [], issues: ['FIELD_ANCHOR_TIME_UNVERIFIED'] });
  });
  it('does not promote later unbound files from the same mail thread', () => {
    const input = fixture(); input.attachments.push(source({ sourceId: 'mail:thread-1:message-2', messageId: 'message-2',
      attachmentId: 'attachment-2', sentAt: '2026-09-22T13:00:00Z', file: { fileUuid: null, versionUuid: null, sha256: otherSha } }));
    const result = anchorCrmControlOfferField(input);
    expect(result.anchors).toHaveLength(1);
    expect(result.anchors[0]).toMatchObject({ laterUnboundAttachments: 1, latestVerified: false });
    expect(result.issues).toContain('FIELD_ANCHOR_LATER_UNBOUND_ATTACHMENTS');
  });
  it.each(['2026-09-22T12:00:00Z', 'missing-time'])('reports ambiguous ordering for a same-time or undated unbound document: %s', sentAt => {
    const input = fixture(); input.attachments.push(source({ sourceId: 'mail:thread-1:message-2', messageId: 'message-2',
      attachmentId: 'attachment-2', sentAt, file: { fileUuid: null, versionUuid: null, sha256: otherSha } }));
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [{ orderUnverifiedAttachments: 1 }],
      issues: expect.arrayContaining(['FIELD_ANCHOR_ORDER_UNVERIFIED']) });
  });
  it('does not copy a file match to another attachment in the same message', () => {
    const input = fixture(); input.attachments.push(source({ attachmentId: 'attachment-2', file: { fileUuid: null, versionUuid: null, sha256: otherSha } }));
    expect(anchorCrmControlOfferField(input).anchors).toHaveLength(1);
    expect(anchorCrmControlOfferField(input).anchors[0].orderUnverifiedAttachments).toBe(1);
  });
  it('keeps other threads separate from the anchored chain', () => {
    const input = fixture(); input.attachments.push(source({ sourceId: 'mail:thread-2:message-2', threadId: 'thread-2', messageId: 'message-2',
      attachmentId: 'attachment-2', sentAt: '2026-09-22T13:00:00Z', file: { fileUuid: null, versionUuid: null, sha256: otherSha } }));
    expect(anchorCrmControlOfferField(input).anchors[0]).toMatchObject({ laterUnboundAttachments: 0, orderUnverifiedAttachments: 0 });
  });
  it('deduplicates identical source metadata and rejects conflicting duplicate source metadata', () => {
    const input = fixture(); input.attachments.push(source());
    expect(anchorCrmControlOfferField(input).anchors).toHaveLength(1);
    input.attachments.push(source({ file: { fileUuid: null, versionUuid: null, sha256: otherSha } }));
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [], issues: ['FIELD_ANCHOR_SOURCE_CONFLICT'] });
  });
  it('requires the source ID to identify this exact thread and message', () => {
    const input = fixture(); input.attachments[0].sourceId = 'mail:other:message';
    expect(anchorCrmControlOfferField(input)).toMatchObject({ anchors: [], issues: ['FIELD_ANCHOR_SOURCE_INVALID'] });
  });
  it('rejects invalid scope and states truncation explicitly', () => {
    const input = fixture();
    expect(anchorCrmControlOfferField({ ...input, scope: { ...scope, snapshotHash: 'bad' } }).issues).toEqual(['FIELD_ANCHOR_SCOPE_INVALID']);
    input.attachments = Array.from({ length: 65 }, (_, index) => source({ attachmentId: `attachment-${index}` }));
    const output = anchorCrmControlOfferField(input);
    expect(output.anchors).toHaveLength(64); expect(output.issues).toContain('FIELD_ANCHOR_LIMIT');
  });
});
