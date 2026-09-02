import { SyncJobType } from '../generated/prisma';
import { AmoSchedulerService } from './amo-scheduler.service';

describe('AmoSchedulerService worker roles', () => {
  const originalWorkerRole = process.env.WORKER_ROLE;

  afterEach(() => {
    if (originalWorkerRole === undefined) {
      delete process.env.WORKER_ROLE;
    } else {
      process.env.WORKER_ROLE = originalWorkerRole;
    }
  });

  function service() {
    return new AmoSchedulerService({} as any, {} as any, { get: jest.fn() } as any) as any;
  }

  it('keeps realtime sync work on the sync worker only', () => {
    process.env.WORKER_ROLE = 'sync';

    expect(service().pullSyncJobTypesForRole()).toEqual([SyncJobType.INCREMENTAL]);
    expect(service().runsSyncWorker()).toBe(true);
  });

  it('keeps full snapshot work on the bootstrap worker only', () => {
    process.env.WORKER_ROLE = 'bootstrap';

    expect(service().pullSyncJobTypesForRole()).toEqual([SyncJobType.FULL]);
    expect(service().runsSyncWorker()).toBe(false);
  });

  it('does not run lead SLA fallback reconcile unless explicitly configured', () => {
    expect(service().getLeadSlaReconcileIntervalSeconds()).toBe(0);
  });

  it('gives an overdue source reconciliation priority over a scheduled incremental sync', async () => {
    process.env.WORKER_ROLE = 'sync';
    const connection = {
      id: 'connection-1',
      status: 'ACTIVE',
      lastFullSyncAt: new Date(),
      lastPullSyncAt: new Date(Date.now() - 2 * 60_000),
      config: {},
    };
    const prisma = {
      amoConnection: { findFirst: jest.fn().mockResolvedValue(connection) },
      syncJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;
    const sync = {
      expireStaleJobs: jest.fn().mockResolvedValue(undefined),
      trigger: jest.fn().mockResolvedValue(undefined),
    } as any;
    const config = {
      get: jest.fn((key: string) => key === 'AMOCRM_RECENT_RECONCILE_INTERVAL_SECONDS' ? '60' : '1'),
    } as any;
    const scheduler = new AmoSchedulerService(prisma, sync, config);

    await scheduler.tick();

    expect(sync.trigger).not.toHaveBeenCalled();
  });

  it('allows scheduled incremental sync after a recent successful reconciliation', async () => {
    process.env.WORKER_ROLE = 'sync';
    const connection = {
      id: 'connection-1',
      status: 'ACTIVE',
      lastFullSyncAt: new Date(),
      lastPullSyncAt: new Date(Date.now() - 2 * 60_000),
      config: { recentReconcileAt: new Date().toISOString() },
    };
    const prisma = {
      amoConnection: { findFirst: jest.fn().mockResolvedValue(connection) },
      syncJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    } as any;
    const sync = {
      expireStaleJobs: jest.fn().mockResolvedValue(undefined),
      trigger: jest.fn().mockResolvedValue(undefined),
    } as any;
    const config = {
      get: jest.fn((key: string) => key === 'AMOCRM_RECENT_RECONCILE_INTERVAL_SECONDS' ? '60' : '1'),
    } as any;
    const scheduler = new AmoSchedulerService(prisma, sync, config);

    await scheduler.tick();

    expect(sync.trigger).toHaveBeenCalledWith(SyncJobType.INCREMENTAL);
  });
});
