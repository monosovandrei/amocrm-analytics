'use strict';
// Read-only live acceptance. Tokens stay in memory, expire in five minutes, never leave localhost.
const {createRequire}=require('node:module');
const root='/opt/analytics',load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma'),{JwtService}=load('@nestjs/jwt');
const db=new PrismaClient(),jwt=new JwtService({secret:process.env.JWT_SECRET});
(async()=>{
  const checks=[];
  async function request(user,path,expected){
    const token=jwt.sign({sub:user.id,role:user.role},{expiresIn:'5m'});
    const response=await fetch(`http://127.0.0.1:4000/api/v1${path}`,{headers:{Authorization:`Bearer ${token}`}});
    const body=await response.json();
    checks.push({user:user.name,path,status:response.status,expected,passed:response.status===expected});
    return body;
  }
  const users=await db.user.findMany({where:{OR:[{role:'ADMIN',isActive:true},{name:{in:['Сержант','Владимир Супруненко','Serafima','Stepan']}}]},select:{id:true,name:true,role:true,isActive:true}});
  const admin=users.find(u=>u.role==='ADMIN'&&u.isActive);
  if(!admin)throw Error('No active administrator');
  for(const name of ['Сержант','Владимир Супруненко','Serafima']){
    const user=users.find(u=>u.name===name);if(!user)throw Error(`Missing expected ROP: ${name}`);
    const session=await request(user,'/workspaces/session',200),department=name==='Serafima'?'csm':'sales';
    checks.push({user:name,test:'department-and-role',passed:session.role==='ROP'&&session.departmentKey===department});
    await request(user,`/workspaces/plans?department=${department}`,200);
    await request(user,`/workspaces/plans?department=${department==='sales'?'csm':'sales'}`,403);
    await request(user,'/workspaces/admin/access',403);
    await request(user,'/reports/templates',403);
    await request(user,'/platform/rop-dashboard',410);
  }
  const retired=users.find(u=>u.name==='Stepan');if(!retired)throw Error('Retired account missing');
  await request(retired,'/workspaces/session',401);
  for(const department of ['sales','csm'])await request(admin,`/workspaces/plans?department=${department}`,200);
  await request(admin,'/workspaces/admin/access',200);
  const currency=await db.factDealCurrent.groupBy({by:['currency'],_count:true,where:{deletedAt:null}});
  checks.push({test:'EUR-only',passed:currency.every(r=>r.currency==='EUR')});
  const assembly=await db.deal.findUnique({where:{externalId:'41490929'}});
  const link=assembly&&await db.commercialShipmentLink.findUnique({where:{shipmentDealId:assembly.id}});
  const sale=link?.saleDealId&&await db.deal.findUnique({where:{id:link.saleDealId},select:{externalId:true}});
  checks.push({test:'provided-sale-assembly-example',passed:link?.status==='CONFIRMED'&&sale?.externalId==='41470057'&&Boolean(link.managerId)});
  const current=new Date(),month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(current);
  const assemblyPipeline=(await db.workspaceDepartment.findFirst()).assemblyPipelineId;
  const cards=await db.deal.findMany({where:{pipelineId:assemblyPipeline,deletedAt:null,createdAt:{gte:new Date(`${month}-01T00:00:00+03:00`)}},select:{id:true}});
  const confirmed=await db.commercialShipmentLink.count({where:{shipmentDealId:{in:cards.map(c=>c.id)},status:'CONFIRMED'}});
  const failures=checks.filter(c=>!c.passed);
  console.log(JSON.stringify({status:failures.length?'failed':'passed',checkedAt:current.toISOString(),checks:checks.length,failures,coverage:{month,created:cards.length,confirmed,unresolved:cards.length-confirmed}}));
  if(failures.length)process.exitCode=1;
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>db.$disconnect());
