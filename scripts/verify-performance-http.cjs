'use strict';
const path=require('node:path'),{createRequire}=require('node:module'),{performance}=require('node:perf_hooks'),{randomBytes}=require('node:crypto');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma'),jwt=load('jsonwebtoken'),p=new PrismaClient();
const isolated=process.argv.includes('--isolated-writes'),db=new URL(process.env.DATABASE_URL).pathname;
if(isolated&&db!=='/analytics_workspace_check_20261023')throw new Error('Isolated fixture writes are forbidden outside the named staging clone');
const base=process.env.PERFORMANCE_CHECK_URL||'http://127.0.0.1:4000/api/v1',checks=[];
const check=(name,passed)=>checks.push({name,passed:Boolean(passed)});
const request=(token,url,method='GET',body)=>fetch(`${base}${url}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
const credential=user=>jwt.sign({sub:user.id},process.env.JWT_SECRET,{expiresIn:'5m'});
(async()=>{
 for(let attempt=0;attempt<20;attempt++){try{if((await request(null,'/health')).ok)break;}catch{}if(attempt===19)throw new Error('API did not become reachable for acceptance checks');await new Promise(resolve=>setTimeout(resolve,500));}
 const users=await p.user.findMany({where:{isActive:true},select:{id:true,role:true,businessRole:true,departmentKey:true,crmUserId:true}}),admin=users.find(u=>u.role==='ADMIN'),token=credential(admin);
 check('display-without-credential-denied',(await request(null,'/display/snapshot')).status===401);
 for(const role of ['ROP','MANAGER'])for(const department of ['sales','csm']){
  const user=users.find(u=>u.businessRole===role&&u.departmentKey===department);if(!user)continue;
  const auth=credential(user),response=await request(auth,`/workspaces/performance?department=${department}`);check(`${role}/${department}/overview`,response.status===200);
  const data=await response.json();if(role==='MANAGER'){check(`${role}/${department}/own-only`,data.rows?.length===1&&data.rows[0].id===user.crmUserId&&data.total===null);check(`${role}/${department}/cannot-save-goal`,(await request(auth,'/workspaces/performance/goals','PATCH',{department,metric:'paid',targetType:'MANAGER',targetId:user.crmUserId,value:5,version:0})).status===403);}
  check(`${role}/${department}/other-department-denied`,(await request(auth,`/workspaces/performance?department=${department==='sales'?'csm':'sales'}`)).status===403);
  check(`${role}/${department}/no-display-settings`,(await request(auth,'/workspaces/displays')).status===403);
  check(`${role}/${department}/no-display-preview`,(await request(auth,`/workspaces/displays/preview?department=${department}`)).status===403);
  check(`${role}/${department}/no-invitations`,(await request(auth,'/workspaces/onboarding')).status===403);
 }
 const times=[];for(let i=0;i<12;i++){const start=performance.now();const r=await request(token,`/workspaces/performance?department=${i%2?'csm':'sales'}`);await r.json();check(`prepared-overview-${i}`,r.status===200);times.push(performance.now()-start);}
 times.sort((a,b)=>a-b);const p95=Math.round(times[Math.ceil(times.length*.95)-1]);check('overview-api-p95-under-2-seconds',p95<=2000);
 const preview=await request(token,'/workspaces/displays/preview?department=sales');check('administrator-can-preview-without-issuing-display-credentials',preview.status===200);
 if(isolated){
  const salt=randomBytes(5).toString('hex'),office=[];
  for(let i=0;i<20;i++)office.push((await request(null,'/auth/login','POST',{email:`capacity-${salt}-${i}@workspace.invalid`,password:'test-only-invalid-password'})).status);
  check('twenty-office-accounts-do-not-share-five-attempt-quota',office.every(status=>status===401));
  const oneAccount=[];for(let i=0;i<6;i++)oneAccount.push((await request(null,'/auth/login','POST',{email:`quota-${salt}@workspace.invalid`,password:'test-only-invalid-password'})).status);
  check('five-attempt-account-protection-remains',oneAccount.slice(0,5).every(status=>status===401)&&oneAccount[5]===429);
  const created=await request(token,'/workspaces/displays','POST',{department:'sales',name:'Изолированная проверка доступа',hours:8});const display=await created.json();check('display-created',created.status===201);
  try{const r=await request(display.token,'/display/snapshot');const snapshot=await r.json();check('limited-display-readable',r.status===200&&snapshot.boards?.length===4);check('display-token-is-not-an-employee-token',(await request(display.token,'/workspaces/session')).status===401);check('display-no-customer-data',!JSON.stringify(snapshot).match(/dealId|externalId|amoDomain|customer|password|email|tokenHash/));check('clone-stale-source-pauses-boards',snapshot.boards.every(b=>b.paused));}
  finally{await request(token,`/workspaces/displays/${display.id}/revoke`,'PATCH');}
  check('revocation-effective-on-next-request',(await request(display.token,'/display/snapshot')).status===401);
  const pending=await p.user.findFirstOrThrow({where:{businessRole:'MANAGER',isActive:false,workspaceInvite:{is:null}},select:{id:true,passwordHash:true,isActive:true,accessVersion:true}});
  try{
   const issued=await request(token,`/workspaces/onboarding/${pending.id}/invite`,'POST'),invite=await issued.json();check('individual-invite-issued',issued.status===201);
   const body={token:invite.token,password:randomBytes(24).toString('base64url')},accepted=await request(null,'/workspace-invite/accept','POST',body);check('first-entry-activates-account',accepted.status===201);
   const replay=await request(null,'/workspace-invite/accept','POST',body);check('invite-replay-denied',replay.status===400||replay.status===409);
  }finally{await p.user.update({where:{id:pending.id},data:{passwordHash:pending.passwordHash,isActive:pending.isActive,accessVersion:pending.accessVersion}});await p.workspaceInvite.deleteMany({where:{userId:pending.id}});}
 }
 console.log(JSON.stringify({status:checks.every(c=>c.passed)?'passed':'failed',checkedAt:new Date().toISOString(),checks:checks.length,failures:checks.filter(c=>!c.passed),overviewApiP95Ms:p95,samples:times.length,isolatedWrites:isolated}));if(checks.some(c=>!c.passed))process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
