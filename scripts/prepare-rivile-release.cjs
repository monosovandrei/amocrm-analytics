'use strict';
// One-time owner-approved configuration. Runtime resolution uses database links,
// never names or these seed IDs. Repeated deployments do not reset edited goals.
const path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
 const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
 try{
  const p=app.get(load('./dist/prisma/prisma.service').PrismaService),config=require('../config/rivile-owner-approved-20261026.json');
  const action='workspace.rivile.owner-approved-20261026';
  if(await p.auditLog.findFirst({where:{action}})){console.log(JSON.stringify({alreadyPrepared:true}));return;}
  const candidates=await app.get(load('./dist/workspaces/workspace-onboarding.service').WorkspaceOnboardingService).candidates((await p.user.findFirstOrThrow({where:{isActive:true,role:'ADMIN'}})).id);
  const sales=candidates.filter(c=>c.departmentKey==='sales'),users=await p.crmUser.findMany({select:{id:true,externalId:true}}),byExternal=new Map(users.map(u=>[u.externalId,u]));
  if(!sales.length||config.seniorAmoIds.some(id=>!sales.some(c=>c.id===byExternal.get(id)?.id)))throw new Error('Senior manager identity or active Sales roster is inconsistent');
  for(const link of config.managerLinks)if(!byExternal.has(link.amoExternalId))throw new Error('Approved CRM identity is missing: '+link.amoExternalId);
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date());
  const goals=sales.flatMap(c=>{const senior=config.seniorAmoIds.some(id=>byExternal.get(id)?.id===c.id);return [{targetType:'MANAGER',targetId:c.id,metric:'paid',value:config.paidTarget},{targetType:'MANAGER',targetId:c.id,metric:'shipmentMargin',value:senior?config.seniorMarginTarget:config.juniorMarginTarget}];});
  const department=await p.workspaceDepartment.findUniqueOrThrow({where:{key:'sales'}});
  for(const metric of ['paid','shipmentMargin'])goals.push({targetType:'GROUP',targetId:department.groupId,metric,value:goals.filter(g=>g.targetType==='MANAGER'&&g.metric===metric).reduce((s,g)=>s+g.value,0)});
  if(!process.argv.includes('--apply-owner-approved')){console.log(JSON.stringify({applied:false,month,managers:sales.length,goals:goals.length,links:config.managerLinks.length}));return;}
  await p.$transaction(async tx=>{
   for(const link of config.managerLinks){const data={code:link.code,crmUserId:byExternal.get(link.amoExternalId).id,departmentKey:link.departmentKey,source:config.source};const old=await tx.rivileManagerLink.findUnique({where:{code:link.code}});if(old&&(old.crmUserId!==data.crmUserId||old.departmentKey!==data.departmentKey))throw new Error('Existing financial manager mapping differs; automatic overwrite refused');await tx.rivileManagerLink.upsert({where:{code:link.code},create:data,update:{}});}
   for(const employee of sales){const margin=goals.find(g=>g.targetType==='MANAGER'&&g.targetId===employee.id&&g.metric==='shipmentMargin').value;await tx.salesTargetProfile.upsert({where:{crmUserId:employee.id},create:{crmUserId:employee.id,marginTarget:margin,paidTarget:config.paidTarget},update:{}});}
   for(const goal of goals){const where={departmentKey:'sales',period:'MONTH',start:`${month}-01`,targetType:goal.targetType,targetId:goal.targetId,metric:goal.metric};const before=await tx.workspaceKpiGoal.findUnique({where:{departmentKey_period_start_targetType_targetId_metric:where}});await tx.workspaceKpiGoal.upsert({where:{departmentKey_period_start_targetType_targetId_metric:where},create:{...where,value:goal.value},update:{value:goal.value,version:{increment:1}}});await tx.auditLog.create({data:{action:'workspace.kpi-goal.owner-approved',entity:'WorkspaceKpiGoal',metadata:{...where,before:before?String(before.value):null,after:goal.value}}});}
   await tx.auditLog.create({data:{action,entity:'Workspace',metadata:{month,managers:sales.length,goals:goals.length,links:config.managerLinks.length,source:'Rivile posted equipment documents',paidSource:'amoCRM unique paid deals'}}});
  });
  console.log(JSON.stringify({applied:true,month,managers:sales.length,links:config.managerLinks.length}));
 }finally{await app.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1;});
