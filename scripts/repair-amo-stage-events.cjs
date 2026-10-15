#!/usr/bin/env node
'use strict';

// Replays immutable source transitions in bounded daily pages. No CRM writes.
// Dry run by default; --apply adds missing events using the normal importer.
const path = require('node:path');
const { createRequire } = require('node:module');
const arg = (key, fallback) => process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;

async function main() {
  const root = path.resolve(arg('release-root', path.join(__dirname, '..')));
  const load = createRequire(path.join(root, 'apps/api/package.json'));
  load('dotenv').config({ path: path.join(root, '.env'), override: true, quiet: true });
  process.env.PROCESS_ROLE = 'verification'; process.env.WORKER_ROLE = 'verification';
  load('reflect-metadata');
  const { NestFactory } = load('@nestjs/core');
  const { AppModule } = load('./dist/app.module');
  const { PrismaService } = load('./dist/prisma/prisma.service');
  const { AmoService } = load('./dist/amo/amo.service');
  const { AmoSyncService } = load('./dist/amo/amo-sync.service');
  const { FactMartsService } = load('./dist/facts/fact-marts.service');
  const from = new Date(arg('from', 'invalid'));
  const to = new Date(arg('to', new Date().toISOString()));
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to || to > new Date()) throw new Error('A valid explicit source interval is required');
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const p = app.get(PrismaService), amo = app.get(AmoService), sync = app.get(AmoSyncService);
    const client = await amo.getClient(await amo.getActiveConnectionOrFail(), { minRequestIntervalMs: 150 });
    const maps = sync.emptyMaps(); await sync.hydrateMetadataMaps(maps);
    const touchedDeals = new Set();
    const totals = { apply, from: from.toISOString(), to: to.toISOString(), fetched: 0, missing: 0, unlinked: 0, inserted: 0, days: 0 };
    for (let start = from.getTime(); start <= to.getTime(); start += 86_400_000) {
      const through = Math.min(to.getTime(), start + 86_400_000 - 1);
      const day = { from: new Date(start).toISOString(), fetched: 0, missing: 0, inserted: 0 };
      await client.paginateBatch('/events', 'events', { 'filter[type]': 'lead_status_changed',
        'filter[created_at][from]': Math.floor(start / 1000), 'filter[created_at][to]': Math.floor(through / 1000), limit: 250 }, async (batch) => {
        const events = [...new Map(batch.map((e) => [String(e.id), e])).values()];
        const stored = new Map((await p.crmEvent.findMany({ where: { externalId: { in: events.map((e) => String(e.id)) } },
          select: { externalId: true, dealId: true } })).map((e) => [e.externalId, e]));
        day.fetched += events.length;
        for (const event of events) {
          const previous = stored.get(String(event.id));
          if (previous?.dealId) continue;
          if (!previous) day.missing += 1;
          if (!apply) continue;
          await sync.upsertCrmEvent(event, maps);
          const saved = await p.crmEvent.findUnique({ where: { externalId: String(event.id) }, select: { dealId: true } });
          if (saved?.dealId) touchedDeals.add(saved.dealId); else totals.unlinked += 1;
          if (!previous) day.inserted += 1;
        }
        const verified = await p.crmEvent.count({ where: { externalId: { in: events.map((e) => String(e.id)) } } });
        if (apply && verified !== events.length) throw new Error(`Source event parity failed for ${day.from}`);
      });
      totals.days += 1; totals.fetched += day.fetched; totals.missing += day.missing; totals.inserted += day.inserted;
      process.stdout.write(JSON.stringify({ step: 'day', ...day }) + '\n');
    }
    if (apply && touchedDeals.size) await app.get(FactMartsService).refreshDeals([...touchedDeals]);
    process.stdout.write(JSON.stringify({ step: 'complete', ...totals, refreshedDeals: touchedDeals.size }) + '\n');
  } finally { await app.close(); }
}

main().catch((e) => { process.stderr.write(JSON.stringify({ status: 'failed', error: e.message }) + '\n'); process.exitCode = 1; });
