import { Body, Controller, Get, Param, Patch, Post, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspacesService } from './workspaces.service';
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
    constructor(private readonly workspaces: WorkspacesService) { }
    @Get('session')
    session(
    @Req()
    req: any) { return this.workspaces.session(req.user.id); }
    @Get('reports/:key')
    report(
    @Req()
    req: any, 
    @Param('key')
    key: string, 
    @Query()
    query: Record<string, string>) { return this.workspaces.report(req.user.id, key, query); }
    @Get('plans')
    plans(
    @Req()
    req: any, 
    @Query()
    query: Record<string, string>) { return this.workspaces.plans(req.user.id, query); }
    @Patch('plans')
    savePlan(
    @Req()
    req: any, 
    @Body()
    body: Record<string, any>) { return this.workspaces.savePlan(req.user.id, body); }
    @Get('deals')
    deals(
    @Req()
    req: any, 
    @Query()
    query: Record<string, string>) { return this.workspaces.deals(req.user.id, query); }
    @Post('reports/:key/export')
    exportReport(
    @Req()
    req: any, 
    @Param('key')
    key: string, 
    @Query()
    query: Record<string, string>) { return this.workspaces.exportReport(req.user.id, key, query); }
    @Get('exports/:id')
    exportJob(
    @Req()
    req: any, 
    @Param('id')
    id: string) { return this.workspaces.exportJob(req.user.id, id); }
    @Get('exports/:id/download')
    async download(
    @Req()
    req: any, 
    @Param('id')
    id: string) { const file = await this.workspaces.exportJob(req.user.id, id, true) as any; return new StreamableFile(file.stream, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', disposition: 'attachment; filename="report.xlsx"' }); }
    @Get('admin/access')
    settings(
    @Req()
    req: any) { return this.workspaces.adminSettings(req.user.id); }
    @Patch('admin/access/:id')
    updateAccount(
    @Req()
    req: any, 
    @Param('id')
    id: string, 
    @Body()
    body: Record<string, any>) { return this.workspaces.updateAccount(req.user.id, id, body); }
    @Post('admin/access')
    createAccount(
    @Req()
    req: any, 
    @Body()
    body: Record<string, any>) { return this.workspaces.createAccount(req.user.id, body); }
    @Patch('admin/stage-rule')
    updateStageRule(
    @Req()
    req: any, 
    @Body()
    body: Record<string, any>) { return this.workspaces.updateStageRule(req.user.id, body); }
}
