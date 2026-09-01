import { Body, Controller, ForbiddenException, Get, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { PlatformBusinessRole, UserRole } from '../generated/prisma';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SettingsService } from './settings.service';
import { UpdateForecastSettingsDto } from './dto/update-forecast-settings.dto';
import { UpdateRopStageSlaDto } from './dto/update-rop-stage-sla.dto';
import { UpdateStageProbabilityDto } from './dto/update-stage-probability.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('options')
  @UseGuards(JwtAuthGuard)
  getOptions() {
    return this.settings.getOptions();
  }

  @Get('forecast')
  @UseGuards(JwtAuthGuard)
  getForecastSettings() {
    return this.settings.getForecastSettings();
  }

  @Get('rop-stage-sla')
  @UseGuards(JwtAuthGuard)
  getRopStageSlaSettings() {
    return this.settings.getRopStageSlaSettings();
  }

  @Patch('rop-stage-sla')
  @UseGuards(JwtAuthGuard)
  updateRopStageSla(@Request() req: any, @Body() dto: UpdateRopStageSlaDto) {
    const user = req.user;
    const canUpdate =
      user?.role === UserRole.ADMIN ||
      user?.role === UserRole.ROP ||
      user?.businessRole === PlatformBusinessRole.OWNER ||
      user?.businessRole === PlatformBusinessRole.ROP;
    if (!canUpdate) throw new ForbiddenException('Недостаточно прав для настройки SLA этапов');
    return this.settings.updateRopStageSla(dto, req.user.id);
  }

  @Patch('forecast')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateForecastSettings(@Request() req: any, @Body() dto: UpdateForecastSettingsDto) {
    return this.settings.updateForecastSettings(dto, req.user.id);
  }

  @Patch('stage-probability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateStageProbability(@Request() req: any, @Body() dto: UpdateStageProbabilityDto) {
    return this.settings.updateStageProbability(dto, req.user.id);
  }

  @Patch('visibility')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateVisibility(@Request() req: any, @Body() dto: UpdateVisibilityDto) {
    return this.settings.updateVisibility(dto, req.user.id);
  }

  @Get('dashboard-layout')
  @UseGuards(JwtAuthGuard)
  getDashboardLayout(@Request() req: any) {
    return this.settings.getDashboardLayout(req.user.id);
  }

  @Post('dashboard-layout')
  @UseGuards(JwtAuthGuard)
  saveDashboardLayout(@Request() req: any, @Body() body: { config: Record<string, unknown> }) {
    return this.settings.saveDashboardLayout(req.user.id, body.config);
  }
}
