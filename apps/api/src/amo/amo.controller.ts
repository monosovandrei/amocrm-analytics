import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { UserRole, SyncJobType } from '../generated/prisma';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AmoService } from './amo.service';
import { AmoSyncService } from './amo-sync.service';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { OAuthUrlDto } from './dto/oauth-url.dto';
import { TriggerSyncDto } from './dto/sync.dto';

@Controller('amo')
export class AmoController {
  constructor(
    private readonly amo: AmoService,
    private readonly sync: AmoSyncService,
  ) {}

  @Get('oauth-url')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  getOAuthUrl(@Query() query: OAuthUrlDto) {
    return this.amo.buildOAuthUrl(query.subdomain);
  }

  @Post('oauth/exchange')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  exchangeOAuth(@Request() req: any, @Body() dto: OAuthExchangeDto) {
    return this.amo.exchangeOAuthCode(dto.subdomain, dto.code, dto.redirectUri, req.user.id);
  }

  @Get('connection')
  @UseGuards(JwtAuthGuard)
  getConnection() {
    return this.amo.getConnection();
  }

  @Post('sync')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  triggerSync(@Request() req: any, @Body() dto: TriggerSyncDto) {
    return this.sync.enqueuePullSync(dto.type ?? SyncJobType.INCREMENTAL, req.user.id);
  }

  @Post('sync/full')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  triggerFullSync(@Request() req: any) {
    return this.sync.enqueuePullSync(SyncJobType.FULL, req.user.id);
  }

  @Post('webhook/register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  registerWebhook(@Request() req: any) {
    return this.sync.registerWebhook(req.user.id);
  }

  @Get('sync/health')
  @UseGuards(JwtAuthGuard)
  getSyncHealth() {
    return this.sync.getHealth();
  }

  @Get('sync-jobs/:id')
  @UseGuards(JwtAuthGuard)
  getSyncJob(@Param('id') id: string) {
    return this.sync.getJob(id);
  }
}
