import { CrmControlStageRule } from './crm-control.types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
type Mode = NonNullable<CrmControlStageRule['deadlineMode']>;
export type StageDeadline = { mode: Mode; deadline: Date | null; reason?: string };

/** Optional legacy hour limits remain unconfigured; explicit modes must be complete. */
export function stageDeadlineConfigError(rule: CrmControlStageRule): string | null {
  const mode = rule.deadlineMode;
  if (mode !== undefined && !['elapsed', 'business_days', 'end_of_day', 'unlimited'].includes(mode)) return 'Неизвестный режим срока этапа';
  const hours = rule.maxDurationHours;
  const days = rule.maxBusinessDays;
  if (hours != null && (!Number.isFinite(hours) || hours <= 0 || hours > 87600)) return 'Срок этапа в часах должен быть больше нуля и не больше 87600';
  if (days != null && (!Number.isInteger(days) || days < 1 || days > 3650)) return 'Срок этапа в рабочих днях должен быть целым числом от 1 до 3650';
  if ((mode === undefined || mode === 'elapsed') && days != null) return 'Рабочие дни допустимы только в режиме «Рабочие дни»';
  if (mode === 'elapsed' && hours == null) return 'Укажите срок этапа в часах';
  if (mode === 'business_days' && (days == null || hours != null)) return 'Для рабочих дней укажите число дней и уберите срок в часах';
  if ((mode === 'end_of_day' || mode === 'unlimited') && (hours != null || days != null)) return 'Для выбранного режима числовой срок не требуется';
  return null;
}

export function hasStageDeadline(rule: CrmControlStageRule | undefined): boolean {
  return !!rule && !stageDeadlineConfigError(rule) && (rule.deadlineMode !== undefined || rule.maxDurationHours != null);
}

export function civilTime(date: Date, formatter: Intl.DateTimeFormat) {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) if (part.type !== 'literal') values[part.type] = Number(part.value);
  // A wall-clock value for calendar arithmetic, never an actual UTC instant.
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second, date.getUTCMilliseconds());
}

function instantAtCivilTime(target: number, formatter: Intl.DateTimeFormat): Date | null {
  // Collect both offsets around a clock change, then verify the exact local time.
  // A nonexistent or ambiguous local deadline is UNKNOWN rather than guessed.
  const candidates = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const probe = target + hours * HOUR;
    const offset = civilTime(new Date(probe), formatter) - probe;
    const instant = target - offset;
    if (Number.isFinite(instant) && civilTime(new Date(instant), formatter) === target) candidates.add(instant);
  }
  return candidates.size === 1 ? new Date([...candidates][0]) : null;
}

export function stageDeadline(rule: CrmControlStageRule | undefined, entry: Date | null, formatter: Intl.DateTimeFormat): StageDeadline {
  const mode = rule?.deadlineMode ?? 'elapsed';
  if (!rule || !hasStageDeadline(rule)) return { mode, deadline: null, reason: 'Для этапа не утверждён корректный предельный срок.' };
  if (mode === 'unlimited') return { mode, deadline: null };
  if (!entry || !Number.isFinite(entry.getTime())) return { mode, deadline: null, reason: 'Неизвестно достоверное время входа в этап.' };
  if (mode === 'elapsed') {
    const deadline = new Date(entry.getTime() + rule.maxDurationHours! * HOUR);
    return Number.isFinite(deadline.getTime()) ? { mode, deadline } : { mode, deadline: null, reason: 'Предельный срок этапа выходит за допустимый диапазон дат.' };
  }
  let target = civilTime(entry, formatter);
  if (mode === 'end_of_day') {
    target = Math.floor(target / DAY) * DAY + 19 * HOUR;
  } else {
    let remaining = rule.maxBusinessDays!;
    while (remaining > 0) {
      target += DAY;
      const weekday = new Date(target).getUTCDay();
      if (weekday !== 0 && weekday !== 6) remaining--;
    }
  }
  const deadline = instantAtCivilTime(target, formatter);
  return deadline ? { mode, deadline } : { mode, deadline: null, reason: 'Местное время предельного срока неоднозначно или отсутствует при переводе часов.' };
}
