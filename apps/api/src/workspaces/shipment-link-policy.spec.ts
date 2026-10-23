import { chooseShipmentSource, responsibleExternalId } from './shipment-link-policy';
describe('shipment source evidence', () => {
    const document = { file_uuid: 'invoice-document-1234567890' };
    const shipment = { invoice: 'INV-001', document, createdAt: new Date('2026-10-23') };
    const sale = { id: 'sale', invoice: 'INV-001', document, createdAt: new Date('2026-10-20'), paidAt:new Date('2026-10-22') };
    it('accepts a unique source corroborated by invoice, file and payment', () => expect(chooseShipmentSource(shipment, [sale])).toMatchObject({ status: 'IDENTIFIED', saleDealId: 'sale' }));
    it('accepts a unique invoice number backed by an actual payment event', () => expect(chooseShipmentSource({ ...shipment, document: null }, [sale]).status).toBe('IDENTIFIED'));
    it('accepts an immutable invoice file identity when the text number is missing', () => expect(chooseShipmentSource({ ...shipment, invoice: null }, [sale]).status).toBe('IDENTIFIED'));
    it('never matches on customer/name/amount similarity', () => expect(chooseShipmentSource({ ...shipment, invoice: null,document:null }, [sale]).status).toBe('UNRESOLVED'));
    it('does not choose an arbitrary duplicate source', () => expect(chooseShipmentSource(shipment, [sale, { ...sale, id: 'other' }]).status).toBe('AMBIGUOUS'));
    it('does not treat different invoice numbers as the same order', () => expect(chooseShipmentSource({ ...shipment, invoice: 'INV-002' }, [sale]).status).toBe('UNRESOLVED'));
    it('does not merge identifiers after dropping meaningful zeroes', () => expect(chooseShipmentSource({ ...shipment, invoice: 'INV-1' }, [sale]).status).toBe('UNRESOLVED'));
    it('does not use another document with the same invoice number', () => expect(chooseShipmentSource({ ...shipment, document: { file_uuid: 'different-document-1234567890' } }, [sale]).status).toBe('UNRESOLVED'));
    it('cannot link to a sale created after the shipment', () => expect(chooseShipmentSource(shipment, [{ ...sale, createdAt: new Date('2026-10-25') }]).status).toBe('UNRESOLVED'));
    it('ignores an automatic Base copy with no payment event',()=>expect(chooseShipmentSource(shipment,[sale,{...sale,id:'base-copy',paidAt:null}])).toMatchObject({status:'IDENTIFIED',saleDealId:'sale'}));
    it('cannot use a payment after creation of assembly',()=>expect(chooseShipmentSource(shipment,[{...sale,paidAt:new Date('2026-10-24')}]).status).toBe('UNRESOLVED'));
    it('reads native historical responsible identity without substituting the event author',()=>expect(responsibleExternalId([{responsible_user:{id:12345}}])).toBe('12345'));
    it.each([null,[],[{responsible_user:{id:0}}],[{created_by:12345}]])('rejects an unknown historical responsible: %j',value=>expect(responsibleExternalId(value)).toBeNull());
});
