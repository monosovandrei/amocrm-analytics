import { createHash } from 'node:crypto';
import { civilTime } from './crm-control-deadline';

export type CrmControlSemanticCheck = 'task_action' | 'proposal_note' | 'deadline_agreement' | 'price_delay';
export type CrmControlSemanticFact = 'action' | 'stage_relevance' | 'transfer_reason' | 'presentation_date'
  | 'manager_note' | 'customer_agreement' | 'agreed_deadline' | 'price_delay_reason';
export type CrmControlSemanticSourceKind = 'task' | 'manager_note' | 'customer_message' | 'supplier_message' | 'message' | 'call_transcript';
export interface CrmControlSemanticSource {
  id: string;
  /** SHA-256 of the exact UTF-8 text, computed by the server. */
  sourceHash: string;
  dealId: string;
  /** Owner of the archived observation, not the author of an incoming message. */
  ownerId: string;
  subjectId: string | null;
  /** Required for task sources. The assignee is separate from the creator, which can be a bot. */
  assignedManagerId?: string | null;
  kind: CrmControlSemanticSourceKind;
  actor: 'manager' | 'customer' | 'supplier' | 'bot' | 'unknown';
  actorId: string | null;
  direction: 'incoming' | 'outgoing' | 'internal' | 'unknown';
  text: string;
  createdAt: string | null;
}
export interface CrmControlSemanticRequest {
  schemaVersion: 1;
  requestId: string;
  check: CrmControlSemanticCheck;
  dealId: string;
  ownerId: string;
  subjectId: string | null;
  observedAt: string;
  stageEnteredAt: string | null;
  timeZone: string;
  stageName: string;
  taskDueAt?: string | null;
  maxDueAt?: string | null;
  coverage: { tasks: boolean; notes: boolean; communications: boolean };
  sources: CrmControlSemanticSource[];
}
export interface CrmControlSemanticCitation { sourceId: string; sourceHash: string; quote: string }
export interface CrmControlSemanticDate { value: string; precision: 'day' | 'minute' }
export interface CrmControlSemanticFinding {
  fact: CrmControlSemanticFact;
  state: 'present' | 'absent' | 'uncertain';
  evidence: CrmControlSemanticCitation[];
  /** Day: YYYY-MM-DD. Minute: ISO instant with explicit offset. Never infer a time from a date alone. */
  date?: CrmControlSemanticDate;
}
export interface CrmControlSemanticResponse {
  schemaVersion: 1;
  requestId: string;
  check: CrmControlSemanticCheck;
  subjectId: string | null;
  inspectedSourceIds: string[];
  findings: CrmControlSemanticFinding[];
}
export interface CrmControlSemanticValidation {
  status: 'VALIDATED' | 'UNKNOWN' | 'INVALID';
  requestId: string;
  check: CrmControlSemanticCheck;
  subjectId: string | null;
  findings: CrmControlSemanticFinding[];
  issues: Array<{ code: string; fact?: CrmControlSemanticFact; sourceId?: string }>;
}

