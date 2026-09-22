import { CrmControlOfferSelectionInput, selectCrmControlOfferCandidate } from './crm-control-offer.selection';
import { CrmControlOfferTextUnit, crmControlOfferTextHash, validateCrmControlOffer } from './crm-control-offer.validation';

const scope = { dealId: 'deal-1', ownerId: 'owner-1', observationId: 'observation-1', snapshotHash: 'a'.repeat(64) };
const artifactSha256 = 'b'.repeat(64);
const unit = (text: string, index = 1): CrmControlOfferTextUnit => ({ id: 'page-' + index, scope: { ...scope }, outgoingSourceId: 'message-1',
  textHash: crmControlOfferTextHash(text), text, artifactSha256, locator: { kind: 'pdf', page: index }, quality: 'VERIFIED_TEXT' });
const input = (text: string): CrmControlOfferSelectionInput => ({ scope: { ...scope }, outgoingSourceId: 'message-1', artifactSha256,
  extractionComplete: true, textUnits: [unit(text)] });

describe('deterministic native offer candidate selection', () => {
  it.each([
    ['Коммерческое предложение\nИтого: 1 234,56 RUB', '1234.56', 'RUB'],
    ['КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ № КП-7\r\n  Всего к оплате: 1\u202f000 ₽', '1000', 'RUB'],
    ['Commercial offer\nTotal: EUR 100.00', '100', 'EUR'],
    ['Commercial offer\nGrand total: 0 USD', '0', 'USD'],
    ['Коммерческое предложение\nИтого: 100₽', '100', 'RUB'],
    ['Коммерческое предложение\nОбщая стоимость: 100 российских рублей', '100', 'RUB'],
    ['Коммерческое предложение\nИтого включая НДС: 9007199254740993.21 RUB', '9007199254740993.21', 'RUB'],
  ])('selects an exact final amount without floating arithmetic: %s', (text, decimal, currency) => {
    const selected = selectCrmControlOfferCandidate(input(text));
    expect(selected).toMatchObject({ classification: 'OFFER', status: 'SELECTED', amount: { decimal, currency, status: 'VERIFIED_UNAMBIGUOUS' } });
    const citation = selected.amount!.amountCitation;
    expect(text.slice(citation.start, citation.end)).toBe(citation.quote);
    expect(citation.quote.slice(selected.amount!.amountTokenStart, selected.amount!.amountTokenStart + selected.amount!.amountToken.length)).toBe(selected.amount!.amountToken);
    expect(selected.headingEvidence).toHaveLength(1);
  });

  it.each([
    'Итого 100 RUB',
    'Файл: Коммерческое предложение.pdf\nИтого 100 RUB',
    'Это не коммерческое предложение\nИтого 100 RUB',
    'Счёт на оплату № 1\nИтого 100 RUB',
    'Invoice\nTotal 100 EUR',
    'Проект договора\nИтого 100 RUB',
  ])('keeps unclassified attachments unresolved instead of excluding them: %s', text => {
    expect(selectCrmControlOfferCandidate(input(text))).toMatchObject({ classification: 'UNRESOLVED', status: 'UNKNOWN', amount: null });
  });

  it.each([
    'Итого: -100 RUB', 'Итого: +100 RUB', 'Итого: 100 % RUB', 'Итого: 100 тыс. RUB',
    'Итого: 100 млн RUB', 'Итого: 100–200 RUB', 'Итого: 100/200 RUB', 'Итого: 100 * 2 RUB',
    'Итого: 1e3 RUB', 'Итого: 01 RUB', 'Итого: 1,234 RUB', 'Итого: 1,234.56 USD',
    'Итого: 100RUB', 'Итого: 100 RUB/месяц', 'Итого: от 100 RUB', 'Итого: до 100 RUB',
    'Итого: 100 USD (примерно)', 'Итого: 100 RUBLE', 'Итого: 100 руб.', 'Итого: 100 $',
    'Итого: 100 ¥', 'Итого: 100 GBP и 10 EUR', 'Итого налога: 100 RUB', 'Итого без НДС: 100 RUB',
    'Subtotal: 100 EUR',
  ])('does not select partial or qualified numeric tokens: %s', total => {
    expect(selectCrmControlOfferCandidate(input('Коммерческое предложение\n' + total))).toMatchObject({ classification: 'OFFER', status: 'UNKNOWN', amount: null });
  });

  it.each([
    'Цена позиции 100 RUB\nЦена позиции 200 RUB',
    'Итого 100 RUB\nВсего к оплате 120 RUB',
    'Итого 100 RUB\nИтого 100 RUB',
    'Subtotal 100 RUB\nTotal 120 RUB',
    'Итого 100 RUB\nСтоимость в USD 2',
    'Итого 100 RUB\nСтоимость в usd 2',
    'Итого 100 RUB\nКурс 1$ = 100 RUB',
    'Предварительная стоимость\nИтого 100 RUB',
    'Итого 100 RUB\nЦена не окончательная',
    'Вариант 2\nИтого 100 RUB',
    'Итого 100 RUB\nНДС дополнительно',
  ])('keeps multiple, absent and nonfinal totals unknown: %s', body => {
    expect(selectCrmControlOfferCandidate(input('Коммерческое предложение\n' + body))).toMatchObject({ classification: 'OFFER', status: 'UNKNOWN', amount: null });
  });

  it('allows line item prices when there is exactly one clear final total', () => {
    expect(selectCrmControlOfferCandidate(input('Коммерческое предложение\nТовар А: 100 RUB\nТовар Б: 200 RUB\nВсего к оплате: 300 RUB')))
      .toMatchObject({ status: 'SELECTED', amount: { decimal: '300', currency: 'RUB' } });
  });
  it('does not stitch a total label and amount from separate spreadsheet cells', () => {
    const request = input('Коммерческое предложение');
    request.textUnits.push(unit('Итого', 2), unit('100 RUB', 3));
    request.textUnits.forEach((entry, index) => { entry.locator = { kind: 'xlsx', sheet: 'КП', cell: `A${index + 1}` }; });
    expect(selectCrmControlOfferCandidate(request)).toMatchObject({ status: 'UNKNOWN', amount: null });
  });
  it.each(['incomplete', 'ocr', 'hash', 'scope', 'source', 'artifact', 'message', 'duplicate-id', 'invalid-locator'])('rejects unverified native source: %s', variant => {
    const request = input('Коммерческое предложение\nИтого 100 RUB');
    if (variant === 'incomplete') request.extractionComplete = false;
    if (variant === 'ocr') request.textUnits[0].quality = 'UNVERIFIED';
    if (variant === 'hash') request.textUnits[0].textHash = '0'.repeat(64);
    if (variant === 'scope') request.textUnits[0].scope.dealId = 'other-deal';
    if (variant === 'source') request.textUnits[0].outgoingSourceId = 'other-message';
    if (variant === 'artifact') request.textUnits[0].artifactSha256 = '0'.repeat(64);
    if (variant === 'message') request.textUnits[0].locator = { kind: 'message' };
    if (variant === 'duplicate-id') request.textUnits.push({ ...request.textUnits[0] });
    if (variant === 'invalid-locator') request.textUnits[0].locator = { kind: 'pdf', page: 0 };
    expect(selectCrmControlOfferCandidate(request)).toMatchObject({ status: 'UNKNOWN', amount: null, classification: 'UNRESOLVED' });
  });
  it('keeps large or excessive input bounded', () => {
    const request = input('Коммерческое предложение\nИтого 100 RUB');
    request.textUnits = Array.from({ length: 129 }, (_, index) => unit('Итого 100 RUB', index));
    expect(selectCrmControlOfferCandidate(request)).toMatchObject({ status: 'UNKNOWN' });
  });
  it('retains exact evidence across independent title and total pages', () => {
    const request = input('Коммерческое предложение');
    request.textUnits.push(unit('Итого 2100 RUB', 2));
    const result = selectCrmControlOfferCandidate(request);
    expect(result).toMatchObject({ status: 'SELECTED', amount: { decimal: '2100', amountToken: '2100', amountCitation: { locator: { kind: 'pdf', page: 2 } } } });
  });
  it('still requires the main validator and complete outgoing chronology', () => {
    const request = input('Коммерческое предложение\nИтого 2100 RUB');
    const selection = selectCrmControlOfferCandidate(request);
    const file = { fileUuid: null, versionUuid: null, sha256: artifactSha256 };
    const validation = { schemaVersion: 1 as const, scope, observedAt: '2026-09-22T16:05:00Z', dealCreatedAt: '2026-09-22T10:00:00Z',
      history: { scope, status: 'VERIFIED_COMPLETE' as const, from: '2026-09-22T10:00:00Z', through: '2026-09-22T16:05:00Z',
        offerClassificationComplete: true, offers: [{ scope, sourceId: 'message-1', sentAt: '2026-09-22T12:00:00Z', direction: 'outgoing' as const,
          sender: 'manager' as const, recipient: 'customer' as const, files: [file] }] },
      selectedLatestOffer: { scope, sourceId: 'message-1', amount: selection.amount, proposalFile: file },
      textUnits: request.textUnits, budget: { decimal: '2100', currency: 'RUB' }, proposalField: { readComplete: true, files: [file] } };
    expect(validateCrmControlOffer(validation).offerBudget.status).toBe('PASS');
    expect(validateCrmControlOffer({ ...validation, budget: { decimal: '100', currency: 'RUB' } }).offerBudget.status).toBe('FAIL');
    expect(validateCrmControlOffer({ ...validation, history: { ...validation.history, status: 'UNVERIFIED' } }).offerBudget.status).toBe('UNKNOWN');
  });
});
