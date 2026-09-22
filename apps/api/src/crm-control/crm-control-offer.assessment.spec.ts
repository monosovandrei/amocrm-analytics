import { createHash } from 'node:crypto';
import { assessArchivedOffer as assessRaw, CrmControlArchivedOfferInput } from './crm-control-offer.assessment';
import { CrmControlDocumentPayload } from './crm-control-local-extraction.client';
import * as validator from './crm-control-offer.validation';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const sha256 = hash('synthetic-proposal-bytes');
const file = { fileUuid: null, versionUuid: null, sha256 };
const sentAt = '2026-09-22T12:00:00Z';
const createdAt = '2026-09-22T10:00:00Z';
const observedAt = '2026-09-22T16:05:00Z';
const artifact = { sha256, storageKey: `${sha256}.bin`, size: 100, contentType: 'application/pdf', capturedAt: observedAt };
const outputSha256 = hash('synthetic-extraction');
const assessArchivedOffer: typeof assessRaw = (input, reader) => {
  // Fixture mutations represent a newly sealed immutable observation snapshot.
  input.scope.snapshotHash = hash(JSON.stringify(input.snapshot));
  return assessRaw(input, reader);
};

function fixture() {
  const scope = { dealId: 'deal-1', ownerId: 'owner-1', observationId: 'observation-1', snapshotHash: hash('snapshot') };
  const snapshot: any = { deal: { id: scope.dealId, responsibleId: scope.ownerId, createdAt, amount: 1234.56 }, observedAt, currency: 'RUB',
    proposalSources: { fieldReadComplete: true, fieldFiles: [{ artifact }], sentAttachments: [{ messageId: 'message-1', sentAt, artifact }], sentHistoryComplete: false },
    browserSources: { communicationsComplete: false, documents: [] },
    communicationSources: { datasetReadComplete: true, sourceCoverage: 'UNVERIFIED' },
    documentAnalysis: { version: 1, documents: [{ sourceSha256: sha256, status: 'COMPLETE', issues: [], outputSha256,
      storageKey: `local-documents-v1/${sha256}.${outputSha256}.json` }] } };
  // Preserve exact decimal source, as an upstream JSON number with fractions is deliberately not guessed.
  snapshot.deal.amount = '1234.56';
  const input: CrmControlArchivedOfferInput = { scope, snapshot };
  const payload: CrmControlDocumentPayload = { extractorVersion: 'local-documents-v1', sourceSha256: sha256, format: 'pdf', mimeType: 'application/pdf',
    status: 'COMPLETE', problems: [], textChars: 0, units: ['Коммерческое предложение', 'Итого: 1 234,56 RUB'].map((text, index) => ({
      text, complete: true, method: 'native', locator: { kind: 'pdf', page: 1, line: index + 1, bbox: [0, index * 20, 400, index * 20 + 15], coordinateSpace: 'pdf-points' } })) };
  const reader = { read: jest.fn().mockResolvedValue(payload) };
  const complete = () => { input.trustedHistory = { scope, status: 'VERIFIED_COMPLETE', from: createdAt, through: observedAt,
    offerClassificationComplete: true, offers: [{ scope, sourceId: 'webhook:message-1', sentAt, direction: 'outgoing', sender: 'manager', recipient: 'customer', files: [file] }] }; };
  return { input, snapshot, payload, reader, complete };
}

