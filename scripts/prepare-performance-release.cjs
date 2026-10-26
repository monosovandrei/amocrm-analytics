'use strict';
// Explicit release step authorized by the owner: prepare personal accounts, no messages or shared passwords.
const path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
 const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
 try{
  const p=app.get(load('./dist/prisma/prisma.service').PrismaService),onboarding=app.get(load('./dist/workspaces/workspace-onboarding.service').WorkspaceOnboardingService),performance=app.get(load('./dist/workspaces/performance.service').PerformanceService);
  const admin=await p.user.findFirstOrThrow({where:{isActive:true,role:'ADMIN'},select:{id:true}}),candidates=await onboarding.candidates(admin.id);
  const apply=process.argv.includes('--apply-owner-approved-rollout');
  if(!apply){console.log(JSON.stringify({applied:false,candidates:candidates.length,departments:['sales','csm'].map(key=>({key,managers:candidates.filter(c=>c.departmentKey===key).length}))}));return;}
  if(await p.auditLog.findFirst({where:{action:'workspace.performance.owner-approved-rollout'},select:{id:true}})){console.log(JSON.stringify({applied:false,alreadyPrepared:true}));return;}
  const prepared=await onboarding.provision(admin.id,{confirmed:true,crmUserIds:candidates.map(c=>c.id)});
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(new Date());
  for(const department of await p.workspaceDepartment.findMany()){
   const existing=await p.workspaceCompetitionPeriod.findUnique({where:{departmentKey_month:{departmentKey:department.key,month}}});
   if(existing){if(existing.mode!=='UNIQUE_DEAL')throw new Error('Existing competition uses different approved rules; automatic rewrite refused');continue;}
   const settings=await performance.competitionSettings(admin.id,{department:department.key,month});
   const ids=settings.candidates.filter(c=>candidates.some(candidate=>candidate.id===c.id&&candidate.departmentKey===department.key)).map(c=>c.id);
   if(ids.length)await performance.setCompetition(admin.id,{department:department.key,month,mode:'UNIQUE_DEAL',memberIds:ids,confirmed:true});
  }
  await p.auditLog.create({data:{action:'workspace.performance.owner-approved-rollout',entity:'Workspace',metadata:{month,created:prepared.created,eligible:candidates.length,mode:'UNIQUE_DEAL',invitesIssued:0,telegramUnchanged:true}}});
  console.log(JSON.stringify({applied:true,created:prepared.created,eligible:candidates.length,mode:'UNIQUE_DEAL',invitesIssued:0,sharedPasswords:false}));
 }finally{await app.close();}
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;});
