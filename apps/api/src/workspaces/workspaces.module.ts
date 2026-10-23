import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { QualityModule } from '../quality/quality.module';
import {WorkspaceLinksAdminController} from './workspace-links-admin.controller';
@Module({ imports: [ReportsModule, QualityModule], controllers: [WorkspacesController,WorkspaceLinksAdminController], providers: [WorkspacesService] })
export class WorkspacesModule {
}
