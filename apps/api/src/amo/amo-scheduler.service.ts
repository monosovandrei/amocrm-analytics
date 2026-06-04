import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SyncJobType } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import { AmoSyncService } from './amo-sync.service';

@Injectable()
export class AmoSchedulerService {
  private readonly logger = new Logger(AmoSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: AmoSyncService,
  ) {}

  @Interval(60_000)
  async tick() {
    const connection = await this.prisma.amoConnection.findFirst({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
    if (!connection || connection.syncIntervalMinutes <= 0) return;

    const lastSync = connection.lastIncrementalSyncAt ?? connection.lastFullSyncAt;
    const due =
      !lastSync ||
      Date.now() - lastSync.getTime() >= connection.syncIntervalMinutes * 60_000;
    if (!due) return;

    const running = await this.prisma.syncJob.count({
      where: { connectionId: connection.id, status: { in: ['QUEUED', 'RUNNING'] } },
    });
    if (running > 0) return;

    try {
      await this.sync.trigger(SyncJobType.INCREMENTAL);
    } catch (error: any) {
      this.logger.warn(`Scheduled amoCRM sync failed: ${error.message}`);
    }
  }
}
