import { createHash } from 'node:crypto';

/**
 * Pure comparison of server-attested evidence. Coverage, attribution and the
 * semantic selection of the final offer must never come directly from an LLM
 * or an HTTP request. This module cannot prove those upstream attestations.
 */
export interface CrmControlOfferScope {
  dealId: string;
  ownerId: string;
  observationId: string;
  snapshotHash: string;
}
export interface CrmControlOfferFile {
  /** Exact Drive metadata, never UUIDs merely parsed from an attachment URL. */
  fileUuid: string | null;
  versionUuid: string | null;
  /** SHA-256 of downloaded bytes, never of a URL or a file name. */
  sha256: string | null;
}
export interface CrmControlOutgoingOffer {
  scope: CrmControlOfferScope;
  sourceId: string;
  sentAt: string;
  direction: 'outgoing' | 'incoming' | 'unknown';
  sender: 'manager' | 'bot' | 'unknown';
  recipient: 'customer' | 'unknown';
  files: CrmControlOfferFile[];
}
export type CrmControlOfferLocator =
  | { kind: 'pdf'; page: number }
  | { kind: 'docx'; part: string; path: string }
  | { kind: 'xlsx'; sheet: string; cell: string }
  | { kind: 'message' };
export interface CrmControlOfferTextUnit {
  id: string;
  scope: CrmControlOfferScope;
  outgoingSourceId: string;
  /** Hash of exact UTF-8 text, independently computed by the server. */
  textHash: string;
  text: string;
  /** null only for the message body itself. */
  artifactSha256: string | null;
  locator: CrmControlOfferLocator;
  /** OCR text, incomplete extraction or unverified rendering is not promoted here. */
  quality: 'VERIFIED_TEXT' | 'UNVERIFIED';
}
export interface CrmControlOfferCitation {
  unitId: string;
  outgoingSourceId: string;
  textHash: string;
  artifactSha256: string | null;
  locator: CrmControlOfferLocator;
  /** Exact substring and UTF-16 offsets within the immutable text unit. */
  quote: string;
  start: number;
  end: number;
}
export interface CrmControlSelectedOfferAmount {
  status: 'VERIFIED_UNAMBIGUOUS' | 'AMBIGUOUS' | 'UNVERIFIED';
  /** Canonical decimal strings; no JS number, exponent or rounding. */
  decimal: string;
  currency: string;
  amountCitation: CrmControlOfferCitation;
  amountToken: string;
  /** UTF-16 start offset of the complete numeric token within amountCitation.quote. */
  amountTokenStart: number;
  currencyCitation: CrmControlOfferCitation;
  currencyToken: string;
  currencyTokenStart: number;
}
export interface CrmControlOfferValidationInput {
  schemaVersion: 1;
  scope: CrmControlOfferScope;
  dealCreatedAt: string;
  observedAt: string;
  history: {
    scope: CrmControlOfferScope;
    status: 'VERIFIED_COMPLETE' | 'UNVERIFIED';
    /** Includes every relevant channel over the entire interval below. */
    from: string;
    through: string;
    /** No unclassified message/attachment that could be a newer offer. */
    offerClassificationComplete: boolean;
    offers: CrmControlOutgoingOffer[];
  };
  selectedLatestOffer: {
    scope: CrmControlOfferScope;
    sourceId: string;
    amount: CrmControlSelectedOfferAmount | null;
    proposalFile: CrmControlOfferFile | null;
  } | null;
  textUnits: CrmControlOfferTextUnit[];
  budget: { decimal: string | null; currency: string | null };
  proposalField: { readComplete: boolean; files: CrmControlOfferFile[] };
}
export interface CrmControlOfferRuleValidation {
  ruleCode: 'offer_budget' | 'proposal_file';
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'NA';
  issues: string[];
  evidence: CrmControlOfferCitation[];
  details?: Record<string, string | number | string[]>;
}
export interface CrmControlOfferValidation {
  offerBudget: CrmControlOfferRuleValidation;
  proposalFile: CrmControlOfferRuleValidation;
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const crmControlOfferTextHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function scopeValid(scope: CrmControlOfferScope) {
  return !!scope && id(scope.dealId) && id(scope.ownerId) && id(scope.observationId) && hash(scope.snapshotHash);
}
function sameScope(a: CrmControlOfferScope, b: CrmControlOfferScope) {
  return scopeValid(a) && scopeValid(b) && a.dealId === b.dealId && a.ownerId === b.ownerId
    && a.observationId === b.observationId && a.snapshotHash === b.snapshotHash;
}
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const datePart = value.slice(0, 10);
  const day = new Date(datePart + 'T00:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== datePart
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Bounded nonnegative decimal arithmetic: at most 30 integer and 6 fractional digits. */
function decimal(value: unknown): { coefficient: bigint; scale: number; canonical: string } | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,29})(?:\.\d{1,6})?$/.test(value)) return null;
  const [whole, rawFraction = ''] = value.split('.');
  const fraction = rawFraction.replace(/0+$/, '');
  return { coefficient: BigInt(whole + fraction), scale: fraction.length,
    canonical: whole + (fraction ? '.' + fraction : '') };
}
function decimalEqual(left: ReturnType<typeof decimal>, right: ReturnType<typeof decimal>) {
  if (!left || !right) return false;
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * (10n ** BigInt(scale - left.scale)) === right.coefficient * (10n ** BigInt(scale - right.scale));
}

