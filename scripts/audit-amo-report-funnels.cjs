#!/usr/bin/env node
'use strict';

// Read-only comparison of source CRM transitions, the mirror, and report results.
// node scripts/audit-amo-report-funnels.cjs --month=2026-10 --live
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const arg = (key, fallback) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const scalar = (v, key) => Array.isArray(v) ? scalar(v[0], key)
  : v?.lead_status?.[key] ?? v?.status?.[key] ?? v?.[key] ?? null;
const statusKey = (v) => `${scalar(v, 'pipeline_id')}:${scalar(v, 'id')}`;
const summarize = (events, userFor, allowed) => {
  const rows = new Map();
  for (const event of events) {
    const user = userFor(event);
    if (!user || !allowed(user)) continue;
    if (!rows.has(user.externalId)) rows.set(user.externalId, { manager: user.name, events: 0, deals: new Set() });
    const row = rows.get(user.externalId);
    row.events += 1;
    row.deals.add(String(event.entity_id));
  }
  const managers = [...rows.values()].map((r) => ({ manager: r.manager, events: r.events, uniqueDeals: r.deals.size }))
    .sort((a, b) => b.events - a.events || a.manager.localeCompare(b.manager, 'ru'));
  return { events: managers.reduce((s, r) => s + r.events, 0),
    uniqueDeals: new Set(events.filter((e) => { const u = userFor(e); return u && allowed(u); }).map((e) => String(e.entity_id))).size,
    managers };
};

