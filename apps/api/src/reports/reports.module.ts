import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FactMartsModule } from '../facts/fact-marts.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { QualityModule } from '../quality/quality.module';

@Module({
  imports: [AuditModule, FactMartsModule, QualityModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
