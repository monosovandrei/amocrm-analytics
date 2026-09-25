import type { PeriodPreset } from './report-types';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function moscowDateInput(date: Date): string {
  const parts = dateFormatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function moscowPresetPeriod(preset: PeriodPreset, now = new Date()): { from: Date; to: Date } {
  const [year, month, day] = moscowDateInput(now).split('-').map(Number);
  // Match the server's Moscow business calendar, independently of browser timezone.
  const midnight = (dayOfMonth: number, monthNumber = month) => Date.UTC(year, monthNumber - 1, dayOfMonth, -3);
  const dayMs = 86_400_000;
  const today = midnight(day);
  const endOfToday = today + dayMs - 1;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
  const monday = midnight(day - weekday + 1);
  let from = today;
  let to = endOfToday;
  switch (preset) {
    case 'yesterday':
      from = today - dayMs;
      to = today - 1;
      break;
    case 'this_week':
      from = monday;
      break;
    case 'last_week':
      from = monday - 7 * dayMs;
      to = monday - 1;
      break;
    case 'this_month':
      from = midnight(1);
      break;
    case 'last_month':
      from = midnight(1, month - 1);
      to = midnight(1) - 1;
      break;
  }
  return { from: new Date(from), to: new Date(to) };
}

export function moscowPresetDateInputs(preset: PeriodPreset, now = new Date()) {
  const { from, to } = moscowPresetPeriod(preset, now);
  return { dateFrom: moscowDateInput(from), dateTo: moscowDateInput(to) };
}