async function main() {
  const root = path.resolve(arg('release-root', path.join(__dirname, '..')));
  const load = createRequire(path.join(root, 'apps/api/package.json'));
  load('dotenv').config({ path: path.join(root, '.env'), override: true, quiet: true });
  process.env.WORKER_ROLE = 'verification';
  process.env.PROCESS_ROLE = 'verification';
  load('reflect-metadata');
  const { NestFactory } = load('@nestjs/core');
  const { AppModule } = load('./dist/app.module');
  const { PrismaService } = load('./dist/prisma/prisma.service');
  const { ReportsService } = load('./dist/reports/reports.service');
  const { AmoService } = load('./dist/amo/amo.service');
  const requestedTo = arg('to', null);
  if (requestedTo && !Number.isFinite(new Date(requestedTo).getTime())) throw new Error('Invalid source cutoff');
  const month = arg('month', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(requestedTo ? new Date(requestedTo) : new Date()));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid month');
  const from = new Date(`${month}-01T00:00:00+03:00`);
  const [year, monthNumber] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1) - 3 * 3_600_000);
  const to = new Date(arg('to', new Date(Math.min(Date.now(), end.getTime() - 1)).toISOString()));
  if (to < from || to >= end || to > new Date()) throw new Error('Source cutoff must be inside the selected month and not in the future');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const result = { checkedAt: new Date().toISOString(), from: from.toISOString(), to: to.toISOString(),
    source: 'amoCRM API v4 lead_status_changed', readOnly: true, metrics: [], gaps: {}, checks: 0, failures: [] };
  const check = (name, actual, expected) => {
    result.checks += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) result.failures.push({ name, actual, expected });
  };
  try {
    const p = app.get(PrismaService), reports = app.get(ReportsService);
    const admin = await p.user.findFirst({ where: { role: 'ADMIN', isActive: true }, select: { id: true, role: true } });
    if (!admin) throw new Error('Active administrator is required');
    const users = await p.crmUser.findMany({ include: { group: true } });
    const usersById = new Map(users.map((u) => [u.id, u]));
    const usersByExternal = new Map(users.map((u) => [u.externalId, u]));
    const stages = await p.pipelineStage.findMany({ include: { pipeline: true } });
    const stagesById = new Map(stages.map((s) => [s.id, s]));
    const definitions = [];
    for (const team of ['sales', 'csm']) {
      const d = await reports.getTeamFunnelDefinition(team);
      if (!d) throw new Error(`Missing ${team} definition`);
      const filters = { ...d.filters, dateFrom: from.toISOString(), dateTo: to.toISOString() };
      const payload = await reports.computeFresh({ name: d.name, sourceType: d.sourceType, filters, config: { ...d.config, filters } }, admin);
      definitions.push({ team, d, payload });
    }
    const mirrorEvents = await p.crmEvent.findMany({ where: { type: 'lead_status_changed', createdAt: { gte: from, lte: to } },
      select: { id: true, externalId: true, dealId: true, createdAt: true, valueAfter: true, raw: true } });
    const reused = arg('reuse-evidence', null);
    const evidence = reused ? JSON.parse(fs.readFileSync(reused, 'utf8')) : null;
    if (evidence && (evidence.from !== from.toISOString() || evidence.to !== to.toISOString())) throw new Error('Evidence period differs');
    let liveEvents = evidence?.events ?? null;
    let client;
    if (process.argv.includes('--live') && !evidence) {
      const amo = app.get(AmoService);
      client = await amo.getClient(await amo.getActiveConnectionOrFail(), { minRequestIntervalMs: 150 });
      // A database clone must never rotate the production OAuth refresh token.
      if(process.argv.includes('--no-token-refresh'))client.refreshToken=async()=>{throw new Error('OAuth refresh is forbidden in the isolated source audit; use a fresh credential snapshot');};
      const byId = new Map();
      for (let start = from.getTime(); start <= to.getTime(); start += 86_400_000) {
        const windowEnd = Math.min(to.getTime(), start + 86_400_000 - 1);
        await client.paginateBatch('/events', 'events', { 'filter[type]': 'lead_status_changed',
          'filter[created_at][from]': Math.floor(start / 1000), 'filter[created_at][to]': Math.floor(windowEnd / 1000), limit: 250 },
        async (batch) => { for (const e of batch) byId.set(String(e.id), e); });
        process.stderr.write(JSON.stringify({ step: 'source-events', through: new Date(windowEnd).toISOString(), events: byId.size }) + '\n');
      }
      liveEvents = [...byId.values()];
    }
    const targetKeys = new Set(definitions.flatMap(({ d }) => d.config.contract.metrics.filter((m) => m.type === 'stage_reached')
      .flatMap((m) => m.stageIds.map((id) => { const s = stagesById.get(id); return `${s.pipeline.externalId}:${s.externalId}`; }))));
    const relevantLive = liveEvents?.filter((e) => targetKeys.has(statusKey(e.value_after))) ?? [];
    const relevantMirror = mirrorEvents.filter((e) => targetKeys.has(statusKey(e.valueAfter)));
    const ids = [...new Set([...relevantLive.map((e) => String(e.entity_id)),
      ...definitions.flatMap(({ payload }) => payload.summaryRows?.[0]?.metrics
        ? Object.values(payload.summaryRows[0].metrics).flatMap((m) => (m.samples || []).map((s) => String(s.dealExternalId ?? s.externalId ?? ''))) : [])].filter(Boolean))];
    const mirrorDeals = await p.deal.findMany({ where: { OR: [{ externalId: { in: ids } }, { id: { in: relevantMirror.map((e) => e.dealId).filter(Boolean) } }] },
      select: { id: true, externalId: true, responsibleId: true, deletedAt: true, amount: true, pipelineId: true } });
    const mirrorDealsById = new Map(mirrorDeals.map((d) => [d.id, d]));
    const mirrorDealsByExternal = new Map(mirrorDeals.map((d) => [d.externalId, d]));
    const liveLeads = new Map((evidence?.leads ?? []).map((lead) => [String(lead.id), lead]));
    if (client) for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const params = { limit: 250 };
      batch.forEach((id, index) => { params[`filter[id][${index}]`] = id; });
      const leads = await client.paginate('/leads', 'leads', params);
      for (const lead of leads) {
        if (!batch.includes(String(lead.id))) throw new Error('amoCRM ignored lead ID filter');
        liveLeads.set(String(lead.id), lead);
      }
    }
    const evidencePath = arg('evidence-output', null);
    if (evidencePath && liveEvents) fs.writeFileSync(evidencePath, JSON.stringify({
      from: from.toISOString(), to: to.toISOString(),
      events: liveEvents.map((e) => ({ id: e.id, entity_id: e.entity_id, created_at: e.created_at, created_by: e.created_by, value_after: e.value_after })),
      leads: [...liveLeads.values()].map((lead) => ({ id: lead.id, responsible_user_id: lead.responsible_user_id, price: lead.price, pipeline_id: lead.pipeline_id, status_id: lead.status_id })),
    }), { mode: 0o600 });
    const mirrorNormalized = relevantMirror.map((e) => ({ id: e.externalId, entity_id: mirrorDealsById.get(e.dealId)?.externalId,
      created_by: e.raw?.created_by, value_after: e.valueAfter }));
    for (const { team, d, payload } of definitions) {
      const allowed = (u) => u.isActive && (team !== 'csm' || u.groupId === d.group.id);
      const historical = (u) => team !== 'csm' || u.groupId === d.group.id;
      for (const metric of d.config.contract.metrics.filter((m) => m.type === 'stage_reached')) {
        const keys = new Set(metric.stageIds.map((id) => { const s = stagesById.get(id); return `${s.pipeline.externalId}:${s.externalId}`; }));
        const source = relevantLive.filter((e) => keys.has(statusKey(e.value_after)));
        const mirror = mirrorNormalized.filter((e) => keys.has(statusKey(e.value_after)));
        const sourceEvents = (liveEvents ?? []).filter((e) => {
          if (metric.includeSystemStageEvents === false && Number(e.created_by) === 0) return false;
          if (keys.has(statusKey(e.value_after))) return true;
          if (!metric.legacyStageBefore || e.created_at * 1000 >= new Date(metric.legacyStageBefore).getTime()) return false;
          return (metric.legacyStageIds ?? []).some((id) => { const s = stagesById.get(id); return `${s.pipeline.externalId}:${s.externalId}` === statusKey(e.value_after); });
        });
        const sourceManagers = new Map();
        for (const event of sourceEvents) {
          const externalActorId = String(event.created_by ?? 'unknown');
          const user = usersByExternal.get(externalActorId);
          const key = user?.id ?? (externalActorId === '0' ? 'amo-automation' : `amo-user:${externalActorId}`);
          const row = sourceManagers.get(key) ?? { name: user?.name ?? (externalActorId === '0' ? 'Автоматизация amoCRM' : 'Неизвестный исполнитель amoCRM'), count: 0, amount: 0 };
          const lead = liveLeads.get(String(event.entity_id));
          row.count += 1;
          if (metric.measure === 'field_sum' && !lead) throw new Error(`Source amount unavailable for ${team}/${metric.id}/${event.entity_id}`);
          row.amount += Number(lead?.price ?? 0);
          sourceManagers.set(key, row);
        }
        const value = (row) => metric.measure === 'field_sum' ? Math.round(row.amount) : row.count;
        const expectedValue = metric.measure === 'field_sum'
          ? Math.round([...sourceManagers.values()].reduce((s, row) => s + row.amount, 0)) : sourceEvents.length;
        const actual = payload.summaryRows?.[0]?.metrics?.[metric.id];
        if (process.argv.includes('--verify')) {
          if (!liveEvents) throw new Error('--verify requires --live or --reuse-evidence');
          check(`${team}/${metric.id}/value`, actual?.value, expectedValue);
          check(`${team}/${metric.id}/occurrences`, actual?.dealCount, sourceEvents.length);
          const externalEventById = new Map(mirrorEvents.map((e) => [e.id, e.externalId]));
          check(`${team}/${metric.id}/eventIds`, (actual?.samples ?? []).map((s) => externalEventById.get(s.occurrenceId)).sort(), sourceEvents.map((e) => String(e.id)).sort());
          for (const [id, row] of sourceManagers) {
            check(`${team}/${metric.id}/${row.name}`, payload.rows.find((r) => r.groupId === id)?.metrics?.[metric.id]?.value, value(row));
          }
        }
        result.metrics.push({ team, metric: metric.id, label: metric.label,
          stageKeys: [...keys], report: payload.summaryRows?.[0]?.metrics?.[metric.id]?.value,
          sourceValue: expectedValue, sourceOccurrences: sourceEvents.length,
          sourceManagers: [...sourceManagers].map(([id, row]) => ({ id, name: row.name, value: value(row) })),
          reportManagers: payload.rows.map((r) => ({ manager: r.groupName, value: r.metrics?.[metric.id]?.value })).filter((r) => r.value),
          mirrorCurrentOwner: summarize(mirror, (e) => usersById.get(mirrorDealsByExternal.get(String(e.entity_id))?.responsibleId), allowed),
          mirrorActor: summarize(mirror, (e) => usersByExternal.get(String(e.created_by)) ?? usersById.get(mirrorDealsByExternal.get(String(e.entity_id))?.responsibleId), allowed),
          ...(liveEvents ? {
            liveCurrentOwner: summarize(source, (e) => usersByExternal.get(String(liveLeads.get(String(e.entity_id))?.responsible_user_id)), allowed),
            liveActor: summarize(source, (e) => usersByExternal.get(String(e.created_by)) ?? usersByExternal.get(String(liveLeads.get(String(e.entity_id))?.responsible_user_id)), allowed),
            liveHistoricalActor: summarize(source, (e) => usersByExternal.get(String(e.created_by)) ?? usersByExternal.get(String(liveLeads.get(String(e.entity_id))?.responsible_user_id)), historical),
          } : {}) });
      }
    }
    const mirrorIds = new Set(mirrorEvents.map((e) => e.externalId));
    result.gaps = { mirrorStatusEvents: mirrorEvents.length, liveStatusEvents: liveEvents?.length ?? null,
      missingRelevantEvents: relevantLive.filter((e) => !mirrorIds.has(String(e.id))).map((e) => ({ eventId: String(e.id), dealId: String(e.entity_id), at: new Date(e.created_at * 1000).toISOString(), stage: statusKey(e.value_after) })),
      missingLeads: relevantLive.map((e) => String(e.entity_id)).filter((id, i, a) => !mirrorDealsByExternal.has(id) && a.indexOf(id) === i),
      ownerMismatches: [...liveLeads.values()].filter((lead) => {
        const mirror = mirrorDealsByExternal.get(String(lead.id));
        return mirror && usersById.get(mirror.responsibleId)?.externalId !== String(lead.responsible_user_id);
      }).map((lead) => ({ dealId: String(lead.id), liveOwner: String(lead.responsible_user_id), mirrorOwner: usersById.get(mirrorDealsByExternal.get(String(lead.id)).responsibleId)?.externalId })),
      relevantLeadCount: new Set(relevantLive.map((e) => String(e.entity_id))).size,
      liveLeadCount: liveLeads.size };
    if (process.argv.includes('--verify')) {
      check('source/missingStatusEvents', (liveEvents ?? []).filter((e) => !mirrorIds.has(String(e.id))).length, 0);
      check('source/responsibleParity', result.gaps.ownerMismatches.length, 0);
      result.status = result.failures.length ? 'failed' : 'passed';
      if (result.failures.length) process.exitCode = 1;
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } finally { await app.close(); }
}

main().catch((e) => { process.stderr.write(JSON.stringify({ status: 'failed', error: e.message }) + '\n'); process.exitCode = 1; });
