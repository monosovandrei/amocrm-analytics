'use strict';
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const root = process.argv.find(a=>a.startsWith('--root='))?.slice(7) || require('node:path').resolve(__dirname,'..');
const load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
load('reflect-metadata');
process.env.WORKER_ROLE='verification';
(async()=>{
  const {NestFactory}=load('@nestjs/core');
  const {AppModule}=load('./dist/app.module');
  const {PrismaService}=load('./dist/prisma/prisma.service');
  const {ReportsService}=load('./dist/reports/reports.service');
  const {CommercialLinksService}=load('./dist/workspaces/commercial-links.service');
  const app=await NestFactory.createApplicationContext(AppModule,{logger:false});
  try{
    const p=app.get(PrismaService),reports=app.get(ReportsService);
    const refs=await reports.resolveRevenueForecastRefs();
    if(!refs.ready)throw new Error('Источники прогноза не настроены');
    const definitions=await Promise.all(['sales','csm'].map(async key=>({key,definition:await reports.getTeamFunnelDefinition(key)})));
    if(definitions.some(d=>!d.definition))throw new Error('Не настроены воронки отделов');
    const applied=process.argv.includes('--apply');
    const summary={applied,departments:definitions.map(d=>d.key),accounts:[],links:null,plansCopied:0};
    if(!applied){console.log(JSON.stringify(summary));return;}
    // This is a one-time migration, not a source of truth for later admin edits.
    if(!process.argv.includes('--currency-only')&&!process.argv.includes('--reapply-workspace-migration')&&await p.auditLog.findFirst({where:{action:'workspace.migration.prepared'},select:{id:true}})){
      console.log(JSON.stringify({applied:false,alreadyPrepared:true}));return;
    }
    const connection=await p.amoConnection.findFirst({orderBy:{createdAt:'desc'},select:{accountId:true}});
    const account=connection?.accountId?await p.amoAccountSnapshot.findUnique({where:{externalId:connection.accountId},select:{raw:true}}):null;
    if(account?.raw?.currency!=='EUR')throw new Error('Валюта аккаунта не подтверждена как EUR. Автоматический пересчёт или подмена единиц запрещены');
    const currencies=await p.deal.groupBy({by:['currency'],_count:true});
    if(currencies.some(c=>!['RUB','EUR'].includes(c.currency)))throw new Error('В базе несколько валют: требуется отдельная проверка');
    summary.currencyRepair=await p.$transaction(async tx=>{
      // Labels only: the old importer hardcoded RUB for EUR account prices. Never change amounts or CRM timestamps.
      const deals=await tx.$executeRaw`UPDATE "Deal" SET currency='EUR' WHERE currency='RUB'`;
      const facts=await tx.$executeRaw`UPDATE fact_deal_current SET currency='EUR' WHERE currency='RUB'`;
      await tx.auditLog.create({data:{action:'workspace.currency-label.repaired',entity:'Deal',metadata:{source:'amo-account.currency',currency:'EUR',deals,facts,amountsUnchanged:true}}});return {deals,facts};
    },{timeout:180000});
    if(process.argv.includes('--currency-only')){console.log(JSON.stringify(summary));return;}
    for(const {key,definition} of definitions){
      const data={name:key==='sales'?'Продажи':'CS',groupId:definition.group.id,pipelineIds:definition.filters.pipelineIds,
        paymentStageIds:definition.config.contract.metrics.find(m=>m.id==='paid').stageIds,
        assemblyPipelineId:refs.assemblyPipeline.id,shippingStageId:refs.shippingDoneStage.id};
      if(!data.pipelineIds?.length)throw new Error(`Нет воронок для ${key}`);
      await p.workspaceDepartment.upsert({where:{key},create:{key,...data},update:data});
    }
    // Explicit human-confirmed roster, not inference from Support/Management membership.
    const roster=[{name:'Сержант',department:'sales'},{name:'Владимир Супруненко',department:'sales'}];
    for(const member of roster){
      const matches=await p.crmUser.findMany({where:{name:member.name,isActive:true}});
      if(matches.length!==1)throw new Error(`Неоднозначная учётная запись РОПа: ${member.name}`);
      const crm=matches[0];
      const account=await p.user.findFirst({where:{crmUserId:crm.id}});
      if(account){
        await p.user.update({where:{id:account.id},data:{businessRole:'ROP',role:'ROP',isActive:true,departmentKey:member.department,accessVersion:{increment:1}}});
        summary.accounts.push({name:member.name,status:'assigned'});
      }else if(crm.email){
        if(await p.user.findUnique({where:{email:crm.email.toLowerCase()}}))throw new Error(`Email РОПа уже занят другой учётной записью: ${member.name}`);
        // No shared/default password. Owner can set a personal password in access settings.
        await p.user.create({data:{name:crm.name,email:crm.email.toLowerCase(),crmUserId:crm.id,businessRole:'ROP',role:'ROP',departmentKey:member.department,passwordHash:await load('bcryptjs').hash(randomBytes(48).toString('base64url'),12)}});
        summary.accounts.push({name:member.name,status:'created-needs-personal-password'});
      }else throw new Error(`У РОПа ${member.name} нет email в CRM`);
    }
    const serafima=await p.user.findMany({where:{name:'Serafima',businessRole:'ROP'}});
    if(serafima.length!==1)throw new Error('Неоднозначная учётная запись Серафимы');
    await p.user.update({where:{id:serafima[0].id},data:{departmentKey:'csm',isActive:true,accessVersion:{increment:1}}});
    summary.accounts.push({name:'Serafima',status:'assigned-csm'});
    const retired=await p.user.findMany({where:{name:'Stepan',businessRole:'ROP'},select:{id:true}});
    if(retired.length>1)throw new Error('Неоднозначная учётная запись уволенного Степана');
    if(retired[0])await p.user.update({where:{id:retired[0].id},data:{isActive:false,accessVersion:{increment:1}}});
    const existingManagers=await p.user.findMany({where:{businessRole:'MANAGER',role:{not:'ADMIN'},crmUserId:{not:null}},include:{crmUser:true}});
    for(const account of existingManagers){
      const department=definitions.find(d=>d.definition.group.id===account.crmUser?.groupId);
      if(department)await p.user.update({where:{id:account.id},data:{departmentKey:department.key,accessVersion:{increment:1}}});
    }
    const legacy=await p.planItem.findMany({where:{metricKey:{in:['sales_paid_amount','csm_paid_amount','sales_shipped_amount','csm_shipped_amount']},periodType:'MONTH',planSet:{isActive:true}},orderBy:{updatedAt:'desc'}});
    for(const old of legacy){
      if(!old.targetId||!['GROUP','MANAGER'].includes(old.targetType))continue;
      const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(old.periodStart);
      const where={month,departmentKey:old.metricKey.startsWith('sales_')?'sales':'csm',targetType:old.targetType,targetId:old.targetId,metric:old.metricKey.includes('shipped')?'shipments':'payments'};
      await p.workspacePlan.upsert({where:{month_departmentKey_targetType_targetId_metric:where},create:{...where,value:old.value,currency:'EUR'},update:{}});
      summary.plansCopied++;
    }
    const links=app.get(CommercialLinksService);
    const count=await p.deal.count({where:{pipelineId:refs.assemblyPipeline.id,deletedAt:null}});
    let confirmed=0,checked=0;
    for(let offset=0;offset<count;offset+=100){const result=await links.reconcile(100);confirmed+=result.confirmed;checked+=result.checked;if(global.gc)global.gc();}
    summary.links={checked,confirmed};
    await p.auditLog.create({data:{action:'workspace.migration.prepared',entity:'WorkspaceDepartment',metadata:summary}});
    console.log(JSON.stringify(summary));
  }finally{await app.close();}
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;});
