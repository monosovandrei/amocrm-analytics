import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { UserRole, SyncJobType } from '../generated/prisma';
import { Roles } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AmoService } from './amo.service';
import { AmoSyncService } from './amo-sync.service';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { OAuthUrlDto } from './dto/oauth-url.dto';
import { TriggerSyncDto } from './dto/sync.dto';

@Controller('amo')
@UseGuards(JwtAuthGuard)
export class AmoController {
  constructor(
    private readonly amo: AmoService,
    private readonly sync: AmoSyncService,
  ) {}

  @Get('oauth-url')
  @Roles(UserRole.ADMIN)
  getOAuthUrl(@Query() query: OAuthUrlDto) {
    return this.amo.buildOAuthUrl(query.subdomain);
  }

  @Post('oauth/exchange')
  @Roles(UserRole.ADMIN)
  exchangeOAuth(@Body() dto: OAuthExchangeDto) {
    return this.amo.exchangeOAuthCode(dto.subdomain, dto.code, dto.redirectUri);
  }

  @Get('connection')
  getConnection() {
    return this.amo.getConnection();
  }

  @Post('sync')
  @Roles(UserRole.ADMIN)
  triggerSync(@Body() dto: TriggerSyncDto) {
    return this.sync.trigger(dto.type ?? SyncJobType.INCREMENTAL);
  }

  @Post('sync/full')
  @Roles(UserRole.ADMIN)
  triggerFullSync() {
    return this.sync.trigger(SyncJobType.FULL);
  }

  @Get('sync-jobs/:id')
  getSyncJob(@Param('id') id: string) {
    return this.sync.getJob(id);
  }
}
