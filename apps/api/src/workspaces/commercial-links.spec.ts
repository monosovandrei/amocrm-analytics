import { CommercialLinksService } from './commercial-links.service';
describe('commercial shipment ownership', () => {
    function fixture(status = 'CONFIRMED', managerId: string | null = 'seller') {
        const p = { workspaceDepartment: { findMany: jest.fn().mockResolvedValue([
                    { key: 'sales', name: 'Продажи', groupId: 'sales-group', assemblyPipelineId: 'assembly' },
                ]) }, commercialShipmentLink: { findMany: jest.fn().mockResolvedValue([
                    { shipmentDealId: 'shipment', saleDealId: 'sale', managerId, departmentKey: 'sales', status },
                ]) }, crmUser: { findMany: jest.fn().mockResolvedValue(managerId ? [{ id: 'seller', name: 'Продавец', group: { id: 'sales-group' } }] : []) } };
        return { p, service: new CommercialLinksService(p as any) };
    }
    const shipment = { id: 'shipment', pipelineId: 'assembly', responsibleId: 'logistics', responsible: { name: 'Логист' } };
    it('attributes a shipment to its confirmed seller, never the logistics owner', async () => {
        expect((await fixture().service.attribute([shipment]))[0]).toMatchObject({ responsibleId: 'seller', responsible: { name: 'Продавец' } });
    });
    it('changing a logistics owner does not change commercial ownership', async () => {
        const { service } = fixture();
        expect((await service.attribute([{ ...shipment, responsibleId: 'another-logistics' }]))[0].responsibleId).toBe('seller');
    });
    it.each(['UNRESOLVED', 'AMBIGUOUS', 'REJECTED'])('retains unknown assignment explicitly: %s', async (status) => {
        expect((await fixture(status).service.attribute([shipment]))[0]).toMatchObject({ responsibleId: 'unassigned-commercial', responsible: { name: 'Не распределено' } });
    });
    it('does not replace a missing seller with a logistics owner', async () => {
        expect((await fixture('CONFIRMED', null).service.attribute([shipment]))[0].responsibleId).toBe('unassigned-commercial');
    });
    it('does not reassign normal sales cards', async () => {
        const deal = { ...shipment, pipelineId: 'sales' };
        expect((await fixture().service.attribute([deal]))[0]).toBe(deal);
    });
    it('restricts assembly scopes to confirmed department and manager links', async () => {
        const { service, p } = fixture();
        expect(await service.assemblyScope('assembly', 'sales', ['seller'])).toEqual({ pipelineId: 'assembly', dealId: { in: ['shipment'] } });
        expect(p.commercialShipmentLink.findMany).toHaveBeenCalledWith({ where: { status: 'CONFIRMED', departmentKey: 'sales', managerId: { in: ['seller'] } }, select: { shipmentDealId: true } });
    });
});
