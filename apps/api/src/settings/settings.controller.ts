import { Body, Controller, Get, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { UserRole } from '../generated/prisma';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { SettingsService } from './settings.service';
import { UpdateForecastSettingsDto } from './dto/update-forecast-settings.dto';
import { UpdateStageProbabilityDto } from './dto/update-stage-probability.dto';
import { UpdateVisibilityDto } from './dto/update-visibility.dto';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('options')
  getOptions() {
    return this.settings.getOptions();
  }

  @Get('forecast')
  getForecastSettings() {
    return this.settings.getForecastSettings();
  }

  @Patch('forecast')
  @Roles(UserRole.ADMIN)
  updateForecastSettings(@Body() dto: UpdateForecastSettingsDto) {
    return this.settings.updateForecastSettings(dto);
  }

  @Patch('stage-probability')
  @Roles(UserRole.ADMIN)
  updateStageProbability(@Body() dto: UpdateStageProbabilityDto) {
    return this.settings.updateStageProbability(dto);
  }

  @Patch('visibility')
  @Roles(UserRole.ADMIN)
  updateVisibility(@Body() dto: UpdateVisibilityDto) {
    return this.settings.updateVisibility(dto);
  }

  @Get('dashboard-layout')
  getDashboardLayout(@Request() req: any) {
    return this.settings.getDashboardLayout(req.user.id);
  }

  @Post('dashboard-layout')
  saveDashboardLayout(@Request() req: any, @Body() body: { config: Record<string, unknown> }) {
    return this.settings.saveDashboardLayout(req.user.id, body.config);
  }
}
