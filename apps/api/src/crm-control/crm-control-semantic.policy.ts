import { civilTime } from './crm-control-deadline';
import { CrmControlSemanticRequest, CrmControlSemanticValidation } from './crm-control-semantic.validation';

export const CRM_CONTROL_SEMANTIC_POLICY_VERSION = '1';
export interface CrmControlSemanticAssessment { status: 'PASS' | 'FAIL' | 'UNKNOWN'; message: string; policyVersion: string }

/** Model findings never decide a violation directly: required facts and allowed deadlines are our policy. */
export function assessCrmControlSemantic(request: CrmControlSemanticRequest, validation: CrmControlSemanticValidation,
  ruleCode: string): CrmControlSemanticAssessment {
  const result = (status: CrmControlSemanticAssessment['status'], message: string) => ({ status, message, policyVersion: CRM_CONTROL_SEMANTIC_POLICY_VERSION });
  if (validation.requestId !== request.requestId || validation.check !== request.check
    || validation.subjectId !== request.subjectId) return result('UNKNOWN', 'Для смысловой проверки пока недостаточно подтверждённых данных.');
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
