import { Global, Module } from '@nestjs/common';
import { WorkspaceAccessService } from './workspace-access.service';
import { CommercialLinksService } from './commercial-links.service';
@Global()
@Module({ providers: [WorkspaceAccessService, CommercialLinksService], exports: [WorkspaceAccessService, CommercialLinksService] })
export class WorkspaceAccessModule {
}
