import { civilTime } from './crm-control-deadline';
import { CRM_CONTROL_SEMANTIC_FACTS, CrmControlSemanticRequest, CrmControlSemanticResponse,
  CrmControlSemanticValidation, validateCrmControlSemanticResponse } from './crm-control-semantic.validation';

export const CRM_CONTROL_SEMANTIC_POLICY_VERSION = '2';
export interface CrmControlSemanticAssessment { status: 'PASS' | 'FAIL' | 'UNKNOWN'; message: string; policyVersion: string }

const unrelatedToMissingManagerNote = (issue: CrmControlSemanticValidation['issues'][number]) =>
  issue.code === 'INCOMPLETE_COMMUNICATIONS'
  || issue.code === 'ANALYZER_UNCERTAIN' && ['customer_agreement', 'agreed_deadline'].includes(issue.fact ?? '');

/** A necessary manager note cannot exist in a complete, verified empty note set. No model or communication inference is involved. */
export function crmControlMissingManagerNoteProof(request: CrmControlSemanticRequest): {
  response: CrmControlSemanticResponse; validation: CrmControlSemanticValidation;
} | null {
  if (request?.check !== 'deadline_agreement' || request.coverage?.notes !== true || !Array.isArray(request.sources)
    || !request.maxDueAt) return null;
  const stage = Date.parse(request.stageEnteredAt ?? ''), observed = Date.parse(request.observedAt);
  if (!Number.isFinite(stage) || !Number.isFinite(observed) || stage > observed) return null;
  if (request.sources.some(source => source?.kind === 'manager_note' && source.actor === 'manager' && source.actorId
    && typeof source.text === 'string' && source.text.trim() && source.createdAt
    && Date.parse(source.createdAt) >= stage && Date.parse(source.createdAt) <= observed)) return null;
  const response: CrmControlSemanticResponse = { schemaVersion: 1, requestId: request.requestId, check: request.check,
    subjectId: request.subjectId, inspectedSourceIds: request.sources.map(source => source?.id),
    findings: CRM_CONTROL_SEMANTIC_FACTS.deadline_agreement.map(fact => ({ fact,
      state: fact === 'manager_note' ? 'absent' : 'uncertain', evidence: [] })) };
  // The native validator checks every source's scope/hash and all note attribution/date/coverage constraints.
  const validation = validateCrmControlSemanticResponse(request, response);
  if (validation.status === 'INVALID' || validation.issues.some(issue => !unrelatedToMissingManagerNote(issue))) return null;
  return { response, validation };
}

