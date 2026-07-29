import { ReportsSchedulerService } from './reports-scheduler.service';

describe('ReportsSchedulerService report cache refresh defaults', () => {
  const originalStaleQueueBatchSize = process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;
  const originalRefreshBatchSize = process.env.REPORT_CACHE_REFRESH_BATCH_SIZE;
  const originalWorkerRole = process.env.WORKER_ROLE;

  afterEach(() => {
    if (originalStaleQueueBatchSize === undefined) {
      delete process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;
    } else {
      process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = originalStaleQueueBatchSize;
    }
    if (originalRefreshBatchSize === undefined) {
      delete process.env.REPORT_CACHE_REFRESH_BATCH_SIZE;
    } else {
      process.env.REPORT_CACHE_REFRESH_BATCH_SIZE = originalRefreshBatchSize;
    }
    if (originalWorkerRole === undefined) {
      delete process.env.WORKER_ROLE;
    } else {
      process.env.WORKER_ROLE = originalWorkerRole;
    }
  });

  function service() {
    return new ReportsSchedulerService({} as any) as any;
  }

  it('disables proactive stale report queueing by default', () => {
    delete process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;

    expect(service().resolveStaleQueueBatchSize()).toBe(0);
  });

  it('allows proactive stale report refresh to be explicitly disabled', () => {
    process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = '0';

    expect(service().resolveStaleQueueBatchSize()).toBe(0);
  });

  it('treats an empty stale queue batch size as unset', () => {
    process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = '';

    expect(service().resolveStaleQueueBatchSize()).toBe(0);
  });

  it('processes a bounded dashboard batch by default', () => {
    delete process.env.REPORT_CACHE_REFRESH_BATCH_SIZE;

    expect(service().resolveRefreshBatchSize()).toBe(4);
  });

  it('does not enqueue stale reports while active refresh jobs are waiting', async () => {
    delete process.env.REPORT_CACHE_REFRESH_BATCH_SIZE;
    process.env.WORKER_ROLE = 'report';
    const reports = {
      processReportCacheRefreshJobs: jest.fn().mockResolvedValue({ processed: 2 }),
      enqueueStaleReportCacheRefreshJobs: jest.fn(),
    };

    await (new ReportsSchedulerService(reports as any) as any).processReportCacheRefreshJobs();

    expect(reports.processReportCacheRefreshJobs).toHaveBeenCalledWith(4);
    expect(reports.enqueueStaleReportCacheRefreshJobs).not.toHaveBeenCalled();
  });

  it('queues stale reports only when the active refresh queue is idle', async () => {
    process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = '3';
    process.env.WORKER_ROLE = 'report';
    const reports = {
      processReportCacheRefreshJobs: jest.fn().mockResolvedValue({ processed: 0 }),
      enqueueStaleReportCacheRefreshJobs: jest.fn().mockResolvedValue({ queued: 3 }),
    };

    await (new ReportsSchedulerService(reports as any) as any).processReportCacheRefreshJobs();

    expect(reports.enqueueStaleReportCacheRefreshJobs).toHaveBeenCalledWith(3);
  });
});
