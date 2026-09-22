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
  /** NON_OFFER requires the explicit document-local policy below, never a filename or missing offer heading alone. */
  classification: 'OFFER' | 'NON_OFFER' | 'UNRESOLVED';
  status: 'SELECTED' | 'CLASSIFIED' | 'UNKNOWN';
  amount: CrmControlSelectedOfferAmount | null;
  headingEvidence: CrmControlOfferCitation[];
  issues: string[];
  nonOffer?: { policyVersion: 'native-non-offer-v1'; kind: 'PAYMENT_INVOICE' | 'COMPLETION_ACT' | 'SIGNATURE_REPORT'; evidence: CrmControlOfferCitation[] };
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

type SourceLine = { unit: CrmControlOfferTextUnit; text: string; start: number };
const DOCUMENT_NUMBER = '(?:[ \\t\\u00a0\\u202f]+№[ \\t\\u00a0\\u202f]*[A-Za-zА-Яа-яЁё0-9/._-]{1,80}(?:[ \\t\\u00a0\\u202f]+от[ \\t\\u00a0\\u202f]+\\d{2}\\.\\d{2}\\.\\d{4})?)?';
const invoiceHeading = new RegExp(`^${SPACE}*Сч[её]т${SPACE}+на${SPACE}+оплату${DOCUMENT_NUMBER}${SPACE}*$`, 'iu');
const actHeading = new RegExp(`^${SPACE}*Акт${SPACE}+(?:выполненных${SPACE}+работ|оказанных${SPACE}+услуг)${DOCUMENT_NUMBER}${SPACE}*$`, 'iu');
const signatureHeading = /^\s*(?:Отч[её]т о проверке электронной подписи|Сведения об электронной подписи)\s*$/iu;
// A commercial component, acceptance clause, sample/draft or instruction to the checker keeps the entire attachment unresolved.
// These are conflict indicators, not proof that a document is an offer.
const offerOrUncertain = /(?:коммерческ[а-яё]*\s+предложени[а-яё]*|оферт[а-яё]*|(?:^|[^А-Яа-яЁёA-Za-z])КП(?:$|[^А-Яа-яЁёA-Za-z])|\b(?:offer|quotation|quote|proposal|proforma)\b|акцепт[а-яё]*|оплата[^\r\n]{0,60}(?:означает|подтверждает)\s+согласие|предлагаем\s+(?:вам|приобрести|купить|поставить)|образец|пример|шаблон|инструкци[а-яё]*|проект\s+(?:сч[её]та|акта)|\b(?:sample|template|draft)\b|игнориру[а-яё]*\s+(?:инструкц|правил)|\b(?:ignore|disregard)\s+(?:instructions?|rules?)\b)/iu;

/** All lines have already passed native completeness, immutable scope, hash and locator checks. */
function explicitNonOffer(lines: SourceLine[]): CrmControlOfferSelection | null {
  // Joining here detects conflicts split across native paragraphs; it never manufactures a citation.
  if (offerOrUncertain.test(lines.map(line => line.text).join('\n').replace(/\s+/gu, ' '))) return null;
  const headers = lines.filter(line => invoiceHeading.test(line.text) || actHeading.test(line.text) || signatureHeading.test(line.text));
  if (headers.length !== 1) return null; // Do not classify concatenated or repeated documents as one administrative attachment.
  const title = headers[0], first = lines[0];
  // A title in a footer, appendix or spreadsheet cell is not enough. Keep this initial policy to PDF/DOCX native text.
  if (!first || lines.indexOf(title) > 19 || title.unit.locator.kind === 'xlsx'
    || (title.unit.locator.kind === 'pdf' && title.unit.locator.page !== 1)
    || (title.unit.locator.kind === 'docx' && title.unit.locator.part !== 'word/document.xml')) return null;
  const find = (pattern: RegExp) => lines.find(line => pattern.test(line.text));
  const supports: Array<SourceLine | undefined> = [];
  let kind: NonNullable<CrmControlOfferSelection['nonOffer']>['kind'];
  if (invoiceHeading.test(title.text)) {
    kind = 'PAYMENT_INVOICE';
    supports.push(find(/^\s*Поставщик(?:\s*\([^\r\n()]{1,50}\))?\s*:\s*\S.{2,1000}$/iu),
      find(/^\s*Покупатель(?:\s*\([^\r\n()]{1,50}\))?\s*:\s*\S.{2,1000}$/iu),
      find(/^\s*БИК\s*:?\s*\d{9}\s*$/iu),
      find(/^\s*(?:Р\/с|Расч[её]тный\s+сч[её]т)\s*:?\s*\d{20}\s*$/iu));
  } else if (actHeading.test(title.text)) {
    kind = 'COMPLETION_ACT';
    supports.push(find(/^\s*(?:Работы выполнены|Услуги оказаны)\s+в полном объ[её]ме(?:\s+и в (?:установленный|согласованный) срок)?\s*[.]?\s*$/iu),
      find(/^\s*Заказчик\s+(?:не имеет претензий(?:\s+по объ[её]му, качеству и срокам)?|претензий по объ[её]му, качеству и срокам (?:выполнения работ|оказания услуг) не имеет)\s*[.]?\s*$/iu));
  } else {
    kind = 'SIGNATURE_REPORT';
    supports.push(find(/^\s*Документ подписан электронной подписью\s*[.]?\s*$/iu),
      find(/^\s*Сертификат\s*:\s*[a-f0-9]{16,128}\s*$/iu));
  }
  if (supports.some(line => !line)) return null;
  const evidence = [title, ...supports as SourceLine[]].map(line => citation(line.unit, line.text, line.start));
  return { classification: 'NON_OFFER', status: 'CLASSIFIED', amount: null, issues: [], headingEvidence: [evidence[0]],
    nonOffer: { policyVersion: 'native-non-offer-v1', kind, evidence } };
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
  const sourceLines: SourceLine[] = [];
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
      if (line.trim()) sourceLines.push({ unit, text: line, start });
      if (heading.test(line)) headings.push(citation(unit, line, start));
      if (totalMarker.test(line)) totals.push({ unit, text: line, start, match: line.match(totalLine) });
    }
  }
  if (!headings.length) return explicitNonOffer(sourceLines) ?? unknown('EXPLICIT_OFFER_HEADING_NOT_FOUND');
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
