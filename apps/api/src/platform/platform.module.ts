import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ReportsModule } from '../reports/reports.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { CrmEventNotificationsService } from './crm-event-notifications.service';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AuditModule, ReportsModule],
  controllers: [PlatformController],
  providers: [PlatformService, TelegramService, CrmEventNotificationsService],
  exports: [PlatformService, TelegramService, CrmEventNotificationsService],
})
export class PlatformModule {}
