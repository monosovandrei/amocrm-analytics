import { CrmControlCompletion, CrmControlConfig, CrmControlCounts, CrmControlRuleResult } from './crm-control.types';

export const emptyControlCounts = (): CrmControlCounts => ({
  deals: 0, failedDeals: 0, violations: 0, review: 0, unknown: 0, passed: 0,
  reviewDeals: 0, unknownDeals: 0, checkedDeals: 0, unresolvedDeals: 0,
});

export function observationCounts(results: CrmControlRuleResult[]): CrmControlCounts {
  const count = (status: string) => results.filter((result) => result.status === status).length;
  const violations = count('FAIL'), review = count('REVIEW'), unknown = count('UNKNOWN');
  return { deals: 1, failedDeals: Number(violations > 0), violations, review, unknown, passed: count('PASS'),
    reviewDeals: Number(review > 0), unknownDeals: Number(unknown > 0),
    checkedDeals: Number(unknown === 0 && review === 0 && results.length > 0), unresolvedDeals: Number(violations > 0) };
}

export function addControlCounts(target: CrmControlCounts, value: Partial<CrmControlCounts>) {
  for (const key of Object.keys(target) as Array<keyof CrmControlCounts>) target[key] += Number(value[key] ?? 0);
  return target;
}

/** Processing state is historical; completion reflects all decisions made on its observations. */
export function controlCompletion(status: string, counts: CrmControlCounts, issues: string[] = []): CrmControlCompletion {
  const reasons: CrmControlCompletion['reasons'] = [];
  const finished = status === 'COMPLETED' || status === 'PARTIAL';
  const running = status === 'QUEUED' || status === 'RUNNING';
  if (!finished) reasons.push({ code: running ? 'PROCESSING' : 'RUN_FAILED', message: running
    ? 'Автоматический обход ещё не завершён.' : 'Автоматический обход не завершился. Повторите его после устранения ошибки.' });
  if (!counts.deals) reasons.push({ code: 'NO_DEALS', message: 'Нет проверенных сделок: полнота проверки не подтверждена.' });
  if (counts.unknown) reasons.push({ code: 'UNKNOWN_RESULTS', count: counts.unknown,
    message: 'По части пунктов ещё нет окончательного результата. Причины и доступные подтверждения указаны в сделках.' });
  if (counts.review) reasons.push({ code: 'REVIEW_RESULTS', count: counts.review,
    message: 'Содержание записей и подтверждения ещё не проверены.' });
  if (counts.checkedDeals < counts.deals && !counts.unknown && !counts.review) reasons.push({ code: 'MISSING_RESULTS', count: counts.deals - counts.checkedDeals,
    message: 'У части сделок отсутствуют результаты правил. Требуется новая автоматическая проверка.' });
  if (issues.length) reasons.push({ code: 'RUN_ISSUES', count: issues.length,
    message: 'Остались замечания к настройке или полноте обхода. Исправьте их и выполните новую автоматическую проверку.' });
  return { status: reasons.length === 0 ? 'CHECKED' : 'UNCHECKED', remainingResults: counts.unknown + counts.review,
    remainingDeals: Math.max(0, counts.deals - counts.checkedDeals), reasons, canRecheck: !running };
}

export function controlManualReviewAllowed(result: { status: string; ruleCode?: string; message?: string; details?: unknown }) {
  if (!['FAIL', 'REVIEW', 'UNKNOWN'].includes(result.status)) return false;
  if (result.status !== 'UNKNOWN') return true;
  const details = result.details && typeof result.details === 'object' ? result.details as Record<string, unknown> : {};
  if (details.awaitingDayEnd === true) return false;
  // Earlier saved snapshots predate the structured day-end flag.
  return !(['intake_stage', 'task_deadline', 'proposal_note'].includes(result.ruleCode ?? '')
    && /итог рабочего дня|итог рабочего дня не наступил/i.test(result.message ?? ''));
}

export function controlManualReviewGuidance(result: { status: string; ruleCode?: string; message?: string; details?: unknown }) {
  if (!controlManualReviewAllowed(result)) return result.status === 'UNKNOWN'
    ? 'Для этого пункта ещё не наступил итог рабочего дня. Запустите новую проверку после 19:00; прошлый снимок не подтверждает будущий результат.'
    : 'Этот пункт уже получил автоматический результат.';
  if (result.ruleCode === 'offer_budget') return 'Сверьте бюджет с суммой конкретного предложения, отправленного клиенту к моменту этой проверки. Укажите ссылку на отправку и объясните сверку.';
  if (result.ruleCode === 'proposal_file') return 'Сверьте файл в поле «КП» с последней версией, отправленной клиенту к моменту проверки. Укажите ссылку на подтверждение версии и отправки.';
  return 'Проверьте сохранённые данные и подтверждение именно на момент этой проверки. Укажите источник и объяснение; текущая карточка сама по себе не восстанавливает прошлое.';
}

export function controlScheduleSlot(now: Date, config: CrmControlConfig): string | null {
  if (!config.enabled) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const date = `${field('year')}-${field('month')}-${field('day')}`;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  if (!config.workdays.includes(weekday) || `${field('hour')}:${field('minute')}` < config.timeOfDay) return null;
  return date;
}

export function nextControlCaseState(
  previous: { status: string; exemptionUntil?: Date | null; confirmedAt?: Date | null } | null,
  result: CrmControlRuleResult,
  observedAt: Date,
): string | null {
  if (result.status === 'PASS' || (result.status === 'NA' && result.details?.resolvesPrior === true)) return previous ? 'RESOLVED' : null;
  if (result.status !== 'FAIL' && result.status !== 'REVIEW') return null;
  if (previous?.status === 'EXEMPTED' && previous.exemptionUntil && previous.exemptionUntil > observedAt) return 'EXEMPTED';
  if (previous?.status === 'DISPUTED') return 'DISPUTED';
  if (previous?.confirmedAt) return 'OPEN';
  return result.status === 'FAIL' ? 'OPEN' : 'REVIEW';
}
