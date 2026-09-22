import { Body, Controller, Get, Header, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthUser } from '../auth/jwt.strategy';
import { CrmControlService } from './crm-control.service';
import { CrmControlDecisionInput, CrmControlManualReviewInput } from './crm-control.types';

@Controller('crm-control')
@UseGuards(JwtAuthGuard)
export class CrmControlController {
  constructor(private readonly service: CrmControlService) {}

  @Get('settings') settings(@Req() request: { user: AuthUser }) { return this.service.settings(request.user); }
  @Put('settings') saveSettings(@Req() request: { user: AuthUser }, @Body() body: unknown) { return this.service.saveSettings(request.user, body); }
  @Get('runs') runs(@Req() request: { user: AuthUser }, @Query('cursor') cursor?: string) { return this.service.runs(request.user, cursor); }
  @Post('runs') enqueue(@Req() request: { user: AuthUser }, @Body() body: { sourceRunId?: string; requestKey?: string }) { return this.service.enqueue(request.user, body); }
  @Get('runs/:id') run(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.run(request.user, id); }
  @Post('runs/:id/recheck-remaining') recheckRemaining(@Req() request: { user: AuthUser }, @Param('id') id: string,
    @Body() body: { requestKey?: string }) { return this.service.recheckRemaining(request.user, id, body); }
  @Get('runs/:id/deals') deals(@Req() request: { user: AuthUser }, @Param('id') id: string,
    @Query() query: { managerId?: string; department?: string; status?: string; ruleCode?: string; cursor?: string }) { return this.service.deals(request.user, id, query); }
  @Get('observations/:id') observation(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.observation(request.user, id); }
  @Get('observations/:observationId/documents/:sha256/file')
  @Header('Cache-Control', 'private, no-store')
  async documentEvidence(@Req() request: { user: AuthUser }, @Param('observationId') observationId: string, @Param('sha256') sha256: string) {
    const file = await this.service.documentEvidence(request.user, observationId, sha256);
    return new StreamableFile(file.buffer, { type: file.contentType,
      disposition: `attachment; filename="crm-document.${file.contentType === 'application/pdf' ? 'pdf' : 'bin'}"` });
  }
  @Get('observations/:observationId/results/:resultId/analysis')
  @Header('Cache-Control', 'private, no-store')
  analysisProof(@Req() request: { user: AuthUser }, @Param('observationId') observationId: string, @Param('resultId') resultId: string) {
    return this.service.analysisProof(request.user, observationId, resultId);
  }
  @Post('observations/:observationId/results/:resultId/review') reviewResult(@Req() request: { user: AuthUser },
    @Param('observationId') observationId: string, @Param('resultId') resultId: string, @Body() body: CrmControlManualReviewInput) {
    return this.service.reviewResult(request.user, observationId, resultId, body);
  }
  @Post('cases/:id/decisions') decide(@Req() request: { user: AuthUser }, @Param('id') id: string, @Body() body: CrmControlDecisionInput) { return this.service.decide(request.user, id, body); }
  @Post('evidence/:id/retry') retryEvidence(@Req() request: { user: AuthUser }, @Param('id') id: string) { return this.service.retryEvidence(request.user, id); }
  @Post('observations/:id/evidence/probe') probeEvidence(@Req() request: { user: AuthUser }, @Param('id') id: string) {
    return this.service.probeEvidence(request.user, id);
  }
  @Post('observations/:id/evidence/enable') enableEvidence(@Req() request: { user: AuthUser }, @Param('id') id: string) {
    return this.service.requeueDisabledEvidence(request.user, id);
  }
  @Get('evidence/:id/manifest')
  @Header('Cache-Control', 'private, no-store')
  manifest(@Req() request: { user: AuthUser }, @Param('id') id: string) {
    return this.service.evidenceManifest(request.user, id);
  }
  @Get('evidence/:id/frames/:frameId/file')
  @Header('Cache-Control', 'private, no-store')
  async frame(@Req() request: { user: AuthUser }, @Param('id') id: string, @Param('frameId') frameId: string) {
    const file = await this.service.evidenceFrameFile(request.user, id, frameId);
    return new StreamableFile(file.buffer, { type: file.contentType, disposition: 'inline; filename="crm-evidence-frame.png"' });
  }
  @Get('evidence/:id/file')
  @Header('Cache-Control', 'private, no-store')
  async evidence(@Req() request: { user: AuthUser }, @Param('id') id: string) {
    const file = await this.service.evidenceFile(request.user, id);
    return new StreamableFile(file.buffer, { type: file.contentType, disposition: `inline; filename="crm-evidence-${id}.png"` });
  }
}