export const CRM_CONTROL_SEMANTIC_FACTS: Record<CrmControlSemanticCheck, readonly CrmControlSemanticFact[]> = {
  task_action: ['action', 'stage_relevance'],
  proposal_note: ['transfer_reason', 'presentation_date'],
  deadline_agreement: ['manager_note', 'customer_agreement', 'agreed_deadline'],
  price_delay: ['price_delay_reason'],
};
export const crmControlSemanticTextHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A narrow fail-closed guard, not a claim that every prompt injection can be detected. */
export function crmControlSemanticInstructionRisk(text: string): boolean {
  const value = text.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').toLowerCase();
  return /(?:<\|(?:im_start|im_end|system|assistant)\|>|\[\/?inst\]|<<\/?sys>>|["']role["']\s*:\s*["']system["'])/.test(value)
    || /(?:ignore|disregard|override|forget).{0,80}(?:instructions?|system prompt|previous rules|audit rules)/.test(value)
    || /(?:игнорируй|игнорировать|забудь|не учитывай|отмени|обойди).{0,80}(?:инструкци|системн.{0,20}(?:промпт|сообщен)|правила провер|предыдущие правила)/.test(value)
    || /(?:верни|возврати|ответь|выдай|поставь|пометь|return|respond|output|mark).{0,80}(?:\b(?:pass|validated|present|absent|uncertain|stage_relevance)\b|проверку пройденной|нарушений нет)/.test(value)
    || /["'](?:action|stage_relevance|transfer_reason|customer_agreement|state)["']\s*:\s*["'](?:present|absent|uncertain)["']/.test(value)
    || /(?:ты|you are).{0,30}(?:системный аудитор|проверяющий ии|system auditor|system assistant)/.test(value);
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const dateFacts = new Set<CrmControlSemanticFact>(['presentation_date', 'agreed_deadline']);
const sourceKinds = ['task', 'manager_note', 'customer_message', 'supplier_message', 'message', 'call_transcript'];
const DAY = 86_400_000;

function calendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !calendarDay(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function civilInstant(target: number, formatter: Intl.DateTimeFormat): Date | null {
  const candidates = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = target + hours * 3_600_000;
    const candidate = target - (civilTime(new Date(probe), formatter) - probe);
    if (civilTime(new Date(candidate), formatter) === target) candidates.add(candidate);
  }
  return candidates.size === 1 ? new Date([...candidates][0]) : null;
}

function hasUnparsedTime(text: string): boolean {
  const value = text.toLocaleLowerCase('ru');
  return /(?<![а-яё])(?:утр[аеоум]|вечер|дн[её]м|ночь|ночью|обед|полдень|полудн|полуноч|половин|час)|\b(?:morning|afternoon|evening|noon|midnight|hours?)\b/.test(value)
    || /(?<![а-яё])(?:в|к|до|после|около|примерно|at|before|after)\s*\d{1,2}(?![\d:])/.test(value)
    || /(?<![а-яё])(?:в|к|до|после)\s+(?:один|два|двух|три|трёх|четыр|пят|шест|сем|восем|девят|десят|одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат)/.test(value);
}

/** Deliberately bounded date grammar. Weekdays, omitted years and mixed dates remain unresolved. */
function citedDate(quote: string, source: CrmControlSemanticSource, formatter: Intl.DateTimeFormat): CrmControlSemanticDate | null {
  const isoMatches = quote.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/g) ?? [];
  if (isoMatches.length) {
    if (isoMatches.length !== 1 || quote.replace(isoMatches[0], '').match(/\d{1,4}[.:/-]\d{2}|сегодня|завтра/i)) return null;
    if (hasUnparsedTime(quote.replace(isoMatches[0], ''))) return null;
    const date = instant(isoMatches[0]);
    return date ? { value: date.toISOString(), precision: 'minute' } : null;
  }
  const days = new Set<string>();
  let invalid = false;
  for (const match of quote.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    const day = `${match[1]}-${match[2]}-${match[3]}`;
    if (calendarDay(day)) days.add(day); else invalid = true;
  }
  for (const match of quote.matchAll(/(?<!\d)(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g)) {
    const day = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    if (calendarDay(day)) days.add(day); else invalid = true;
  }
  for (const match of quote.toLocaleLowerCase('ru').matchAll(/(?<![а-яё])(послезавтра|завтра|сегодня)(?![а-яё])/g)) {
    const created = instant(source.createdAt);
    if (!created) { invalid = true; continue; }
    const localDay = Math.floor(civilTime(created, formatter) / DAY) * DAY;
    const offset = match[1] === 'сегодня' ? 0 : match[1] === 'завтра' ? 1 : 2;
    days.add(new Date(localDay + offset * DAY).toISOString().slice(0, 10));
  }
  const remaining = quote.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\d{1,2}\.\d{1,2}\.\d{4}/g, '');
  if (/\d[./-]\d/.test(remaining)) return null;
  // Do not widen an unparsed clock restriction into permission for the entire day.
  if (hasUnparsedTime(remaining)) return null;
  if (invalid || days.size !== 1) return null;
  const day = [...days][0];
  const times = [...quote.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)];
  if (!times.length) return { value: day, precision: 'day' };
  const values = new Set(times.map(match => `${match[1].padStart(2, '0')}:${match[2]}`));
  if (values.size !== 1) return null;
  const time = [...values][0];
  if (Number(time.slice(0, 2)) > 23 || Number(time.slice(3)) > 59) return null;
  const target = new Date(`${day}T${time}:00Z`).getTime();
  const resolved = civilInstant(target, formatter);
  return resolved ? { value: resolved.toISOString(), precision: 'minute' } : null;
}

function supportsFact(source: CrmControlSemanticSource, fact: CrmControlSemanticFact, request: CrmControlSemanticRequest) {
  // No server-attested transcription quality/speaker proof exists in this contract yet.
  if (source.kind === 'call_transcript') return false;
  if (fact === 'action' || fact === 'stage_relevance') return source.kind === 'task'
    && source.subjectId === request.subjectId && source.assignedManagerId === request.ownerId;
  if (!source.actorId || source.actor === 'unknown' || source.actor === 'bot') return false;
  if (fact === 'manager_note' || fact === 'transfer_reason' || fact === 'presentation_date') return source.kind === 'manager_note' && source.actor === 'manager';
  const external = (party: 'customer' | 'supplier') => source.actor === party
    && ['message', `${party}_message`].includes(source.kind) && source.direction === 'incoming';
  if (fact === 'customer_agreement' || fact === 'agreed_deadline') return external('customer');
  return external('customer') || external('supplier');
}

function hasUncertainAttribution(source: CrmControlSemanticSource, fact: CrmControlSemanticFact) {
  if (fact === 'action' || fact === 'stage_relevance' || source.actor === 'bot') return false;
  const isNote = fact === 'manager_note' || fact === 'transfer_reason' || fact === 'presentation_date';
  const couldContain = isNote ? source.kind === 'manager_note'
    : ['customer_message', 'supplier_message', 'message', 'call_transcript'].includes(source.kind);
  return couldContain && (source.actor === 'unknown' || !source.actorId || (!isNote && source.direction === 'unknown'));
}

/** Validates grounding, identity and dates only. It neither judges semantic truth nor emits a rule PASS/FAIL. */
export function validateCrmControlSemanticResponse(request: CrmControlSemanticRequest, response: unknown): CrmControlSemanticValidation {
  const result: CrmControlSemanticValidation = { status: 'VALIDATED', requestId: request.requestId, check: request.check,
    subjectId: request.subjectId, findings: [], issues: [] };
  const invalid = (code: string, fact?: CrmControlSemanticFact, sourceId?: string) => {
    result.status = 'INVALID'; result.findings = []; result.issues.push({ code, ...(fact ? { fact } : {}), ...(sourceId ? { sourceId } : {}) });
    return result;
  };
  const unknown = (code: string, fact?: CrmControlSemanticFact, sourceId?: string) => {
    if (result.status !== 'INVALID') result.status = 'UNKNOWN';
    result.issues.push({ code, ...(fact ? { fact } : {}), ...(sourceId ? { sourceId } : {}) });
  };
  const required = CRM_CONTROL_SEMANTIC_FACTS[request.check];
  const observedAt = instant(request.observedAt);
  if (request.schemaVersion !== 1 || !required || !id(request.requestId) || !id(request.dealId) || !id(request.ownerId)
    || (request.subjectId !== null && !id(request.subjectId)) || !observedAt || !object(request.coverage)
    || !['tasks', 'notes', 'communications'].every(key => typeof request.coverage[key as keyof typeof request.coverage] === 'boolean')
    || !Array.isArray(request.sources) || request.sources.length > 128 || typeof request.stageName !== 'string') return invalid('INVALID_REQUEST');
  if ((request.taskDueAt != null && !instant(request.taskDueAt)) || (request.maxDueAt != null && !instant(request.maxDueAt))) return invalid('INVALID_REQUEST_DATE');
  if (request.check === 'task_action' && !request.subjectId) return invalid('MISSING_TASK_SUBJECT');
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-GB', { timeZone: request.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
  catch { return invalid('INVALID_TIME_ZONE'); }
  const stageEnteredAt = instant(request.stageEnteredAt);
  if (request.check !== 'task_action' && (!stageEnteredAt || stageEnteredAt > observedAt)) unknown('UNKNOWN_STAGE_ENTRY');
  if (!request.stageName.trim()) unknown('MISSING_STAGE_CONTEXT');
  if (crmControlSemanticInstructionRisk(request.stageName)) unknown('STAGE_INSTRUCTION_TO_ANALYZER');
  const sources = new Map<string, CrmControlSemanticSource>();
  let characters = 0;
  for (const source of request.sources) {
    if (!source || !id(source.id) || sources.has(source.id) || typeof source.text !== 'string' || source.text.length > 16_000
      || !sourceKinds.includes(source.kind) || !['manager', 'customer', 'supplier', 'bot', 'unknown'].includes(source.actor)
      || !['incoming', 'outgoing', 'internal', 'unknown'].includes(source.direction)
      || (source.actorId !== null && !id(source.actorId)) || (source.subjectId !== null && !id(source.subjectId))) return invalid('INVALID_SOURCE');
    if (source.dealId !== request.dealId || source.ownerId !== request.ownerId) return invalid('SOURCE_SCOPE_MISMATCH', undefined, source.id);
    if ((source.subjectId !== null && source.subjectId !== request.subjectId)
      || (source.kind === 'task' && !source.subjectId)) return invalid('SOURCE_SUBJECT_MISMATCH', undefined, source.id);
    if (source.kind === 'task' && source.assignedManagerId !== request.ownerId) return invalid('TASK_ASSIGNEE_MISMATCH', undefined, source.id);
    if (source.sourceHash !== crmControlSemanticTextHash(source.text)) return invalid('SOURCE_HASH_MISMATCH', undefined, source.id);
    // Matching text and a claimed actor prove neither accurate ASR nor who spoke. This also blocks false absence.
    if (source.kind === 'call_transcript') unknown('CALL_TRANSCRIPT_UNVERIFIED', undefined, source.id);
    if (crmControlSemanticInstructionRisk(source.text)) unknown('SOURCE_INSTRUCTION_TO_ANALYZER', undefined, source.id);
    characters += source.text.length;
    if (characters > 128_000) return invalid('SOURCE_LIMIT_EXCEEDED');
    sources.set(source.id, source);
  }
  let value = response;
  if (typeof value === 'string') {
    if (value.length > 64_000) return invalid('RESPONSE_LIMIT_EXCEEDED');
    try { value = JSON.parse(value); } catch { return invalid('INVALID_JSON'); }
  }
  if (!object(value) || !onlyKeys(value, ['schemaVersion', 'requestId', 'check', 'subjectId', 'inspectedSourceIds', 'findings'])
    || value.schemaVersion !== 1 || value.requestId !== request.requestId || value.check !== request.check
    || value.subjectId !== request.subjectId || !Array.isArray(value.findings) || value.findings.length !== required.length
    || !Array.isArray(value.inspectedSourceIds) || value.inspectedSourceIds.some(sourceId => !id(sourceId))
    || new Set(value.inspectedSourceIds).size !== value.inspectedSourceIds.length) return invalid('INVALID_RESPONSE');
  const inspected = new Set(value.inspectedSourceIds as string[]);
  if (inspected.size !== sources.size || [...sources.keys()].some(sourceId => !inspected.has(sourceId))) return invalid('INCOMPLETE_INSPECTED_SOURCES');
  const seen = new Set<string>();
  for (const item of value.findings) {
    if (!object(item) || !onlyKeys(item, ['fact', 'state', 'evidence', 'date']) || typeof item.fact !== 'string'
      || !required.includes(item.fact as CrmControlSemanticFact) || seen.has(item.fact)
      || !['present', 'absent', 'uncertain'].includes(String(item.state)) || !Array.isArray(item.evidence) || item.evidence.length > 12) return invalid('INVALID_FINDING');
    const fact = item.fact as CrmControlSemanticFact;
    seen.add(fact);
    if (item.date !== undefined && (!dateFacts.has(fact) || item.state !== 'present' || !object(item.date)
      || !onlyKeys(item.date, ['value', 'precision']) || typeof item.date.value !== 'string' || !['day', 'minute'].includes(String(item.date.precision)))) return invalid('INVALID_DATE', fact);
    const evidence: CrmControlSemanticCitation[] = [];
    const witnesses: Array<{ source: CrmControlSemanticSource; quote: string }> = [];
    for (const reference of item.evidence) {
      if (!object(reference) || !onlyKeys(reference, ['sourceId', 'sourceHash', 'quote']) || !id(reference.sourceId)
        || typeof reference.sourceHash !== 'string' || typeof reference.quote !== 'string' || reference.quote.trim().length < 2
        || reference.quote.length > 2000) return invalid('INVALID_CITATION', fact);
      const source = sources.get(reference.sourceId);
      if (!source || source.sourceHash !== reference.sourceHash || !source.text.includes(reference.quote)) return invalid('UNGROUNDED_CITATION', fact, reference.sourceId);
      const createdAt = instant(source.createdAt);
      if (!createdAt || createdAt > observedAt || (fact !== 'action' && fact !== 'stage_relevance' && (!stageEnteredAt || createdAt < stageEnteredAt))) {
        unknown('SOURCE_OUTSIDE_OBSERVATION_WINDOW', fact, source.id);
      } else if (supportsFact(source, fact, request)) witnesses.push({ source, quote: reference.quote });
      evidence.push({ sourceId: reference.sourceId, sourceHash: reference.sourceHash, quote: reference.quote });
    }
    const finding: CrmControlSemanticFinding = { fact, state: item.state as CrmControlSemanticFinding['state'], evidence };
    if (item.state === 'uncertain') unknown('ANALYZER_UNCERTAIN', fact);
    if (item.state === 'present' && !witnesses.length) unknown('MISSING_TRUSTED_WITNESS', fact);
    if (item.state === 'present' && ['customer_agreement', 'agreed_deadline'].includes(fact) && witnesses.length) {
      const witnessedAt = Math.min(...witnesses.map(witness => instant(witness.source.createdAt)!.getTime()));
      for (const source of request.sources) {
        const createdAt = instant(source.createdAt);
        if (!supportsFact(source, fact, request) || !createdAt || createdAt.getTime() < witnessedAt || createdAt > observedAt) continue;
        const text = source.text.replace(/\s+/gu, ' ');
        if (/(?:не\s+соглас(?:ен|на|ны)[^.!?]{0,50}(?:перенос|срок)|(?:отменяю|отменяем)\s+(?:договор[её]нность|перенос|согласование)|(?:договор[её]нность|перенос|согласование|срок)\s+отмен[её]н(?:а|о)?|(?:новый|этот|указанный|согласованный)\s+срок\s+не\s+подходит|не\s+переносим\s+(?:срок|встречу|презентацию))/iu.test(text)) {
          unknown('CONFLICTING_CUSTOMER_AGREEMENT', fact, source.id);
        }
      }
    }
    if (item.state === 'absent') {
      // Missing/undated source records cannot certify absence, even if the model lists all their IDs.
      const relevant = request.sources.filter(source => supportsFact(source, fact, request));
      if (relevant.some(source => !instant(source.createdAt) || instant(source.createdAt)! > observedAt)) unknown('UNDATED_OR_FUTURE_SOURCE', fact);
      if (request.sources.some(source => hasUncertainAttribution(source, fact))) unknown('UNATTRIBUTED_SOURCE', fact);
    }
    if (item.state === 'present' && dateFacts.has(fact)) {
      const dates = witnesses.map(witness => citedDate(witness.quote, witness.source, formatter));
      const distinct = new Map(dates.filter((date): date is CrmControlSemanticDate => !!date).map(date => [`${date.precision}:${date.value}`, date]));
      if (!dates.length || dates.some(date => !date) || distinct.size !== 1) unknown('UNRESOLVED_DATE', fact);
      else {
        const date = [...distinct.values()][0];
        if (object(item.date)) {
          const supplied = item.date.precision === 'minute' ? instant(item.date.value)?.toISOString() : item.date.value;
          if (item.date.precision !== date.precision || supplied !== date.value) return invalid('DATE_NOT_GROUNDED', fact);
        }
        finding.date = date;
      }
    }
    result.findings.push(finding);
  }
  const coverage = request.check === 'task_action' ? ['tasks'] : request.check === 'proposal_note' ? ['notes'] : ['notes', 'communications'];
  for (const kind of coverage) if (!request.coverage[kind as keyof typeof request.coverage]) {
    // A grounded incoming quotation proves presence. It cannot prove absence in unread email/call/chat channels.
    const communicationsFacts = request.check === 'deadline_agreement' ? ['customer_agreement', 'agreed_deadline'] : ['price_delay_reason'];
    const positiveCommunications = kind === 'communications' && communicationsFacts.every(fact =>
      result.findings.some(finding => finding.fact === fact && finding.state === 'present'));
    if (!positiveCommunications) unknown(`INCOMPLETE_${kind.toUpperCase()}`);
  }
  return result;
}
