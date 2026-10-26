'use strict';
// Emergency pause before the central admin switch is deployed. Preserve the token privately.
const fs=require('node:fs'),{createRequire}=require('node:module');
const root='/opt/analytics',load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma'),db=new PrismaClient();
(async()=>{
  if(!process.argv.includes('--apply'))throw Error('Use --apply for the requested production pause');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-'),base=`/opt/analytics-backups/telegram-before-reset-${stamp}`;
  const snapshot={templates:await db.notificationTemplate.findMany(),alerts:await db.alertRule.findMany(),schedules:await db.reportSchedule.findMany()};
  fs.writeFileSync(`${base}.json`,JSON.stringify(snapshot),{mode:0o600,flag:'wx'});
  const env=fs.readFileSync(`${root}/.env`,'utf8');
  if(!/^TELEGRAM_BOT_TOKEN=.+/m.test(env))throw Error('Bot token entry missing; inspect configuration without logging secrets');
  fs.writeFileSync(`${base}.env`,env,{mode:0o600,flag:'wx'});
  await db.$transaction(async tx=>{
    await tx.notificationTemplate.updateMany({data:{isActive:false,recipients:[{kind:'delivery_mode',id:'disabled'}]}});
    // Report alerts are Telegram-only in this application. Do not touch other schedule formats.
    await tx.alertRule.updateMany({data:{enabled:false}});
    await tx.reportSchedule.updateMany({where:{format:'telegram'},data:{enabled:false,nextRunAt:null}});
    await tx.auditLog.create({data:{action:'telegram.emergency-pause',entity:'NotificationTemplate',metadata:{backup:`${base}.json`,templates:snapshot.templates.length,alerts:snapshot.alerts.length,schedules:snapshot.schedules.length}}});
  });
  // Existing inode/ownership is retained; never print the original token.
  fs.writeFileSync(`${root}/.env`,env.replace(/^TELEGRAM_BOT_TOKEN=.*$/m,'TELEGRAM_BOT_TOKEN=""'));
  console.log(JSON.stringify({paused:true,backup:base,templates:snapshot.templates.length,alerts:snapshot.alerts.length,schedules:snapshot.schedules.length}));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
