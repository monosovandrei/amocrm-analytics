import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

const MB = 1024 * 1024;

@Injectable()
export class WorkerRuntimeService implements OnModuleInit {
  private readonly logger = new Logger(WorkerRuntimeService.name);
  private readonly role = process.env.WORKER_ROLE || 'all';
  private readonly startedAt = new Date();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.writeHeartbeat(true);
  }

  @Interval(10_000)
  async heartbeat() {
    await this.writeHeartbeat(false);
  }

  private async writeHeartbeat(isStart: boolean) {
    const memory = process.memoryUsage();
    const now = new Date();
    try {
      await this.prisma.workerRuntime.upsert({
        where: { role: this.role },
        create: {
          role: this.role,
          processId: process.pid,
          startedAt: this.startedAt,
          heartbeatAt: now,
          rssMb: Math.round(memory.rss / MB),
          heapUsedMb: Math.round(memory.heapUsed / MB),
        },
        update: {
          processId: process.pid,
          ...(isStart ? { startedAt: this.startedAt } : {}),
          heartbeatAt: now,
          rssMb: Math.round(memory.rss / MB),
          heapUsedMb: Math.round(memory.heapUsed / MB),
        },
      });
    } catch (error: any) {
      this.logger.warn(`Worker heartbeat failed for ${this.role}: ${error.message}`);
    }
  }
}
