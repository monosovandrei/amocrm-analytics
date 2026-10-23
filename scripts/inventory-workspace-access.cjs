'use strict';
// Read-only deployment inventory. Never emit credentials or customer field values.
const { createRequire } = require('node:module');
const root = process.argv[2] || '/opt/analytics';
const load = createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({ path: `${root}/.env`, quiet: true });
const { PrismaClient } = load('./src/generated/prisma');
const p = new PrismaClient();
(async () => {
  const users = await p.user.findMany({ select: { id: true, name: true, role: true, businessRole: true, crmUserId: true,
    crmUser: { select: { isActive: true, group: { select: { id: true, name: true } } } } } });
  const pipelines = await p.pipeline.findMany({ select: { id: true, name: true, externalId: true } });
  const fields = await p.customFieldDefinition.findMany({ where: { entityType: 'LEAD' }, select: { externalId: true, name: true, type: true } });
  const counts = await p.deal.groupBy({ by: ['pipelineId'], _count: true });
  const relationFields = fields.filter(f => /связ|исход|родител|сделк|заказ|lead|parent|link/i.test(f.name));
  const rawKeys = await p.$queryRawUnsafe('SELECT DISTINCT jsonb_object_keys(raw) AS key FROM "Deal" LIMIT 80');
  const linkTypes = await p.entityLink.groupBy({ by: ['entityType', 'linkedEntityType'], _count: true });
  const orderCoverage = await p.$queryRawUnsafe(`WITH orders AS (
    SELECT "pipelineId", NULLIF(BTRIM("customFields"->'485087'->>'value'), '') AS order_id
    FROM "Deal" WHERE "deletedAt" IS NULL
  ) SELECT "pipelineId", COUNT(*)::int AS total, COUNT(order_id)::int AS with_order,
    COUNT(DISTINCT order_id)::int AS distinct_orders FROM orders GROUP BY "pipelineId"`);
  const orderMatches = await p.$queryRawUnsafe(`WITH orders AS (
    SELECT "pipelineId", NULLIF(BTRIM("customFields"->'485087'->>'value'), '') AS order_id
    FROM "Deal" WHERE "deletedAt" IS NULL
  ), per_pipeline AS (SELECT "pipelineId", order_id, COUNT(*) AS n FROM orders WHERE order_id IS NOT NULL GROUP BY "pipelineId", order_id)
  SELECT a."pipelineId" AS first_pipeline, b."pipelineId" AS second_pipeline, COUNT(*)::int AS shared_orders,
    COUNT(*) FILTER (WHERE a.n = 1 AND b.n = 1)::int AS one_to_one_orders
  FROM per_pipeline a JOIN per_pipeline b ON a.order_id = b.order_id AND a."pipelineId" < b."pipelineId"
  GROUP BY a."pipelineId", b."pipelineId"`);
  const noteLinkCoverage = await p.$queryRawUnsafe(`SELECT n.type, COUNT(*)::int AS notes, COUNT(DISTINCT n."dealId")::int AS deals
    FROM "Note" n JOIN "Deal" d ON d.id = n."dealId" JOIN "Pipeline" pl ON pl.id = d."pipelineId"
    WHERE pl.name ILIKE '%сборк%' AND (COALESCE(n.text, '') ~* 'leads/detail/[0-9]+' OR n.raw::text ~* 'leads/detail/[0-9]+') GROUP BY n.type`);
  const ropCandidates = await p.crmUser.findMany({ where: { OR: [ { name: { contains: 'Владимир', mode: 'insensitive' } }, { name: { contains: 'Серж', mode: 'insensitive' } }, { name: { contains: 'Vladimir', mode: 'insensitive' } }, { name: { contains: 'Sergeant', mode: 'insensitive' } } ] }, select: { id: true, name: true, isActive: true, group: { select: { name: true } } } });
  console.log(JSON.stringify({ users, pipelines, counts, relationFields, rawKeys, linkTypes, orderCoverage, orderMatches, noteLinkCoverage, ropCandidates }));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => p.$disconnect());