/** Deliberately unambiguous Russian/ISO numeric forms; "1,234" is not guessed. */
function quotedDecimal(token: unknown) {
  if (typeof token !== 'string' || token.length > 48
    || !/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d{1,2})?$/.test(token)) return null;
  return decimal(token.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
}
function tokenGrounded(quote: string, token: unknown, start: unknown, numeric: boolean) {
  if (typeof token !== 'string' || !token || !Number.isSafeInteger(start) || (start as number) < 0) return false;
  const at = start as number;
  if (quote.slice(at, at + token.length) !== token) return false;
  const before = quote.slice(0, at), after = quote.slice(at + token.length);
  if (numeric) {
    // A substring of a larger amount, grouped number, percentage or negative amount is not evidence.
    return !/[\d.,+\-−/]$/.test(before) && !/^[\d.,%/*^A-Za-zА-Яа-яЁё]/.test(after)
      && !/[+\-−][ \u00a0\u202f]*$/.test(before) && !/^[ \u00a0\u202f]*%/.test(after)
      && !/\d[ \u00a0\u202f]+$/.test(before) && !/^[ \u00a0\u202f]+\d/.test(after)
      && !/^[ \u00a0\u202f]*[-−–—][ \u00a0\u202f]*\d/.test(after)
      && !/^[ \u00a0\u202f]+(?:тыс\.?|млн\.?|млрд\.?|тысяч[а-яё]*|миллион[а-яё]*|миллиард[а-яё]*|thousand|million|billion|k\b|m\b)/i.test(after);
  }
  return !/[A-Za-zА-Яа-яЁё]$/.test(before) && !/^[A-Za-zА-Яа-яЁё]/.test(after);
}
function currencyToken(token: string): string | null {
  if (/^[A-Z]{3}$/.test(token)) return token;
  // "$", "¥" and bare "руб." can designate more than one currency.
  if (token === '₽' || token.toLowerCase() === 'российских рублей') return 'RUB';
  if (token === '€') return 'EUR';
  return null;
}
function fileValid(file: CrmControlOfferFile) {
  return object(file) && (file.fileUuid === null || uuid(file.fileUuid))
    && (file.versionUuid === null || uuid(file.versionUuid))
    && (file.sha256 === null || hash(file.sha256))
    && (!!(file.fileUuid && file.versionUuid) || !!file.sha256);
}
type FileMatch = 'SAME' | 'DIFFERENT' | 'UNRESOLVED' | 'CONFLICT';
function fileMatch(a: CrmControlOfferFile, b: CrmControlOfferFile): FileMatch {
  if (!fileValid(a) || !fileValid(b)) return 'UNRESOLVED';
  const havePair = !!(a.fileUuid && a.versionUuid && b.fileUuid && b.versionUuid);
  const samePair = havePair && a.fileUuid!.toLowerCase() === b.fileUuid!.toLowerCase()
    && a.versionUuid!.toLowerCase() === b.versionUuid!.toLowerCase();
  if (samePair && a.sha256 && b.sha256 && a.sha256 !== b.sha256) return 'CONFLICT';
  if ((a.sha256 && b.sha256 && a.sha256 === b.sha256) || samePair) return 'SAME';
  if (havePair || (a.sha256 && b.sha256)) return 'DIFFERENT';
  return 'UNRESOLVED';
}
function locatorKey(value: CrmControlOfferLocator): string | null {
  if (!object(value)) return null;
  if (value.kind === 'message' && Object.keys(value).length === 1) return 'message';
  if (value.kind === 'pdf' && Object.keys(value).length === 2 && Number.isSafeInteger(value.page)
    && value.page > 0 && value.page <= 100_000) return 'pdf:' + value.page;
  if (value.kind === 'docx' && Object.keys(value).length === 3 && id(value.part)
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= 2048) return JSON.stringify(['docx', value.part, value.path]);
  if (value.kind === 'xlsx' && Object.keys(value).length === 3 && id(value.sheet)
    && typeof value.cell === 'string' && /^[A-Z]{1,3}[1-9]\d{0,6}$/.test(value.cell)) return JSON.stringify(['xlsx', value.sheet, value.cell]);
  return null;
}

function citationValid(citation: CrmControlOfferCitation, input: CrmControlOfferValidationInput,
  latest: CrmControlOutgoingOffer): boolean {
  if (!object(citation) || !id(citation.unitId) || !hash(citation.textHash)
    || typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 4000
    || !Number.isSafeInteger(citation.start) || !Number.isSafeInteger(citation.end)
    || citation.start < 0 || citation.end <= citation.start) return false;
  const units = input.textUnits.filter(unit => unit?.id === citation.unitId);
  if (units.length !== 1) return false;
  const unit = units[0];
  if (!sameScope(unit.scope, input.scope) || unit.outgoingSourceId !== latest.sourceId
    || citation.outgoingSourceId !== latest.sourceId || unit.quality !== 'VERIFIED_TEXT'
    || typeof unit.text !== 'string' || unit.text.length > 16_000 || !hash(unit.textHash)
    || unit.textHash !== crmControlOfferTextHash(unit.text) || unit.textHash !== citation.textHash
    || unit.text.slice(citation.start, citation.end) !== citation.quote
    || citation.end > unit.text.length || !locatorKey(unit.locator)
    || locatorKey(unit.locator) !== locatorKey(citation.locator)
    || unit.artifactSha256 !== citation.artifactSha256) return false;
  if (unit.locator.kind === 'message') return unit.artifactSha256 === null;
  return hash(unit.artifactSha256) && latest.files.some(file => file.sha256 === unit.artifactSha256);
}

function citedTokenGrounded(citation: CrmControlOfferCitation, token: string, start: number,
  numeric: boolean, input: CrmControlOfferValidationInput) {
  if (!Number.isSafeInteger(start) || start < 0 || typeof token !== 'string' || !token
    || citation.quote.slice(start, start + token.length) !== token) return false;
  const unit = input.textUnits.find(item => item.id === citation.unitId);
  // Inspect boundaries in the full source. A quote can otherwise cut the leading
  // "2" from "2100", a minus sign, a percent suffix or the first letter of a code.
  return !!unit && tokenGrounded(unit.text, token, citation.start + start, numeric);
}

export function validateCrmControlOffer(input: CrmControlOfferValidationInput): CrmControlOfferValidation {
  const rule = (ruleCode: CrmControlOfferRuleValidation['ruleCode'], status: CrmControlOfferRuleValidation['status'],
    issue: string, evidence: CrmControlOfferCitation[] = [], details?: CrmControlOfferRuleValidation['details']): CrmControlOfferRuleValidation =>
    ({ ruleCode, status, issues: issue ? [issue] : [],
      evidence: evidence.map(item => ({ ...item, locator: { ...item.locator } })),
      ...(details ? { details } : {}) });
  const both = (status: 'UNKNOWN' | 'NA', issue: string): CrmControlOfferValidation => ({
    offerBudget: rule('offer_budget', status, issue), proposalFile: rule('proposal_file', status, issue),
  });
  if (!input || input.schemaVersion !== 1 || !scopeValid(input.scope) || !input.history
    || !input.budget || !input.proposalField || !Array.isArray(input.textUnits) || input.textUnits.length > 128
    || !Array.isArray(input.history.offers) || input.history.offers.length > 4096) return both('UNKNOWN', 'INVALID_INPUT');
  const observed = instant(input.observedAt), created = instant(input.dealCreatedAt);
  const from = instant(input.history.from), through = instant(input.history.through);
  if (observed === null || created === null || created > observed || from === null || through === null
    || !sameScope(input.history.scope, input.scope)) return both('UNKNOWN', 'HISTORY_SCOPE_OR_TIME_MISMATCH');
  if (input.history.status !== 'VERIFIED_COMPLETE' || input.history.offerClassificationComplete !== true
    || from > created || through < observed) return both('UNKNOWN', 'INCOMPLETE_SENT_HISTORY');
  const events: Array<{ event: CrmControlOutgoingOffer; at: number }> = [];
  const sourceIds = new Set<string>();
  for (const event of input.history.offers) {
    const at = instant(event?.sentAt);
    if (!event || !sameScope(event.scope, input.scope) || !id(event.sourceId) || sourceIds.has(event.sourceId)
      || at === null || at < created || at > observed || event.direction !== 'outgoing'
      || !['manager', 'bot'].includes(event.sender) || event.recipient !== 'customer'
      || !Array.isArray(event.files) || event.files.length > 64 || !event.files.every(fileValid)) {
      return both('UNKNOWN', 'UNVERIFIED_OUTGOING_SOURCE');
    }
    sourceIds.add(event.sourceId);
    events.push({ event, at });
  }
  if (!events.length) {
    return input.selectedLatestOffer === null ? both('NA', 'NO_SENT_OFFER') : both('UNKNOWN', 'OFFER_HISTORY_CONFLICT');
  }
  events.sort((a, b) => b.at - a.at);
  if (events.length > 1 && events[0].at === events[1].at) return both('UNKNOWN', 'LATEST_OFFER_ORDER_AMBIGUOUS');
  const latest = events[0].event;
  const selected = input.selectedLatestOffer;
  if (!selected || !sameScope(selected.scope, input.scope) || selected.sourceId !== latest.sourceId) {
    return both('UNKNOWN', 'LATEST_OFFER_NOT_VERIFIED');
  }
  const output: CrmControlOfferValidation = {
    offerBudget: rule('offer_budget', 'UNKNOWN', 'OFFER_AMOUNT_UNVERIFIED'),
    proposalFile: rule('proposal_file', 'UNKNOWN', 'LATEST_PROPOSAL_FILE_UNVERIFIED'),
  };
  const amount = selected.amount;
  if (amount?.status === 'AMBIGUOUS') output.offerBudget = rule('offer_budget', 'UNKNOWN', 'AMBIGUOUS_OFFER_TOTAL');
  else if (amount?.status === 'VERIFIED_UNAMBIGUOUS') {
    const total = decimal(amount.decimal), budget = decimal(input.budget.decimal);
    if (!total || !budget) output.offerBudget = rule('offer_budget', 'UNKNOWN', 'INVALID_MONEY_DECIMAL');
    else if (typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency)
      || amount.currency !== input.budget.currency) output.offerBudget = rule('offer_budget', 'UNKNOWN', 'CURRENCY_MISMATCH_OR_UNKNOWN');
    else if (!citationValid(amount.amountCitation, input, latest) || !citationValid(amount.currencyCitation, input, latest)
      || amount.amountCitation.artifactSha256 !== amount.currencyCitation.artifactSha256
      || !citedTokenGrounded(amount.amountCitation, amount.amountToken, amount.amountTokenStart, true, input)
      || !decimalEqual(total, quotedDecimal(amount.amountToken))
      || !citedTokenGrounded(amount.currencyCitation, amount.currencyToken, amount.currencyTokenStart, false, input)
      || currencyToken(amount.currencyToken) !== amount.currency) {
      output.offerBudget = rule('offer_budget', 'UNKNOWN', 'AMOUNT_OR_CURRENCY_NOT_GROUNDED');
    } else {
      output.offerBudget = rule('offer_budget', decimalEqual(total, budget) ? 'PASS' : 'FAIL',
        decimalEqual(total, budget) ? '' : 'BUDGET_DIFFERS_FROM_SENT_OFFER',
        [amount.amountCitation, amount.currencyCitation],
        { budget: budget.canonical, offerAmount: total.canonical, currency: amount.currency, outgoingSourceId: latest.sourceId });
    }
  }
  const expected = selected.proposalFile;
  if (expected && fileValid(expected)) {
    const sourceMatches = latest.files.map(file => fileMatch(file, expected));
    if (sourceMatches.includes('CONFLICT')) output.proposalFile = rule('proposal_file', 'UNKNOWN', 'FILE_IDENTITY_CONFLICT');
    else if (sourceMatches.includes('SAME')) {
      const field = input.proposalField;
      if (field.readComplete !== true || !Array.isArray(field.files) || field.files.length > 64 || !field.files.every(fileValid)) {
        output.proposalFile = rule('proposal_file', 'UNKNOWN', 'PROPOSAL_FIELD_INCOMPLETE');
      } else {
        const matches = field.files.map(file => fileMatch(file, expected));
        if (matches.includes('CONFLICT')) output.proposalFile = rule('proposal_file', 'UNKNOWN', 'FILE_IDENTITY_CONFLICT');
        else if (!matches.length) output.proposalFile = rule('proposal_file', 'FAIL', 'LATEST_PROPOSAL_MISSING');
        else if (matches.includes('DIFFERENT')) output.proposalFile = rule('proposal_file', 'FAIL', 'EXTRA_OR_OLDER_PROPOSAL_FILE');
        else if (matches.includes('UNRESOLVED')) output.proposalFile = rule('proposal_file', 'UNKNOWN', 'FILE_IDENTITY_UNRESOLVED');
        else output.proposalFile = rule('proposal_file', 'PASS', '', [], { outgoingSourceId: latest.sourceId, filesChecked: matches.length });
      }
    }
  }
  return output;
}
