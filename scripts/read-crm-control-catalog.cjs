#!/usr/bin/env node
'use strict';

// Read-only production catalog export. Does not refresh OAuth credentials or write to the database.
// Run on the existing server: node /path/to/read-crm-control-catalog.cjs /opt/analytics
const fs = require('node:fs');
const path = require('node:path');

class CatalogError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function main() {
  const root = path.resolve(process.argv[2] || '/opt/analytics');
  const dotenv = require(path.join(root, 'node_modules/dotenv'));
  const parsed = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  const env = { ...process.env, ...parsed };
  if (!env.DATABASE_URL || !env.CREDENTIALS_ENCRYPTION_KEY) throw new CatalogError('SERVER_CONFIGURATION_UNAVAILABLE');

  const { PrismaClient } = require(path.join(root, 'apps/api/dist/generated/prisma'));
  const { decryptJson } = require(path.join(root, 'apps/api/dist/common/crypto.util'));
  const prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } }, log: [] });
  let connection;
  let localPipelines;
  try {
    ({ connection, localPipelines } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return {
        connection: await tx.amoConnection.findFirst({
          where: { status: { in: ['ACTIVE', 'SYNCING', 'ERROR'] } }, orderBy: { createdAt: 'desc' },
          select: { subdomain: true, accountId: true, credentials: true },
        }),
        localPipelines: await tx.pipeline.findMany({ select: { id: true, externalId: true,
          stages: { select: { id: true, externalId: true } } } }),
      };
    }));
  } finally { await prisma.$disconnect(); }
  if (!connection) throw new CatalogError('AMO_CONNECTION_UNAVAILABLE');

  const domain = String(connection.subdomain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9-]+\.(?:amocrm\.(?:ru|com)|kommo\.com)$/i.test(domain)) throw new CatalogError('UNEXPECTED_AMO_DOMAIN');
  const credentials = decryptJson(connection.credentials, env.CREDENTIALS_ENCRYPTION_KEY);
  if (!credentials || typeof credentials.accessToken !== 'string') throw new CatalogError('TOKEN_UNAVAILABLE');
  const get = async (apiPath, params = {}) => {
    const url = new URL(`/api/v4${apiPath}`, `https://${domain}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: 'GET', headers: { Authorization: `Bearer ${credentials.accessToken}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (response.status === 401) throw new CatalogError('TOKEN_EXPIRED_WAIT_FOR_NORMAL_SYNC');
    if (!response.ok) throw new CatalogError(`AMO_CATALOG_HTTP_${response.status}`);
    return response.json();
  };

  const account = await get('/account', { with: 'task_types,datetime_settings' });
  if (connection.accountId && String(account.id) !== String(connection.accountId)) throw new CatalogError('AMO_ACCOUNT_MISMATCH');
  const allPipelines = [];
  for (let page = 1; ; page += 1) {
    const response = await get('/leads/pipelines', { page, limit: 250 });
    const rows = response?._embedded?.pipelines;
    if (!Array.isArray(rows)) throw new CatalogError('PIPELINES_RESPONSE_INCOMPLETE');
    allPipelines.push(...rows);
    if (!response?._links?.next?.href) break;
  }
  const taskRows = account?._embedded?.task_types;
  if (!Array.isArray(taskRows)) throw new CatalogError('TASK_TYPES_RESPONSE_INCOMPLETE');

  const pipelines = [...new Map(allPipelines.map((item) => [String(item.id), item])).values()]
    .sort((a, b) => Number(a.sort) - Number(b.sort) || Number(a.id) - Number(b.id))
    .map((pipeline, pipelineIndex) => {
      const local = localPipelines.find((item) => item.externalId === String(pipeline.id));
      if (!Array.isArray(pipeline?._embedded?.statuses)) throw new CatalogError('STAGES_RESPONSE_INCOMPLETE');
      return {
        number: pipelineIndex + 1, id: String(pipeline.id), platformId: local?.id ?? null,
        name: String(pipeline.name), order: Number(pipeline.sort), archived: Boolean(pipeline.is_archive),
        main: Boolean(pipeline.is_main), unsortedEnabled: Boolean(pipeline.is_unsorted_on),
        stages: [...pipeline._embedded.statuses]
          .sort((a, b) => Number(a.sort) - Number(b.sort) || Number(a.id) - Number(b.id))
          .map((stage, stageIndex) => ({
            number: stageIndex + 1, id: String(stage.id),
            platformId: local?.stages.find((item) => item.externalId === String(stage.id))?.id ?? null,
            name: String(stage.name), order: Number(stage.sort),
            unsorted: Number(stage.type) === 1,
            won: String(stage.id) === '142', lost: String(stage.id) === '143',
            terminal: String(stage.id) === '142' || String(stage.id) === '143',
          })),
      };
    });
  const taskTypes = taskRows.map((task, index) => ({ number: index + 1, id: Number(task.id), name: String(task.name),
    code: task.code == null ? null : String(task.code), order: index + 1 }));
  process.stdout.write(JSON.stringify({ source: 'amoCRM API', fetchedAt: new Date().toISOString(),
    account: { id: String(account.id), name: String(account.name), domain, timeZone: account?._embedded?.datetime_settings?.timezone ?? null },
    pipelines, taskTypes }, null, 2) + '\n');
}

main().catch((error) => {
  // Never print stack traces, response bodies, credentials, or connection URLs.
  process.stderr.write(JSON.stringify({ error: error instanceof CatalogError ? error.code : 'CATALOG_READ_FAILED' }) + '\n');
  process.exitCode = 1;
});
