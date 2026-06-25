export function toDateFromAmoTimestamp(value: unknown): Date | null {
  if (value === null || value === undefined || value === 0) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

export function startOfMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0));
}

export function endOfMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

export const MOSCOW_TIME_ZONE = 'Europe/Moscow';
export const MOSCOW_WORKDAY_START_HOUR = 10;
export const MOSCOW_WORKDAY_END_HOUR = 19;
export const MOSCOW_WORKDAY_LABEL = 'Пн-пт 10:00-19:00 МСК';
export const MOSCOW_WORKDAY_MS = (MOSCOW_WORKDAY_END_HOUR - MOSCOW_WORKDAY_START_HOUR) * 60 * 60_000;

type MoscowParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number;
};

export function moscowParts(date: Date): MoscowParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: MOSCOW_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return {
    year,
    month,
    day,
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
    dayOfWeek,
  };
}

export function moscowDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second, ms));
}

export function isMoscowBusinessDay(parts: { dayOfWeek: number }): boolean {
  return parts.dayOfWeek >= 1 && parts.dayOfWeek <= 5;
}

export function isMoscowWorkingTime(date: Date): boolean {
  const parts = moscowParts(date);
  const minutes = parts.hour * 60 + parts.minute;
  return isMoscowBusinessDay(parts) &&
    minutes >= MOSCOW_WORKDAY_START_HOUR * 60 &&
    minutes < MOSCOW_WORKDAY_END_HOUR * 60;
}

export function nextMoscowBusinessStart(date: Date): Date {
  const parts = moscowParts(date);
  const minutes = parts.hour * 60 + parts.minute;

  if (isMoscowBusinessDay(parts) && minutes < MOSCOW_WORKDAY_START_HOUR * 60) {
    return moscowDate(parts.year, parts.month, parts.day, MOSCOW_WORKDAY_START_HOUR);
  }
  if (isMoscowBusinessDay(parts) && minutes < MOSCOW_WORKDAY_END_HOUR * 60) {
    return date;
  }

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = moscowParts(moscowDate(parts.year, parts.month, parts.day + offset, 12));
    if (isMoscowBusinessDay(candidate)) {
      return moscowDate(candidate.year, candidate.month, candidate.day, MOSCOW_WORKDAY_START_HOUR);
    }
  }
  return moscowDate(parts.year, parts.month, parts.day + 1, MOSCOW_WORKDAY_START_HOUR);
}

export function addMoscowBusinessTime(start: Date, milliseconds: number): Date {
  let cursor = nextMoscowBusinessStart(start);
  let remaining = Math.max(0, milliseconds);
  if (remaining === 0) return cursor;

  while (remaining > 0) {
    const parts = moscowParts(cursor);
    const dayEnd = moscowDate(parts.year, parts.month, parts.day, MOSCOW_WORKDAY_END_HOUR);
    const available = Math.max(0, dayEnd.getTime() - cursor.getTime());
    if (remaining <= available) return new Date(cursor.getTime() + remaining);
    remaining -= available;
    cursor = nextMoscowBusinessStart(new Date(dayEnd.getTime() + 1));
  }

  return cursor;
}

export function moscowBusinessElapsedMs(start: Date, end: Date): number {
  if (end <= start) return 0;
  let cursor = start;
  let total = 0;

  while (cursor < end) {
    const workStart = nextMoscowBusinessStart(cursor);
    if (workStart >= end) break;

    const parts = moscowParts(workStart);
    const workEnd = moscowDate(parts.year, parts.month, parts.day, MOSCOW_WORKDAY_END_HOUR);
    const chunkEnd = workEnd < end ? workEnd : end;
    total += Math.max(0, chunkEnd.getTime() - workStart.getTime());
    cursor = new Date(workEnd.getTime() + 1);
  }

  return total;
}

export function moscowBusinessDurationDays(start: Date, end: Date): number | null {
  if (end <= start) return null;
  return moscowBusinessElapsedMs(start, end) / 86_400_000;
}

export function moscowWeekdayElapsedMs(start: Date, end: Date): number {
  if (end <= start) return 0;
  let cursor = start;
  let total = 0;

  while (cursor < end) {
    const parts = moscowParts(cursor);
    const nextDay = moscowDate(parts.year, parts.month, parts.day + 1, 0);
    const chunkEnd = nextDay < end ? nextDay : end;
    if (isMoscowBusinessDay(parts)) {
      total += Math.max(0, chunkEnd.getTime() - cursor.getTime());
    }
    cursor = chunkEnd;
  }

  return total;
}

export function moscowWeekdayDurationDays(start: Date, end: Date): number | null {
  if (end <= start) return null;
  return moscowWeekdayElapsedMs(start, end) / 86_400_000;
}

export function absoluteDurationDays(start: Date, end: Date): number | null {
  if (end <= start) return null;
  return (end.getTime() - start.getTime()) / 86_400_000;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}
