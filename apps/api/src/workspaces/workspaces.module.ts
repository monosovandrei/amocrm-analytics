import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { QualityModule } from '../quality/quality.module';
import {WorkspaceLinksAdminController} from './workspace-links-admin.controller';
import { PerformanceService } from './performance.service';
import { DisplayController, PerformanceController, WorkspaceInviteController } from './performance.controller';
import { WorkspaceOnboardingService } from './workspace-onboarding.service';
import { AuthModule } from '../auth/auth.module';
import { RivileSalesService } from './rivile-sales.service';
@Module({ imports: [ReportsModule, QualityModule, AuthModule], controllers: [WorkspacesController,WorkspaceLinksAdminController, PerformanceController, DisplayController, WorkspaceInviteController], providers: [WorkspacesService, PerformanceService, WorkspaceOnboardingService, RivileSalesService] })
export class WorkspacesModule {
}
