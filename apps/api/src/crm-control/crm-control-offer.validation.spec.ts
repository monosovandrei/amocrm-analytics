import {
  CrmControlOfferCitation, CrmControlOfferFile, CrmControlOfferValidationInput,
  crmControlOfferTextHash, validateCrmControlOffer,
} from './crm-control-offer.validation';

const scope = { dealId: 'deal-1', ownerId: 'manager-1', observationId: 'observation-1', snapshotHash: 'a'.repeat(64) };
const currentFile: CrmControlOfferFile = { fileUuid: '11111111-1111-4111-8111-111111111111',
  versionUuid: '22222222-2222-4222-8222-222222222222', sha256: 'b'.repeat(64) };
const olderFile: CrmControlOfferFile = { fileUuid: currentFile.fileUuid,
  versionUuid: '33333333-3333-4333-8333-333333333333', sha256: 'c'.repeat(64) };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function fixture(text = 'Итого: 125 000,50 RUB', money = '125000.50'): CrmControlOfferValidationInput {
  const citation: CrmControlOfferCitation = { unitId: 'unit-1', outgoingSourceId: 'message-1',
    textHash: crmControlOfferTextHash(text), artifactSha256: currentFile.sha256,
    locator: { kind: 'pdf', page: 2 }, quote: text, start: 0, end: text.length };
  const token = text.slice('Итого: '.length, text.lastIndexOf(' '));
  return clone({
    schemaVersion: 1, scope, dealCreatedAt: '2026-09-01T10:00:00+03:00', observedAt: '2026-09-22T19:05:00+03:00',
    history: { scope, status: 'VERIFIED_COMPLETE', from: '2026-09-01T00:00:00+03:00',
      through: '2026-09-22T19:05:00+03:00', offerClassificationComplete: true,
      offers: [{ scope, sourceId: 'message-1', sentAt: '2026-09-22T15:00:00+03:00',
        direction: 'outgoing', sender: 'manager', recipient: 'customer', files: [currentFile] }] },
    selectedLatestOffer: { scope, sourceId: 'message-1', proposalFile: currentFile,
      amount: { status: 'VERIFIED_UNAMBIGUOUS', decimal: money, currency: 'RUB',
        amountCitation: citation, amountToken: token, amountTokenStart: 7,
        currencyCitation: citation, currencyToken: 'RUB', currencyTokenStart: text.length - 3 } },
    textUnits: [{ id: 'unit-1', scope, outgoingSourceId: 'message-1', textHash: crmControlOfferTextHash(text),
      text, artifactSha256: currentFile.sha256, locator: { kind: 'pdf', page: 2 }, quality: 'VERIFIED_TEXT' }],
    budget: { decimal: money, currency: 'RUB' }, proposalField: { readComplete: true, files: [currentFile] },
  });
}

