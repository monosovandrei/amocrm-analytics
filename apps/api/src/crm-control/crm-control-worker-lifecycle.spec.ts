import { installCrmControlWorkerShutdown } from './crm-control-worker-lifecycle';

describe('CRM worker process shutdown', () => {
  function fixture() {
    const listeners = new Map<string, () => void>();
    let exited!: (code: number) => void;
    const exit = new Promise<number>(resolve => { exited = resolve; });
    const signals = { on: jest.fn((event: string, listener: () => void) => { listeners.set(event, listener); }),
      exit: jest.fn((code: number) => { exited(code); }) };
    const application = { close: jest.fn(async (): Promise<void> => undefined) };
    const logger = { log: jest.fn(), error: jest.fn() };
    return { listeners, exit, signals, application, logger };
  }

  it('does not disconnect providers until work has persisted and ignores repeated signals', async () => {
    const f = fixture(); let release!: () => void; let persisted = false;
    const scheduler = { drain: jest.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); persisted = true; }) };
    f.application.close.mockImplementation(async () => { expect(persisted).toBe(true); });
    installCrmControlWorkerShutdown(f.application, scheduler, f.signals, f.logger);
    f.listeners.get('SIGTERM')!(); f.listeners.get('SIGINT')!(); f.listeners.get('SIGTERM')!();
    expect(scheduler.drain).toHaveBeenCalledTimes(1);
    expect(f.application.close).not.toHaveBeenCalled(); expect(f.signals.exit).not.toHaveBeenCalled();
    release(); expect(await f.exit).toBe(0);
    expect(f.application.close).toHaveBeenCalledTimes(1); expect(f.signals.exit).toHaveBeenCalledTimes(1);
  });

  it('waits for browser/database shutdown after queues have drained', async () => {
    const f = fixture(); let releaseClose!: () => void;
    const scheduler = { drain: jest.fn(async () => undefined) };
    f.application.close.mockImplementation(() => new Promise<void>(resolve => { releaseClose = resolve; }));
    installCrmControlWorkerShutdown(f.application, scheduler, f.signals, f.logger);
    f.listeners.get('SIGINT')!(); await Promise.resolve();
    expect(f.application.close).toHaveBeenCalledTimes(1); expect(f.signals.exit).not.toHaveBeenCalled();
    releaseClose(); expect(await f.exit).toBe(0);
  });

  it('reports a failed shutdown without leaking exception contents or claiming a clean exit', async () => {
    const f = fixture(); const scheduler = { drain: jest.fn(async () => undefined) };
    f.application.close.mockRejectedValue(new Error('private connection details'));
    installCrmControlWorkerShutdown(f.application, scheduler, f.signals, f.logger);
    f.listeners.get('SIGTERM')!(); expect(await f.exit).toBe(1);
    expect(f.logger.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('private');
  });
});
