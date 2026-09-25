#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

function checkTimezone() {
  const load = createRequire(path.join(__dirname, '..', 'apps', 'api', 'package.json'));
  load('ts-node').register({
    transpileOnly: true,
    skipProject: true,
    compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022' },
  });
  const { moscowPresetPeriod, moscowPresetDateInputs } = require('../apps/web/src/report-period.ts');
  const { buildQueryFromTemplate } = require('../apps/web/src/report-utils.ts');
  const RealDate = Date;
  const instant = '2026-08-31T22:30:00.000Z';
  const expected = {
    today: ['2026-08-31T21:00:00.000Z', '2026-09-01T20:59:59.999Z'],
    yesterday: ['2026-08-30T21:00:00.000Z', '2026-08-31T20:59:59.999Z'],
    this_week: ['2026-08-30T21:00:00.000Z', '2026-09-01T20:59:59.999Z'],
    last_week: ['2026-08-23T21:00:00.000Z', '2026-08-30T20:59:59.999Z'],
    this_month: ['2026-08-31T21:00:00.000Z', '2026-09-01T20:59:59.999Z'],
    last_month: ['2026-07-31T21:00:00.000Z', '2026-08-31T20:59:59.999Z'],
  };
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return RealDate.parse(instant); }
  };
  try {
    const template = { name: 'Sales', sourceType: 'EVENT', config: { filters: { pipelineIds: ['sales'] } } };
    for (const [preset, bounds] of Object.entries(expected)) {
      const { from, to } = moscowPresetPeriod(preset);
      assert.deepEqual([from.toISOString(), to.toISOString()], bounds, `${process.env.TZ}/${preset}`);
      const query = buildQueryFromTemplate(template, { periodMode: 'preset', periodPreset: preset });
      assert.deepEqual([query.filters.dateFrom, query.filters.dateTo], bounds);
      assert.deepEqual(query.filters.pipelineIds, ['sales']);
    }
    assert.deepEqual(moscowPresetDateInputs('this_month'), { dateFrom: '2026-09-01', dateTo: '2026-09-01' });
    assert.deepEqual(moscowPresetDateInputs('last_week'), { dateFrom: '2026-08-24', dateTo: '2026-08-30' });
    const custom = { periodMode: 'custom', dateFrom: '2026-08-01T08:15:00Z', dateTo: '2026-08-02T13:30:00Z' };
    const query = buildQueryFromTemplate(template, custom);
    assert.deepEqual([query.filters.dateFrom, query.filters.dateTo], [custom.dateFrom, custom.dateTo]);
    for (const [now, preset, bounds] of [
      ['2026-12-31T22:30:00Z', 'last_month', ['2026-11-30T21:00:00.000Z', '2026-12-31T20:59:59.999Z']],
      ['2024-02-29T22:30:00Z', 'last_month', ['2024-01-31T21:00:00.000Z', '2024-02-29T20:59:59.999Z']],
      ['2026-09-27T12:00:00Z', 'this_week', ['2026-09-20T21:00:00.000Z', '2026-09-27T20:59:59.999Z']],
    ]) {
      const { from, to } = moscowPresetPeriod(preset, new RealDate(now));
      assert.deepEqual([from.toISOString(), to.toISOString()], bounds);
    }
    process.stdout.write(JSON.stringify({ timezone: process.env.TZ, offsetMinutes: new RealDate(instant).getTimezoneOffset(), status: 'passed' }) + '\n');
  } finally {
    global.Date = RealDate;
  }
}

function main() {
  if (process.argv.includes('--zone-check')) return checkTimezone();
  const zones = { UTC: 0, 'Europe/Moscow': -180, 'Europe/Lisbon': -60, 'America/Los_Angeles': 420, 'Asia/Tokyo': -540 };
  const results = [];
  for (const [timezone, offset] of Object.entries(zones)) {
    const child = spawnSync(process.execPath, [__filename, '--zone-check'], {
      encoding: 'utf8', env: { ...process.env, TZ: timezone }, timeout: 20_000,
    });
    assert.equal(child.status, 0, child.stderr || String(child.error || 'Timezone child failed'));
    const result = JSON.parse(child.stdout);
    assert.equal(result.offsetMinutes, offset, `Timezone was not applied: ${timezone}`);
    results.push(result);
  }
  process.stdout.write(JSON.stringify({ status: 'passed', results }) + '\n');
}

main();
