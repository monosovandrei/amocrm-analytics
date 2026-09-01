import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FactMartsModule } from '../facts/fact-marts.module';
import { ReportsModule } from '../reports/reports.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';
import { CrmEventNotificationsService } from './crm-event-notifications.service';
import { TelegramService } from './telegram.service';
import { QualityModule } from '../quality/quality.module';
import { QualityNotificationController } from './quality-notification.controller';

@Module({
  imports: [AuditModule, FactMartsModule, ReportsModule, QualityModule],
  controllers: [PlatformController, QualityNotificationController],
  providers: [PlatformService, TelegramService, CrmEventNotificationsService],
  exports: [PlatformService, TelegramService, CrmEventNotificationsService],
})
export class PlatformModule {}
