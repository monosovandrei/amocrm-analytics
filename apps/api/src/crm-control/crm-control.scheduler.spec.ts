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
});
