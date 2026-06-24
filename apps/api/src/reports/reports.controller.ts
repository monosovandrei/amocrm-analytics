import { Body, Controller, Delete, Get, Header, Param, Post, Request, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { ReportQueryDto, SaveReportTemplateDto } from './dto/report-query.dto';

@Controller('reports')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post('compute')
  compute(@Body() dto: ReportQueryDto, @Request() req: any) {
    return this.reports.compute(dto, req.user);
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
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportExcel(@Body() dto: ReportQueryDto, @Request() req: any) {
    const buffer = await this.reports.exportExcel(dto, req.user);
    return new StreamableFile(buffer, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="${encodeURIComponent(dto.name)}.xlsx"`,
    });
  }
}
