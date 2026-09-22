import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { CrmControlScheduler } from './crm-control/crm-control.scheduler';
import { installCrmControlWorkerShutdown } from './crm-control/crm-control-worker-lifecycle';

export async function bootstrapWorker(role: string) {
  process.env.WORKER_ROLE = role;
  const logger = new Logger('Worker');
  const application = await NestFactory.createApplicationContext(WorkerModule);
  if (role === 'crm-control') installCrmControlWorkerShutdown(application, application.get(CrmControlScheduler));
  logger.log(`amoCRM analytics ${role} worker started`);
}
