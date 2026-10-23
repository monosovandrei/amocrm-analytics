import { createHash } from 'node:crypto';
import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
export type WorkspaceScope = {
    userId: string;
    role: 'ADMIN' | 'ROP' | 'MANAGER';
    departmentKey: string | null;
    managerId: string | null;
    version: number;
    fingerprint: string;
};
@Injectable()
export class WorkspaceAccessService {
    constructor(private readonly prisma: PrismaService) { }
    async resolve(id: string): Promise<WorkspaceScope> {
        const user = await this.prisma.user.findUnique({ where: { id }, include: { crmUser: true } });
        if (!user?.isActive)
            throw new ForbiddenException('Учётная запись отключена');
        const role: WorkspaceScope['role'] = user.role === 'ADMIN' || user.businessRole === 'OWNER' ? 'ADMIN'
            : user.businessRole === 'ROP' ? 'ROP' : 'MANAGER';
        if (role !== 'ADMIN' && !user.departmentKey)
            throw new ForbiddenException('Не назначен отдел. Обратитесь к администратору');
        if (role === 'MANAGER' && (!user.crmUserId || !user.crmUser?.isActive)) {
            throw new ForbiddenException('Не настроена связь с сотрудником amoCRM. Обратитесь к администратору');
        }
        const scope = { userId: user.id, role, departmentKey: user.departmentKey,
            managerId: role === 'MANAGER' ? user.crmUserId : null, version: user.accessVersion };
        return { ...scope, fingerprint: createHash('sha256').update(JSON.stringify(scope)).digest('hex') };
    }
    async department(scope: WorkspaceScope, requested?: string) {
        const key = requested || scope.departmentKey;
        if (!key)
            throw new ForbiddenException('Выберите отдел');
        if (scope.role !== 'ADMIN' && key !== scope.departmentKey)
            throw new ForbiddenException('Другой отдел недоступен');
        const department = await this.prisma.workspaceDepartment.findUnique({ where: { key } });
        if (!department)
            throw new ForbiddenException('Отдел не настроен. Обратитесь к администратору');
        return department;
    }
    async managerIds(scope: WorkspaceScope, department: {
        key: string;
        groupId: string;
    }, requested?: string) {
        if (scope.role === 'MANAGER') {
            if (requested && requested !== scope.managerId)
                throw new ForbiddenException('Данные другого сотрудника недоступны');
            return [scope.managerId!];
        }
        const users = await this.prisma.crmUser.findMany({ where: { groupId: department.groupId }, select: { id: true } });
        const linked = await this.prisma.commercialShipmentLink.findMany({ where: { departmentKey: department.key, status: 'CONFIRMED', managerId: { not: null } }, distinct: ['managerId'], select: { managerId: true } });
        const ids = [...new Set([...users.map(u => u.id), ...linked.map(l => l.managerId!)])].sort();
        if (requested && !ids.includes(requested))
            throw new ForbiddenException('Сотрудник не относится к отделу');
        return requested ? [requested] : ids;
    }
}
