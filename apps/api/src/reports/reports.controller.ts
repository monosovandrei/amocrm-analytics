import { Body, Controller, Delete, Get, Param, Post, Request, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { ReportQueryDto, ReportSnapshotsDto, SaveReportTemplateDto } from './dto/report-query.dto';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('compute')
  compute(@Body() dto: ReportQueryDto, @Request() req: any) {
    return this.reports.compute(dto, req.user);
  }

  @Post('snapshots')
  snapshots(@Body() dto: ReportSnapshotsDto, @Request() req: any) {
    return this.reports.snapshots(dto.reports ?? [], req.user);
  }

  @Get('templates')
  listTemplates(@Request() req: any) {
    return this.reports.listTemplates(req.user);
  }

  @Post('templates')
  saveTemplate(@Body() dto: SaveReportTemplateDto, @Request() req: any) {
    return this.reports.saveTemplate(dto, req.user.id);
  }

  @Delete('templates/:id')
  deleteTemplate(@Param('id') id: string, @Request() req: any) {
    return this.reports.deleteTemplate(id, req.user);
  }

  @Post('export.xlsx')
  async exportExcel(@Body() dto: ReportQueryDto, @Request() req: any) {
    return this.reports.enqueueExport(dto, req.user);
  }

  @Get('export-jobs/:id')
  exportJob(@Param('id') id: string, @Request() req: any) {
    return this.reports.getExportJob(id, req.user);
  }

  @Get('export-jobs/:id/download')
  async downloadExport(@Param('id') id: string, @Request() req: any) {
    const file = await this.reports.getExportFile(id, req.user);
    return new StreamableFile(file.stream, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${encodeURIComponent(file.fileName)}"`,
    });
  }
}
