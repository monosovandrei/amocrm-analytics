#!/usr/bin/env node
'use strict';

// MUTATING deployment step: updates built-in templates and warms report snapshots.
// It never starts worker schedulers or changes CRM records.
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

function moscowWindows(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const month = `${parts.year}-${parts.month}`;
  const today = `${month}-${parts.day}`;
  const monthStart = new Date(`${month}-01T00:00:00+03:00`);
  const todayStart = new Date(`${today}T00:00:00+03:00`);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000 - 1);
  const windows = [
    { key: 'month', dateFrom: monthStart.toISOString(), dateTo: todayEnd.toISOString() },
    { key: 'today', dateFrom: todayStart.toISOString(), dateTo: todayEnd.toISOString() },
  ];
  if (todayStart > monthStart) windows.push({ key: 'beforeToday',
    dateFrom: monthStart.toISOString(), dateTo: new Date(todayStart.getTime() - 1).toISOString() });
  return windows;
}

function reportDto(template, window) {
  const filters = { ...(template.config.filters || {}), dateFrom: window.dateFrom, dateTo: window.dateTo };
  return { name: template.name, sourceType: template.sourceType,
    filters, config: { ...template.config, filters } };
}

function warmupJobs(templates, windows) {
  const isFunnel = (template) => ['sales_funnel_steps', 'csm_funnel'].includes(template.config.builtinKey);
  const ordered = [...templates].sort((a, b) =>
    Number(a.config.builtinKey === 'revenue_profit_forecast') - Number(b.config.builtinKey === 'revenue_profit_forecast'));
  // Do not parallelize the forecast or whole reports: the worker's memory budget is bounded.
  return ['ADMIN', 'ROP'].flatMap((role) => [
    ...templates.filter(isFunnel).flatMap((template) => windows.map((window) => ({ role, template, window }))),
    ...ordered.filter((template) => !isFunnel(template))
      .map((template) => ({ role, template, window: windows[0] })),
  ]);
}

async function waitForCertification(quality, buildId, metricVersion, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 180_000);
  do {
    const status = await quality.status();
    if (status.overall === 'CERTIFIED' && status.buildId === buildId && status.metricVersion === metricVersion) return;
    if (now() >= deadline) throw new Error('Current release data did not become certified within the startup window');
    await sleep(2000);
  } while (true);
}

