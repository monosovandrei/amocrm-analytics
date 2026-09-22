import { CrmControlOfferCitation, CrmControlOfferScope, CrmControlOfferTextUnit,
  CrmControlSelectedOfferAmount, crmControlOfferTextHash } from './crm-control-offer.validation';

/** Attachment-local selection only. This does not attest sending, chronology or history coverage. */
export interface CrmControlOfferSelectionInput {
  scope: CrmControlOfferScope;
  outgoingSourceId: string;
  artifactSha256: string;
  /** From the native extractor, never inferred from the presence of some text. */
  extractionComplete: boolean;
  textUnits: CrmControlOfferTextUnit[];
}
export interface CrmControlOfferSelection {
  /** NON_OFFER is reserved for a future explicit policy; this selector never excludes an unrecognised attachment. */
  classification: 'OFFER' | 'NON_OFFER' | 'UNRESOLVED';
  status: 'SELECTED' | 'UNKNOWN';
  amount: CrmControlSelectedOfferAmount | null;
  headingEvidence: CrmControlOfferCitation[];
  issues: string[];
}

const HASH = /^[a-f0-9]{64}$/;
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const scopeValid = (scope: CrmControlOfferScope) => !!scope && id(scope.dealId) && id(scope.ownerId)
  && id(scope.observationId) && typeof scope.snapshotHash === 'string' && HASH.test(scope.snapshotHash);
const sameScope = (left: CrmControlOfferScope, right: CrmControlOfferScope) => scopeValid(left) && scopeValid(right)
  && left.dealId === right.dealId && left.ownerId === right.ownerId && left.observationId === right.observationId && left.snapshotHash === right.snapshotHash;
const CODES = ['RUB', 'USD', 'EUR', 'BYN', 'KZT', 'CNY', 'GBP', 'CHF', 'JPY', 'AED', 'TRY', 'UZS', 'KGS', 'AMD', 'GEL', 'AZN', 'TJS', 'TMT'];
const CURRENCY = `(?:${CODES.join('|')}|₽|€|российских рублей)`;
const NUMBER = '(?:0|[1-9]\\d{0,29}|[1-9]\\d{0,2}(?:[ \\u00a0\\u202f]\\d{3})+)(?:[.,]\\d{1,2})?';
const SPACE = '[ \\t\\u00a0\\u202f]';
const LABEL = '(?:Итого к оплате|Всего к оплате|Итоговая стоимость|Общая стоимость|Итого|Grand total|Total amount|Total due|Total)';
const totalLine = new RegExp(`^${SPACE}*(?<label>${LABEL})(?:${SPACE}+(?:с НДС|включая НДС|including VAT))?${SPACE}*:?${SPACE}*`
  + `(?:(?<number>${NUMBER})${SPACE}*(?<currency>${CURRENCY})|(?<currencyFirst>${CURRENCY})${SPACE}+(?<numberAfter>${NUMBER}))${SPACE}*\\.?${SPACE}*$`, 'iu');
const totalMarker = new RegExp(`^${SPACE}*(?:${LABEL}|К оплате|Сумма к оплате|Итог|Всего|Final total|Amount due|Balance due|Подытог|Subtotal)(?=$|[ \\t\\u00a0\\u202f:.,])`, 'iu');
const heading = new RegExp(`^${SPACE}*(?:Коммерческое${SPACE}+предложение|Commercial${SPACE}+offer)`
  + `(?:${SPACE}+№${SPACE}*[A-Za-zА-Яа-яЁё0-9/._-]{1,80})?${SPACE}*$`, 'iu');
const currencyMention = new RegExp(`(?<![A-Za-zА-Яа-яЁё])(${CURRENCY})(?![A-Za-zА-Яа-яЁё])`, 'giu');

function currency(token: string): string | null {
  if (token === '₽' || token.toLowerCase() === 'российских рублей') return 'RUB';
  if (token === '€') return 'EUR';
  return CODES.includes(token) ? token : null; // Lowercase codes are not silently corrected in a citation.
}

