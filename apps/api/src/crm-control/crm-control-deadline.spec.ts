import { hasStageDeadline, stageDeadline } from './crm-control-deadline';

const formatter = (timeZone = 'Europe/Moscow') => new Intl.DateTimeFormat('en-GB', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

describe('CRM control stage calendar', () => {
  it('adds three business days from Friday to Wednesday at the same local time', () => {
    const result = stageDeadline({ deadlineMode: 'business_days', maxBusinessDays: 3 }, new Date('2026-09-18T07:15:30.123Z'), formatter());
    expect(result.deadline?.toISOString()).toBe('2026-09-23T07:15:30.123Z');
  });

  it.each(['2026-09-19T07:00:00Z', '2026-09-20T07:00:00Z'])('counts Monday as the first business day for entry on a weekend: %s', (entry) => {
    const result = stageDeadline({ deadlineMode: 'business_days', maxBusinessDays: 1 }, new Date(entry), formatter());
    expect(result.deadline?.toISOString()).toBe('2026-09-21T07:00:00.000Z');
  });

  it.each([
    ['2026-03-27T09:15:00Z', '2026-03-30T08:15:00.000Z'],
    ['2026-10-23T08:15:00Z', '2026-10-26T09:15:00.000Z'],
  ])('preserves local time across a DST weekend from %s', (entry, expected) => {
    const result = stageDeadline({ deadlineMode: 'business_days', maxBusinessDays: 1 }, new Date(entry), formatter('Europe/Berlin'));
    expect(result.deadline?.toISOString()).toBe(expected);
  });

  it('keeps legacy elapsed hours as elapsed time across DST', () => {
    const result = stageDeadline({ maxDurationHours: 72 }, new Date('2026-03-27T09:15:00Z'), formatter('Europe/Berlin'));
    expect(result.deadline?.toISOString()).toBe('2026-03-30T09:15:00.000Z');
  });

  it('returns an unknown deadline when the target local business date does not exist', () => {
    // Pacific/Apia skipped Friday 2011-12-30 entirely when moving across the date line.
    const result = stageDeadline({ deadlineMode: 'business_days', maxBusinessDays: 1 }, new Date('2011-12-29T22:00:00Z'), formatter('Pacific/Apia'));
    expect(result.deadline).toBeNull();
    expect(result.reason).toContain('отсутствует');
  });

  it('uses 19:00 on the entry date even when the entry is later that evening', () => {
    const result = stageDeadline({ deadlineMode: 'end_of_day' }, new Date('2026-09-18T17:30:00Z'), formatter());
    expect(result.deadline?.toISOString()).toBe('2026-09-18T16:00:00.000Z');
  });

  it('does not require entry history for an explicitly unlimited stage', () => {
    expect(stageDeadline({ deadlineMode: 'unlimited' }, null, formatter())).toEqual({ mode: 'unlimited', deadline: null });
    expect(hasStageDeadline({ deadlineMode: 'unlimited' })).toBe(true);
    expect(hasStageDeadline({})).toBe(false);
    expect(hasStageDeadline({ deadlineMode: 'business_days' })).toBe(false);
  });
});
