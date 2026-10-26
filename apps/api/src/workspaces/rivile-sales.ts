import { Prisma } from '../generated/prisma';

export type RivileDocument = { id: string; number: string; date: string; managerCode: string; revenue: number; cost: number; margin: number; operation: string };
export const isMoneyMetric = (metric: string) => metric === 'shipments' || metric === 'shipmentMargin';
export const goalMetricsFor = (department: string) => department === 'sales' ? ['paid', 'shipmentMargin'] : ['proposals', 'invoices', 'paid', 'shipments'];
export const text = (v: unknown) => typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
const money = (v: unknown) => {
    const raw = text(v).replace(/\s/g, '').replace(',', '.');
    if (!raw || !/^-?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw new Error('INVALID_FINANCIAL_VALUE');
    return new Prisma.Decimal(raw);
};
export const roundMoney = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

// Same accounting scope as the existing warehouse sales report: posted sales and
// returns, equipment (delivery code remains equipment), base amounts excluding VAT.
export function parseRivileDocument(raw: Record<string, any>, from: string, toExclusive: string): RivileDocument | null {
    if (text(raw.I06_PERKELTA) !== '2') return null;
    const operation = text(raw.I06_OP_TIP);
    if (!['51', '52'].includes(operation)) throw new Error('INVALID_OPERATION');
    const id = text(raw.I06_KODAS_PO), date = text(raw.I06_DOK_DATA).slice(0, 10);
    if (!id || !/^20\d\d-\d\d-\d\d$/.test(date) || date < from || date >= toExclusive || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('INVALID_DOCUMENT_ID_OR_DATE');
    if (!raw.I07 || typeof raw.I07 !== 'object') throw new Error('MISSING_DOCUMENT_LINES');
    const lines = Array.isArray(raw.I07) ? raw.I07 : [raw.I07];
    const sign = operation === '52' ? -1 : 1;
    let revenue = new Prisma.Decimal(0), cost = new Prisma.Decimal(0), count = 0;
    for (const line of lines) {
        const code = text(line.I07_KODAS);
        if (!code || !text(line.I07_TIPAS)) throw new Error('MISSING_LINE_CLASSIFICATION');
        if (code !== '9990006' && (text(line.I07_TIPAS) === '2' || code.startsWith('999'))) continue;
        revenue = revenue.plus(money(line.I07_SUMA).abs().mul(sign));
        cost = cost.plus(money(line.I07_SAVIKAINA).abs().mul(sign));
        count++;
    }
    if (!count) return null;
    return { id, number: text(raw.I06_DOK_NR) || id, date, managerCode: text(raw.I06_KODAS_MS), revenue: revenue.toDecimalPlaces(2).toNumber(), cost: cost.toDecimalPlaces(2).toNumber(), margin: revenue.minus(cost).toDecimalPlaces(2).toNumber(), operation };
}
