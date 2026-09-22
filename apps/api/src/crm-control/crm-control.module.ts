import { Module } from '@nestjs/common';
import { AmoModule } from '../amo/amo.module';
import { CrmControlController } from './crm-control.controller';
import { CrmControlService } from './crm-control.service';
import { CrmControlEvidenceService } from './crm-control-evidence.service';
import { CrmControlAnalysisService } from './crm-control-analysis.service';
import { CrmControlAnalysisBatchService } from './crm-control-analysis-batch.service';
import { CrmControlBrowserSourceService } from './crm-control-browser-source.service';
import { CrmControlDocumentAnalysisService } from './crm-control-document-analysis.service';

@Module({
  imports: [AmoModule],
  controllers: [CrmControlController],
  providers: [CrmControlService, CrmControlEvidenceService, CrmControlAnalysisService, CrmControlAnalysisBatchService, CrmControlBrowserSourceService, CrmControlDocumentAnalysisService],
  exports: [CrmControlService, CrmControlAnalysisService, CrmControlAnalysisBatchService],
})
export class CrmControlModule {}
