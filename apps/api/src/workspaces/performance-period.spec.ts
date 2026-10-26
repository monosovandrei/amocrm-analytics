import { performancePeriod, rankPerformance } from './performance-period';

describe('performance periods and fair ranks', () => {
    const now = new Date('2026-10-26T12:00:00Z');
    it('uses Moscow midnight and exclusive end of month', () => {
        expect(performancePeriod({}, now)).toMatchObject({ period: 'MONTH', month: '2026-10', key: '2026-10-01', start: new Date('2026-09-30T21:00:00Z'), end: new Date('2026-10-31T21:00:00Z') });
    });
    it('handles leap year February', () => { expect(performancePeriod({ month: '2028-02' }, now).end.toISOString()).toBe('2028-02-29T21:00:00.000Z'); });
    it('clips the week explicitly to its month and retains one target key for the week', () => {
        const monday = performancePeriod({ month: '2026-10', day: '2026-10-26', period: 'WEEK' }, now);
        const saturday = performancePeriod({ month: '2026-10', day: '2026-10-31', period: 'WEEK' }, now);
        expect(monday.key).toBe('2026-10-26'); expect(saturday.key).toBe(monday.key); expect(monday.end).toEqual(new Date('2026-10-31T21:00:00Z'));
    });
    it.each(['2026-02-30', '2026-13-01', '2026-10-00', '2026-09-30', 'invalid'])('rejects invalid day %s', day => { expect(() => performancePeriod({ month: '2026-10', day, period: 'DAY' }, now)).toThrow(); });
    it.each(['2026-00', '2026-13', '26-10', 'bad'])('rejects invalid month %s', month => { expect(() => performancePeriod({ month }, now)).toThrow(); });
    it('does not give a last place to people without positive targets', () => {
        const row = (id: string, fact: number, plan: number | null) => ({ id, values: [{ metric: 'paid', fact, plan }] });
        const ranked = rankPerformance([row('a', 2, 4), row('b', 10, null), row('c', 1, 2), row('d', 10, 10), row('e', 2, 0)], 'paid', 'completion', false);
        expect(ranked.map(r => [r.id, r.rank])).toEqual([['d', 1], ['a', 2], ['c', 2], ['b', null], ['e', null]]);
    });
    it('can rank factual performance separately from target completion', () => {
        expect(rankPerformance([{ id: 'a', values: [{ metric: 'paid', fact: 3, plan: null }] }], 'paid', 'fact', false)[0].rank).toBe(1);
    });
    it('does not assign any shipment rank until unassigned shipments are resolved', () => {
        expect(rankPerformance([{ id: 'a', values: [{ metric: 'shipments', fact: 100, plan: 200 }] }], 'shipments', 'completion', true)[0].rank).toBeNull();
    });
});
