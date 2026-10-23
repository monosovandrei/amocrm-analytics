import { WorkspacesService } from './workspaces.service';
describe('workspace application rules', () => {
    const department = { key: 'sales', name: 'Продажи', groupId: 'group', pipelineIds: ['sales-pipeline'], assemblyPipelineId: 'assembly', shippingStageId: 'shipped' };
    const scope = { userId: 'account', role: 'MANAGER', departmentKey: 'sales', managerId: 'seller', fingerprint: 'f1' };
    const invoiceReport = { type: 'contract', rows: [{ groupId: 'seller', groupName: 'Продавец', metrics: { payment_amount: { value: 120 } } }], summaryRows: [{ metrics: { payment_amount: { value: 120 } } }] };
    function fixture(role = 'MANAGER') {
        const p: any = { workspacePlan: { findMany: jest.fn().mockResolvedValue([]) }, factDealCurrent: { findMany: jest.fn().mockResolvedValue([]) }, factStageTransition: { findMany: jest.fn().mockResolvedValue([]) }, commercialShipmentLink: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) }, crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'seller', name: 'Продавец' }]) }, factDealStageInterval: { findMany: jest.fn().mockResolvedValue([]) }, ropStageSlaRule: { findMany: jest.fn().mockResolvedValue([]) }, customFieldDefinition: { findFirst: jest.fn().mockResolvedValue(null) } };
        const access: any = { resolve: jest.fn().mockResolvedValue({ ...scope, role }), department: jest.fn().mockResolvedValue(department), managerIds: jest.fn().mockResolvedValue(['seller']) };
        const reports: any = { getTeamFunnelDefinition: jest.fn().mockResolvedValue({}), workspaceReport: jest.fn().mockResolvedValue(invoiceReport) };
        const service = new WorkspacesService(p, access, reports, { assignment: jest.fn().mockResolvedValue(new Map()) } as any, {} as any);
        return { p, access, reports, service };
    }
    beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-23T12:00:00Z')); });
    afterEach(() => jest.useRealTimers());
    it('does not allow managers to change even their own plans', async () => {
        await expect(fixture().service.savePlan('account', { department: 'sales', month: '2026-10', targetType: 'MANAGER', targetId: 'seller', metric: 'payments', value: 100, version: 0 })).rejects.toThrow('Менеджер');
    });
    it.each([-1, NaN, Infinity, '', null])('rejects invalid plan value %s', async (value) => {
        await expect(fixture('ROP').service.savePlan('account', { department: 'sales', month: '2026-10', targetType: 'MANAGER', targetId: 'seller', metric: 'payments', value, version: 0 })).rejects.toThrow();
    });
    it('does not let a ROP edit a different group plan', async () => {
        await expect(fixture('ROP').service.savePlan('account', { department: 'sales', month: '2026-10', targetType: 'GROUP', targetId: 'other', metric: 'payments', value: 100, version: 0 })).rejects.toThrow('Чужой');
    });
    it('keeps two independent plan metrics and no invented plan when missing', async () => {
        const { service } = fixture();
        const result = await service.plans('account', { month: '2026-09' });
        expect(result.rows[0].values).toMatchObject([{ metric: 'payments', fact: 120, plan: null, completion: null, forecast: null }, { metric: 'shipments', fact: 0, plan: null, completion: null, forecast: null }]);
        expect(result.total).toBeNull();
        expect(result.canEdit).toBe(false);
    });
    it('represents zero plan separately from an absent plan without dividing by zero', async () => {
        const { service, p } = fixture();
        p.workspacePlan.findMany.mockResolvedValue([{ metric: 'payments', targetType: 'MANAGER', targetId: 'seller', value: 0, version: 1 }]);
        const result = await service.plans('account', { month: '2026-09' });
        expect(result.rows[0].values[0]).toMatchObject({ plan: 0, fact: 120, completion: null, remaining: 0 });
    });
    it('does not invent a historical monthly forecast', async () => {
        await expect(fixture().service.report('account', 'revenue_profit_forecast', { month: '2026-09' })).rejects.toThrow('текущий');
    });
    it('does not block the first plan/fact screen on a forecast calculation',async()=>{
        const {service,reports}=fixture();await service.plans('account',{month:'2026-10'});
        expect(reports.workspaceReport.mock.calls.map((call:any[])=>call[0])).toEqual(['sales_funnel_steps']);
    });
    it('shows the difference between the group plan and personal plans',async()=>{
        const {service,p}=fixture('ROP');
        p.workspacePlan.findMany.mockResolvedValue([{metric:'payments',targetType:'GROUP',targetId:'group',value:500,version:1},{metric:'payments',targetType:'MANAGER',targetId:'seller',value:300,version:1}]);
        const result=await service.plans('account',{month:'2026-09'});
        expect(result.planReconciliation?.[0]).toMatchObject({individualSum:300,departmentPlan:500,difference:200,missingPlans:0});
    });
    it('keeps promised Delivery day inclusive in Moscow',async()=>{
        const {service,p}=fixture();
        p.factDealCurrent.findMany.mockResolvedValue([{dealId:'ship',stageId:'stage',amount:5,customFields:{delivery:{value:'2026-10-23'}}}]);
        p.customFieldDefinition.findFirst.mockResolvedValue({externalId:'delivery'});
        p.factDealStageInterval.findMany.mockResolvedValue([{dealId:'ship',stageId:'stage',enteredAt:new Date('2026-10-22T12:00:00Z')}]);
        p.ropStageSlaRule.findMany.mockResolvedValue([{stageId:'stage',isEnabled:true,slaDays:3,reason:'Настроено администратором'}]);
        expect((await service.deals('account',{kind:'shipments'})).rows[0].assessment).toBe('OK');
    });
    it('restricts operational cards to current department and owner', async () => {
        const { service, p } = fixture();
        await service.deals('account', {});
        expect(p.factDealCurrent.findMany.mock.calls[0][0].where).toMatchObject({ pipelineId: { in: ['sales-pipeline'] }, responsibleId: { in: ['seller'] }, deletedAt: null, stageIsWon: false, stageIsLost: false });
    });
    it('uses commercial links, not the logistics owner, for the shipment list', async () => {
        const { service, p } = fixture();
        p.commercialShipmentLink.findMany.mockResolvedValue([{ shipmentDealId: 'ship' }]);
        await service.deals('account', { kind: 'shipments' });
        expect(p.factDealCurrent.findMany.mock.calls[0][0].where).toMatchObject({ pipelineId: 'assembly', dealId: { in: ['ship'] } });
        expect(p.factDealCurrent.findMany.mock.calls[0][0].where.responsibleId).toBeUndefined();
    });
    it('never gives a healthy stage label without a confirmed entry time', async () => {
        const { service, p } = fixture();
        p.factDealCurrent.findMany.mockResolvedValue([{ dealId: 'deal', dealExternalId: '123', stageId: 'stage', amount: 5 }]);
        p.ropStageSlaRule.findMany.mockResolvedValue([{ stageId: 'stage', isEnabled: true, slaDays: 3, reason: 'Настроено администратором' }]);
        const result = await service.deals('account', { attention: 'true' });
        expect(result.rows[0]).toMatchObject({ assessment: 'UNKNOWN', reason: 'Нет подтверждённой даты входа в этап' });
    });
    it('does not silently use a fallback seven-day threshold', async () => {
        const { service, p } = fixture();
        p.factDealCurrent.findMany.mockResolvedValue([{ dealId: 'deal', stageId: 'stage', amount: 5 }]);
        p.factDealStageInterval.findMany.mockResolvedValue([{ dealId: 'deal', stageId: 'stage', enteredAt: new Date('2026-10-01') }]);
        p.ropStageSlaRule.findMany.mockResolvedValue([{ stageId: 'stage', isEnabled: true, slaDays: 7, reason: 'Для этапа пока нет отдельного SLA, используется запасной порог 7 дн.' }]);
        expect((await service.deals('account', {})).rows[0].assessment).toBe('UNKNOWN');
    });
    it('uses current stage entry, not the last note update, for elapsed time', async () => {
        const { service, p } = fixture();
        p.factDealCurrent.findMany.mockResolvedValue([{ dealId: 'deal', stageId: 'stage', amount: 5, updatedAt: new Date() }]);
        p.factDealStageInterval.findMany.mockResolvedValue([{ dealId: 'deal', stageId: 'stage', enteredAt: new Date('2026-10-19T12:00:00Z') }]);
        p.ropStageSlaRule.findMany.mockResolvedValue([{ stageId: 'stage', isEnabled: true, slaDays: 3, reason: 'Настроено администратором' }]);
        expect((await service.deals('account', {})).rows[0]).toMatchObject({ assessment: 'OVERDUE', days: 4, overdueDays: 1 });
    });
});
