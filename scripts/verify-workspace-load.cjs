'use strict';
// Existing isolated QA accounts only. No fixture or business-data writes.
const {createRequire}=require('node:module');
const fs=require('node:fs');
const root=process.argv[2]||'/opt/analytics-staging-workspaces-20261023';
const load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma');
const {JwtService}=load('@nestjs/jwt');const p=new PrismaClient();
(async()=>{
  const [{name}]=await p.$queryRawUnsafe('SELECT current_database() AS name');
  if(name!=='analytics_workspace_check_20261023')throw new Error('Isolated database required');
  const jwt=new JwtService({secret:process.env.JWT_SECRET});
  const profiles=[['admin','sales'],['rop-sales','sales'],['rop-csm','csm'],['manager-sales','sales'],['manager-csm','csm']];
  const sessions=await Promise.all(profiles.map(async([key,department])=>{const user=await p.user.findUniqueOrThrow({where:{email:`qa-${key}@workspace.invalid`}});return {key,department,token:jwt.sign({sub:user.id})};}));
  const samples=[];
  async function request(session,kind,round){
    const started=performance.now(),heavy=process.argv.includes('--all-heavy')&&kind==='detail';
    const path=kind==='main'?'plans':!heavy||session.key==='admin'?'reports/revenue_profit_forecast':session.department==='csm'?'reports/csm_base_stage_age':'reports/sales_assigned_stage_speed';
    const department=heavy&&session.key==='admin'?'all':session.department;
    const response=await fetch(`http://127.0.0.1:4100/api/v1/workspaces/${path}?department=${department}&month=2026-10`,{headers:{Authorization:`Bearer ${session.token}`}});await response.arrayBuffer();const result={profile:session.key,kind,round,status:response.status,ms:Math.round(performance.now()-started)};samples.push(result);
  }
  // First simultaneous requests are recorded separately, never hidden in warm averages.
  for(const kind of ['main','detail'])for(let round=0;round<6;round++){
    await Promise.all(sessions.map(session=>request(session,kind,round)));
    console.log(JSON.stringify({progress:kind,round,maximumMs:Math.max(...samples.filter(s=>s.kind===kind&&s.round===round).map(s=>s.ms))}));
  }
  const summary=['main','detail'].map(kind=>{const values=samples.filter(s=>s.kind===kind).map(s=>s.ms).sort((a,b)=>a-b);const p95=values[Math.ceil(values.length*.95)-1],limit=kind==='main'?3000:10000;return {kind,samples:values.length,p95,limit,passed:p95<=limit,coldMaximumMs:Math.max(...samples.filter(s=>s.kind===kind&&s.round===0).map(s=>s.ms))};});
  const result={status:summary.every(s=>s.passed)&&samples.every(s=>s.status===200)?'passed':'failed',sessions:5,checkedAt:new Date().toISOString(),summary,samples};
  fs.writeFileSync(`${root}/workspace-load${process.argv.includes('--all-heavy')?'-heavy':''}-verification.json`,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({status:result.status,summary}));if(result.status!=='passed')process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
