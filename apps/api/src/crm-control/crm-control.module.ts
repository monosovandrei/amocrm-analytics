import { Module } from '@nestjs/common';
import { AmoModule } from '../amo/amo.module';
import { CrmControlController } from './crm-control.controller';
import { CrmControlService } from './crm-control.service';
import { CrmControlEvidenceService } from './crm-control-evidence.service';

@Module({
  imports: [AmoModule],
  controllers: [CrmControlController],
  providers: [CrmControlService, CrmControlEvidenceService],
  exports: [CrmControlService],
})
export class CrmControlModule {}
