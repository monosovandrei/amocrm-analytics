'use strict';
const {createRequire}=require('node:module');
const root=process.argv[2]||'/opt/analytics-staging-workspaces-20261023';
const load=createRequire(`${root}/apps/api/package.json`);load('dotenv').config({path:`${root}/.env`,quiet:true});
const {PrismaClient}=load('./src/generated/prisma');const p=new PrismaClient();
(async()=>{
  const breakdown=await p.$queryRawUnsafe(`SELECT l.status, COUNT(*)::int AS count, COUNT(l."saleDealId")::int AS source_identified, COUNT(l."managerId")::int AS seller_identified
    FROM "CommercialShipmentLink" l JOIN "Deal" d ON d.id=l."shipmentDealId"
    WHERE d."createdAt">='2026-09-30T21:00:00Z' AND d."deletedAt" IS NULL GROUP BY l.status`);
  const events=await p.crmEvent.groupBy({by:['type'],where:{type:{contains:'responsible'}},_count:true});
  const sample=await p.crmEvent.findFirst({where:{type:{contains:'responsible'}},select:{type:true,valueBefore:true,valueAfter:true}});
  const pending=await p.commercialShipmentLink.findMany({where:{status:{not:'CONFIRMED'},saleDealId:{not:null}},take:5,select:{saleDealId:true,shipmentDealId:true,evidence:true}});
  const history=await p.dealResponsibleHistory.count();
  const policy=load('./dist/workspaces/shipment-link-policy');
  const fields=await p.customFieldDefinition.findMany({where:{entityType:'LEAD'},select:{externalId:true,name:true}});
  const invoice=fields.find(f=>f.name.toLowerCase().replace(/\s+/g,'')==='№счета');
  const document=fields.find(f=>f.name.trim().toLowerCase()==='proforma invoice');
  const ids=await p.$queryRawUnsafe(`SELECT d.id FROM "CommercialShipmentLink" l JOIN "Deal" d ON d.id=l."shipmentDealId" WHERE d."createdAt">='2026-09-30T21:00:00Z' AND d."deletedAt" IS NULL AND l.status <> 'CONFIRMED'`);
  const cards=await p.deal.findMany({where:{id:{in:ids.map(x=>x.id)}},select:{customFields:true}});
  const missing={invoice:0,document:0};
  for(const card of cards){if(!policy.identifier(card.customFields[invoice.externalId]?.value))missing.invoice++;if(!policy.fileIds(card.customFields[document.externalId]?.value).length)missing.document++;}
  console.log(JSON.stringify({breakdown,events,sample,history,pending,missing}));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>p.$disconnect());