describe('archived offer assessment integration', () => {
  afterEach(() => jest.restoreAllMocks());
  it('calls the real validator while keeping current webhook/browser coverage unverified', async () => {
    const f = fixture(), call = jest.spyOn(validator, 'validateCrmControlOffer');
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(call).toHaveBeenCalledTimes(1);
    expect(output.validation.offerBudget).toMatchObject({ status: 'UNKNOWN', issues: ['INCOMPLETE_SENT_HISTORY'] });
    expect(output.validation.proposalFile.status).toBe('UNKNOWN');
    expect(output.messages.offer_budget).toContain('полноты истории');
    expect(output.details.candidates.find(candidate => candidate.source === 'sent')).toMatchObject({ status: 'CANDIDATE_ONLY', classification: 'OFFER',
      selectionStatus: 'SELECTED', amount: { decimal: '1234.56', currency: 'RUB' } });
    expect(f.reader.read).toHaveBeenCalledTimes(1); // Same bytes in КП field and outgoing attachment.
    const request = call.mock.calls[0][0];
    expect(request.textUnits[0]).toMatchObject({ text: 'Коммерческое предложение\nИтого: 1 234,56 RUB', locator: { kind: 'pdf', page: 1 },
      textHash: hash('Коммерческое предложение\nИтого: 1 234,56 RUB') });
    expect(JSON.stringify(output)).not.toContain('storageKey');
    expect(JSON.stringify(output)).not.toContain('bbox');
  });
  it('can produce grounded PASS with an explicit future complete history attestation', async () => {
    const f = fixture(); f.complete();
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS');
    expect(output.validation.proposalFile.status).toBe('PASS');
  });
  function addLaterInvoice(f: ReturnType<typeof fixture>, textSuffix = '') {
    const invoiceSha = hash('synthetic-invoice-bytes'), invoiceOutput = hash('synthetic-invoice-extraction');
    const invoiceArtifact = { ...artifact, sha256: invoiceSha, storageKey: `${invoiceSha}.bin` };
    f.snapshot.browserSources.documents.push({ binding: 'DEAL', threadId: 'invoice-thread', messageId: 'invoice-message',
      attachmentId: 'invoice-attachment', sentAt: '2026-09-22T13:00:00Z', artifact: invoiceArtifact });
    f.snapshot.documentAnalysis.documents.push({ sourceSha256: invoiceSha, status: 'COMPLETE', issues: [], outputSha256: invoiceOutput,
      storageKey: `local-documents-v1/${invoiceSha}.${invoiceOutput}.json` });
    const lines = ['Счёт на оплату № 17 от 22.09.2026', 'Поставщик: ООО Синтетический поставщик', 'Покупатель: ООО Синтетический покупатель',
      'БИК: 044525000', 'Р/с: 40702810000000000000', 'Итого 100 RUB', textSuffix].filter(Boolean);
    const payload: CrmControlDocumentPayload = { ...f.payload, sourceSha256: invoiceSha, units: lines.map((text, index) => ({
      text, complete: true, method: 'native', locator: { kind: 'pdf', page: 1, line: index + 1, bbox: [0, index * 20, 400, index * 20 + 15], coordinateSpace: 'pdf-points' } })) };
    f.reader.read.mockImplementation(async (reference: any) => reference.sourceSha256 === invoiceSha ? payload : f.payload);
    return { payload, invoiceSha, invoiceArtifact };
  }
  it('does not let a later verified invoice block the last offer when the full sending history is independently proven', async () => {
    const f = fixture(); f.complete(); const invoice = addLaterInvoice(f);
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS'); expect(output.validation.proposalFile.status).toBe('PASS');
    const classified = output.details.candidates.find(candidate => candidate.artifactSha256 === invoice.invoiceSha)!;
    expect(classified).toMatchObject({ classification: 'NON_OFFER', selectionStatus: 'CLASSIFIED', amount: null,
      nonOffer: { kind: 'PAYMENT_INVOICE', policyVersion: 'native-non-offer-v1' } });
    expect(classified.nonOffer?.evidence).toHaveLength(5);
    expect(classified.nonOffer?.evidence.every(citation => citation.artifactSha256 === invoice.invoiceSha && citation.outgoingSourceId === 'mail:invoice-thread:invoice-message')).toBe(true);
  });
  it('never upgrades incomplete sending history just because one unrelated attachment has been classified', async () => {
    const f = fixture(); addLaterInvoice(f);
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.candidates.some(candidate => candidate.classification === 'NON_OFFER')).toBe(true);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN'); expect(output.validation.proposalFile.status).toBe('UNKNOWN');
    expect(output.details.historyStatus).toBe('UNVERIFIED');
  });
  it.each(['conflict', 'ocr', 'incomplete'])('keeps an unreadable or possibly commercial later invoice unresolved: %s', async variant => {
    const f = fixture(); f.complete(); const invoice = addLaterInvoice(f, variant === 'conflict' ? 'Дополнительное коммерческое предложение для клиента' : '');
    if (variant === 'ocr') invoice.payload.units[0].method = 'ocr';
    if (variant === 'incomplete') invoice.payload.units[0].complete = false;
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.candidates.find(candidate => candidate.artifactSha256 === invoice.invoiceSha)?.classification).toBe('UNRESOLVED');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN'); expect(output.validation.proposalFile.status).toBe('UNKNOWN');
  });
  it('still flags an invoice stored in the КП field as an extra file', async () => {
    const f = fixture(); f.complete(); const invoice = addLaterInvoice(f);
    f.snapshot.proposalSources.fieldFiles.push({ artifact: invoice.invoiceArtifact });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS');
    expect(output.validation.proposalFile).toMatchObject({ status: 'FAIL', issues: ['EXTRA_OR_OLDER_PROPOSAL_FILE'] });
  });
  it('produces FAIL for a proven different budget and extra/old file', async () => {
    const f = fixture(); f.complete(); f.snapshot.deal.amount = '1000';
    const old = hash('old-proposal');
    f.snapshot.proposalSources.fieldFiles.push({ artifact: { ...artifact, sha256: old, storageKey: `${old}.bin` } });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('FAIL');
    expect(output.validation.proposalFile).toMatchObject({ status: 'FAIL', issues: ['EXTRA_OR_OLDER_PROPOSAL_FILE'] });
  });
  it('does not promote fractional JS money or mismatched currency', async () => {
    const f = fixture(); f.complete(); f.snapshot.deal.amount = 1234.56;
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.issues).toEqual(['INVALID_MONEY_DECIMAL']);
    f.snapshot.deal.amount = '1234.56'; f.snapshot.currency = 'EUR';
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.issues).toEqual(['CURRENCY_MISMATCH_OR_UNKNOWN']);
  });
  it('keeps contact-only mail out of reading and comparison', async () => {
    const f = fixture(); f.complete(); f.snapshot.proposalSources.fieldFiles = []; f.snapshot.proposalSources.sentAttachments = [];
    f.snapshot.browserSources.documents = [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', sentAt, artifact }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.issues).toContain('CONTACT_MAIL_NOT_BOUND');
    expect(output.details.candidates).toHaveLength(0);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(f.reader.read).not.toHaveBeenCalled();
  });
  it('uses bound mail source IDs without claiming unknown mail history is complete', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    f.snapshot.browserSources.documents = [{ binding: 'DEAL', threadId: 't1', messageId: 'm1', sentAt, artifact }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.candidates.some(candidate => candidate.sourceId === 'mail:t1:m1')).toBe(true);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('recognizes sending of identical field bytes in contact mail without trusting the whole thread or latest version', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    f.snapshot.browserSources.documents = [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, artifact }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.fieldAnchors).toEqual([expect.objectContaining({ status: 'EXACT_FILE_SENT', sourceId: 'mail:t1:m1',
      attachmentId: 'a1', matchMethod: 'SHA256', contentAuthorized: true, latestVerified: false })]);
    expect(output.details.candidates.find(candidate => candidate.sourceId === 'mail:t1:m1')).toMatchObject({ source: 'sent',
      status: 'CANDIDATE_ONLY', classification: 'OFFER', amount: { decimal: '1234.56', currency: 'RUB' } });
    expect(output.details.issues).not.toContain('CONTACT_MAIL_NOT_BOUND');
    expect(output.details.issues).not.toContain('NO_ARCHIVED_SENT_OFFER');
    expect(output.details.reasons.join(' ')).toContain('Совпадение содержимого подтверждено');
    expect(output.details.historyStatus).toBe('UNVERIFIED');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.validation.proposalFile.status).toBe('UNKNOWN');
    expect(f.reader.read).toHaveBeenCalledTimes(1);
    expect(f.snapshot.browserSources.documents[0].binding).toBe('NOT_BOUND');
    expect(JSON.stringify(output)).not.toContain('storageKey');
  });
  it('does not read or quote other contact attachments even in the anchored outgoing message', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    const other = hash('private-other-deal-file');
    f.snapshot.browserSources.documents = [
      { binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, artifact },
      { binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a2', sentAt, name: 'same-file-name.pdf',
        artifact: { ...artifact, sha256: other, storageKey: `${other}.bin` } },
    ];
    f.snapshot.documentAnalysis.documents.push({ ...f.snapshot.documentAnalysis.documents[0], sourceSha256: other,
      storageKey: `local-documents-v1/${other}.${outputSha256}.json` });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(f.reader.read).toHaveBeenCalledTimes(1);
    expect(f.reader.read.mock.calls[0][0].sourceSha256).toBe(sha256);
    expect(output.details.candidates.some(candidate => candidate.artifactSha256 === other)).toBe(false);
    expect(output.details.fieldAnchors?.[0].orderUnverifiedAttachments).toBe(1);
    expect(output.details.issues).toContain('FIELD_ANCHOR_ORDER_UNVERIFIED');
    expect(output.details.issues).toContain('CONTACT_MAIL_NOT_BOUND');
  });
  it('explains a later unbound attachment without promoting the matched field file to latest', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    f.snapshot.browserSources.documents = [
      { binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, artifact },
      { binding: 'NOT_BOUND', threadId: 't1', messageId: 'm2', attachmentId: 'a2', sentAt: '2026-09-22T13:00:00Z',
        artifact: { ...artifact, sha256: hash('later-document'), storageKey: `${hash('later-document')}.bin` } },
    ];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.fieldAnchors?.[0]).toMatchObject({ laterUnboundAttachments: 1, latestVerified: false });
    expect(output.details.issues).toContain('FIELD_ANCHOR_LATER_UNBOUND_ATTACHMENTS');
    expect(output.details.reasons.join(' ')).toContain('После совпавшего файла');
    expect(output.validation.proposalFile.status).toBe('UNKNOWN');
  });
  it('keeps a UUID+version-only sending proof separate from permission to read a contact attachment', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    const identity = { fileUuid: 'a1000000-0000-0000-0000-000000000001', versionUuid: 'b1000000-0000-0000-0000-000000000001' };
    Object.assign(f.snapshot.proposalSources.fieldFiles[0], identity);
    f.snapshot.browserSources.documents = [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, ...identity }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.fieldAnchors?.[0]).toMatchObject({ matchMethod: 'FILE_VERSION', contentAuthorized: false });
    expect(output.details.candidates.every(candidate => candidate.source === 'field')).toBe(true);
    expect(output.details.issues).toContain('FIELD_ANCHOR_CONTENT_NOT_AUTHORIZED');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('does not let contradictory byte hashes reuse a field UUID+version for source authorization', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    const identity = { fileUuid: 'a1000000-0000-0000-0000-000000000001', versionUuid: 'b1000000-0000-0000-0000-000000000001' };
    Object.assign(f.snapshot.proposalSources.fieldFiles[0], identity);
    const other = hash('different-bytes');
    f.snapshot.browserSources.documents = [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, ...identity,
      artifact: { ...artifact, sha256: other, storageKey: `${other}.bin` } }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.fieldAnchors).toEqual([]);
    expect(output.details.issues).toContain('FIELD_ANCHOR_IDENTITY_CONFLICT');
    expect(output.details.candidates.every(candidate => candidate.source === 'field')).toBe(true);
  });
  it('ignores snapshot completeness flags even after an exact field-file sending match', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    f.snapshot.browserSources = { communicationsComplete: true, sourceCoverage: 'VERIFIED_COMPLETE',
      documents: [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, artifact }] };
    f.snapshot.proposalSources.sentHistoryComplete = true;
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.fieldAnchors).toHaveLength(1);
    expect(output.details.historyStatus).toBe('UNVERIFIED');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('requires independent full-history attestation to compare a field-anchored send as the latest offer', async () => {
    const f = fixture(); f.complete(); f.snapshot.proposalSources.sentAttachments = [];
    f.input.trustedHistory!.offers[0].sourceId = 'mail:t1:m1';
    f.snapshot.browserSources.documents = [{ binding: 'NOT_BOUND', threadId: 't1', messageId: 'm1', attachmentId: 'a1', sentAt, artifact }];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS');
    expect(output.validation.proposalFile.status).toBe('PASS');
    expect(output.details.fieldAnchors?.[0].latestVerified).toBe(false); // The anchor itself makes no history claim.
  });
  it.each(['missing', 'failed', 'corrupt', 'ocr', 'incomplete', 'duplicate-reference'])('explains unread or untrusted document: %s', async variant => {
    const f = fixture(); f.complete();
    if (variant === 'missing') f.snapshot.documentAnalysis.documents = [];
    if (variant === 'failed') f.snapshot.documentAnalysis.documents[0].status = 'ERROR';
    if (variant === 'corrupt') f.reader.read.mockRejectedValue(new Error('private-token-should-not-leak'));
    if (variant === 'ocr') f.payload.units[0].method = 'ocr';
    if (variant === 'incomplete') f.payload.units[0].complete = false;
    if (variant === 'duplicate-reference') f.snapshot.documentAnalysis.documents.push(f.snapshot.documentAnalysis.documents[0]);
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.details.candidates.every(candidate => candidate.amount === null)).toBe(true);
    expect(output.details.issues.some(code => code.startsWith('DOCUMENT_'))).toBe(true);
    expect(JSON.stringify(output)).not.toContain('private-token');
  });
  it('does not treat a КП field file alone as a sent proposal', async () => {
    const f = fixture(); f.snapshot.proposalSources.sentAttachments = [];
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.candidates[0]).toMatchObject({ source: 'field', classification: 'OFFER' });
    expect(output.details.issues).toContain('NO_ARCHIVED_SENT_OFFER');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('rejects a second К оплате total even when the first Итого is parseable', async () => {
    const f = fixture(); f.complete();
    f.payload.units.push({ text: 'К оплате: 2000 RUB', complete: true, method: 'native', locator: { kind: 'pdf', page: 1, line: 3, coordinateSpace: 'pdf-points' } });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.issues).toContain('MULTIPLE_OFFER_TOTALS');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.messages.offer_budget).toContain('несколько итоговых');
  });
  it('does not invent adjacency for separate XLSX total label and price cells', async () => {
    const f = fixture(); f.complete(); f.payload.format = 'xlsx';
    f.payload.units = ['Коммерческое предложение', 'Итого', '1234,56 RUB'].map((text, index) => ({ text, complete: true, method: 'native',
      locator: { kind: 'xlsx', sheet: 'КП', cell: `A${index + 1}` } }));
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('retains a DOCX paragraph locator without joining table text', async () => {
    const f = fixture(); f.complete(); f.payload.format = 'docx';
    f.payload.units.forEach((unit, index) => { unit.locator = { kind: 'docx', part: 'word/document.xml', path: `/document/body/p[${index + 1}]` }; });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS');
    expect(output.validation.offerBudget.evidence[0].locator).toMatchObject({ kind: 'docx', path: '/document/body/p[2]' });
  });
  it('requires the archived source to exist in the trusted chronology', async () => {
    const f = fixture(); f.complete(); f.input.trustedHistory!.offers[0].sourceId = 'other-message';
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.details.issues).toContain('SENT_HISTORY_CONFLICT');
  });
  it('accepts equivalent timestamp offsets and leaves latest-order ties to the main validator', async () => {
    const f = fixture(); f.complete(); f.input.trustedHistory!.offers[0].sentAt = '2026-09-22T15:00:00+03:00';
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.status).toBe('PASS');
    f.input.trustedHistory!.offers.push({ ...f.input.trustedHistory!.offers[0], sourceId: 'other-message' });
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.issues).toEqual(['LATEST_OFFER_ORDER_AMBIGUOUS']);
  });
  it('can return NA only for an explicitly complete empty offer history', async () => {
    const f = fixture(); f.complete(); f.input.trustedHistory!.offers = []; f.snapshot.proposalSources.sentAttachments = [];
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.status).toBe('NA');
    delete f.input.trustedHistory;
    expect((await assessArchivedOffer(f.input, f.reader)).validation.offerBudget.status).toBe('UNKNOWN');
  });
  it('does not assert that a missing malformed field array is an empty field', async () => {
    const f = fixture(); f.complete(); delete f.snapshot.proposalSources.fieldFiles;
    expect((await assessArchivedOffer(f.input, f.reader)).validation.proposalFile.issues).toEqual(['PROPOSAL_FIELD_INCOMPLETE']);
  });
  it('does not choose between different proposal files in the same outgoing message', async () => {
    const f = fixture(); f.complete(); const other = hash('another-proposal');
    f.snapshot.proposalSources.sentAttachments.push({ messageId: 'message-1', sentAt, artifact: { ...artifact, sha256: other, storageKey: `${other}.bin` } });
    f.snapshot.documentAnalysis.documents.push({ ...f.snapshot.documentAnalysis.documents[0], sourceSha256: other,
      storageKey: `local-documents-v1/${other}.${outputSha256}.json` });
    f.input.trustedHistory!.offers[0].files.push({ fileUuid: null, versionUuid: null, sha256: other });
    f.reader.read.mockImplementation(async ref => ({ ...f.payload, sourceSha256: ref.sourceSha256 }));
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.details.issues).toContain('MULTIPLE_PROPOSALS_IN_MESSAGE');
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.validation.proposalFile.status).toBe('UNKNOWN');
  });
  it('does not verify an older offer while a later attachment remains unread', async () => {
    const f = fixture(); f.complete(); const later = hash('later-unread-proposal');
    f.snapshot.proposalSources.sentAttachments.push({ messageId: 'message-2', sentAt: '2026-09-22T13:00:00Z', artifact: { ...artifact, sha256: later, storageKey: `${later}.bin` } });
    f.input.trustedHistory!.offers.push({ ...f.input.trustedHistory!.offers[0], sourceId: 'webhook:message-2', sentAt: '2026-09-22T13:00:00Z',
      files: [{ fileUuid: null, versionUuid: null, sha256: later }] });
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('UNKNOWN');
    expect(output.validation.proposalFile.status).toBe('UNKNOWN');
    expect(output.details.issues).toContain('DOCUMENT_EXTRACTION_UNAVAILABLE');
  });
  it('does not mistake duplicate references to the same bytes for multiple versions', async () => {
    const f = fixture(); f.complete(); f.snapshot.proposalSources.sentAttachments.push(f.snapshot.proposalSources.sentAttachments[0]);
    const output = await assessArchivedOffer(f.input, f.reader);
    expect(output.validation.offerBudget.status).toBe('PASS');
    expect(output.validation.proposalFile.status).toBe('PASS');
    expect(f.reader.read).toHaveBeenCalledTimes(1);
  });
  it.each(['owner', 'deal', 'hash', 'unassigned'])('does not read another or unbound snapshot: %s', async variant => {
    const f = fixture(); f.complete(); f.input.scope.snapshotHash = hash(JSON.stringify(f.snapshot));
    if (variant === 'owner') f.input.scope.ownerId = 'other-owner';
    if (variant === 'deal') f.input.scope.dealId = 'other-deal';
    if (variant === 'hash') f.input.scope.snapshotHash = '0'.repeat(64);
    if (variant === 'unassigned') f.snapshot.deal.responsibleId = null;
    const result = await assessRaw(f.input, f.reader);
    expect(result.validation.offerBudget.status).toBe('UNKNOWN');
    expect(result.details.issues).toContain(variant === 'unassigned' ? 'DEAL_OWNER_UNVERIFIED' : 'SNAPSHOT_SCOPE_MISMATCH');
    expect(f.reader.read).not.toHaveBeenCalled();
  });
});