function selfTest() {
  const windows = moscowWindows(new Date('2026-09-24T22:15:00Z'));
  assert.equal(windows[0].dateFrom, '2026-08-31T21:00:00.000Z');
  assert.equal(windows[0].dateTo, '2026-09-25T20:59:59.999Z');
  assert.equal(windows[1].dateFrom, '2026-09-24T21:00:00.000Z');
  assert.equal(windows[2].dateTo, '2026-09-24T20:59:59.999Z');
  assert.equal(moscowWindows(new Date('2026-08-31T22:15:00Z')).length, 2);
  const templates = ['sales_funnel_steps', 'csm_funnel', 'sales_current', 'revenue_profit_forecast']
    .map((key) => ({ name: key, sourceType: 'EVENT', config: { builtinKey: key, filters: { groupIds: ['group'] } } }));
  const jobs = warmupJobs(templates, windows);
  assert.equal(jobs.length, 16);
  assert.equal(jobs.filter((job) => job.role === 'ADMIN').at(-1).template.config.builtinKey, 'revenue_profit_forecast');
  assert.deepEqual(reportDto(templates[0], windows[0]).filters.groupIds, ['group']);
  process.stdout.write(JSON.stringify({ selfTest: 'passed' }) + '\n');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const rootArgument = process.argv.find((arg) => arg.startsWith('--release-root='));
  const root = path.resolve(rootArgument?.slice('--release-root='.length) || path.join(__dirname, '..'));
  const apiRoot = path.join(root, 'apps', 'api');
  if (!fs.existsSync(path.join(apiRoot, 'dist', 'app.module.js'))) throw new Error('Compiled release is missing');
  const templatesOnly = process.argv.includes('--templates-only');
  const load = createRequire(path.join(apiRoot, 'package.json'));
  process.chdir(apiRoot);
  // Release constants are evaluated while importing AppModule, before Nest's
  // ConfigModule initializes. Rollback must load the previous release's values.
  load('dotenv').config({ path: path.join(root, '.env'), override: true, quiet: true });
  process.env.WORKER_ROLE = 'verification';
  process.env.PROCESS_ROLE = 'verification';
  load('reflect-metadata');
  const { NestFactory } = load('@nestjs/core');
  const { AppModule } = load('./dist/app.module');
  const { PrismaService } = load('./dist/prisma/prisma.service');
  const { ReportsService } = load('./dist/reports/reports.service');
  const { DataQualityService } = load('./dist/quality/data-quality.service');
  const { RELEASE_BUILD_ID, METRIC_VERSION } = load('./dist/quality/release-info');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const reports = app.get(ReportsService);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, select: { id: true, role: true } });
    if (!admin) throw new Error('An administrator account is required to prepare report templates');
    // This is the same built-in template update path as GET /reports/templates.
    const templates = (await reports.listTemplates(admin)).filter((template) =>
      template.userId === null && template.config?.builtinKey);
    if (!templates.length) throw new Error('No built-in report templates were generated');
    process.stdout.write(JSON.stringify({ step: 'templates', status: 'ready', count: templates.length,
      buildId: RELEASE_BUILD_ID, metricVersion: METRIC_VERSION }) + '\n');
    if (templatesOnly) return;
    // Readiness checks process health; certification runs on its own schedule.
    // A previous release's certificate or a transient sync must not pass the gate.
    process.stdout.write(JSON.stringify({ step: 'certification', status: 'waiting', buildId: RELEASE_BUILD_ID }) + '\n');
    const quality = app.get(DataQualityService);
    await waitForCertification(quality, RELEASE_BUILD_ID, METRIC_VERSION);
    for (const key of ['sales_funnel_steps', 'csm_funnel', 'revenue_profit_forecast']) {
      if (!templates.some((template) => template.config.builtinKey === key)) throw new Error(`Missing required template: ${key}`);
    }
    // Force fresh calculation via the normal compute/save/quality path. A browser may
    // have created a PENDING cache row during startup; it must not count as warmed.
    reports.getCachedReport = async () => null;
    const jobs = warmupJobs(templates, moscowWindows());
    for (const job of jobs) {
      const started = Date.now();
      const user = { ...admin, role: job.role };
      const [dto] = await reports.normalizeBuiltinRequests([reportDto(job.template, job.window)]);
      await waitForCertification(quality, RELEASE_BUILD_ID, METRIC_VERSION);
      const report = await reports.compute(dto, user);
      if (!report?.type || report.type === 'pending' || report.ready === false) throw new Error(`Report is unavailable: ${job.template.name}`);
      const findSnapshot = () => prisma.reportSnapshot.findUnique({
        where: { cacheKey: reports.reportCacheKey(dto, user) },
        select: { payload: true, qualityStatus: true },
      });
      let snapshot = await findSnapshot();
      if (snapshot?.payload?.type && snapshot.qualityStatus === 'CHECKING') {
        // A scheduled source check can run during computation. Retry once after
        // it certifies; never relabel an unchecked payload as certified.
        await waitForCertification(quality, RELEASE_BUILD_ID, METRIC_VERSION);
        await reports.compute(dto, user);
        snapshot = await findSnapshot();
      }
      if (!snapshot?.payload?.type || snapshot.payload.type === 'pending' || snapshot.qualityStatus !== 'CERTIFIED') {
        throw new Error(`Snapshot was not certified: ${job.template.name}`);
      }
      process.stdout.write(JSON.stringify({ step: 'warmup', name: job.template.name, role: job.role,
        period: job.window.key, durationMs: Date.now() - started, status: 'ready' }) + '\n');
      if (typeof global.gc === 'function') global.gc();
    }
    process.stdout.write(JSON.stringify({ step: 'complete', status: 'ready', reports: jobs.length }) + '\n');
  } finally {
    await app.close();
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n');
  process.exitCode = 1;
});

module.exports = { moscowWindows, reportDto, warmupJobs, waitForCertification };
