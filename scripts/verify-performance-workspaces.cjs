'use strict';
// Read-only, repeatable database snapshot: the four counters vs canonical CRM reports and shipment plans.
const path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
 const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
 const checks=[],failures=[],timings=[];
 const check=(name,actual,expected)=>{const passed=typeof actual==='number'&&typeof expected==='number'?Math.abs(actual-expected)<.005:JSON.stringify(actual)===JSON.stringify(expected);checks.push({name,passed});if(!passed)failures.push({name,actual,expected});};
 try{
  const p=app.get(load('./dist/prisma/prisma.service').PrismaService),performance=app.get(load('./dist/workspaces/performance.service').PerformanceService),reports=app.get(load('./dist/reports/reports.service').ReportsService),workspaces=app.get(load('./dist/workspaces/workspaces.service').WorkspacesService),access=app.get(load('./dist/workspaces/workspace-access.service').WorkspaceAccessService),quality=app.get(load('./dist/quality/data-quality.service').DataQualityService),links=app.get(load('./dist/workspaces/commercial-links.service').CommercialLinksService);
  await p.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
   const readOnly=new Proxy(tx,{get(target,key){if(key==='$transaction')return async fn=>fn(readOnly);const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
   for(const service of [performance,reports,workspaces,access,quality,links])service.prisma=readOnly;
   reports.compute=(dto,user)=>reports.computeFresh(dto,user);reports.saveRevenueForecastSnapshot=async()=>undefined;
   const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date()),departments=await tx.workspaceDepartment.findMany(),accounts=await tx.user.findMany({where:{isActive:true},select:{id:true}}),scopes=[];
   for(const user of accounts){const scope=await access.resolve(user.id).catch(()=>null);if(scope)scopes.push(scope);}
   const admin=scopes.find(s=>s.role==='ADMIN');if(!admin)throw new Error('No active administrator');
   for(const department of departments){
    const query={department:department.key,month};const started=performanceNow();const actual=await performance.overview(admin.userId,query);timings.push({scope:`ADMIN/${department.key}`,milliseconds:Math.round(performanceNow()-started)});
    const report=await workspaces.report(admin.userId,department.key==='sales'?'sales_funnel_steps':'csm_funnel',query),plan=await workspaces.plans(admin.userId,query);
    const keys={proposals:department.key==='sales'?'kp_presented':'offer_made',invoices:'invoice_sent',paid:'paid'};
    for(const [metric,key]of Object.entries(keys))check(`${department.key}/raw-total/${metric}`,actual.total.values.find(v=>v.metric===metric).raw,Number(report.summaryRows?.[0]?.metrics?.[key]?.value||0));
    for(const row of actual.rows){
     for(const [metric,key]of Object.entries(keys)){const expected=Number(report.rows?.find(r=>r.groupId===row.id)?.metrics?.[key]?.value||0);check(`${department.key}/${row.id}/${metric}/raw-amo-events`,row.values.find(v=>v.metric===metric).raw,expected);}
     check(`${department.key}/${row.id}/shipments`,row.values.find(v=>v.metric==='shipments').fact,plan.rows.find(r=>r.id===row.id)?.values.find(v=>v.metric==='shipments').fact||0);
    }
    for(const metric of ['proposals','invoices','paid','shipments'])check(`${department.key}/sum/${metric}`,actual.rows.reduce((sum,r)=>sum+r.values.find(v=>v.metric===metric).fact,0),actual.total.values.find(v=>v.metric===metric).fact);
    for(const role of ['ROP','MANAGER']){
     const scope=scopes.find(s=>s.role===role&&s.departmentKey===department.key);if(!scope){checks.push({name:`${role}/${department.key}/no-active-account-yet`,passed:true});continue;}
     const personal=await performance.overview(scope.userId,query);
     check(`${role}/${department.key}/editable`,personal.canEdit,role!=='MANAGER');
     if(role==='MANAGER'){check(`${role}/${department.key}/own-only`,personal.rows.map(r=>r.id),[scope.managerId]);check(`${role}/${department.key}/no-total`,personal.total,null);check(`${role}/${department.key}/no-outside-actors`,personal.unknownEvents,undefined);}
     const other=departments.find(d=>d.key!==department.key);let blocked=false;try{await performance.overview(scope.userId,{...query,department:other.key});}catch(e){blocked=e.getStatus?.()===403;}check(`${role}/${department.key}/other-department-denied`,blocked,true);
    }
   }
  },{isolationLevel:'RepeatableRead',timeout:240000,maxWait:10000});
  console.log(JSON.stringify({status:failures.length?'failed':'passed',checkedAt:new Date().toISOString(),readOnly:true,checks:checks.length,failures,timings}));if(failures.length)process.exitCode=1;
 }finally{await app.close();}
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;});
function performanceNow(){return require('node:perf_hooks').performance.now();}