/** Model findings never decide a violation directly: required facts and allowed deadlines are our policy. */
export function assessCrmControlSemantic(request: CrmControlSemanticRequest, validation: CrmControlSemanticValidation,
  ruleCode: string): CrmControlSemanticAssessment {
  const result = (status: CrmControlSemanticAssessment['status'], message: string) => ({ status, message, policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION });
  if (validation.requestId !== request.requestId || validation.check !== request.check
    || validation.subjectId !== request.subjectId) return result('UNKNOWN', 'Для смысловой проверки пока недостаточно подтверждённых данных.');
  if (validation.status !== 'INVALID' && request.check === 'deadline_agreement'
    && ['task_stage_deadline', 'stage_duration'].includes(ruleCode)
    && validation.findings.find(finding => finding.fact === 'manager_note')?.state === 'absent'
    && validation.issues.every(unrelatedToMissingManagerNote) && crmControlMissingManagerNoteProof(request)) {
    return result('FAIL', 'Превышение срока не обосновано примечанием менеджера.');
  }
  if (validation.status !== 'VALIDATED') return result('UNKNOWN', validation.status === 'UNKNOWN' && !request.sources.length
    ? 'В сохранённом срезе нет текстовых источников для смысловой проверки. Отсутствие нужного примечания этим не подтверждено.'
    : 'Для смысловой проверки пока недостаточно подтверждённых данных.');
  const facts = new Map(validation.findings.map(finding => [finding.fact, finding]));
  if (request.check === 'task_action' && ruleCode === 'task_text') {
    if (facts.get('action')?.state === 'absent') return result('FAIL', 'Текст задачи не описывает следующее действие по сделке.');
    if (facts.get('stage_relevance')?.state === 'absent') return result('FAIL', 'Следующее действие не соответствует текущему этапу сделки.');
    if (['action','stage_relevance'].every(fact => facts.get(fact as any)?.state === 'present')) return result('PASS', 'В задаче указан следующий шаг, соответствующий этапу сделки.');
  }
  if (request.check === 'proposal_note' && ruleCode === 'proposal_note') {
    if (facts.get('transfer_reason')?.state === 'absent') return result('FAIL', 'В примечании нет причины переноса презентации текущего КП.');
    if (facts.get('presentation_date')?.state === 'absent') return result('FAIL', 'В примечании не указано, когда запланирована презентация КП.');
    if (facts.get('transfer_reason')?.state === 'present' && facts.get('presentation_date')?.state === 'present' && facts.get('presentation_date')?.date) {
      if (!dateCovers(facts.get('presentation_date')!.date!, request.observedAt, request.timeZone)) return result('FAIL', 'Указанная в примечании дата презентации уже прошла.');
      return result('PASS', 'В примечании есть причина переноса и дата презентации текущего КП.');
    }
  }
  if (request.check === 'deadline_agreement' && ['task_stage_deadline','stage_duration'].includes(ruleCode)) {
    if (!request.maxDueAt || !Number.isFinite(Date.parse(request.maxDueAt))) return result('UNKNOWN', 'Предельный срок этапа неизвестен; договорённость не заменяет настройку норматива.');
    if (facts.get('manager_note')?.state === 'absent') return result('FAIL', 'Превышение срока не обосновано примечанием менеджера.');
    if (facts.get('customer_agreement')?.state === 'absent' || facts.get('agreed_deadline')?.state === 'absent') {
      return result('FAIL', 'Перенос за норматив не подтверждён договорённостью с клиентом о новом сроке.');
    }
    const date = facts.get('agreed_deadline')?.date;
    if (date && ['manager_note','customer_agreement','agreed_deadline'].every(fact => facts.get(fact as any)?.state === 'present')) {
      const target = ruleCode === 'task_stage_deadline' ? request.taskDueAt : request.observedAt;
      if (!target) return result('UNKNOWN', 'Не установлен срок действия, который нужно сверить с договорённостью.');
      if (!dateCovers(date, target, request.timeZone)) return result('FAIL', 'Срок превышает даже подтверждённую договорённость с клиентом.');
      return result('PASS', 'Превышение норматива подтверждено примечанием и договорённостью клиента; согласованный срок не нарушен.');
    }
  }
  if (request.check === 'price_delay' && ruleCode === 'price_requested_duration') {
    if (!request.maxDueAt || !Number.isFinite(Date.parse(request.maxDueAt))) return result('UNKNOWN', 'Предельный срок получения цены неизвестен; сначала нужно подтвердить норматив.');
    if (facts.get('price_delay_reason')?.state === 'present') return result('PASS', 'В источниках есть подтверждение причины задержки получения цены.');
    if (facts.get('price_delay_reason')?.state === 'absent') return result('FAIL', 'Норматив запроса цены превышен; подтверждения допустимой задержки нет.');
  }
  return result('UNKNOWN', 'Смысловая проверка не дала однозначного результата.');
}

function dateCovers(date: { value: string; precision: 'day' | 'minute' }, target: string, timeZone: string): boolean {
  const instant = new Date(target);
  if (!Number.isFinite(instant.getTime())) return false;
  if (date.precision === 'minute') return instant.getTime() <= Date.parse(date.value);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const localDay = new Date(civilTime(instant, formatter)).toISOString().slice(0, 10);
  return localDay <= date.value;
}
