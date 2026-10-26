import { PerformanceService } from './performance.service';

describe('performance API privacy, provenance and targets', () => {
    const department = { key: 'sales', name: 'Продажи', groupId: 'g', assemblyPipelineId: 'assembly', shippingStageId: 'shipping' };
    const event = (metric: string, dealId: string, actorId: string | null, day: number, eventId: string) => ({ metric, dealId, actorId, eventId, occurredAt: new Date(`2026-10-${day}T09:00:00Z`) });
    function fixture(role = 'ROP') {
        const tx: any = {
            workspaceCompetitionPeriod: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
            crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'a', name: 'Первый', email: 'first@workspace.invalid', isActive: true, groupId: 'g' }, { id: 'b', name: 'Второй', email: 'second@workspace.invalid', isActive: true, groupId: 'g' }]) },
            workspaceKpiGoal: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'goal', version: 1, value: 5 }) },
            workspacePlan: { findMany: jest.fn().mockResolvedValue([]) }, auditLog: { create: jest.fn() },
            workspaceDisplay: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn() },
            workspaceDepartment: { findUnique: jest.fn().mockResolvedValue(department) },
            factDealCurrent: { findMany: jest.fn().mockResolvedValue([]) },
            user: { findMany: jest.fn().mockResolvedValue([]) },
            $queryRaw: jest.fn().mockResolvedValue([]),
        };
        tx.$transaction = jest.fn((fn: any) => fn(tx));
        const access: any = { resolve: jest.fn().mockResolvedValue({ role }), department: jest.fn().mockResolvedValue(department), managerIds: jest.fn().mockResolvedValue(role === 'MANAGER' ? ['a'] : ['a', 'b']) };
        const quality: any = { status: jest.fn().mockResolvedValue({ overall: 'CERTIFIED', cutoffAt: '2026-10-26T11:59:00Z', checkedAt: '2026-10-26T12:00:00Z' }) };
        const reports: any = { getTeamFunnelDefinition: jest.fn().mockResolvedValue({ config: { contract: { metrics: ['kp_presented', 'invoice_sent', 'paid'].map(id => ({ id, stageIds: [id] })) } } }) };
        const workspaces: any = { savePlan: jest.fn().mockResolvedValue({ version: 2 }) };
        const service = new PerformanceService(tx, access, reports, quality, workspaces);
        return { service, tx, access, quality, reports, workspaces };
    }
    beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-26T12:00:00Z')); });
    afterEach(() => jest.useRealTimers());
    it('keeps raw CRM actions when competition has not been configured', async () => {
        const { service, tx } = fixture();
        tx.$queryRaw.mockResolvedValueOnce([event('proposals', 'd', 'a', 26, 'e1'), event('proposals', 'd', 'a', 26, 'e2')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);
        const result = await service.overview('u', {});
        expect(result.policy).toBeNull(); expect(result.rows[0].values[0]).toMatchObject({ fact: 2, raw: 2, plan: null, completion: null });
    });
    it('credits a deal to its first actor, not its current owner or a repeated actor', async () => {
        const { service, tx } = fixture();
        tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({ mode: 'UNIQUE_DEAL', memberIds: ['a', 'b'] });
        tx.$queryRaw.mockResolvedValueOnce([event('proposals', 'd', 'a', 25, 'e1'), event('proposals', 'd', 'b', 26, 'e2'), event('paid', 'd', 'b', 26, 'e3')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);
        const result = await service.overview('u', { period: 'DAY', day: '2026-10-26' });
        expect(result.rows[0].values[0].fact).toBe(0); expect(result.rows[1].values[0]).toMatchObject({ fact: 0, raw: 1 }); expect(result.rows[1].values[2].fact).toBe(1);
    });
    it('never credits a repeated deal again after a new month starts', async () => {
        const { service, tx } = fixture(); tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({mode:'UNIQUE_DEAL',memberIds:['a']});
        tx.$queryRaw.mockResolvedValueOnce([event('paid','deal','a',26,'e1')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:0n}]).mockResolvedValueOnce([{metric:'paid',dealId:'deal'}]);
        expect((await service.overview('u',{})).rows[0].values[2]).toMatchObject({fact:0,raw:1});
    });
    it('keeps historical actors in department totals even if they have moved to another CRM group', async () => {
        const {service,tx}=fixture();
        tx.crmUser.findMany.mockResolvedValueOnce([{id:'a',name:'Первый',isActive:true,groupId:'g'}]).mockResolvedValueOnce([{id:'historical',name:'Прежний сотрудник',isActive:false,groupId:'other'}]);
        tx.$queryRaw.mockResolvedValueOnce([event('proposals','d','historical',26,'e1')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:0n}]);
        const result=await service.overview('u',{});
        expect(result.rows.find(r=>r.id==='historical')).toMatchObject({canSetGoal:false});
        expect(result.total?.values[0]).toMatchObject({fact:1,raw:1});
    });
    it('does not let automation steal the first human credit, while retaining the raw CRM total', async () => {
        const {service,tx}=fixture();tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({mode:'UNIQUE_DEAL',memberIds:['a']});
        tx.$queryRaw.mockResolvedValueOnce([{...event('proposals','d',null,26,'e1'),system:true},event('proposals','d','a',26,'e2')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:0n}]);
        const result=await service.overview('u',{});expect(result.total?.values[0]).toMatchObject({fact:1,raw:2});expect(result.unattributedMetrics).toEqual([]);
    });
    it('marks unknown human actors as unresolved instead of quietly assigning their actions', async () => {
        const {service,tx}=fixture();tx.$queryRaw.mockResolvedValueOnce([event('paid','d',null,26,'e1')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:0n}]);
        const result=await service.overview('u',{});expect(result.unattributedMetrics).toContain('paid');expect(result.total?.values[2]).toMatchObject({fact:0,raw:1});
    });
    it('does not expose colleague names or event totals in a personal response', async () => {
        const { service, tx } = fixture('MANAGER');
        tx.$queryRaw.mockResolvedValueOnce([event('paid', 'd', 'b', 26, 'e1')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 2n }]);
        const result = await service.overview('u', {});
        expect(result.rows.map(r => r.id)).toEqual(['a']); expect(result.total).toBeNull(); expect(result.unknownEvents).toBeUndefined(); expect(result.unresolvedShipments).toBeUndefined(); expect(result.incompleteShipments).toBe(true);
    });
    it('pauses certification if either quality read fails or the cutoff is old', async () => {
        const { service, quality } = fixture(); quality.status.mockResolvedValueOnce({ overall: 'CERTIFIED', cutoffAt: '2026-10-26T11:59:00Z' }).mockResolvedValueOnce({ overall: 'BLOCKED' });
        expect((await service.overview('u', {})).dataStatus.status).toBe('BLOCKED');
    });
    it('uses existing monthly shipment plans instead of introducing a conflicting duplicate', async () => {
        const { service, workspaces, access } = fixture(); access.department.mockResolvedValue({...department,key:'csm'}); await service.saveGoal('u', { metric: 'shipments', value: 100, version: 0, targetType: 'MANAGER', targetId: 'a' }); expect(workspaces.savePlan).toHaveBeenCalledWith('u', expect.objectContaining({ metric: 'shipments', month: '2026-10' }));
    });
    it('denies managers write access', async () => { await expect(fixture('MANAGER').service.saveGoal('u', { targetType: 'MANAGER', targetId: 'a' })).rejects.toThrow('РОП'); });
    it('redacts transferred deals in personal credit evidence while retaining their fact', async () => {
        const { service, tx, reports } = fixture('MANAGER');
        reports.getTeamFunnelDefinition.mockResolvedValue({ pipelineIds: ['sales'], config: { contract: { metrics: ['kp_presented','invoice_sent','paid'].map(id=>({id,stageIds:[id]})) } } });
        tx.$queryRaw.mockResolvedValueOnce([event('paid','deal','a',26,'original-amo-event')]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:0n}]);
        tx.factDealCurrent.findMany.mockResolvedValue([{dealId:'deal',dealExternalId:'PRIVATE-ID',title:'PRIVATE-CUSTOMER',pipelineId:'other-department',responsibleId:'b'}]);
        const result=await service.overview('u',{detail:'paid'});
        expect(result.rows[0].values.find(v=>v.metric==='paid')?.fact).toBe(1);
        expect(result.proof?.rows[0]).toMatchObject({counted:true,eventId:'original-amo-event',externalId:null,title:'Историческое действие по переданной сделке'});
        expect(JSON.stringify(result)).not.toContain('PRIVATE');
    });
    it.each([-1, 2.5, '', null, Infinity, 'bad'])('rejects invalid count target %s', async value => { await expect(fixture().service.saveGoal('u', { metric: 'paid', value, targetType: 'MANAGER', targetId: 'a' })).rejects.toThrow(); });
    it('rejects goal update with a stale version', async () => { const { service, tx } = fixture(); tx.workspaceKpiGoal.findUnique.mockResolvedValue({ version: 2 }); await expect(service.saveGoal('u', { metric: 'paid', value: 3, version: 1, targetType: 'MANAGER', targetId: 'a' })).rejects.toThrow('изменена'); });
    it('requires explicit confirmation, mode and participant selection', async () => { await expect(fixture().service.setCompetition('u', { confirmed: true, mode: 'UNIQUE_DEAL', memberIds: [] })).rejects.toThrow('выберите'); });
    it('does not permit changing rules mid-period', async () => { const { service, tx } = fixture(); tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({ mode: 'UNIQUE_DEAL', memberIds: ['a'] }); await expect(service.setCompetition('u', { mode: 'UNIQUE_DEAL', memberIds: ['a'], confirmed: true })).rejects.toThrow('утверждены'); });
    it.each(['ROP', 'MANAGER'])('denies display credentials to %s', async role => { await expect(fixture(role).service.createDisplay('u', {})).rejects.toThrow('администратор'); });
    it('rejects expired or revoked displays before reading business data', async () => { const { service, tx } = fixture(); tx.workspaceDisplay.findUnique.mockResolvedValue({ expiresAt: new Date('2026-10-25'), revokedAt: null }); await expect(service.display('opaque-token', {})).rejects.toThrow('истёк'); expect(tx.$queryRaw).not.toHaveBeenCalled(); });
    it('returns only a limited display response, not employee IDs or customer data', async () => {
        const { service, tx } = fixture(); tx.workspaceDisplay.findUnique.mockResolvedValue({ expiresAt: new Date('2026-10-27'), departmentKey: 'sales' });
        tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({ mode: 'UNIQUE_DEAL', memberIds: ['a'] });
        const result = await service.display('token', {});
        expect(result.boards).toHaveLength(5); expect(result.boards[0].rows).toHaveLength(1);
        expect(Object.keys(result.boards[0].rows[0]).sort()).toEqual(['completion','fact','metric','name','plan','rank','raw','remaining','unit','version'].sort());
        expect(result.boards[0].rows[0].rank).toBeNull();
    });
    it('uses identical actual Rivile margin in overview and TV independently of unassigned CRM shipments', async()=>{
        const {service,tx}=fixture();
        (service as any).rivile={read:jest.fn().mockResolvedValue({source:{status:'CERTIFIED',reason:null,cutoffAt:new Date('2026-10-26T11:59:00Z')},unknownCodes:[],links:[{crmUserId:'a'}],documents:[{id:'rv',number:'INV-1',date:'2026-10-20',managerId:'a',revenue:1000,cost:700,margin:300,operation:'51'}]})};
        tx.workspaceCompetitionPeriod.findUnique.mockResolvedValue({mode:'UNIQUE_DEAL',memberIds:['a']});
        tx.workspaceKpiGoal.findMany.mockResolvedValue([{metric:'shipmentMargin',targetType:'MANAGER',targetId:'a',value:40000,version:1},{metric:'paid',targetType:'MANAGER',targetId:'a',value:14,version:1}]);
        const result=await service.overview('u',{detail:'shipmentMargin'});
        expect(result.goalMetrics).toEqual(['paid','shipmentMargin']);expect(result.rows[0].values.find(v=>v.metric==='shipmentMargin')).toMatchObject({fact:300,plan:40000,completion:.75});
        expect(result.rows[0].values.find(v=>v.metric==='paid')?.plan).toBe(14);expect(result.proof?.rows[0].reason).toContain('700.00');
        tx.workspaceDisplay.findUnique.mockResolvedValue({expiresAt:new Date('2026-10-27'),departmentKey:'sales'});
        tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{count:53n}]);
        const display=await service.display('token',{}),margin=display.boards.find(b=>b.metric==='shipmentMargin')!;
        expect(margin.paused).toBe(false);expect(margin.rows[0].rank).toBe(1);expect(margin.rows[0].fact).toBe(300);
        expect(JSON.stringify(display)).not.toContain('INV-1');expect(margin.rows[0]).not.toHaveProperty('cost');expect(margin.rows[0]).not.toHaveProperty('revenue');
    });
    it('retains stale Rivile facts without a target completion percentage',async()=>{
        const {service,tx}=fixture('MANAGER');
        (service as any).rivile={read:jest.fn().mockResolvedValue({source:{status:'CHECKING',reason:'source failed',cutoffAt:new Date()},documents:[{managerId:'a',margin:100}],links:[],unknownCodes:[]})};
        tx.workspaceKpiGoal.findMany.mockResolvedValue([{metric:'shipmentMargin',targetType:'MANAGER',targetId:'a',value:30000}]);
        const result=await service.overview('u',{});expect(result.rows[0].values.find(v=>v.metric==='shipmentMargin')).toMatchObject({fact:100,plan:30000,completion:null,remaining:null});expect(result.unknownRivileCodes).toBeUndefined();
    });
    it.each(['proposals','invoices','shipments'])('rejects an extra Sales goal for %s',async metric=>{
        await expect(fixture().service.saveGoal('u',{metric,targetType:'MANAGER',targetId:'a',value:100})).rejects.toThrow('Некорректная цель');
    });
    it.each(['ROP','MANAGER'])('denies financial manager configuration to %s',async role=>{
        await expect(fixture(role).service.rivileSettings('u')).rejects.toThrow();await expect(fixture(role).service.rivileMapping('u',{})).rejects.toThrow();await expect(fixture(role).service.salesTargetProfile('u',{})).rejects.toThrow();
    });
});
