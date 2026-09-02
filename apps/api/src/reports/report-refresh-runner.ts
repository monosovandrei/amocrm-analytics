import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ReportsModule } from './reports.module';
import { ReportsService } from './reports.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ReportsModule],
})
class ReportRefreshRunnerModule {}

async function sendResult(result: { processed: number }) {
  if (!process.send) return;
  await new Promise<void>((resolve, reject) => {
    process.send!(result, (error) => (error ? reject(error) : resolve()));
  });
}

async function run() {
  const app = await NestFactory.createApplicationContext(ReportRefreshRunnerModule, {
    logger: ['error', 'warn'],
  });
  try {
    const reports = app.get(ReportsService);
    const result = await reports.processReportCacheRefreshJobs(1);
    await sendResult(result);
  } finally {
    await app.close();
    if (process.connected) process.disconnect();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
