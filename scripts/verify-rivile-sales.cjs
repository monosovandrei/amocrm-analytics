'use strict';
const path=require('node:path'),{createRequire}=require('node:module'),root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
 const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
 try{
  const p=app.get(load('./dist/prisma/prisma.service').PrismaService),service=app.get(load('./dist/workspaces/performance.service').PerformanceService),rivile=app.get(load('./dist/workspaces/rivile-sales.service').RivileSalesService);
  const {performancePeriod}=load('./dist/workspaces/performance-period'),period=performancePeriod({}),admin=await p.user.findFirstOrThrow({where:{isActive:true,role:'ADMIN'}}),month=period.month;
  const result=await service.overview(admin.id,{department:'sales',month}),source=await rivile.read(month,period.start,period.end,'sales');
  if(source.source.status!=='CERTIFIED')throw new Error(source.source.reason||'Rivile not certified');
  const failures=[],check=(name,condition)=>{if(!condition)failures.push(name);};
  const close=(a,b)=>a!=null&&b!=null&&Math.abs(a-b)<.015;
  check('two-sales-goals',JSON.stringify(result.goalMetrics)===JSON.stringify(['paid','shipmentMargin']));
  for(const row of result.rows){const expected=source.documents.filter(d=>d.managerId===row.id).reduce((s,d)=>s+d.margin,0),actual=row.values.find(v=>v.metric==='shipmentMargin');check('manager-margin/'+row.id,close(actual.fact,expected));if(actual.plan>0)check('manager-completion/'+row.id,close(actual.completion,expected/actual.plan*100));}
  check('department-margin',close(result.total.values.find(v=>v.metric==='shipmentMargin').fact,source.documents.reduce((s,d)=>s+d.margin,0)));
  check('rows-sum',close(result.rows.reduce((s,r)=>s+r.values.find(v=>v.metric==='shipmentMargin').fact,0),result.total.values.find(v=>v.metric==='shipmentMargin').fact));
  check('unique-source-documents',new Set(source.documents.map(d=>d.id)).size===source.documents.length);
  check('no-unmapped-financial-actors',source.unknownCodes.length===0);
  const participants=result.rows.filter(r=>r.participant&&r.active);
  const goals=await p.workspaceKpiGoal.findMany({where:{departmentKey:'sales',period:'MONTH',start:month+'-01'}});
  for(const row of participants)for(const metric of ['paid','shipmentMargin']){const saved=goals.find(g=>g.targetType==='MANAGER'&&g.targetId===row.id&&g.metric===metric);check('persisted-target/'+row.id+'/'+metric,row.values.find(v=>v.metric===metric).plan===(saved?Number(saved.value):null));}
  console.log(JSON.stringify({status:failures.length?'failed':'passed',month,checkedAt:new Date().toISOString(),cutoffAt:source.source.cutoffAt,documents:source.documents.length,managers:participants.length,failures}));if(failures.length)process.exitCode=1;
 }finally{await app.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
