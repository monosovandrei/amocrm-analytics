'use strict';
// Exercises the real queue and download routes using isolated QA users only.
const {createRequire}=require('node:module'),fs=require('node:fs');
const root=process.argv[2]||'/opt/analytics-staging-workspaces-20261023';
const load=createRequire(`${root}/apps/api/package.json`);load('dotenv').config({path:`${root}/.env`,quiet:true});load('reflect-metadata');process.env.WORKER_ROLE='verification';
(async()=>{
  const app=await load('@nestjs/core').NestFactory.createApplicationContext(load('./dist/app.module').AppModule,{logger:false});
  try{
    const p=app.get(load('./dist/prisma/prisma.service').PrismaService),reports=app.get(load('./dist/reports/reports.service').ReportsService);
    const [{name}]=await p.$queryRawUnsafe('SELECT current_database() AS name');if(name!=='analytics_workspace_check_20261023')throw new Error('Isolated database required');
    const owner=await p.user.findUniqueOrThrow({where:{email:'qa-manager-sales@workspace.invalid'}}),other=await p.user.findUniqueOrThrow({where:{email:'qa-manager-csm@workspace.invalid'}});
    const jwt=new(load('@nestjs/jwt').JwtService)({secret:process.env.JWT_SECRET}),checks=[];
    const request=(user,path,method='GET')=>fetch(`http://127.0.0.1:4100/api/v1/workspaces/${path}`,{method,headers:{Authorization:`Bearer ${jwt.sign({sub:user.id})}`}});
    const check=(name,passed)=>{checks.push({name,passed:Boolean(passed)});if(!passed)throw new Error(name);};
    const queued=await request(owner,'reports/sales_funnel_steps/export?department=sales&month=2026-10','POST');check('enqueue',queued.status===201||queued.status===200);const {jobId}=await queued.json();
    check('foreign-job-denied',(await request(other,`exports/${jobId}`)).status===403);
    await reports.processExportJobs(25);
    const status=await(await request(owner,`exports/${jobId}`)).json();check('real-worker-success',status.status==='SUCCESS');
    const download=await request(owner,`exports/${jobId}/download`),bytes=new Uint8Array(await download.arrayBuffer());check('own-xlsx-download',download.status===200&&bytes.length>500&&bytes[0]===80&&bytes[1]===75);
    check('foreign-file-denied',(await request(other,`exports/${jobId}/download`)).status===403);
    const next=await(await request(owner,'reports/sales_funnel_steps/export?department=sales&month=2026-10','POST')).json();
    await p.user.update({where:{id:owner.id},data:{accessVersion:{increment:1}}});
    check('changed-scope-download-denied',(await request(owner,`exports/${jobId}/download`)).status===403);
    await reports.processExportJobs(25);const failed=await p.exportJob.findUniqueOrThrow({where:{id:next.jobId}});check('queued-old-scope-denied',failed.status==='ERROR');
    await p.user.update({where:{id:owner.id},data:{isActive:false,accessVersion:{increment:1}}});
    try{check('disabled-account-denied',[401,403].includes((await request(owner,'session')).status));}finally{await p.user.update({where:{id:owner.id},data:{isActive:true,accessVersion:{increment:1}}});}
    const result={status:'passed',checkedAt:new Date().toISOString(),checks};fs.writeFileSync(`${root}/workspace-export-verification.json`,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
  }finally{await app.close();}
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;});
