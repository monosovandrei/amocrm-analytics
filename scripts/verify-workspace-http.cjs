'use strict';
// Runs only against the isolated database. No credentials or customer rows in stdout.
const {createRequire}=require('node:module');
const fs=require('node:fs');
const root=process.argv[2]||'/opt/analytics-staging-workspaces-20261023';
const load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma');
const {JwtService}=load('@nestjs/jwt');
const p=new PrismaClient();
const profiles=[['admin','OWNER',null],['rop-sales','ROP','sales'],['rop-csm','ROP','csm'],['manager-sales','MANAGER','sales'],['manager-csm','MANAGER','csm']];
const password='Isolated-Workspace-2026-Check!';
(async()=>{
  const [{name}]=await p.$queryRawUnsafe('SELECT current_database() AS name');
  if(name!=='analytics_workspace_check_20261023')throw new Error('Refusing QA fixture writes outside isolated database');
  const used=(await p.user.findMany({select:{crmUserId:true}})).map(u=>u.crmUserId).filter(Boolean);
  const accounts=[];
  const hash=await load('bcryptjs').hash(password,12);
  for(const [key,businessRole,departmentKey] of profiles){
    const email=`qa-${key}@workspace.invalid`;
    const department=departmentKey?await p.workspaceDepartment.findUnique({where:{key:departmentKey}}):null;
    const existing=await p.user.findUnique({where:{email}});
    let crmUserId=existing?.crmUserId||null;
    if(businessRole==='MANAGER'&&!crmUserId){const crm=await p.crmUser.findFirst({where:{groupId:department.groupId,isActive:true,id:{notIn:used}},orderBy:{name:'asc'}});if(!crm)throw new Error('No free CRM manager for fixture');crmUserId=crm.id;used.push(crm.id);}
    const data={name:`Проверка: ${key}`,passwordHash:hash,role:businessRole==='OWNER'?'ADMIN':'ROP',businessRole,departmentKey,crmUserId,isActive:true};
    const account=await p.user.upsert({where:{email},create:{email,...data},update:data});
    accounts.push({key,id:account.id,departmentKey,crmUserId});
  }
  const jwt=new JwtService({secret:process.env.JWT_SECRET});
  const request=async(account,path,options={})=>{
    const start=performance.now();
    const response=await fetch(`http://127.0.0.1:4100/api/v1${path}`,{...options,headers:{Authorization:`Bearer ${jwt.sign({sub:account.id})}`,'Content-Type':'application/json'}});
    let body;try{body=await response.json();}catch{body=null;}
    return {status:response.status,body,ms:Math.round(performance.now()-start)};
  };
  const failures=[],checks=[];
  function check(name,ok,details={}){checks.push({name,passed:Boolean(ok),...details});if(!ok)failures.push(name);}
  for(const account of accounts){
    const session=await request(account,'/workspaces/session');
    check(`${account.key}/session`,session.status===200&&session.body.configured);
    if(account.departmentKey)check(`${account.key}/department`,session.body.departments.length===1&&session.body.departments[0].key===account.departmentKey);
    for(const path of ['/reports/templates','/settings/options','/platform/plans/items','/quality/incidents/unknown']){
      if(account.key==='admin')continue;
      const denied=await request(account,path);check(`${account.key}/legacy/${path}`,denied.status===403);
    }
    for(const path of ['/platform/rop-dashboard','/platform/email-threads/pending','/crm-control']){
      const removed=await request(account,path);check(`${account.key}/retired/${path}`,[404,410].includes(removed.status));
    }
    if(account.departmentKey){
      const foreign=account.departmentKey==='sales'?'csm':'sales';
      const denied=await request(account,`/workspaces/plans?department=${foreign}`);check(`${account.key}/foreign-department`,denied.status===403);
      const admin=await request(account,'/workspaces/admin/access');check(`${account.key}/admin-boundary`,admin.status===403);
      const queue=await request(account,'/workspaces/admin/unassigned?month=2026-10');check(`${account.key}/private-link-queue`,queue.status===403);
      const company=await request(account,'/workspaces/reports/revenue_profit_forecast?department=all&month=2026-10');check(`${account.key}/company-boundary`,company.status===403);
    }
    if(account.crmUserId){
      const other=accounts.find(a=>a.crmUserId&&a.id!==account.id);
      const denied=await request(account,`/workspaces/deals?department=${account.departmentKey}&manager=${other.crmUserId}`);check(`${account.key}/foreign-manager`,denied.status===403);
      const change=await request(account,'/workspaces/plans',{method:'PATCH',body:JSON.stringify({department:account.departmentKey,month:'2026-10',targetType:'MANAGER',targetId:account.crmUserId,metric:'payments',value:1,version:0})});check(`${account.key}/read-only-plan`,change.status===403);
    }
  }
  const planResults=[];
  for(const account of accounts.filter(a=>a.departmentKey)){
    const plan=await request(account,`/workspaces/plans?department=${account.departmentKey}&month=2026-10`);
    check(`${account.key}/plans`,plan.status===200,{ms:plan.ms});
    if(account.crmUserId&&plan.status===200)check(`${account.key}/own-only`,plan.body.rows.length===1&&plan.body.rows[0].id===account.crmUserId&&plan.body.total===null);
    if(plan.status===200)planResults.push({key:account.key,rows:plan.body.rows.length,ms:plan.ms,incompleteShipments:plan.body.incompleteShipments});
    if(plan.status===200){
      const key=account.departmentKey==='sales'?'sales_funnel_steps':'csm_funnel',metric=account.departmentKey==='sales'?'payment_amount':'paid_amount';
      const report=await request(account,`/workspaces/reports/${key}?department=${account.departmentKey}&month=2026-10`);
      const expected=account.crmUserId?report.body?.rows?.find(r=>r.groupId===account.crmUserId)?.metrics?.[metric]?.value||0:report.body?.summaryRows?.[0]?.metrics?.[metric]?.value;
      const actual=account.crmUserId?plan.body.rows[0].values.find(v=>v.metric==='payments').fact:plan.body.total.values.find(v=>v.metric==='payments').fact;
      check(`${account.key}/payment-report-parity`,report.status===200&&Math.abs(actual-expected)<.005);
      if(account.crmUserId){
        const details=await request(account,`/workspaces/deals?department=${account.departmentKey}&month=2026-10&kind=shipments&shipped=true`);
        const fact=plan.body.rows[0].values.find(v=>v.metric==='shipments').fact;
        check(`${account.key}/shipment-detail-parity`,details.status===200&&Math.abs(fact-details.body.amount)<.005);
      }
    }
  }
  const owner=accounts.find(a=>a.key==='admin');
  const company=await request(owner,'/workspaces/reports/revenue_profit_forecast?department=all&month=2026-10');check('admin/company-report',company.status===200&&company.body.ready);
  const queue=await request(owner,'/workspaces/admin/unassigned?month=2026-10');check('admin/link-queue-pagination',queue.status===200&&queue.body.rows.length<=30);
  for(const account of accounts.filter(a=>a.departmentKey)){
    const session=await request(account,'/workspaces/session');
    for(const key of session.body.reports[account.departmentKey]){
      const report=await request(account,`/workspaces/reports/${key}?department=${account.departmentKey}&month=2026-10`);
      check(`${account.key}/report/${key}`,report.status===200&&report.body?.ready!==false,{ms:report.ms});
    }
  }
  const shipment=await p.deal.findUnique({where:{externalId:'41490929'},select:{id:true}});
  const example=shipment?await p.commercialShipmentLink.findUnique({where:{shipmentDealId:shipment.id},select:{status:true,saleDealId:true,managerId:true}}):null;
  const currentShipments=await p.deal.findMany({where:{pipelineId:(await p.workspaceDepartment.findFirst()).assemblyPipelineId,createdAt:{gte:new Date('2026-09-30T21:00:00Z')},deletedAt:null},select:{id:true}});
  const confirmed=await p.commercialShipmentLink.count({where:{shipmentDealId:{in:currentShipments.map(d=>d.id)},status:'CONFIRMED'}});
  const result={status:failures.length?'failed':'passed',checkedAt:new Date().toISOString(),checks,failures,planResults,exampleLink:example?{status:example.status,hasSeller:Boolean(example.managerId)}:null,linkCoverage:{month:'2026-10',shipments:currentShipments.length,confirmed,unresolved:currentShipments.length-confirmed}};
  fs.writeFileSync(`${root}/workspace-http-verification.json`,JSON.stringify(result,null,2),{mode:0o600});
  console.log(JSON.stringify(result));
  if(failures.length)process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