function decimal(token: string) {
  const value = token.replace(/[ \u00a0\u202f]/g, '').replace(',', '.');
  if (!/^(?:0|[1-9]\d{0,29})(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return whole + (trimmed ? '.' + trimmed : '');
}

function locatorValid(unit: CrmControlOfferTextUnit) {
  const value = unit.locator;
  if (!object(value)) return false;
  if (value.kind === 'pdf') return Object.keys(value).length === 2 && Number.isSafeInteger(value.page) && value.page > 0 && value.page <= 100_000;
  if (value.kind === 'docx') return Object.keys(value).length === 3 && id(value.part) && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048;
  if (value.kind === 'xlsx') return Object.keys(value).length === 3 && id(value.sheet) && typeof value.cell === 'string' && /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(value.cell);
  return false; // A message mentioning an offer is not an attachment headed as an offer.
}

function citation(unit: CrmControlOfferTextUnit, line: string, start: number): CrmControlOfferCitation {
  return { unitId: unit.id, outgoingSourceId: unit.outgoingSourceId, textHash: unit.textHash,
    artifactSha256: unit.artifactSha256, locator: { ...unit.locator }, quote: line, start, end: start + line.length };
}

export function selectCrmControlOfferCandidate(input: CrmControlOfferSelectionInput): CrmControlOfferSelection {
  const unknown = (issue: string, headingEvidence: CrmControlOfferCitation[] = []): CrmControlOfferSelection => ({
    classification: headingEvidence.length ? 'OFFER' : 'UNRESOLVED', status: 'UNKNOWN', amount: null, headingEvidence, issues: [issue],
  });
  if (!input || !scopeValid(input.scope) || !id(input.outgoingSourceId) || typeof input.artifactSha256 !== 'string'
    || !HASH.test(input.artifactSha256) || !Array.isArray(input.textUnits) || !input.textUnits.length || input.textUnits.length > 128) return unknown('INVALID_ATTACHMENT_INPUT');
  if (input.extractionComplete !== true) return unknown('EXTRACTION_INCOMPLETE');
  const ids = new Set<string>();
  let textSize = 0;
  for (const unit of input.textUnits) {
    if (!unit || !id(unit.id) || ids.has(unit.id) || !sameScope(unit.scope, input.scope) || unit.outgoingSourceId !== input.outgoingSourceId
      || unit.artifactSha256 !== input.artifactSha256 || unit.quality !== 'VERIFIED_TEXT' || !locatorValid(unit)
      || typeof unit.text !== 'string' || unit.text.length > 16_000 || unit.textHash !== crmControlOfferTextHash(unit.text)) return unknown('ATTACHMENT_TEXT_UNVERIFIED');
    ids.add(unit.id); textSize += unit.text.length;
  }
  if (textSize > 200_000) return unknown('ATTACHMENT_TEXT_LIMIT');
  const headings: CrmControlOfferCitation[] = [];
  const totals: Array<{ unit: CrmControlOfferTextUnit; text: string; start: number; match: RegExpMatchArray | null }> = [];
  const currencies = new Set<string>();
  let qualified = false, ambiguousSymbol = false;
  for (const unit of input.textUnits) {
    // Nonfinal/alternative prices cannot become a verified single final amount.
    qualified ||= /(?:не\s+окончательн|предварительн|ориентировочн|приблизительн|вариант\s*\d|альтернативн|\bestimat(?:e|ed)\b|\bapproximate\b|\bnot\s+final\b|\balternative\b|\boption\s*\d)/iu.test(unit.text)
      || /(?:НДС[^\r\n]{0,80}(?:сверх|дополнительно)|(?:plus|excluding)\s+(?:VAT|tax))/iu.test(unit.text);
    ambiguousSymbol ||= /[$¥£]/u.test(unit.text);
    for (const mention of unit.text.matchAll(currencyMention)) {
      const code = currency(mention[1]) ?? currency(mention[1].toUpperCase()); if (code) currencies.add(code);
    }
    // Preserve source offsets; never concatenate adjacent cells or unrelated paragraphs into a fabricated line.
    const lines = /[^\r\n]+/g;
    for (const match of unit.text.matchAll(lines)) {
      const line = match[0], start = match.index!;
      if (heading.test(line)) headings.push(citation(unit, line, start));
      if (totalMarker.test(line)) totals.push({ unit, text: line, start, match: line.match(totalLine) });
    }
  }
  if (!headings.length) return unknown('EXPLICIT_OFFER_HEADING_NOT_FOUND');
  if (qualified) return unknown('OFFER_AMOUNT_QUALIFIED_OR_ALTERNATIVE', headings);
  if (ambiguousSymbol || currencies.size !== 1) return unknown('OFFER_CURRENCY_AMBIGUOUS', headings);
  if (totals.length !== 1) return unknown(totals.length ? 'MULTIPLE_OFFER_TOTALS' : 'EXPLICIT_FINAL_TOTAL_NOT_FOUND', headings);
  const selected = totals[0], groups = selected.match?.groups;
  if (!groups || selected.text.length > 4000) return unknown('FINAL_TOTAL_FORMAT_UNVERIFIED', headings);
  const amountToken = groups.number ?? groups.numberAfter;
  const currencyToken = groups.currency ?? groups.currencyFirst;
  const amountDecimal = decimal(amountToken), currencyCode = currency(currencyToken);
  if (amountDecimal === null || currencyCode === null || !currencies.has(currencyCode)) return unknown('FINAL_TOTAL_FORMAT_UNVERIFIED', headings);
  const amountTokenStart = selected.text.indexOf(amountToken, groups.label.length);
  const currencyTokenStart = selected.text.indexOf(currencyToken, groups.label.length);
  // Exact full-line grammar prevents partial number/negative/percent/range matches.
  if (amountTokenStart < 0 || currencyTokenStart < 0 || /^[A-Za-zА-Яа-яЁё]/.test(selected.text.slice(amountTokenStart + amountToken.length))) {
    return unknown('FINAL_TOTAL_FORMAT_UNVERIFIED', headings);
  }
  const quote = citation(selected.unit, selected.text, selected.start);
  return { classification: 'OFFER', status: 'SELECTED', issues: [], headingEvidence: headings,
    amount: { status: 'VERIFIED_UNAMBIGUOUS', decimal: amountDecimal, currency: currencyCode,
      amountCitation: quote, amountToken, amountTokenStart,
      currencyCitation: { ...quote, locator: { ...quote.locator } }, currencyToken, currencyTokenStart } };
}
