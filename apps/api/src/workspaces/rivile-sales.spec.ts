import { parseRivileDocument, goalMetricsFor } from './rivile-sales';
import { RivileSalesService } from './rivile-sales.service';
import { rankPerformance } from './performance-period';

const line = { I07_KODAS: 'SRV', I07_TIPAS: '1', I07_SUMA: '1000.00', I07_SAVIKAINA: '700.00' };
const document = { I06_KODAS_PO:'doc', I06_DOK_NR:'INV-1', I06_DOK_DATA:'2026-10-20', I06_KODAS_MS:'105', I06_PERKELTA:'2', I06_OP_TIP:'51', I07:[line] };
describe('Rivile accounting and source integrity',()=>{
    it('uses revenue minus actual cost, not the forecast rate or invoice VAT',()=>{
        expect(parseRivileDocument({...document,I06_SUMA_PVM:'210'},'2026-10-01','2026-11-01')).toMatchObject({revenue:1000,cost:700,margin:300,managerCode:'105'});
    });
    it('subtracts returns including their cost reversal',()=>{
        expect(parseRivileDocument({...document,I06_OP_TIP:'52'},'2026-10-01','2026-11-01')).toMatchObject({revenue:-1000,cost:-700,margin:-300});
    });
    it('does not invent zero cost when the source is missing it',()=>{
        expect(()=>parseRivileDocument({...document,I07:[{...line,I07_SAVIKAINA:undefined}]},'2026-10-01','2026-11-01')).toThrow('INVALID_FINANCIAL_VALUE');
    });
    it.each(['','not-money','NaN','Infinity'])('rejects malformed financial value %s',value=>{
        expect(()=>parseRivileDocument({...document,I07:[{...line,I07_SUMA:value}]},'2026-10-01','2026-11-01')).toThrow();
    });
    it('allows genuine zero cost and decimal commas',()=>{
        expect(parseRivileDocument({...document,I07:[{...line,I07_SUMA:'1000,50',I07_SAVIKAINA:'0'}]},'2026-10-01','2026-11-01')?.margin).toBe(1000.5);
    });
    it('rounds financial decimals without binary floating point half-cent errors',()=>{
        expect(parseRivileDocument({...document,I07:[{...line,I07_SUMA:'1.005',I07_SAVIKAINA:'0'}]},'2026-10-01','2026-11-01')?.margin).toBe(1.01);
        expect(parseRivileDocument({...document,I06_OP_TIP:'52',I07:[{...line,I07_SUMA:'1.005',I07_SAVIKAINA:'0'}]},'2026-10-01','2026-11-01')?.margin).toBe(-1.01);
    });
    it('ignores unposted documents, not their posted counterparts',()=>{
        expect(parseRivileDocument({...document,I06_PERKELTA:'1'},'2026-10-01','2026-11-01')).toBeNull();
    });
    it('matches the existing equipment scope, excluding services but retaining delivery code',()=>{
        expect(parseRivileDocument({...document,I07:[{...line,I07_TIPAS:'2',I07_KODAS:'9990001'}]},'2026-10-01','2026-11-01')).toBeNull();
        expect(parseRivileDocument({...document,I07:[{...line,I07_TIPAS:'2',I07_KODAS:'9990006'}]},'2026-10-01','2026-11-01')?.margin).toBe(300);
    });
    it('does not accept out-of-window or invalid document dates',()=>{
        expect(()=>parseRivileDocument({...document,I06_DOK_DATA:'2026-11-01'},'2026-10-01','2026-11-01')).toThrow();
        expect(()=>parseRivileDocument({...document,I06_DOK_DATA:'2026-02-30'},'2026-02-01','2026-03-01')).toThrow();
    });
    it('defines only two Sales goals without changing the CS contract',()=>{
        expect(goalMetricsFor('sales')).toEqual(['paid','shipmentMargin']); expect(goalMetricsFor('csm')).toHaveLength(4);
    });
    it('does not rank a missing or unverified margin as zero',()=>{
        expect(rankPerformance([{id:'a',values:[{metric:'shipmentMargin',fact:null,plan:40000}]}],'shipmentMargin','completion',false)[0].rank).toBeNull();
        expect(rankPerformance([{id:'a',values:[{metric:'shipmentMargin',fact:10000,plan:40000}]}],'shipmentMargin','completion',true)[0].rank).toBeNull();
    });
    function fixture(snapshot:any,links:any[]=[]){
        const p:any={rivileSalesSnapshot:{findUnique:jest.fn().mockResolvedValue(snapshot)},rivileManagerLink:{findMany:jest.fn().mockResolvedValue(links)}};
        return {p,service:new RivileSalesService(p)};
    }
    beforeEach(()=>{jest.useFakeTimers();jest.setSystemTime(new Date('2026-10-26T12:00:00Z'));});
    afterEach(()=>jest.useRealTimers());
    const start=new Date('2026-10-01T00:00:00+03:00'),end=new Date('2026-11-01T00:00:00+03:00');
    it('does not certify a partial snapshot after its month closes',async()=>{
        jest.setSystemTime(new Date('2026-11-01T00:01:00Z'));
        const {service}=fixture({documents:[],cutoffAt:new Date('2026-10-31T20:59:00Z'),throughDate:'2026-10-31'});
        expect((await service.read('2026-10',start,end,'sales')).source.status).toBe('CHECKING');
    });
    it('keeps the last good facts on failure but does not certify them',async()=>{
        const {service}=fixture({documents:[{...parseRivileDocument(document,'2026-10-01','2026-11-01')}],cutoffAt:new Date(),lastError:'SOURCE_REFRESH_FAILED'},[{code:'105',crmUserId:'bilal',departmentKey:'sales'}]);
        const result=await service.read('2026-10',start,end,'sales');expect(result.documents[0].margin).toBe(300);expect(result.source.status).toBe('CHECKING');
    });
    it('flags unknown manager codes and keeps CS documents out of Sales',async()=>{
        const {service}=fixture({documents:[{...parseRivileDocument(document,'2026-10-01','2026-11-01'),managerCode:'unknown'},{...parseRivileDocument(document,'2026-10-01','2026-11-01'),id:'other',managerCode:'CS'}],cutoffAt:new Date()},[{code:'CS',crmUserId:'cs-user',departmentKey:'csm'}]);
        const result=await service.read('2026-10',start,end,'sales');expect(result.documents).toEqual([]);expect(result.unknownCodes).toEqual(['unknown']);expect(result.source.status).toBe('CHECKING');
    });
    it('does not schedule source calls from verification processes',async()=>{
        const saved=process.env.WORKER_ROLE;process.env.WORKER_ROLE='verification';
        try{const {p,service}=fixture(null);await service.tick();expect(p.rivileSalesSnapshot.findUnique).not.toHaveBeenCalled();}finally{if(saved===undefined)delete process.env.WORKER_ROLE;else process.env.WORKER_ROLE=saved;}
    });
    it('does not start Rivile background work in an untagged HTTP API process',async()=>{
        const role=process.env.WORKER_ROLE,key=process.env.RIVILE_API_KEY;delete process.env.WORKER_ROLE;process.env.RIVILE_API_KEY='test-only-not-a-real-key';
        try{const {p,service}=fixture(null);await service.tick();expect(p.rivileSalesSnapshot.findUnique).not.toHaveBeenCalled();}finally{if(role===undefined)delete process.env.WORKER_ROLE;else process.env.WORKER_ROLE=role;if(key===undefined)delete process.env.RIVILE_API_KEY;else process.env.RIVILE_API_KEY=key;}
    });
    it('requires two identical source reads before publishing a financial snapshot',async()=>{
        const {p,service}=fixture(null);p.rivileSalesSnapshot.upsert=jest.fn();p.rivileSalesSnapshot.updateMany=jest.fn().mockResolvedValue({count:1});
        const first={documents:[parseRivileDocument(document,'2026-10-01','2026-11-01')],throughDate:'2026-10-27'};
        jest.spyOn(service as any,'load').mockResolvedValueOnce(first).mockResolvedValueOnce({...first,documents:[]});
        await expect(service.refresh('2026-10')).rejects.toThrow('previous snapshot retained');
        expect(p.rivileSalesSnapshot.updateMany.mock.calls.some(([arg]:any[])=>arg.data.documents!==undefined)).toBe(false);
    });
    it('publishes stable documents atomically and releases the lease',async()=>{
        const {p,service}=fixture(null);p.rivileSalesSnapshot.upsert=jest.fn();p.rivileSalesSnapshot.updateMany=jest.fn().mockResolvedValue({count:1});
        const stable={documents:[parseRivileDocument(document,'2026-10-01','2026-11-01')],throughDate:'2026-10-27'};
        jest.spyOn(service as any,'load').mockResolvedValue(stable);await service.refresh('2026-10');
        expect(p.rivileSalesSnapshot.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({documents:stable.documents,runId:null,leaseUntil:null,lastError:null})}));
    });
    it('does not issue source calls when another process owns the lease',async()=>{
        const {p,service}=fixture(null);p.rivileSalesSnapshot.upsert=jest.fn();p.rivileSalesSnapshot.updateMany=jest.fn().mockResolvedValue({count:0});const fetcher=jest.spyOn(service as any,'load');
        expect(await service.refresh('2026-10')).toEqual({skipped:true});expect(fetcher).not.toHaveBeenCalled();
    });
    it('can explicitly exclude an owner-confirmed external code without inventing a CRM identity',async()=>{
        const {service}=fixture({documents:[parseRivileDocument(document,'2026-10-01','2026-11-01')],cutoffAt:new Date()},[{code:'105',crmUserId:null,departmentKey:null}]);
        const result=await service.read('2026-10',start,end,'sales');expect(result.documents).toEqual([]);expect(result.unknownCodes).toEqual([]);expect(result.source.status).toBe('CERTIFIED');
    });
    it('creates missing monthly goals from profiles without rewriting an edited plan or creating goals for heads',async()=>{
        const saved:any[]=[{departmentKey:'sales',period:'MONTH',start:'2026-10-01',targetType:'MANAGER',targetId:'a',metric:'paid',value:99}];
        const tx:any={workspaceKpiGoal:{findUnique:jest.fn(({where}:any)=>saved.find(g=>Object.entries(where.departmentKey_period_start_targetType_targetId_metric).every(([k,v])=>g[k]===v))||null),create:jest.fn(({data}:any)=>{saved.push(data);return {...data,id:'goal'};}),findMany:jest.fn(({where}:any)=>saved.filter(g=>g.metric===where.metric&&where.targetId.in.includes(g.targetId))),upsert:jest.fn()},auditLog:{create:jest.fn()}};
        const p:any={workspaceDepartment:{findUnique:jest.fn().mockResolvedValue({groupId:'g'})},salesTargetProfile:{findMany:jest.fn().mockResolvedValue([{crmUserId:'a',marginTarget:40000,paidTarget:14,version:1},{crmUserId:'head',marginTarget:30000,paidTarget:14,version:1}])},crmUser:{findMany:jest.fn().mockResolvedValue([{id:'a'},{id:'head'}])},user:{findMany:jest.fn().mockResolvedValue([{crmUserId:'head'}])},$transaction:jest.fn(fn=>fn(tx))};
        await new RivileSalesService(p).ensureMonthlyTargets();expect(tx.workspaceKpiGoal.create).toHaveBeenCalledTimes(1);expect(saved.find(g=>g.targetId==='a'&&g.metric==='paid')?.value).toBe(99);expect(saved.find(g=>g.targetId==='a'&&g.metric==='shipmentMargin')?.value).toBe(40000);expect(saved.some(g=>g.targetId==='head')).toBe(false);
    });
});
