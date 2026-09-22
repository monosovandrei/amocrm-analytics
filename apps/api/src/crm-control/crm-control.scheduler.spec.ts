import { CrmControlScheduler } from './crm-control.scheduler';

describe('CRM control dedicated worker', () => {
  const originalRole = process.env.WORKER_ROLE;
  afterEach(() => { if (originalRole === undefined) delete process.env.WORKER_ROLE; else process.env.WORKER_ROLE = originalRole; });

  const fixture = () => {
    const service = { schedule: jest.fn(), processQueue: jest.fn(), processEvidenceQueue: jest.fn() };
    const analysis = { processQueue: jest.fn() };
    return { service, analysis, scheduler: new CrmControlScheduler(service as any, analysis as any) };
  };
  it('keeps both audit and screenshot work out of the notification worker', async () => {
    process.env.WORKER_ROLE = 'notification';
    const f = fixture();
    await f.scheduler.check(); await f.scheduler.capture(); await f.scheduler.analyze();
    expect(f.service.schedule).not.toHaveBeenCalled();
    expect(f.service.processQueue).not.toHaveBeenCalled();
    expect(f.service.processEvidenceQueue).not.toHaveBeenCalled();
    expect(f.analysis.processQueue).not.toHaveBeenCalled();
  });
  it.each(['all', 'crm-control'])('runs persistent queues on the %s worker', async (role) => {
    process.env.WORKER_ROLE = role;
    const f = fixture();
    await f.scheduler.check(); await f.scheduler.capture(); await f.scheduler.analyze();
    expect(f.service.schedule).toHaveBeenCalledTimes(1);
    expect(f.service.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.processEvidenceQueue).toHaveBeenCalledTimes(1);
    expect(f.analysis.processQueue).toHaveBeenCalledTimes(1);
  });
  it('continues collecting queued evidence while an audit is still running', async () => {
    process.env.WORKER_ROLE = 'crm-control';
    const f = fixture();
    let finish!: () => void;
    f.service.processQueue.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const running = f.scheduler.check();
    await Promise.resolve();
    await f.scheduler.check(); await f.scheduler.capture(); await f.scheduler.analyze();
    expect(f.service.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.processEvidenceQueue).toHaveBeenCalledTimes(1);
    expect(f.analysis.processQueue).toHaveBeenCalledTimes(1);
    finish(); await running;
  });
  it('keeps audit and evidence ticks independent while local analysis is running', async () => {
    process.env.WORKER_ROLE = 'crm-control';
    const f = fixture();
    let finish!: () => void;
    f.analysis.processQueue.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const running = f.scheduler.analyze();
    await f.scheduler.analyze(); await f.scheduler.check(); await f.scheduler.capture();
    expect(f.analysis.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.processEvidenceQueue).toHaveBeenCalledTimes(1);
    finish(); await running;
  });

  it('drains analysis persistence, capture and batch work and refuses new ticks', async () => {
    process.env.WORKER_ROLE = 'crm-control';
    const f = fixture();
    let finishAnalysis!: () => void, finishCapture!: () => void, finishBatch!: () => void;
    let persisted = false, drained = false;
    f.analysis.processQueue.mockImplementation(async () => {
      await new Promise<void>(resolve => { finishAnalysis = resolve; }); persisted = true;
    });
    f.service.processEvidenceQueue.mockImplementation(() => new Promise<void>(resolve => { finishCapture = resolve; }));
    const batches = { processQueue: jest.fn(() => new Promise<void>(resolve => { finishBatch = resolve; })) };
    const scheduler = new CrmControlScheduler(f.service as any, f.analysis as any, batches as any);
    const work = [scheduler.analyze(), scheduler.capture(), scheduler.enqueueAnalysis()];
    const drain = scheduler.drain();
    expect(scheduler.drain()).toBe(drain);
    void drain.then(() => { drained = true; });
    await scheduler.analyze(); await scheduler.capture(); await scheduler.enqueueAnalysis(); await scheduler.check();
    expect(f.analysis.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.processEvidenceQueue).toHaveBeenCalledTimes(1);
    expect(batches.processQueue).toHaveBeenCalledTimes(1);
    expect(f.service.schedule).not.toHaveBeenCalled();
    finishAnalysis(); await work[0];
    expect(persisted).toBe(true); expect(drained).toBe(false);
    finishCapture(); await work[1]; expect(drained).toBe(false);
    finishBatch(); await Promise.all(work); await drain;
    expect(drained).toBe(true);
  });

  it('does not claim a new full audit when stopping during scheduling', async () => {
    process.env.WORKER_ROLE = 'crm-control';
    const f = fixture(); let finish!: () => void;
    f.service.schedule.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const checking = f.scheduler.check(); const drain = f.scheduler.drain();
    finish(); await checking; await drain;
    expect(f.service.processQueue).not.toHaveBeenCalled();
  });

  it('can finish draining after a failed active queue without starting replacement work', async () => {
    process.env.WORKER_ROLE = 'crm-control';
    const f = fixture(); let reject!: (reason: Error) => void;
    f.analysis.processQueue.mockImplementation(() => new Promise<void>((_, failure) => { reject = failure; }));
    const running = f.scheduler.analyze(); const drain = f.scheduler.drain();
    reject(new Error('private diagnostic details'));
    await running; await expect(drain).resolves.toBeUndefined();
    await f.scheduler.analyze(); expect(f.analysis.processQueue).toHaveBeenCalledTimes(1);
  });
});
