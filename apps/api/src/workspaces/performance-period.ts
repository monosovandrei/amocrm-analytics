import { BadRequestException } from '@nestjs/common';

export function performancePeriod(query: Record<string, string>, now = new Date()) {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const period = query.period || 'MONTH';
    const month = query.month || today.slice(0, 7);
    if (typeof month !== 'string' || !/^20\d\d-(0[1-9]|1[0-2])$/.test(month) || !['MONTH', 'WEEK', 'DAY'].includes(period)) throw new BadRequestException('Выберите корректный период');
    const day = query.day || (month === today.slice(0, 7) ? today : `${month}-01`);
    if (typeof day !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(day) || day.slice(0, 7) !== month) throw new BadRequestException('Дата должна относиться к выбранному месяцу');
    const anchor = new Date(`${day}T00:00:00+03:00`);
    if (!Number.isFinite(+anchor) || new Date(+anchor + 10800000).toISOString().slice(0, 10) !== day) throw new BadRequestException('Некорректная дата');
    const [year, number] = month.split('-').map(Number);
    const monthStart = new Date(`${month}-01T00:00:00+03:00`), monthEnd = new Date(Date.UTC(year, number, 1) - 10800000);
    let start = monthStart, end = monthEnd;
    if (period === 'DAY') { start = anchor; end = new Date(+anchor + 86400000); }
    if (period === 'WEEK') {
        const weekday = new Date(+anchor + 10800000).getUTCDay() || 7;
        start = new Date(Math.max(+monthStart, +anchor - (weekday - 1) * 86400000));
        end = new Date(Math.min(+monthEnd, +anchor + (8 - weekday) * 86400000));
    }
    return { period, month, day, key: new Date(+start + 10800000).toISOString().slice(0, 10), start, end, monthStart, monthEnd };
}

export function rankPerformance<T extends { id: string; values: Array<{ metric: string; fact: number | null; plan: number | null }> }>(rows: T[], metric: string, by: string, incompleteShipments: boolean) {
    const eligible = rows.filter(row => row.values.find(v => v.metric === metric)?.fact != null && !(['shipments', 'shipmentMargin'].includes(metric) && incompleteShipments) && (by !== 'completion' || (row.values.find(v => v.metric === metric)?.plan || 0) > 0));
    const score = (row: T) => { const v = row.values.find(v => v.metric === metric)!; return by === 'completion' ? v.fact! / v.plan! : v.fact!; };
    eligible.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    let rank = 0, previous: number | null = null;
    const ranks = new Map<string, number>();
    eligible.forEach((row, index) => { const value = score(row); if (previous == null || Math.abs(value - previous) > 1e-9) rank = index + 1; previous = value; ranks.set(row.id, rank); });
    return rows.map(row => ({ ...row, rank: ranks.get(row.id) ?? null })).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.id.localeCompare(b.id));
}
