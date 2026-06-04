import { Module } from '@nestjs/common';
import { AmoClientFactory } from './amo-client';
import { AmoController } from './amo.controller';
import { AmoSchedulerService } from './amo-scheduler.service';
import { AmoSyncService } from './amo-sync.service';
import { AmoService } from './amo.service';
import { AmoWebhookController } from './amo-webhook.controller';

@Module({
  controllers: [AmoController, AmoWebhookController],
  providers: [AmoClientFactory, AmoService, AmoSyncService, AmoSchedulerService],
  exports: [AmoService, AmoSyncService],
})
export class AmoModule {}
