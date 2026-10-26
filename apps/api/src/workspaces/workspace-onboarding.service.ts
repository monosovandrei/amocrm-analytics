import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAccessService } from './workspace-access.service';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class WorkspaceOnboardingService {
    constructor(private readonly prisma: PrismaService, private readonly access: WorkspaceAccessService, private readonly auth: AuthService) {}
    private async admin(userId: string) { if ((await this.access.resolve(userId)).role !== 'ADMIN') throw new ForbiddenException('Доступ только администратору'); }
    private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
    async candidates(userId: string) {
        await this.admin(userId);
        const departments = await this.prisma.workspaceDepartment.findMany();
        const users = await this.prisma.crmUser.findMany({ where: { isActive: true, isVisible: true, groupId: { in: departments.map(d => d.groupId) } }, include: { platformUser: { select: { id: true, isActive: true, businessRole: true } } }, orderBy: { name: 'asc' } });
        return users.filter(u => u.email && !((u.raw as any)?.rights || (u.raw as any)?.permissions)?.is_admin && (!u.platformUser || u.platformUser.businessRole === 'MANAGER')).map(u => ({ id: u.id, name: u.name, departmentKey: departments.find(d => d.groupId === u.groupId)!.key, accountId: u.platformUser?.id || null, active: u.platformUser?.isActive || false }));
    }
    async provision(userId: string, body: Record<string, any>) {
        const candidates = await this.candidates(userId);
        if (body.confirmed !== true || !Array.isArray(body.crmUserIds) || !body.crmUserIds.length) throw new BadRequestException('Подтвердите список менеджеров');
        const selected = [...new Set(body.crmUserIds)] as string[];
        if (selected.some(id => !candidates.some(c => c.id === id))) throw new BadRequestException('Список изменился в amoCRM. Проверьте его заново');
        const hashes = new Map(await Promise.all(selected.map(async id => [id, await bcrypt.hash(randomBytes(48).toString('hex'), 12)] as const)));
        return this.prisma.$transaction(async tx => {
            let created = 0;
            for (const id of selected) {
                const candidate = candidates.find(c => c.id === id)!;
                const crm = await tx.crmUser.findUniqueOrThrow({ where: { id } });
                const department = await tx.workspaceDepartment.findUniqueOrThrow({ where: { key: candidate.departmentKey } });
                if (!crm.isActive || !crm.isVisible || !crm.email || crm.groupId !== department.groupId || ((crm.raw as any)?.rights || (crm.raw as any)?.permissions)?.is_admin) throw new ConflictException('Состав сотрудников изменился. Проверьте список заново');
                if (await tx.user.findFirst({ where: { OR: [{ crmUserId: id }, { email: crm.email!.toLowerCase() }] } })) continue;
                const user = await tx.user.create({ data: { email: crm.email!.toLowerCase(), name: crm.name, role: 'ROP', businessRole: 'MANAGER', crmUserId: id, departmentKey: candidate.departmentKey, isActive: false, passwordHash: hashes.get(id)! } });
                await tx.auditLog.create({ data: { userId, action: 'workspace.manager.prepared', entity: 'User', entityId: user.id, metadata: { departmentKey: candidate.departmentKey, crmUserId: id } } });
                created++;
            }
            return { created };
        }, { timeout: 20000 }).catch(error => { if (['P2002','P2034'].includes(error?.code)) throw new ConflictException('Доступы уже изменены другим администратором. Обновите список'); throw error; });
    }
    async invite(userId: string, id: string) {
        await this.admin(userId);
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 72 * 3600000);
        await this.prisma.$transaction(async tx => {
            const user = await tx.user.findUnique({ where: { id } });
            if (!user || user.businessRole !== 'MANAGER' || user.isActive || !await tx.auditLog.findFirst({ where: { action: 'workspace.manager.prepared', entityId: id } })) throw new BadRequestException('Приглашение доступно только новому менеджеру, который ещё не вошёл');
            await tx.workspaceInvite.upsert({ where: { userId: id }, create: { userId: id, tokenHash: this.hash(token), expiresAt, accessVersion: user.accessVersion }, update: { tokenHash: this.hash(token), expiresAt, accessVersion: user.accessVersion, usedAt: null } });
            await tx.auditLog.create({ data: { userId, action: 'workspace.invite.created', entity: 'User', entityId: id, metadata: { expiresAt: expiresAt.toISOString() } } });
        });
        return { token, expiresAt };
    }
    async accept(body: Record<string, any>) {
        if (typeof body.token !== 'string' || body.token.length > 100 || typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new BadRequestException('Укажите ссылку-приглашение и пароль от 12 до 128 символов');
        const pending = await this.prisma.workspaceInvite.findUnique({ where: { tokenHash: this.hash(body.token) }, select: { usedAt: true, expiresAt: true } });
        if (!pending || pending.usedAt || pending.expiresAt <= new Date()) throw new BadRequestException('Приглашение недействительно. Попросите администратора выдать новую ссылку');
        const passwordHash = await bcrypt.hash(body.password, 12);
        const result = await this.prisma.$transaction(async tx => {
            const invite = await tx.workspaceInvite.findUnique({ where: { tokenHash: this.hash(body.token) }, include: { user: { include: { crmUser: true } } } });
            if (!invite || invite.usedAt || invite.expiresAt < new Date() || invite.user.isActive || invite.user.businessRole !== 'MANAGER' || invite.accessVersion !== invite.user.accessVersion || !invite.user.crmUser?.isActive) throw new BadRequestException('Приглашение недействительно. Попросите администратора выдать новую ссылку');
            const department = await tx.workspaceDepartment.findUnique({ where: { key: invite.user.departmentKey || '' } });
            if (!department || invite.user.crmUser.groupId !== department.groupId) throw new BadRequestException('Отдел сотрудника изменился. Обратитесь к администратору');
            const consumed = await tx.workspaceInvite.updateMany({ where: { id: invite.id, usedAt: null }, data: { usedAt: new Date() } });
            if (consumed.count !== 1) throw new ConflictException('Приглашение уже использовано');
            await tx.user.update({ where: { id: invite.userId, isActive: false, accessVersion: invite.accessVersion }, data: { passwordHash, isActive: true, accessVersion: { increment: 1 } } });
            await tx.auditLog.create({ data: { userId: invite.userId, action: 'workspace.invite.accepted', entity: 'User', entityId: invite.userId } });
            return { ok: true, email: invite.user.email };
        }).catch(e => { if (e?.code === 'P2025') throw new ConflictException('Доступ изменён. Запросите новую ссылку'); throw e; });
        const login = await this.auth.login({ email: result.email, password: body.password });
        return { ...result, accessToken: login.accessToken };
    }
}
