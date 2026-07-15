import { Body, Controller, HttpCode, HttpStatus, Logger, Param, Post } from '@nestjs/common';
import { AmoService } from './amo.service';

@Controller('webhooks/amocrm')
export class AmoWebhookController {
  private readonly logger = new Logger(AmoWebhookController.name);

  constructor(private readonly amo: AmoService) {}

  @Post(':secret')
  @HttpCode(HttpStatus.OK)
  async handle(@Param('secret') secret: string, @Body() body: any) {
    const connection = await this.amo.findByWebhookSecret(secret);
    if (!connection) {
      this.logger.warn('amoCRM webhook ignored: unknown secret');
      return { status: 'ignored' };
    }

    if (!this.amo.validateWebhookAccount(body, connection)) {
      this.logger.warn('amoCRM webhook ignored: account mismatch');
      return { status: 'ignored', reason: 'account_mismatch' };
    }

    const events = this.amo.flattenWebhook(body);
    await this.amo.recordWebhook(connection.id, events);
    return { status: 'ok', events: events.length };
  }
}
