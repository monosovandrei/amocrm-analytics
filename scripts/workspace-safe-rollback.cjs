'use strict';
// Old releases do not enforce department boundaries. Fail closed before selecting old code.
const {createRequire}=require('node:module');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),load=createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma'),p=new PrismaClient();
(async()=>{
  if(!process.argv.includes('--apply'))throw new Error('Explicit --apply is required');
  const disabled=await p.$transaction(async tx=>{
    const users=await tx.user.findMany({where:{isActive:true,role:{not:'ADMIN'},businessRole:{not:'OWNER'}},select:{id:true}});
    await tx.user.updateMany({where:{id:{in:users.map(u=>u.id)}},data:{isActive:false,accessVersion:{increment:1}}});
    await tx.auditLog.create({data:{action:'workspace.rollback.access-suspended',entity:'User',metadata:{ids:users.map(u=>u.id),reason:'Previous release cannot safely isolate departments; plans and links preserved'}}});return users.length;
  });console.log(JSON.stringify({status:'fail-closed',suspendedNonAdminAccounts:disabled,plansAndLinksPreserved:true}));
})().catch(e=>{console.error(JSON.stringify({status:'failed',error:e.message}));process.exitCode=1;}).finally(()=>p.$disconnect());