describe('verified sent-offer comparison', () => {
  it('compares exact grounded totals and version identity without mutating evidence', () => {
    const input = fixture(), before = JSON.stringify(input);
    const result = validateCrmControlOffer(input);
    expect(result.offerBudget).toMatchObject({ status: 'PASS', issues: [], details: { offerAmount: '125000.5' } });
    expect(result.proposalFile).toMatchObject({ status: 'PASS', issues: [] });
    expect(JSON.stringify(input)).toBe(before);
    result.offerBudget.evidence[0].quote = 'changed';
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ['0', '0.00', 'PASS'], ['0.10', '0.1', 'PASS'], ['0.30', '0.3', 'PASS'],
    ['9007199254740993.01', '9007199254740993.01', 'PASS'],
    ['9007199254740993.01', '9007199254740993.02', 'FAIL'],
    ['125000.50', '125000.51', 'FAIL'], ['100', '100.000001', 'FAIL'],
  ])('compares %s with %s using bounded decimal integers: %s', (offer, budget, status) => {
    const input = fixture('Итого: ' + offer + ' RUB', offer);
    input.budget.decimal = budget;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe(status);
  });

  it.each(['1e5', '-1', '+1', 'NaN', 'Infinity', '01', '1,00', '1.0000001', '9'.repeat(31)])('rejects noncanonical budget %s', invalid => {
    const input = fixture();
    input.budget.decimal = invalid;
    expect(validateCrmControlOffer(input).offerBudget).toMatchObject({ status: 'UNKNOWN', issues: ['INVALID_MONEY_DECIMAL'] });
  });

  it.each(['UNVERIFIED', 'classification', 'start', 'through'] as const)('requires complete history: %s', variant => {
    const input = fixture();
    if (variant === 'UNVERIFIED') input.history.status = 'UNVERIFIED';
    if (variant === 'classification') input.history.offerClassificationComplete = false;
    if (variant === 'start') input.history.from = '2026-09-01T11:00:00+03:00';
    if (variant === 'through') input.history.through = '2026-09-22T19:04:59+03:00';
    const result = validateCrmControlOffer(input);
    expect(result.offerBudget.status).toBe('UNKNOWN');
    expect(result.proposalFile.status).toBe('UNKNOWN');
  });

  it('returns NA before the first sent offer only when the entire history is complete', () => {
    const input = fixture();
    input.history.offers = [];
    input.selectedLatestOffer = null;
    expect(validateCrmControlOffer(input)).toMatchObject({ offerBudget: { status: 'NA' }, proposalFile: { status: 'NA' } });
    input.history.status = 'UNVERIFIED';
    expect(validateCrmControlOffer(input)).toMatchObject({ offerBudget: { status: 'UNKNOWN' }, proposalFile: { status: 'UNKNOWN' } });
  });

  it.each(['dealId', 'ownerId', 'observationId', 'snapshotHash'] as const)('rejects evidence for another %s', field => {
    for (const target of ['history', 'event', 'selected', 'text'] as const) {
      const input = fixture();
      const changed = target === 'history' ? input.history.scope : target === 'event' ? input.history.offers[0].scope
        : target === 'selected' ? input.selectedLatestOffer!.scope : input.textUnits[0].scope;
      changed[field] = field === 'snapshotHash' ? 'f'.repeat(64) : 'other';
      expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
    }
  });

  it.each(['2026-09-22T19:05:01+03:00', '2026-08-31T12:00:00+03:00',
    '2026-02-30T12:00:00+03:00', '2026-09-22T24:00:00+03:00', '2026-09-22T15:00:00'])('rejects invalid/out-of-snapshot sent time %s', sentAt => {
    const input = fixture();
    input.history.offers[0].sentAt = sentAt;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it.each(['incoming', 'unknown-sender', 'unknown-recipient'] as const)('requires server-attributed outgoing delivery: %s', variant => {
    const input = fixture();
    if (variant === 'incoming') input.history.offers[0].direction = 'incoming';
    if (variant === 'unknown-sender') input.history.offers[0].sender = 'unknown';
    if (variant === 'unknown-recipient') input.history.offers[0].recipient = 'unknown';
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('UNKNOWN');
  });

  it('allows a verified bot delivery without declaring the bot to be the manager', () => {
    const input = fixture();
    input.history.offers[0].sender = 'bot';
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('PASS');
  });

  it('requires the actual latest source, not an older offer with a matching amount', () => {
    const input = fixture();
    input.history.offers.push({ ...clone(input.history.offers[0]), sourceId: 'new-message', sentAt: '2026-09-22T16:00:00+03:00' });
    expect(validateCrmControlOffer(input)).toMatchObject({ offerBudget: { status: 'UNKNOWN' }, proposalFile: { status: 'UNKNOWN' } });
  });

  it('does not invent ordering for simultaneous messages or duplicate source IDs', () => {
    const input = fixture();
    input.history.offers.push({ ...clone(input.history.offers[0]), sourceId: 'other-message' });
    expect(validateCrmControlOffer(input).offerBudget.issues).toContain('LATEST_OFFER_ORDER_AMBIGUOUS');
    input.history.offers[1].sourceId = 'message-1';
    expect(validateCrmControlOffer(input).offerBudget.issues).toContain('UNVERIFIED_OUTGOING_SOURCE');
  });

  it('normalizes timezones before selecting the latest offer', () => {
    const input = fixture();
    input.history.offers.push({ ...clone(input.history.offers[0]), sourceId: 'older-message', sentAt: '2026-09-22T10:00:00Z' });
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('PASS');
  });

  it.each(['AMBIGUOUS', 'UNVERIFIED'] as const)('does not compare a %s total', status => {
    const input = fixture();
    input.selectedLatestOffer!.amount!.status = status;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('PASS');
  });

  it.each(['quote', 'hash', 'file', 'page', 'offset', 'unitId', 'sourceId', 'quality'] as const)('requires authentic %s in amount citations', variant => {
    const input = fixture(), amount = input.selectedLatestOffer!.amount!;
    if (variant === 'quote') amount.amountCitation.quote = 'Итого: 125000.50 USD';
    if (variant === 'hash') amount.amountCitation.textHash = 'd'.repeat(64);
    if (variant === 'file') amount.amountCitation.artifactSha256 = 'd'.repeat(64);
    if (variant === 'page') amount.amountCitation.locator = { kind: 'pdf', page: 3 };
    if (variant === 'offset') amount.amountCitation.start = 1;
    if (variant === 'unitId') amount.amountCitation.unitId = 'other';
    if (variant === 'sourceId') amount.amountCitation.outgoingSourceId = 'other';
    if (variant === 'quality') input.textUnits[0].quality = 'UNVERIFIED';
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it('recomputes source text hashes instead of trusting the citation hash', () => {
    const input = fixture();
    input.textUnits[0].text += ' changed';
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it('cannot borrow the currency from a different attachment in the same message', () => {
    const input = fixture();
    input.history.offers[0].files.push(olderFile);
    input.textUnits.push({ ...clone(input.textUnits[0]), id: 'unit-2', artifactSha256: olderFile.sha256 });
    const citation = input.selectedLatestOffer!.amount!.currencyCitation;
    citation.unitId = 'unit-2';
    citation.artifactSha256 = olderFile.sha256;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it('supports an explicit message-body offer without inventing an attached proposal', () => {
    const input = fixture(), amount = input.selectedLatestOffer!.amount!;
    input.history.offers[0].files = [];
    input.selectedLatestOffer!.proposalFile = null;
    input.textUnits[0].artifactSha256 = null;
    input.textUnits[0].locator = { kind: 'message' };
    for (const citation of [amount.amountCitation, amount.currencyCitation]) {
      citation.artifactSha256 = null;
      citation.locator = { kind: 'message' };
    }
    expect(validateCrmControlOffer(input)).toMatchObject({ offerBudget: { status: 'PASS' }, proposalFile: { status: 'UNKNOWN' } });
  });

  it.each(['100', '000', '1 000', '1000.0'])('does not accept a numeric substring %s as a whole total', token => {
    const input = fixture('Итого: 1000.00 RUB', '100');
    const amount = input.selectedLatestOffer!.amount!;
    amount.amountToken = token;
    amount.amountTokenStart = token === '000' ? 8 : 7;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it.each(['1,234', '-100', '+100', '1 00', '100%'])('leaves ambiguous/signed/formatted token %s unresolved', token => {
    const input = fixture('Итого: ' + token + ' RUB', '100');
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it.each(['2100', '-100', '- 100', '100%', '100 %', '100 тыс.', '100e3', '100/200', '100 - 200'])(
    'does not strip context outside a cited numeric substring: %s', expression => {
      const text = 'Итого: ' + expression + ' RUB';
      const input = fixture(text, '100'), amount = input.selectedLatestOffer!.amount!;
      const start = text.indexOf('100');
      amount.amountCitation = { ...amount.amountCitation, start, end: start + 3, quote: '100' };
      amount.amountToken = '100';
      amount.amountTokenStart = 0;
      expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
    });

  it('does not strip a letter outside a cited currency substring', () => {
    const text = 'Итого: 100 XRUB';
    const input = fixture(text, '100'), amount = input.selectedLatestOffer!.amount!;
    amount.currencyCitation = { ...amount.currencyCitation, start: text.indexOf('RUB'), end: text.length, quote: 'RUB' };
    amount.currencyTokenStart = 0;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it('never converts different or missing currencies', () => {
    const input = fixture();
    input.budget.currency = 'USD';
    expect(validateCrmControlOffer(input).offerBudget.issues).toContain('CURRENCY_MISMATCH_OR_UNKNOWN');
    input.budget.currency = null;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it.each(['$', '¥', 'руб.'])('does not guess the ambiguous currency symbol %s', symbol => {
    const input = fixture('Итого: 100 ' + symbol, '100');
    const amount = input.selectedLatestOffer!.amount!;
    amount.currencyToken = symbol;
    amount.currencyTokenStart = 11;
    expect(validateCrmControlOffer(input).offerBudget.status).toBe('UNKNOWN');
  });

  it('accepts a full UUID/version identity when content has not been downloaded', () => {
    const input = fixture();
    input.selectedLatestOffer!.proposalFile!.sha256 = null;
    input.proposalField.files[0].sha256 = null;
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('PASS');
  });

  it('accepts exact byte identity for a copy with different Drive IDs', () => {
    const input = fixture();
    input.proposalField.files[0] = { ...olderFile, sha256: currentFile.sha256 };
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('PASS');
  });

  it('fails for any older or extra file even when the newest file is also pinned', () => {
    const input = fixture();
    input.proposalField.files.push(olderFile);
    expect(validateCrmControlOffer(input).proposalFile).toMatchObject({ status: 'FAIL', issues: ['EXTRA_OR_OLDER_PROPOSAL_FILE'] });
    input.proposalField.files = [olderFile];
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('FAIL');
  });

  it('fails if a verified sent proposal is missing from the fully read field', () => {
    const input = fixture();
    input.proposalField.files = [];
    expect(validateCrmControlOffer(input).proposalFile).toMatchObject({ status: 'FAIL', issues: ['LATEST_PROPOSAL_MISSING'] });
  });

  it('does not certify an incompletely read field or match by a file name', () => {
    const input = fixture();
    input.proposalField.readComplete = false;
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('UNKNOWN');
    input.proposalField.readComplete = true;
    input.proposalField.files = [{ fileUuid: null, versionUuid: null, sha256: null, name: 'same.pdf' } as CrmControlOfferFile];
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('UNKNOWN');
  });

  it('distinguishes unknown identity from known content that differs', () => {
    const input = fixture();
    input.selectedLatestOffer!.proposalFile = { ...currentFile, sha256: null };
    input.proposalField.files = [{ fileUuid: null, versionUuid: null, sha256: currentFile.sha256 }];
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('UNKNOWN');
  });

  it('rejects conflicting content hashes under the same UUID/version', () => {
    const input = fixture();
    input.proposalField.files[0].sha256 = 'd'.repeat(64);
    expect(validateCrmControlOffer(input).proposalFile).toMatchObject({ status: 'UNKNOWN', issues: ['FILE_IDENTITY_CONFLICT'] });
  });

  it('requires the selected file to be linked to the verified latest delivery', () => {
    const input = fixture();
    input.selectedLatestOffer!.proposalFile = olderFile;
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('UNKNOWN');
  });

  it('does not treat duplicate references to the same version as an older file', () => {
    const input = fixture();
    input.proposalField.files.push(clone(currentFile));
    expect(validateCrmControlOffer(input).proposalFile.status).toBe('PASS');
  });
});
