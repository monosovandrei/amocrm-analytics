#!/usr/bin/env node
'use strict';

// Runs against the compiled release, without refreshing CRM or publishing snapshots.
// Usage: node scripts/verify-section-consistency.cjs --months=2026-09,2026-08 --roles=ADMIN,ROP
const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const METRICS = {
  sales: {
    sales_qualified_leads: 'leads_received',
    sales_kp_count: 'kp_presented',
    sales_conv_kp_to_invoice: 'conv_kp_presented_to_invoice',
    sales_invoice_count: 'invoice_sent',
    sales_conv_invoice_to_paid: 'conv_invoice_to_paid',
    sales_paid_count: 'paid',
    sales_paid_amount: 'payment_amount',
  },
  csm: {
    csm_taken_to_work_count: 'taken_to_work',
    csm_conv_work_to_kp: 'conv_work_to_offer',
    csm_kp_count: 'offer_made',
    csm_conv_kp_to_invoice: 'conv_offer_to_invoice',
    csm_invoice_count: 'invoice_sent',
    csm_conv_invoice_to_paid: 'conv_invoice_to_paid',
    csm_paid_count: 'paid',
    csm_paid_amount: 'paid_amount',
  },
};

function sameNumber(actual, expected) {
  if (actual == null || expected == null) return actual === null && expected === null;
  return Number.isFinite(Number(actual)) && Number.isFinite(Number(expected))
    && Math.abs(Number(actual) - Number(expected)) < 0.005;
}

