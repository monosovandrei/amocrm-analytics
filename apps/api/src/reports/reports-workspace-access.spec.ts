import { ReportsService } from './reports.service';
describe('report access revalidation', () => {
    it.each(['CHECKING','BLOCKED','CERTIFIED'])('only sends certified Telegram report data: %s',async status=>{
        const quality={reportQuality:jest.fn().mockResolvedValue({status})};
        const access={resolve:jest.fn().mockResolvedValue({userId:'admin',role:'ADMIN'})};
        const service=new ReportsService({} as any,{} as any,quality as any,undefined,access as any) as any;
        service.latestReportSourceSyncAt=jest.fn().mockResolvedValue(new Date());
        service.compute=jest.fn().mockResolvedValue({summary:{count:1}});
        const result=service.notificationReport({name:'Отчёт',sourceType:'DEALS',config:{}},'admin');
        if(status==='CERTIFIED')await expect(result).resolves.toMatchObject({report:{summary:{count:1}}});
        else await expect(result).rejects.toThrow('данные ещё не прошли проверку');
        expect(service.compute).toHaveBeenCalledWith(expect.anything(),expect.anything(),{requireFresh:true});
    });
    const scope = { userId: 'a', role: 'MANAGER', departmentKey: 'sales', managerId: 'seller', fingerprint: 'v1', version: 1 };
    const department = { key: 'sales', pipelineIds: ['sales-pipeline'], assemblyPipelineId: 'assembly' };
    const dto = { filters: { _workspace: { departmentKey: 'sales', managerIds: ['seller'], ownManagerId: 'seller', pipelineIds: ['sales-pipeline'], assemblyPipelineId: 'assembly', fingerprint: 'v1' } } };
    function fixture(patch = {}) {
        const access = { resolve: jest.fn().mockResolvedValue({ ...scope, ...patch }), department: jest.fn().mockResolvedValue(department), managerIds: jest.fn().mockResolvedValue(['seller']) };
        return new ReportsService({} as any, {} as any, undefined, undefined, access as any) as any;
    }
    it('validates persisted scope against current database permissions', async () => {
        await expect(fixture().assertWorkspaceActor(dto, { id: 'a', role: 'ADMIN' })).resolves.toBeUndefined();
    });
    it('ignores the stale ADMIN role from a queued job', async () => {
        await expect(fixture().assertWorkspaceActor({ filters: {} }, { id: 'a', role: 'ADMIN' })).rejects.toThrow('Права изменились');
    });
    it('rejects results from an old binding/role version', async () => {
        await expect(fixture({ fingerprint: 'v2' }).assertWorkspaceActor(dto, { id: 'a', role: 'ROP' })).rejects.toThrow('Права изменились');
    });
    it.each([
        { managerIds: ['other'] }, { pipelineIds: ['other'] }, { assemblyPipelineId: 'other' }, { ownManagerId: null },
    ])('rejects forged or widened scope: %j', async (patch) => {
        await expect(fixture().assertWorkspaceActor({ filters: { _workspace: { ...dto.filters._workspace, ...patch } } }, { id: 'a', role: 'ROP' })).rejects.toThrow();
    });
    it('allows an explicitly current administrator to use full report endpoints', async () => {
        await expect(fixture({ role: 'ADMIN' }).assertWorkspaceActor({ filters: {} }, { id: 'a', role: 'ROP' })).resolves.toBeUndefined();
    });
    it('includes personal access scope in the cache key', () => {
        const s = fixture();
        expect(s.reportCacheKey(dto, { id: 'a', role: 'ADMIN' })).not.toBe(s.reportCacheKey(dto, { id: 'b', role: 'ADMIN' }));
    });
    it('rechecks recipients and never sends a department report to an individual manager',async()=>{
        const access:any={resolve:jest.fn(async(id:string)=>id==='a'?scope:id==='admin'?{role:'ADMIN'}:id==='rop'?{role:'ROP',departmentKey:'sales'}:id==='other'?{role:'ROP',departmentKey:'csm'}:{role:'MANAGER',departmentKey:'sales',managerId:id})};
        const s=new ReportsService({} as any,{} as any,undefined,undefined,access);
        expect(await s.notificationRecipients({...scope,role:'ROP'} as any,['admin','rop','other','seller'])).toEqual(['admin','rop']);
        expect(await s.notificationRecipients(scope as any,['admin','rop','other','seller','colleague'])).toEqual(['admin','rop','seller']);
    });
    it('does not send a prepared notification after the author role changes',async()=>{
        const s=fixture({fingerprint:'new'});
        await expect(s.notificationRecipients(scope,['a'])).rejects.toThrow('изменились');
    });
});
