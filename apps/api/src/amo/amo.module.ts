import { Module } from '@nestjs/common';
import { AmoClientFactory } from './amo-client';
import { AmoController } from './amo.controller';
import { AmoSyncService } from './amo-sync.service';
import { AmoService } from './amo.service';
import { AmoWebhookController } from './amo-webhook.controller';
import { AuditModule } from '../audit/audit.module';
import { FactMartsModule } from '../facts/fact-marts.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [AuditModule, FactMartsModule, PlatformModule],
  controllers: [AmoController, AmoWebhookController],
  providers: [AmoClientFactory, AmoService, AmoSyncService],
  exports: [AmoService, AmoSyncService],
})
export class AmoModule {}
