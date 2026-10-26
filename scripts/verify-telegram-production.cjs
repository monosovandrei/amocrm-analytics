'use strict';
// Read-only acceptance of the deliberately paused production channel. No test messages.
const {createRequire}=require('node:module'),path=require('node:path');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
if(new URL(process.env.DATABASE_URL).pathname!=='/amocrm_analytics')throw Error('Expected production database');
const {PrismaClient}=load('./src/generated/prisma'),jwt=load('jsonwebtoken'),db=new PrismaClient(),checks=[];
const check=(name,ok)=>{checks.push({name,passed:Boolean(ok)});};
async function request(user,path){return fetch(`http://127.0.0.1:4000/api/v1${path}`,{headers:{Authorization:`Bearer ${jwt.sign({sub:user.id},process.env.JWT_SECRET,{expiresIn:'2m'})}`}});}
(async()=>{
  const admin=await db.user.findFirstOrThrow({where:{isActive:true,role:'ADMIN'},select:{id:true}});
  const response=await request(admin,'/platform/telegram/admin');check('administrator-can-open-settings',response.status===200);
  const data=await response.json();check('global-channel-paused',data.settings?.enabled===false);
  check('all-CRM-rules-disabled',data.rules?.length===15&&data.rules.every(r=>!r.isActive));
  check('quality-Telegram-disabled',data.settings?.quality?.enabled!==true);
  check('all-Telegram-schedules-disabled',await db.reportSchedule.count({where:{enabled:true,format:'telegram'}})===0);
  check('all-threshold-alerts-disabled',await db.alertRule.count({where:{enabled:true}})===0);
  const history=await request(admin,'/platform/telegram/admin/history?page=1');check('history-readable',history.status===200);
  const roles=await db.user.findMany({where:{isActive:true,role:{not:'ADMIN'},businessRole:{not:'OWNER'}},select:{id:true,businessRole:true,departmentKey:true}});
  for(const role of ['ROP','MANAGER'])for(const departmentKey of ['sales','csm']){
    const user=roles.find(u=>u.businessRole===role&&u.departmentKey===departmentKey);
    if(user)check(`${role}-${departmentKey}-cannot-read-admin-settings`,(await request(user,'/platform/telegram/admin')).status===403);
  }
  const cutoff=new Date('2026-10-23T14:43:20Z');
  check('no-message-sent-since-emergency-pause',await db.notificationDelivery.count({where:{channel:'TELEGRAM',status:'SENT',sentAt:{gte:cutoff}}})===0);
  const health=await (await fetch('http://127.0.0.1:4000/api/v1/health/data')).json();check('production-data-fresh',health.status==='ok'&&health.freshness==='FRESH');
  const result={status:checks.every(c=>c.passed)?'passed':'failed',checkedAt:new Date().toISOString(),checks,connections:await db.telegramAccount.count(),groups:await db.telegramChat.count()};
  console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>db.$disconnect());
