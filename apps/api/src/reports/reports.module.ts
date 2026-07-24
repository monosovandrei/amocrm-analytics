import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FactMartsModule } from '../facts/fact-marts.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [AuditModule, FactMartsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
