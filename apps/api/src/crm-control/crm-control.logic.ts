import { CrmControlConfig, CrmControlCounts, CrmControlRuleResult } from './crm-control.types';

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
