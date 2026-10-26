'use strict';
// Only the isolated clone. This never enables production or contacts Telegram.
const {createRequire}=require('node:module'),path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
if(new URL(process.env.DATABASE_URL).pathname!=='/analytics_workspace_check_20261023')throw Error('Refusing to mutate a non-test database');
const {PrismaClient}=load('./src/generated/prisma'),p=new PrismaClient(),base='http://127.0.0.1:4100/api/v1',checks=[],failures=[];
const check=(name,passed,details)=>{checks.push({name,passed});if(!passed)failures.push({name,details});};
async function request(token,url,expected,method='GET',body){const response=await fetch(`${base}${url}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});const result=await response.json();check(`${method} ${url}=${expected}`,response.status===expected,{status:response.status,message:result.message});return result;}
(async()=>{
  const started=new Date(),oldSettings=await p.telegramSettings.findUniqueOrThrow({where:{id:'default'}}),oldRules=await p.notificationTemplate.findMany();
  const qa=await p.user.findUniqueOrThrow({where:{email:'qa-admin@workspace.invalid'},select:{id:true}});
  let syntheticAccount;
  if(!await p.telegramAccount.findUnique({where:{userId:qa.id}}))syntheticAccount=await p.telegramAccount.create({data:{userId:qa.id,chatId:'qa-never-send-telegram',username:'qa_telegram_blocked',isActive:true}});
  const bindings=await p.telegramAccount.count();
  const createdSchedules=[],createdAlerts=[];
  try{
    const tokens={};for(const kind of ['admin','rop-sales','rop-csm','manager-sales','manager-csm']){
      const session=await request('', '/auth/login',201,'POST',{email:`qa-${kind}@workspace.invalid`,password:'Isolated-Workspace-2026-Check!'});tokens[kind]=session.accessToken;
    }
    const admin=tokens.admin,overview=await request(admin,'/platform/telegram/admin',200);
    check('migration-pauses-entire-channel',overview.settings.enabled===false);
    check('migration-disables-every-CRM-rule',overview.rules.every(r=>r.isActive===false));
    check('all-current-event-rules-visible',overview.rules.length===15);
    for(const kind of ['rop-sales','rop-csm','manager-sales','manager-csm'])for(const [url,method] of [['', 'GET'],['/history','GET'],['/pause','POST'],['/settings','PATCH'],['/rules/amo_payment_received','PATCH'],['/link-codes/user/invalid','POST'],['/report-jobs/schedule','POST'],['/connections/user/invalid','PATCH']])await request(tokens[kind],`/platform/telegram/admin${url}`,403,method,method==='GET'?undefined:{});
    const settingsBody={version:overview.settings.version,enabled:false,parameters:{},quality:{enabled:false,recipientIds:[],repeatMinutes:30,includeRecovery:true}};
    const saved=await request(admin,'/platform/telegram/admin/settings',200,'PATCH',settingsBody);
    check('global-still-paused-after-settings-save',saved.enabled===false);
    await request(admin,'/platform/telegram/admin/settings',409,'PATCH',settingsBody);
    await request(admin,'/platform/telegram/admin/settings',400,'PATCH',{...settingsBody,version:saved.version,parameters:{csmDailyCheckHour:27}});
    const rule=overview.rules.find(r=>r.eventType==='amo_new_assigned_lead'),body={version:rule.version,isActive:true,deliveryMode:'direct_responsible',body:'{managerMention}: {deal} {dealUrl}'};
    await request(admin,`/platform/telegram/admin/rules/${rule.eventType}`,200,'PATCH',body);
    check('enabled-rule-does-not-unpause-channel',(await p.telegramSettings.findUnique({where:{id:'default'}})).enabled===false);
    await request(admin,`/platform/telegram/admin/rules/${rule.eventType}`,409,'PATCH',body);
    await request(admin,`/platform/telegram/admin/rules/${rule.eventType}`,400,'PATCH',{...body,body:'{not_a_variable}'});
    await request(admin,`/platform/telegram/admin/rules/${rule.eventType}`,400,'PATCH',{...body,deliveryMode:'disabled'});
    const test=await request(admin,'/platform/telegram/test',201,'POST',{});
    check('manual-test-cannot-bypass-pause',test.ok===false&&test.delivery?.status==='SKIPPED',test.delivery?.status);
    const paused=await request(admin,'/platform/telegram/admin/pause',201,'POST',{});check('emergency-pause-does-not-need-draft-validation',paused.enabled===false);
    await request(admin,`/platform/telegram/admin/connections/user/${qa.id}`,200,'PATCH',{isActive:false});
    check('connection-can-be-paused-without-deleting-binding',(await p.telegramAccount.findUnique({where:{userId:qa.id}})).isActive===false);
    await request(admin,`/platform/telegram/admin/connections/user/${qa.id}`,200,'PATCH',{isActive:true});
    await request(admin,`/platform/telegram/admin/connections/user/${qa.id}`,400,'PATCH',{isActive:'true'});
    const report=overview.templates.find(t=>t.config?.contract?.metrics?.length),recipient=overview.users.find(u=>(u.role==='ADMIN'||u.businessRole==='OWNER')&&u.telegramAccount?.isActive);
    if(!report||!recipient)throw Error('Isolated report/recipient fixture missing');
    const job={name:'QA Telegram disabled schedule',enabled:false,reportTemplateId:report.id,recipients:[recipient.id],timeOfDay:'00:05'};
    const scheduled=await request(admin,'/platform/telegram/admin/report-jobs/schedule',201,'POST',job);if(scheduled.id)createdSchedules.push(scheduled.id);
    check('disabled-schedule-has-no-due-date',scheduled.enabled===false&&scheduled.nextRunAt===null);
    await request(admin,`/platform/telegram/admin/report-jobs/schedule/${scheduled.id}`,200,'PATCH',{...job,version:scheduled.version,timeOfDay:'09:05'});
    await request(admin,`/platform/telegram/admin/report-jobs/schedule/${scheduled.id}`,409,'PATCH',{...job,version:scheduled.version});
    await request(admin,`/platform/telegram/admin/report-jobs/schedule/${scheduled.id}`,400,'PATCH',job);
    await request(admin,'/platform/telegram/admin/report-jobs/schedule',400,'POST',{...job,timeOfDay:'25:99'});
    const alert={...job,name:'QA Telegram disabled threshold',metricKey:`summaryRows.0.metrics.${report.config.contract.metrics[0].id}.value`,operator:'GTE',threshold:1,checkEveryMinutes:15,cooldownMinutes:30};
    const alerted=await request(admin,'/platform/telegram/admin/report-jobs/alert',201,'POST',alert);if(alerted.id)createdAlerts.push(alerted.id);
    await request(admin,'/platform/telegram/admin/report-jobs/alert',400,'POST',{...alert,metricKey:'arbitrary-field'});
    await request(admin,'/platform/telegram/admin/history?status=SKIPPED&page=1',200);
    check('connections-preserved',await p.telegramAccount.count()===bindings);
    check('no-Telegram-message-sent',await p.notificationDelivery.count({where:{status:'SENT',createdAt:{gte:started}}})===0);
    check('changes-audited',await p.auditLog.count({where:{action:{startsWith:'telegram.'},createdAt:{gte:started}}})>=4);
  }finally{
    await p.reportSchedule.deleteMany({where:{id:{in:createdSchedules}}});await p.alertRule.deleteMany({where:{id:{in:createdAlerts}}});
    for(const rule of oldRules)await p.notificationTemplate.update({where:{id:rule.id},data:{body:rule.body,isActive:rule.isActive,recipients:rule.recipients,groupIds:rule.groupIds,enabledAt:rule.enabledAt,version:{increment:1}}});
    await p.telegramSettings.update({where:{id:'default'},data:{enabled:false,parameters:oldSettings.parameters,quality:oldSettings.quality,resumedAt:oldSettings.resumedAt,version:{increment:1}}});
    if(syntheticAccount)await p.telegramAccount.delete({where:{id:syntheticAccount.id}});
  }
  const result={status:failures.length?'failed':'passed',checkedAt:new Date().toISOString(),checks:checks.length,failures};fs.writeFileSync(`${root}/telegram-admin-verification.json`,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));if(failures.length)process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
