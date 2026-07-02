import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { AuthUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformService } from './platform.service';

type AuthRequest = { user: AuthUser };

@Controller('platform')
@UseGuards(JwtAuthGuard)
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  @Get('overview')
  overview(@Req() req: AuthRequest) {
    return this.platform.overview(req.user);
  }

  @Get('telegram/status')
  telegramStatus(@Req() req: AuthRequest) {
    return this.platform.telegramStatus(req.user.id);
  }

  @Get('admin/user-links')
  userLinks(@Req() req: AuthRequest) {
    return this.platform.listUserLinks(req.user);
  }

  @Patch('admin/user-links/:id')
  updateUserLink(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, any>) {
    return this.platform.updateUserLink(req.user, id, body);
  }

  @Get('lead-sla')
  leadSlaCards() {
    return this.platform.leadSlaCards();
  }

  @Get('email-threads/pending')
  pendingEmailThreads(@Req() req: AuthRequest) {
    return this.platform.pendingEmailThreads(req.user);
  }

  @Post('email-threads/dismiss')
  dismissEmailThread(@Req() req: AuthRequest, @Body() body: Record<string, any>) {
    return this.platform.dismissEmailThread(req.user, body);
  }

  @Post('telegram/link-code')
  createTelegramLinkCode(@Req() req: AuthRequest) {
    return this.platform.createTelegramLinkCode(req.user.id);
  }

  @Get('telegram/crm-users')
  crmTelegramLinks(@Req() req: AuthRequest) {
    return this.platform.listCrmTelegramLinks(req.user);
  }

  @Post('telegram/crm-users/:id/link-code')
  createCrmTelegramLinkCode(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.platform.createCrmTelegramLinkCode(req.user, id);
  }

  @Delete('telegram/crm-users/:id/link')
  disconnectCrmTelegram(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.platform.disconnectCrmTelegram(req.user, id);
  }

  @Post('telegram/test')
  sendTelegramTest(@Req() req: AuthRequest) {
    return this.platform.sendTelegramTest(req.user.id);
  }

  @Get('telegram/templates')
  telegramTemplates(@Req() req: AuthRequest) {
    return this.platform.listTelegramTemplates(req.user);
  }

  @Patch('telegram/templates/:eventType')
  updateTelegramTemplate(@Req() req: AuthRequest, @Param('eventType') eventType: string, @Body() body: Record<string, any>) {
    return this.platform.updateTelegramTemplate(req.user, eventType, body);
  }

  @Get('alerts')
  listAlerts(@Req() req: AuthRequest) {
    return this.platform.listAlerts(req.user);
  }

  @Post('alerts')
  createAlert(@Req() req: AuthRequest, @Body() body: Record<string, any>) {
    return this.platform.createAlert(req.user, body);
  }

  @Patch('alerts/:id')
  updateAlert(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, any>) {
    return this.platform.updateAlert(req.user, id, body);
  }

  @Delete('alerts/:id')
  deleteAlert(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.platform.deleteAlert(req.user, id);
  }

  @Post('alerts/run')
  runAlerts(@Req() req: AuthRequest) {
    return this.platform.runAlertChecks(req.user);
  }

  @Get('plans/sets')
  listPlanSets() {
    return this.platform.listPlanSets();
  }

  @Post('plans/sets')
  createPlanSet(@Req() req: AuthRequest, @Body() body: Record<string, any>) {
    return this.platform.createPlanSet(req.user.id, body);
  }

  @Patch('plans/sets/:id')
  updatePlanSet(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.platform.updatePlanSet(id, body);
  }

  @Get('plans/items')
  listPlanItems(@Query('planSetId') planSetId?: string) {
    return this.platform.listPlanItems(planSetId);
  }

  @Post('plans/items')
  createPlanItem(@Body() body: Record<string, any>) {
    return this.platform.createPlanItem(body);
  }

  @Delete('plans/items/:id')
  deletePlanItem(@Param('id') id: string) {
    return this.platform.deletePlanItem(id);
  }

  @Get('plans/template.csv')
  planTemplate() {
    const csv = this.platform.planTemplateCsv();
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="plan-template.csv"',
    });
  }

  @Get('plans/fact')
  planFact(@Req() req: AuthRequest, @Query('planSetId') planSetId?: string, @Query('month') month?: string) {
    return this.platform.planFact(req.user, planSetId, month);
  }

  @Patch('plans/fact')
  updatePlanFact(@Req() req: AuthRequest, @Body() body: Record<string, any>) {
    return this.platform.updatePlanFact(req.user, body);
  }

  @Get('quality/rules')
  qualityRules() {
    return this.platform.listQualityRules();
  }

  @Patch('quality/rules/:id')
  updateQualityRule(@Param('id') id: string, @Body() body: Record<string, any>) {
    return this.platform.updateQualityRule(id, body);
  }

  @Post('quality/run')
  runQuality() {
    return this.platform.runQualityChecks();
  }

  @Get('quality/violations')
  qualityViolations(@Query('resolved') resolved?: string) {
    return this.platform.listQualityViolations(resolved === 'true');
  }

  @Get('schedules')
  listSchedules(@Req() req: AuthRequest) {
    return this.platform.listSchedules(req.user);
  }

  @Post('schedules')
  createSchedule(@Req() req: AuthRequest, @Body() body: Record<string, any>) {
    return this.platform.createSchedule(req.user, body);
  }

  @Patch('schedules/:id')
  updateSchedule(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: Record<string, any>) {
    return this.platform.updateSchedule(req.user, id, body);
  }

  @Delete('schedules/:id')
  deleteSchedule(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.platform.deleteSchedule(req.user, id);
  }

  @Post('schedules/:id/run')
  runSchedule(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.platform.runScheduleNow(req.user, id);
  }
}
