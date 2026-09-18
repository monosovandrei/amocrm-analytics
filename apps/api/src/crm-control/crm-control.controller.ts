import { Body, Controller, Get, Header, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { CrmControlService } from './crm-control.service';
import { CrmControlDecisionInput } from './crm-control.types';

@Controller('crm-control')
@UseGuards(JwtAuthGuard)
export class CrmControlController {
  constructor(private readonly service: CrmControlService) {}

  @Get('settings') settings(@Req() request: { user: AuthUser }) { return this.service.settings(request.user); }
  @Put('settings') saveSettings(@Req() request: { user: AuthUser }, @Body() body: unknown) { return this.service.saveSettings(request.user, body); }
  @Get('runs') runs(@Req() request: { user: AuthUser }, @Query('cursor') cursor?: string) { return this.service.runs(request.user, cursor); }
  @Post('runs') enqueue(@Req() request: { user: AuthUser }, @Body() body: { sourceRunId?: string; requestKey?: string }) { return this.service.enqueue(request.user, body); }
  @Get('runs/:id') run(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.run(request.user, id); }
  @Get('runs/:id/deals') deals(@Req() request: { user: AuthUser }, @Param('id') id: string,
    @Query() query: { managerId?: string; department?: string; status?: string; cursor?: string }) { return this.service.deals(request.user, id, query); }
  @Get('observations/:id') observation(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.observation(request.user, id); }
  @Post('cases/:id/decisions') decide(@Req() request: { user: AuthUser }, @Param('id') id: string, @Body() body: CrmControlDecisionInput) { return this.service.decide(request.user, id, body); }
  @Post('evidence/:id/retry') retryEvidence(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.retryEvidence(request.user, id); }
  @Get('evidence/:id/file')
  @Header('Cache-Control', 'private, no-store')
  async evidence(@Req() request: { user: AuthUser }, @Param('id') id: string) {
    const file = await this.service.evidenceFile(request.user, id);
    return new StreamableFile(file.buffer, { type: file.contentType, disposition: `inline; filename="crm-evidence-${id}.png"` });
  }
}
