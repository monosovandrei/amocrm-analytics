import { addMoscowBusinessTime, absoluteDurationDays, moscowBusinessElapsedMs, moscowWeekdayElapsedMs } from './date.util';

describe('Moscow business time', () => {
  it('pauses SLA after 19:00 and resumes on the next business day', () => {
    const start = new Date('2026-06-25T15:55:00.000Z'); // 18:55 MSK, Thursday
    const dueAt = addMoscowBusinessTime(start, 20 * 60_000);

    expect(dueAt.toISOString()).toBe('2026-06-26T07:15:00.000Z');
    expect(moscowBusinessElapsedMs(start, dueAt)).toBe(20 * 60_000);
  });

  it('skips weekends while counting working time', () => {
    const start = new Date('2026-06-26T15:55:00.000Z'); // 18:55 MSK, Friday
    const dueAt = addMoscowBusinessTime(start, 20 * 60_000);

    expect(dueAt.toISOString()).toBe('2026-06-29T07:15:00.000Z');
    expect(moscowBusinessElapsedMs(start, new Date('2026-06-29T07:10:00.000Z'))).toBe(15 * 60_000);
  });

  it('counts nights but skips Saturday and Sunday in weekday mode', () => {
    const start = new Date('2026-06-26T15:55:00.000Z'); // 18:55 MSK, Friday
    const end = new Date('2026-06-29T07:15:00.000Z'); // 10:15 MSK, Monday

    expect(moscowWeekdayElapsedMs(start, end)).toBe((5 * 60 + 5 + 10 * 60 + 15) * 60_000);
    expect(absoluteDurationDays(start, end)).toBeCloseTo(2.64, 2);
  });
});
