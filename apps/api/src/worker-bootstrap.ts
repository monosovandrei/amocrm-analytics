import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

export async function bootstrapWorker(role: string) {
  process.env.WORKER_ROLE = role;
  const logger = new Logger('Worker');
  await NestFactory.createApplicationContext(WorkerModule);
  logger.log(`amoCRM analytics ${role} worker started`);
}
