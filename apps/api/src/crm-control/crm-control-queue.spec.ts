import { AmoRequestError } from '../amo/amo-client';
import { CrmControlService } from './crm-control.service';
import { CRM_CONTROL_RULE_VERSION } from './crm-control.rules';
import { DEFAULT_CRM_CONTROL_CONFIG } from './crm-control.types';

describe('CRM control persistent attempt recovery', () => {
  const now = new Date('2026-09-22T16:05:00Z');
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(now); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  function fixture(overrides: Record<string, unknown> = {}) {
    const run: any = { id: 'run', status: 'QUEUED', activeKey: null, startedAt: null, heartbeatAt: null, sourceSyncAt: null,
      scheduledFor: now, counts: {}, config: { ...DEFAULT_CRM_CONTROL_CONFIG }, ruleVersion: CRM_CONTROL_RULE_VERSION, ...overrides };
    const matches = (where: any) => Object.entries(where).every(([key, value]) => value instanceof Date
      ? run[key]?.getTime() === value.getTime() : run[key] === value);
    const prisma = { crmControlRun: {
      findMany: jest.fn(async () => run.status === 'RUNNING' && run.heartbeatAt?.getTime() < now.getTime() - 30 * 60_000 ? [{ ...run }] : []),
      count: jest.fn(async () => Number(run.activeKey === 'global')),
      findFirst: jest.fn(async () => run.status === 'QUEUED' ? { ...run } : null),
      updateMany: jest.fn(async ({ where, data }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(run, data); return { count: 1 };
      }),
    } };
    const service = new CrmControlService(prisma as any, {} as any, {} as any);
    const execute = jest.spyOn(service as any, 'executeRun').mockResolvedValue(undefined);
    return { run, prisma, service, execute };
  }

  it('reclaims an expired same-day attempt with a new fencing timestamp', async () => {
    const old = new Date(now.getTime() - 31 * 60_000);
    const f = fixture({ status: 'RUNNING', activeKey: 'global', startedAt: old, heartbeatAt: old, counts: { deals: 15, executionAttempts: 1 }, sourceSyncAt: old });
    await f.service.processQueue();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0][0]).toMatchObject({ startedAt: now, sourceSyncAt: old, counts: { deals: 15, executionAttempts: 2 } });
    expect(f.prisma.crmControlRun.updateMany.mock.calls[0][0].where).toMatchObject({ startedAt: old, heartbeatAt: old });
  });

  it.each(['day', 'version', 'attempts'])('refuses to resume after a changed %s', async (condition) => {
    const old = new Date(now.getTime() - 31 * 60_000);
    const f = fixture({ status: 'RUNNING', activeKey: 'global', startedAt: old, heartbeatAt: old,
      scheduledFor: condition === 'day' ? new Date(now.getTime() - 86400_000) : now,
      ruleVersion: condition === 'version' ? 'previous' : CRM_CONTROL_RULE_VERSION,
      counts: { executionAttempts: condition === 'attempts' ? 3 : 1 } });
    await f.service.processQueue();
    expect(f.run.status).toBe('ERROR');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('bounds automatic retry of a transient source-list failure to three attempts', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new AmoRequestError('source unavailable', true));
    await f.service.processQueue(); expect(f.run.status).toBe('QUEUED');
    await f.service.processQueue(); expect(f.run.status).toBe('QUEUED');
    await f.service.processQueue(); expect(f.run.status).toBe('ERROR');
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(f.run.counts.executionAttempts).toBe(3);
    const starts = f.execute.mock.calls.map(([run]) => (run as { startedAt: Date }).startedAt.getTime());
    expect(new Set(starts).size).toBe(3);
  });

  it('does not automatically retry a permanent permissions error', async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new AmoRequestError('denied', false, 403));
    await f.service.processQueue();
    expect(f.run.status).toBe('ERROR');
    expect(f.run.counts.executionAttempts).toBe(1);
  });

  it('does not let an old catch handler finalize a reclaimed run', async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      f.run.startedAt = new Date(now.getTime() + 1);
      f.run.counts = { executionAttempts: 2 };
      throw new AmoRequestError('old attempt failed', true);
    });
    await f.service.processQueue();
    expect(f.run.status).toBe('RUNNING');
    expect(f.run.activeKey).toBe('global');
    expect(f.run.counts.executionAttempts).toBe(2);
  });

  it('does not reclaim a lease whose heartbeat changed after it was selected', async () => {
    const old = new Date(now.getTime() - 31 * 60_000);
    const f = fixture({ status: 'RUNNING', activeKey: 'global', startedAt: old, heartbeatAt: old });
    f.prisma.crmControlRun.findMany.mockImplementation(async () => {
      const stale = { ...f.run };
      f.run.heartbeatAt = now;
      return [stale];
    });
    await f.service.processQueue();
    expect(f.run.status).toBe('RUNNING');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('counts an already started legacy run as the first attempt', async () => {
    const old = new Date(now.getTime() - 31 * 60_000);
    const f = fixture({ status: 'RUNNING', activeKey: 'global', startedAt: old, heartbeatAt: old });
    await f.service.processQueue();
    expect(f.execute.mock.calls[0][0]).toMatchObject({ counts: { executionAttempts: 2 } });
  });

  it('does not claim an obsolete queued row after another attempt already ran and requeued it', async () => {
    const f = fixture();
    f.prisma.crmControlRun.findFirst.mockImplementation(async () => {
      const selected = { ...f.run };
      f.run.startedAt = new Date(now.getTime() + 1);
      f.run.counts = { executionAttempts: 1 };
      return selected;
    });
    await f.service.processQueue();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.run.status).toBe('QUEUED');
    expect(f.run.counts.executionAttempts).toBe(1);
  });
});
