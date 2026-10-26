import { CallHandler, ExecutionContext, ForbiddenException, GoneException, Injectable, NestInterceptor } from '@nestjs/common';
import { WorkspaceAccessService } from './workspace-access.service';
// Applied after route authentication. Legacy routes are closed, not merely hidden.
@Injectable()
export class WorkspaceBoundaryInterceptor implements NestInterceptor {
    constructor(private readonly access: WorkspaceAccessService) { }
    async intercept(context: ExecutionContext, next: CallHandler) {
        const req = context.switchToHttp().getRequest();
        const path = String(req.url || '').split('?')[0].replace(/^\/api\/v1/, '');
        if(req.method==='PATCH'&&/^\/platform\/admin\/user-links\//.test(path))throw new GoneException('Назначайте права в новых настройках кабинетов');
        if(req.method!=='GET'&&/^\/platform\/(alerts|schedules)(\/|$)/.test(path))throw new GoneException('Настраивайте рассылки в администраторском разделе Telegram');
        if (/^\/(crm-control(?:\/|$)|platform\/(?:rop-dashboard(?:-v2)?|email-threads)(?:\/|$))/.test(path)) {
            throw new GoneException('Раздел удалён. Используйте новый кабинет');
        }
        if (!req.user)
            return next.handle();
        const scope = await this.access.resolve(req.user.id).catch(error => {
            if (path === '/auth/me' || path === '/workspaces/session')
                return null;
            throw error;
        });
        if (scope && scope.role !== 'ADMIN' && !/^\/(?:auth\/me|workspaces(?:\/|$)|platform\/telegram\/(?:status|link-code))$/.test(path)
            && !path.startsWith('/workspaces/'))
            throw new ForbiddenException('Используйте разделы своего кабинета');
        return next.handle();
    }
}
