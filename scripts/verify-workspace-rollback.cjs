'use strict';
const {createRequire}=require('node:module'),{execFileSync}=require('node:child_process');
const root=process.argv[2]||'/opt/analytics-staging-workspaces-20261023',load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});const {PrismaClient}=load('./src/generated/prisma'),p=new PrismaClient();
(async()=>{
  const [{name}]=await p.$queryRawUnsafe('SELECT current_database() AS name');if(name!=='analytics_workspace_check_20261023')throw new Error('Rollback rehearsal requires the isolated database');
  const users=await p.user.findMany({select:{id:true,role:true,businessRole:true,isActive:true}}),plans=await p.workspacePlan.count(),links=await p.commercialShipmentLink.count();
  try{
    execFileSync(process.execPath,[`${root}/scripts/workspace-safe-rollback.cjs`,'--apply'],{cwd:root,stdio:['ignore','pipe','inherit']});
    const remaining=await p.user.findMany({where:{isActive:true},select:{id:true,role:true,businessRole:true}});
    if(remaining.some(u=>u.role!=='ADMIN'&&u.businessRole!=='OWNER'))throw new Error('Non-administrator remained active');
    if(users.filter(u=>u.isActive&&(u.role==='ADMIN'||u.businessRole==='OWNER')).some(u=>!remaining.some(r=>r.id===u.id)))throw new Error('Administrator access was lost');
    if(plans!==await p.workspacePlan.count()||links!==await p.commercialShipmentLink.count())throw new Error('Plans or shipment links changed');
    console.log(JSON.stringify({status:'passed',checks:4,nonAdminAccessBlocked:true,adminAccessPreserved:true,plansPreserved:true,linksPreserved:true}));
  }finally{
    // Restore only this isolated copy. Versions advance; stale exports never become valid again.
    for(const user of users)await p.user.update({where:{id:user.id},data:{isActive:user.isActive,accessVersion:{increment:1}}});
  }
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
