import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CommercialLinksService } from './commercial-links.service';
@Injectable()
export class WorkspaceLinksScheduler {
    private busy = false;
    private readonly logger = new Logger(WorkspaceLinksScheduler.name);
    constructor(private readonly links: CommercialLinksService) { }
    @Interval(60000)
    async reconcile() {
        if (!['bootstrap', 'all'].includes(process.env.WORKER_ROLE || 'all') || this.busy)
            return;
        this.busy = true;
        try {
            await this.links.reconcile(100);
        }
        catch {
            this.logger.warn('Не удалось проверить связи отгрузок. Неподтверждённые связи не используются');
        }
        finally {
            this.busy = false;
        }
    }
}
