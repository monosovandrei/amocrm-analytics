import { ReportsSchedulerService } from './reports-scheduler.service';

describe('ReportsSchedulerService report cache refresh defaults', () => {
  const originalStaleQueueBatchSize = process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;

  afterEach(() => {
    if (originalStaleQueueBatchSize === undefined) {
      delete process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;
    } else {
      process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = originalStaleQueueBatchSize;
    }
  });

  function service() {
    return new ReportsSchedulerService({} as any) as any;
  }

  it('enables a bounded stale report queue by default', () => {
    delete process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE;

    expect(service().resolveStaleQueueBatchSize()).toBe(3);
  });

  it('allows proactive stale report refresh to be explicitly disabled', () => {
    process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = '0';

    expect(service().resolveStaleQueueBatchSize()).toBe(0);
  });

  it('treats an empty stale queue batch size as unset', () => {
    process.env.REPORT_CACHE_STALE_QUEUE_BATCH_SIZE = '';

    expect(service().resolveStaleQueueBatchSize()).toBe(3);
  });
});
