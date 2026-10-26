import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard } from '@nestjs/throttler';
import { createHash } from 'node:crypto';

@Injectable()
export class LoginThrottleGuard extends ThrottlerGuard {
    protected errorMessage = 'Слишком много попыток входа в эту учётную запись. Подождите минуту.';
    protected async getTracker(req: Record<string, any>) {
        const email = typeof req.body?.email === 'string' ? req.body.email.slice(0, 320).trim().toLowerCase() : '';
        return createHash('sha256').update(`${req.ip}:${email}`).digest('hex');
    }
    async canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest();
        // Five attempts per account remain in force; colleagues sharing NAT do not consume each other's quota.
        const network = createHash('sha256').update(`login-network:${req.ip}`).digest('hex');
        const limit = await this.storageService.increment(network, 60000, 100, 60000, 'login-network');
        if (limit.isBlocked) throw new ThrottlerException('Слишком много попыток входа с этой сети. Подождите минуту.');
        return super.canActivate(context);
    }
}
