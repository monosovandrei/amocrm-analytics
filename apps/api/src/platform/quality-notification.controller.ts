import { Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AuthUser } from '../auth/jwt.strategy';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { DataQualityService } from '../quality/data-quality.service';
import { TelegramService } from './telegram.service';

@Controller('quality')
@UseGuards(JwtAuthGuard)
export class QualityNotificationController {
  constructor(
    private readonly quality: DataQualityService,
    private readonly telegram: TelegramService,
  ) {}

  @Post('notifications/test')
  async test(@Req() req: { user: AuthUser }) {
    if (req.user.role !== 'ADMIN' && req.user.businessRole !== 'OWNER') {
      throw new ForbiddenException('Только владелец может проверять аварийные уведомления');
    }
    const payload = await this.quality.testNotificationPayload();
    const deliveries = await this.telegram.sendMessageToUsers(
      payload.ownerUserIds,
      payload.message,
      { type: 'data-quality-test' },
      undefined,
      payload.eventKey,
    );
    return { sent: deliveries.filter((delivery) => delivery.status === 'SENT').length, deliveries };
  }
}
