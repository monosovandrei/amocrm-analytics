import { Logger } from '@nestjs/common';

export const CRM_CONTROL_WORKER_SHUTDOWN_VERSION = 1;

interface WorkerShutdownSignals {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exit(code: number): unknown;
}

/** Drain durable work before application.close() disconnects Prisma or closes the browser session. */
export function installCrmControlWorkerShutdown(
  application: { close(): Promise<void> }, scheduler: { drain(): Promise<void> },
  signals: WorkerShutdownSignals = process,
  logger: Pick<Logger, 'log' | 'error'> = new Logger('CrmControlWorker'),
) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // drain() synchronously disables new scheduler work before the first await.
    const drained = scheduler.drain();
    logger.log('CRM worker is draining current work');
    void (async () => {
      try {
        await drained;
        await application.close();
        logger.log('CRM worker drained and closed');
        signals.exit(0);
      } catch {
        logger.error('CRM worker shutdown failed; persistent leases remain available for recovery');
        signals.exit(1);
      }
    })();
  };
  signals.on('SIGINT', shutdown);
  signals.on('SIGTERM', shutdown);
}