function stable(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function comparableConfig(config = {}) {
  const { filters, metric, contract, steps, operator, dashboardSection,
    builtinKey, lockPipelineFilter, lockTeamFilter } = config;
  return { filters, metric, contract, steps, operator, dashboardSection,
    builtinKey, lockPipelineFilter, lockTeamFilter };
}

function reportDto(template, dateFrom, dateTo) {
  const filters = { ...(template.config.filters || {}), dateFrom, dateTo };
  return { name: template.name, sourceType: template.sourceType,
    filters, config: { ...template.config, filters } };
}

function compareFunnel(team, report, factField, check, label) {
  const mapping = METRICS[team.key];
  const reportRows = new Map((report.rows || []).map((row) => [row.groupId, row]));
  const pairs = [
    [team.total, report.summaryRows?.[0], 'total'],
    ...team.rows.map((row) => [row, reportRows.get(row.targetId), row.targetName]),
  ];
  for (const [planRow, reportRow, target] of pairs) {
    for (const [planKey, reportKey] of Object.entries(mapping)) {
      // A manager with no funnel activity can still appear in Plan-fact through
      // shipping or another window. Missing metrics on an existing row remain errors.
      const expected = !reportRow && target !== 'total'
        ? (reportKey.startsWith('conv_') ? null : 0)
        : reportRow?.metrics?.[reportKey]?.value;
      const actual = planRow.values?.[planKey]?.[factField];
      check(`${label}/${team.key}/${target}/${planKey}`, actual, expected);
    }
    if (team.key === 'sales') {
      const leads = reportRow?.metrics?.leads_received?.value;
      const quotes = reportRow?.metrics?.kp_presented?.value;
      const ratio = leads > 0 ? Number(((quotes / leads) * 100).toFixed(2)) : null;
      check(`${label}/sales/${target}/sales_conv_lead_to_kp`,
        planRow.values?.sales_conv_lead_to_kp?.[factField], ratio);
    }
  }
  const listedIds = new Set(team.rows.map((row) => row.targetId));
  for (const row of report.rows || []) {
    if (listedIds.has(row.groupId)) continue;
    for (const key of Object.values(mapping)) {
      const value = row.metrics?.[key]?.value;
      if (value != null && Number(value) !== 0) {
        check(`${label}/${team.key}/missing-manager/${row.groupName}/${key}`, undefined, value);
      }
    }
  }
  for (const metric of team.metrics.filter((item) => item.kind === 'additive')) {
    const values = team.rows.map((row) => row.values?.[metric.key]?.[factField]);
    const total = values.every((value) => value != null && Number.isFinite(Number(value)))
      ? values.reduce((sum, value) => sum + Number(value), 0) : undefined;
    check(`${label}/${team.key}/row-sum/${metric.key}`, team.total.values?.[metric.key]?.[factField], total);
  }
}

function selfTest() {
  assert.equal(sameNumber(null, 0), false);
  assert.equal(sameNumber(undefined, null), false);
  assert.equal(sameNumber(undefined, undefined), false);
  assert.equal(sameNumber(NaN, NaN), false);
  assert.equal(sameNumber(1, 1.001), true);
  assert.equal(sameNumber(1, 1.01), false);
  assert.equal(stable({ b: 2, a: 1 }), stable({ a: 1, b: 2 }));
  const dto = reportDto({ name: 'test', sourceType: 'EVENT', config: { filters: { groupIds: ['g'] } } }, 'from', 'to');
  assert.deepEqual(dto.filters, dto.config.filters);
  assert.deepEqual(dto.filters.groupIds, ['g']);
  const reportMetrics = Object.fromEntries(Object.values(METRICS.csm).map((key) => [key, { value: key.startsWith('conv_') ? null : 1 }]));
  const planValues = Object.fromEntries(Object.entries(METRICS.csm).map(([key, reportKey]) => [key, { factMonth: reportMetrics[reportKey].value }]));
  const team = { key: 'csm', metrics: [], rows: [{ targetId: 'manager', targetName: 'Test', values: planValues }], total: { values: planValues } };
  const report = { rows: [{ groupId: 'manager', metrics: reportMetrics }], summaryRows: [{ metrics: reportMetrics }] };
  let differences = 0;
  const check = (_name, actual, expected) => { if (!sameNumber(actual, expected)) differences += 1; };
  compareFunnel(team, report, 'factMonth', check, 'test');
  assert.equal(differences, 0);
  team.rows[0].values = { ...planValues, csm_kp_count: { factMonth: 7 } };
  compareFunnel(team, report, 'factMonth', check, 'test');
  assert.equal(differences, 1);
  const emptyValues = Object.fromEntries(Object.entries(METRICS.csm)
    .map(([key, reportKey]) => [key, { factMonth: reportKey.startsWith('conv_') ? null : 0 }]));
  team.rows[0] = { targetId: 'shipping-only', targetName: 'Shipping only', values: emptyValues };
  report.rows = [];
  compareFunnel(team, report, 'factMonth', check, 'test');
  assert.equal(differences, 1);
  delete report.summaryRows[0].metrics.paid_amount;
  compareFunnel(team, report, 'factMonth', check, 'test');
  assert.equal(differences, 2);
  process.stdout.write(JSON.stringify({ selfTest: 'passed' }) + '\n');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const root = path.resolve(__dirname, '..');
  const apiRoot = path.join(root, 'apps', 'api');
  const load = createRequire(path.join(apiRoot, 'package.json'));
  process.chdir(apiRoot);
  process.env.WORKER_ROLE = 'verification';
  process.env.PROCESS_ROLE = 'verification';
  load('reflect-metadata');
  const { NestFactory } = load('@nestjs/core');
  const { AppModule } = load('./dist/app.module');
  const { PrismaService } = load('./dist/prisma/prisma.service');
  const { ReportsService } = load('./dist/reports/reports.service');
  const { PlatformService } = load('./dist/platform/platform.service');
  const { RELEASE_BUILD_ID, METRIC_VERSION } = load('./dist/quality/release-info');
  const currentMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date());
  const monthsArg = process.argv.find((arg) => arg.startsWith('--months='));
  const months = [...new Set((monthsArg?.slice('--months='.length) || currentMonth).split(','))];
  const rolesArg = process.argv.find((arg) => arg.startsWith('--roles='));
  const roles = [...new Set((rolesArg?.slice('--roles='.length) || 'ADMIN,ROP').split(','))];
  for (const month of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Invalid month: ${month}`);
  }
  for (const role of roles) {
    if (!['ADMIN', 'ROP'].includes(role)) throw new Error(`Unsupported verification role: ${role}`);
  }
  const result = { buildId: RELEASE_BUILD_ID, metricVersion: METRIC_VERSION,
    readOnly: true, checkedAt: new Date().toISOString(), checks: 0, failures: [], periods: [], reports: [] };
  const check = (name, actual, expected) => {
    result.checks += 1;
    if (!sameNumber(actual, expected)) result.failures.push({ name, actual: actual ?? null, expected: expected ?? null,
      ...(actual === undefined || expected === undefined ? { missingValue: true } : {}) });
  };
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const prisma = app.get(PrismaService);
    const reports = app.get(ReportsService);
    const platform = app.get(PlatformService);
    // AppModule excludes schedulers. READ ONLY guards every query, including accidental writes.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      reports.prisma = tx;
      platform.prisma = tx;
      reports.compute = (dto, user) => reports.computeFresh(dto, user);
      reports.saveRevenueForecastSnapshot = async () => undefined;
      const admin = await tx.user.findFirst({ where: { role: 'ADMIN' },
        select: { id: true, role: true, email: true, name: true, businessRole: true, crmUserId: true } });
      if (!admin) throw new Error('An administrator account is required for full reconciliation');
      const generated = [
        ...await reports.buildSalesReportTemplates(),
        ...await reports.buildCsmReportTemplates(),
        reports.buildRevenueForecastReportTemplate(),
      ];
      const persisted = await tx.reportTemplate.findMany({ where: { name: { in: generated.map((item) => item.name) } } });
      for (const template of generated) {
        const saved = persisted.filter((item) => item.name === template.name);
        check(`template/${template.name}/unique`, saved.length, 1);
        if (saved[0]) check(`template/${template.name}/definition`,
          stable(comparableConfig(saved[0].config)) === stable(comparableConfig(template.config)) ? 1 : 0, 1);
      }
      for (const role of roles) {
        // The role is an in-memory read scope; no account is modified or impersonation token issued.
        const user = { ...admin, role };
        const roleCheck = (name, actual, expected) => check(`${role}/${name}`, actual, expected);
        for (const month of months) {
          const start = Date.now();
          const plan = await platform.planFact(user, undefined, month);
          roleCheck(`${month}/teams`, plan.teams.length, 2);
          for (const warning of plan.warnings || []) result.failures.push({ name: `${role}/${month}/configuration`, message: warning });
          const dateFrom = new Date(plan.calendar.monthStart).toISOString();
          const dateTo = new Date(Math.min(new Date(plan.calendar.monthEnd).getTime(), new Date(plan.calendar.todayEnd).getTime())).toISOString();
          for (const team of plan.teams) {
            const definition = await reports.getTeamFunnelDefinition(team.key);
            if (!definition) throw new Error(`Missing canonical ${team.key} funnel`);
            const template = generated.find((item) => item.config.builtinKey === (team.key === 'sales' ? 'sales_funnel_steps' : 'csm_funnel'));
            if (!template) throw new Error(`Missing built-in ${team.key} funnel`);
            const report = await reports.compute(reportDto(template, dateFrom, dateTo), user);
            compareFunnel(team, report, 'factMonth', roleCheck, month);
            if (plan.calendar.isCurrentMonth) {
              const daily = await reports.compute(reportDto(template,
                new Date(plan.calendar.todayStart).toISOString(), new Date(plan.calendar.todayEnd).toISOString()), user);
              compareFunnel(team, daily, 'factToday', roleCheck, `${month}/today`);
            }
          }
          await verifyShipping({ plan, reports, user, dateFrom, dateTo, currentMonth, month, check: roleCheck });
          result.periods.push({ role, month, dateFrom, dateTo, durationMs: Date.now() - start,
            teams: plan.teams.map((team) => ({ team: team.key, managers: team.rows.length,
              facts: Object.fromEntries(Object.entries(team.total.values).map(([key, value]) => [key, value.factMonth])) })) });
        }
        if (months.includes(currentMonth)) {
          const plan = await platform.planFact(user, undefined, currentMonth);
          const dateFrom = new Date(plan.calendar.monthStart).toISOString();
          const dateTo = new Date(plan.calendar.todayEnd).toISOString();
          for (const template of generated.filter((item) => !['sales_funnel_steps', 'csm_funnel'].includes(item.config.builtinKey)
            && item.config.metric !== 'revenue_profit_forecast')) {
            const start = Date.now();
            const report = await reports.compute(reportDto(template, dateFrom, dateTo), user);
            roleCheck(`report/${template.name}/payload`, report && report.type && report.ready !== false ? 1 : 0, 1);
            result.reports.push({ role, name: template.name, type: report.type, durationMs: Date.now() - start });
          }
        }
      }
    }, { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 300_000 });
  } finally {
    await app.close();
  }
  result.status = result.failures.length ? 'failed' : 'passed';
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.failures.length) process.exitCode = 1;
}

async function verifyShipping({ plan, reports, user, dateFrom, dateTo, currentMonth, month, check }) {
  const shipping = await reports.getActualShipping({ dateFrom, dateTo }, user.role);
  const teams = ['sales', 'csm'];
  if (!Array.isArray(shipping.entries)) throw new Error('Unexpected getActualShipping entries contract');
  const shippedIds = shipping.entries.map((entry) => entry.deal.id);
  check(`${month}/shipping/uniqueDeals`, new Set(shippedIds).size, shippedIds.length);
  for (const key of teams) {
    const team = plan.teams.find((item) => item.key === key);
    if (!team) continue;
    const entries = shipping.entries.filter(({ deal }) =>
      (deal.responsible?.group?.id === shipping.csmGroupId) === (key === 'csm'));
    check(`${month}/${key}/shipping/count`, team.total.values[`${key}_shipped_count`].factMonth, entries.length);
    check(`${month}/${key}/shipping/amount`, team.total.values[`${key}_shipped_amount`].factMonth,
      entries.reduce((sum, item) => sum + Number(item.deal.amount ?? 0), 0));
    for (const row of team.rows) {
      const managerEntries = entries.filter(({ deal }) => deal.responsibleId === row.targetId);
      check(`${month}/${key}/${row.targetName}/shipping/count`, row.values[`${key}_shipped_count`].factMonth, managerEntries.length);
      check(`${month}/${key}/${row.targetName}/shipping/amount`, row.values[`${key}_shipped_amount`].factMonth,
        managerEntries.reduce((sum, item) => sum + Number(item.deal.amount ?? 0), 0));
    }
  }
  if (month !== currentMonth) return;
  const forecast = await reports.compute(reportDto(reports.buildRevenueForecastReportTemplate(), dateFrom, dateTo), user);
  check(`${month}/forecast/ready`, forecast.ready ? 1 : 0, 1);
  const combined = plan.teams.reduce((sum, team) => sum + Number(team.total.values[`${team.key}_shipped_amount`].factMonth), 0);
  check(`${month}/forecast/actualRevenue`, combined, forecast.summary?.actualRevenue);
  const actualRows = (forecast.rows || []).filter((row) => ['salesShippedThisMonth', 'repeatShippedThisMonth'].includes(row.id));
  const actualIds = actualRows.flatMap((row) => (row.deals || []).map((deal) => deal.dealId));
  const allIds = (forecast.rows || []).flatMap((row) => (row.deals || []).map((deal) => deal.dealId));
  check(`${month}/forecast/uniqueActual`, new Set(actualIds).size, actualIds.length);
  check(`${month}/forecast/uniqueDeals`, new Set(allIds).size, allIds.length);
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n');
  process.exitCode = 1;
});

module.exports = { sameNumber, stable, comparableConfig, reportDto, compareFunnel };
