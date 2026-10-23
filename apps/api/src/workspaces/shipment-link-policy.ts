import { createHash } from 'node:crypto';
export function responsibleExternalId(value:unknown):string|null {
    const item=Array.isArray(value)?value[0]:value;
    const id=(item as any)?.responsible_user?.id;
    return /^\d+$/.test(String(id))&&String(id)!=='0'?String(id):null;
}
export function identifier(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    const result = String(value).trim();
    return result && !/^(?:0|null|нет|без номера|-|n\/a)$/i.test(result) ? result : null;
}
export function fileIds(value: unknown): string[] {
    if (!value || typeof value !== 'object')
        return [];
    if (Array.isArray(value))
        return [...new Set(value.flatMap(fileIds))];
    const result: string[] = [];
    for (const [key, child] of Object.entries(value)) {
        if (['file_uuid', 'uuid', 'file_id', 'version_uuid'].includes(key) && typeof child === 'string' && child.length >= 16)
            result.push(child);
        else if (typeof child === 'object')
            result.push(...fileIds(child));
    }
    return [...new Set(result)];
}
export function chooseShipmentSource(shipment: {
    invoice: unknown;
    document: unknown;
    createdAt: Date;
}, candidates: Array<{
    id: string;
    invoice: unknown;
    document: unknown;
    createdAt: Date;
    paidAt?: Date | null;
}>) {
    const invoice = identifier(shipment.invoice), files = new Set(fileIds(shipment.document));
    if (!invoice && !files.size)
        return { status: 'UNRESOLVED', saleDealId: null, evidence: { reason:'missing-business-identifier' } };
    const matches = candidates.filter(c => {
        if(!c.paidAt||c.paidAt>shipment.createdAt||c.createdAt>shipment.createdAt)return false;
        const otherInvoice=identifier(c.invoice),otherFiles=fileIds(c.document);
        const invoiceMatch=Boolean(invoice&&otherInvoice===invoice);
        const documentMatch=otherFiles.some(f=>files.has(f));
        if(invoice&&otherInvoice&&invoice!==otherInvoice)return false;
        if(files.size&&otherFiles.length&&!documentMatch)return false;
        return invoiceMatch||documentMatch;
    });
    if (matches.length !== 1)
        return { status: matches.length ? 'AMBIGUOUS' : 'UNRESOLVED', saleDealId: null, evidence: { candidateCount: matches.length } };
    return { status: 'IDENTIFIED', saleDealId: matches[0].id, evidence: { invoiceHash: invoice?createHash('sha256').update(invoice).digest('hex'):null,
        documentHashes:[...files].filter(id=>fileIds(matches[0].document).includes(id)).map(id=>createHash('sha256').update(id).digest('hex')),
        basis: 'unique-invoice-identity-with-confirmed-payment' } };
}
