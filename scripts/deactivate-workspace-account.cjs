'use strict';
const { createRequire } = require('node:module');
const root = process.argv.find(a => a.startsWith('--root='))?.slice(7) || '/opt/analytics';
const id = process.argv.find(a => a.startsWith('--id='))?.slice(5);
const expected = process.argv.find(a => a.startsWith('--expected-name='))?.slice(16);
const load = createRequire(`${root}/apps/api/package.json`);
load('dotenv').config({ path: `${root}/.env`, quiet: true });
const { PrismaClient } = load('./src/generated/prisma');
const p = new PrismaClient();
(async () => {
  if (!id || !expected) throw new Error('An exact account id and expected name are required');
  const result = await p.$transaction(async tx => {
    const account = await tx.user.findUnique({ where: { id }, select: { id: true, name: true, isActive: true } });
    if (!account || account.name !== expected) throw new Error('Account identity does not match; no changes made');
    if (!process.argv.includes('--apply')) return { ...account, applied: false };
    if (account.isActive) {
      await tx.user.update({ where: { id }, data: { isActive: false } });
      await tx.auditLog.create({ data: { action: 'workspace.account.deactivated', entity: 'User', entityId: id,
        metadata: { reason: 'User confirmed employment termination during workspace migration', previousActive: true } } });
    }
    return { id, name: account.name, isActive: false, applied: true };
  });
  console.log(JSON.stringify(result));
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => p.$disconnect());
