export const kpiLabels = { proposals: 'КП', invoices: 'Счета отправлены', paid: 'Оплаты, шт.', shipments: 'Отгружено' };
export type KpiValue = { metric: keyof typeof kpiLabels; fact: number; raw: number; plan: number | null; version: number; completion: number | null; remaining: number | null };
export const kpiNumber = (value: number | null, metric: string) => value == null ? 'Не задано' : new Intl.NumberFormat('ru-RU', metric === 'shipments' ? { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 } : { maximumFractionDigits: 0 }).format(value);
