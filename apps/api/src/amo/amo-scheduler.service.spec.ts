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
    return new AmoSchedulerService({} as any, {} as any, {} as any) as any;
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
});
