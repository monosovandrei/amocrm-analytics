'use strict';
const { createRequire } = require('node:module');
const root = process.argv[2] || '/opt/analytics';
const load = createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({ path: `${root}/.env`, quiet: true });
const { PrismaClient } = load('./src/generated/prisma');
const p = new PrismaClient();
const ids = ['41470057', '41490929'];
function paths(value, needle, prefix = '') {
  if (value == null) return [];
  if (typeof value !== 'object') return String(value).includes(needle) ? [prefix] : [];
  return Object.entries(value).flatMap(([k,v]) => paths(v, needle, `${prefix}/${k}`));
}
(async () => {
  const deals = await p.deal.findMany({ where: { externalId: { in: ids } }, include: { pipeline: true, responsible: { select: { name: true } } } });
  const a = deals.find(d => d.externalId === ids[0]), b = deals.find(d => d.externalId === ids[1]);
  if (!a || !b) throw new Error('Example cards not present in mirror');
  const fields = Object.keys(a.customFields).filter(k => b.customFields[k]);
  const comparison = fields.map(k => ({ fieldId:k, name:a.customFields[k].name,
    same: JSON.stringify(a.customFields[k].value) === JSON.stringify(b.customFields[k].value),
    populated: a.customFields[k].value != null && a.customFields[k].value !== '' }));
  const notes = await p.note.findMany({ where: { dealId: { in: [a.id,b.id] } }, select: { dealId:true, type:true, text:true, raw:true } });
  const invoiceId=Object.keys(a.customFields).find(k=>String(a.customFields[k].name).toLowerCase().replace(/\s+/g,'')==='№счета');
  const candidates=invoiceId?await p.deal.findMany({where:{customFields:{path:[invoiceId,'value'],equals:a.customFields[invoiceId].value},NOT:{pipelineId:b.pipelineId}},select:{id:true,externalId:true,createdAt:true,updatedAt:true,stage:{select:{name:true}},pipeline:{select:{name:true}}}}):[];
  const nearbyEvents=candidates.length?await p.crmEvent.findMany({where:{dealId:{in:candidates.map(c=>c.id)},type:'lead_status_changed',createdAt:{gte:new Date(+b.createdAt-120000),lte:new Date(+b.createdAt+120000)}},select:{dealId:true,createdAt:true,valueAfter:true}}):[];
  console.log(JSON.stringify({ examples: deals.map(d => ({ id:d.externalId, pipeline:d.pipeline.name, manager:d.responsible?.name,
    createdAt:d.createdAt, otherIdReferences:paths(d.raw, ids.find(id => id !== d.externalId)), embeddedKeys:Object.keys(d.raw._embedded || {}) })),
    sameContact: a.contactId === b.contactId, fields:comparison,
    noteTypes:[...new Set(notes.map(n => n.type))], noteReferencePaths:notes.flatMap(n => ids.flatMap(id => paths(n.raw,id))),
    noteUrls:notes.flatMap(n => String(n.text || '').match(/https?:\/\/[^\s<>]+\/leads\/detail\/\d+/g) || []),
    candidates:candidates.map(c=>({id:c.externalId,pipeline:c.pipeline.name,stage:c.stage.name,createdAt:c.createdAt,updatedAt:c.updatedAt,nearbyEvents:nearbyEvents.filter(e=>e.dealId===c.id).map(e=>({at:e.createdAt,after:e.valueAfter}))})) }));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>p.$disconnect());
