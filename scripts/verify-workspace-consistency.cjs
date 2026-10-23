'use strict';
// Candidate workspaces, one database snapshot, no fixture/business-data writes.
const {createRequire}=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
  const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
  const checks=[],failures=[];const check=(name,actual,expected)=>{const passed=typeof actual==='number'&&typeof expected==='number'?Math.abs(actual-expected)<.005:JSON.stringify(actual)===JSON.stringify(expected);checks.push({name,passed});if(!passed)failures.push({name,actual,expected});};
  try{
    const p=app.get(load('./dist/prisma/prisma.service').PrismaService),reports=app.get(load('./dist/reports/reports.service').ReportsService),workspaces=app.get(load('./dist/workspaces/workspaces.service').WorkspacesService),access=app.get(load('./dist/workspaces/workspace-access.service').WorkspaceAccessService),links=app.get(load('./dist/workspaces/commercial-links.service').CommercialLinksService);
    await p.$transaction(async tx=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      for(const service of [reports,workspaces,access,links])service.prisma=tx;
      reports.compute=(dto,user)=>reports.computeFresh(dto,user);reports.saveRevenueForecastSnapshot=async()=>undefined;
      const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date()),[year,number]=month.split('-').map(Number),start=new Date(`${month}-01T00:00:00+03:00`),end=new Date(Date.UTC(year,number,1)-10800000-1);
      const accounts=await tx.user.findMany({where:{isActive:true},orderBy:{createdAt:'asc'},select:{id:true}}),contexts=[],seen=new Set();
      for(const account of accounts){
        const scope=await access.resolve(account.id).catch(()=>null);if(!scope)continue;
        const departments=await tx.workspaceDepartment.findMany({where:scope.role==='ADMIN'?{}:{key:scope.departmentKey}});
        for(const department of departments){const key=`${scope.role}:${department.key}`;if(seen.has(key))continue;seen.add(key);contexts.push({scope,department});}
      }
      check('required-rop-sales',seen.has('ROP:sales'),true);check('required-rop-csm',seen.has('ROP:csm'),true);check('required-admin',seen.has('ADMIN:sales')&&seen.has('ADMIN:csm'),true);
      for(const {scope,department} of contexts){
        const label=`${scope.role}/${department.key}`;process.stderr.write(JSON.stringify({step:'workspace',scope:label})+'\n');
        const query={department:department.key,month},plan=await workspaces.plans(scope.userId,query),report=await workspaces.report(scope.userId,department.key==='sales'?'sales_funnel_steps':'csm_funnel',query),metric=department.key==='sales'?'payment_amount':'paid_amount';
        for(const row of plan.rows)check(`${label}/${row.id}/payments`,row.values.find(v=>v.metric==='payments').fact,Number(report.rows.find(r=>r.groupId===row.id)?.metrics?.[metric]?.value||0));
        if(plan.total){check(`${label}/total/payments`,plan.total.values.find(v=>v.metric==='payments').fact,Number(report.summaryRows[0].metrics[metric].value));for(const key of ['payments','shipments'])check(`${label}/sum/${key}`,plan.rows.reduce((s,r)=>s+r.values.find(v=>v.metric===key).fact,0),plan.total.values.find(v=>v.metric===key).fact);}
        const details=await workspaces.deals(scope.userId,{...query,kind:'shipments',shipped:'true'}),shipmentFact=plan.total?plan.total.values.find(v=>v.metric==='shipments').fact:plan.rows.reduce((s,r)=>s+r.values.find(v=>v.metric==='shipments').fact,0);
        check(`${label}/shipping-detail`,shipmentFact,details.amount);
        const forecast=await workspaces.report(scope.userId,'revenue_profit_forecast',query);check(`${label}/forecast-ready`,forecast.ready,true);check(`${label}/forecast-actual`,Number(forecast.summary.actualRevenue),shipmentFact);
        if(global.gc)global.gc();
      }
      const admin=contexts.find(c=>c.scope.role==='ADMIN').scope,template=reports.buildRevenueForecastReportTemplate(),company=await reports.compute({name:template.name,sourceType:template.sourceType,filters:{},config:template.config},{id:admin.userId,role:'ADMIN'});
      const actual=await reports.getActualShipping({dateFrom:start.toISOString(),dateTo:end.toISOString()},'ADMIN');
      check('company/actual-includes-unassigned',Number(company.summary.actualRevenue),actual.entries.reduce((s,e)=>s+Number(e.deal.amount),0));
      const ids=company.rows.flatMap(r=>r.deals.map(d=>d.dealId));check('company/no-duplicate-forecast-deals',new Set(ids).size,ids.length);
      const currencies=await tx.factDealCurrent.groupBy({by:['currency'],_count:true,where:{deletedAt:null}});check('single-currency',currencies.every(c=>c.currency==='EUR'),true);
    },{isolationLevel:'RepeatableRead',maxWait:10000,timeout:300000});
    console.log(JSON.stringify({status:failures.length?'failed':'passed',checkedAt:new Date().toISOString(),readOnly:true,checks:checks.length,failures}));if(failures.length)process.exitCode=1;
  }finally{await app.close();}
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;});
