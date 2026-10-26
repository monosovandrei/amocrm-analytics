import { Body, Controller, Get, Header, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PerformanceService } from './performance.service';
import { WorkspaceOnboardingService } from './workspace-onboarding.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class PerformanceController {
    constructor(private readonly performance: PerformanceService, private readonly onboarding: WorkspaceOnboardingService) {}
    @Get('onboarding') candidates(@Req() req: any) { return this.onboarding.candidates(req.user.id); }
    @Post('onboarding') provision(@Req() req: any, @Body() body: Record<string, any>) { return this.onboarding.provision(req.user.id, body); }
    @Post('onboarding/:id/invite') invite(@Req() req: any, @Param('id') id: string) { return this.onboarding.invite(req.user.id, id); }
    @Get('performance') overview(@Req() req: any, @Query() query: Record<string, string>) { return this.performance.overview(req.user.id, query); }
    @Patch('performance/goals') goal(@Req() req: any, @Body() body: Record<string, any>) { return this.performance.saveGoal(req.user.id, body); }
    @Get('competition') settings(@Req() req: any, @Query() query: Record<string, string>) { return this.performance.competitionSettings(req.user.id, query); }
    @Post('competition') competition(@Req() req: any, @Body() body: Record<string, any>) { return this.performance.setCompetition(req.user.id, body); }
    @Get('displays') displays(@Req() req: any) { return this.performance.displays(req.user.id); }
    @Get('displays/preview') preview(@Req() req: any, @Query() query: Record<string, string>) { return this.performance.displayPreview(req.user.id, query); }
    @Post('displays') create(@Req() req: any, @Body() body: Record<string, any>) { return this.performance.createDisplay(req.user.id, body); }
    @Patch('displays/:id/revoke') revoke(@Req() req: any, @Param('id') id: string) { return this.performance.revokeDisplay(req.user.id, id); }
}

@Controller('workspace-invite')
export class WorkspaceInviteController {
    constructor(private readonly onboarding: WorkspaceOnboardingService) {}
    @Post('accept')
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { ttl: 60000, limit: 30 } })
    accept(@Body() body: Record<string, any>) { return this.onboarding.accept(body); }
}

// Opaque, expiring read-only credentials, deliberately separate from employee JWTs.
@Controller('display')
export class DisplayController {
    constructor(private readonly performance: PerformanceService) {}
    @Get('snapshot')
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { ttl: 60000, limit: 60 } })
    @Header('Cache-Control', 'no-store')
    snapshot(@Headers('authorization') authorization: string, @Query() query: Record<string, string>) {
        return this.performance.display(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '', query);
    }
}
