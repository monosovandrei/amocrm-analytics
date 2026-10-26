import { WorkspaceOnboardingService } from './workspace-onboarding.service';

jest.mock('bcryptjs', () => ({ hash: jest.fn().mockResolvedValue('private-hash') }));
describe('first manager access without shared passwords', () => {
    function fixture(role = 'ADMIN') {
        const tx: any = { workspaceDepartment: { findMany: jest.fn().mockResolvedValue([{ key: 'sales', groupId: 'g' }]), findUnique: jest.fn().mockResolvedValue({ key: 'sales', groupId: 'g' }) }, crmUser: { findMany: jest.fn().mockResolvedValue([]) }, user: { findUnique: jest.fn(), update: jest.fn() }, auditLog: { findFirst: jest.fn().mockResolvedValue({ id: 'proof' }), create: jest.fn() }, workspaceInvite: { findUnique: jest.fn(), upsert: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
        tx.$transaction = (fn: any) => fn(tx);
        return { tx, service: new WorkspaceOnboardingService(tx, { resolve: async () => ({ role }) } as any, { login: jest.fn().mockResolvedValue({ accessToken: 'test-session' }) } as any) };
    }
    const pending = { id: 'user', email: 'manager@workspace.invalid', businessRole: 'MANAGER', isActive: false, accessVersion: 1, departmentKey: 'sales', crmUser: { isActive: true, groupId: 'g' } };
    it.each(['ROP', 'MANAGER'])('blocks %s from listing onboarding or issuing invitations', async role => { await expect(fixture(role).service.candidates('u')).rejects.toThrow('администратору'); });
    it('excludes technical/admin CRM accounts and existing ROPs', async () => {
        const { tx, service } = fixture();
        const base = { groupId: 'g', email: 'm@workspace.invalid', raw: {} };
        tx.crmUser.findMany.mockResolvedValue([{ ...base, id: 'yes', name: 'Менеджер' }, { ...base, id: 'technical', raw: { rights: { is_admin: true } } }, { ...base, id: 'head', platformUser: { businessRole: 'ROP' } }]);
        expect((await service.candidates('admin')).map(u => u.id)).toEqual(['yes']);
    });
    it('never creates an invitation for an already active account', async () => { const { tx, service } = fixture(); tx.user.findUnique.mockResolvedValue({ ...pending, isActive: true }); await expect(service.invite('admin', 'user')).rejects.toThrow('новому менеджеру'); });
    it('stores only the invitation hash, not the one-time secret', async () => { const { tx, service } = fixture(); tx.user.findUnique.mockResolvedValue(pending); const result = await service.invite('admin', 'user'); expect(result.token).toHaveLength(43); expect(tx.workspaceInvite.upsert.mock.calls[0][0].create.tokenHash).not.toBe(result.token); expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain(result.token); });
    it.each(['used', 'expired', 'active', 'version', 'crm'])('rejects %s invitation without changing access', async reason => {
        const { tx, service } = fixture();
        const user = { ...pending, ...(reason === 'active' ? { isActive: true } : {}), ...(reason === 'crm' ? { crmUser: { isActive: false, groupId: 'g' } } : {}) };
        tx.workspaceInvite.findUnique.mockResolvedValue({ id: 'invite', userId: 'user', accessVersion: reason === 'version' ? 2 : 1, user, expiresAt: new Date(Date.now() + (reason === 'expired' ? -1000 : 100000)), usedAt: reason === 'used' ? new Date() : null });
        await expect(service.accept({ token: 'secret', password: 'a-private-password' })).rejects.toThrow('недействительно'); expect(tx.user.update).not.toHaveBeenCalled();
    });
    it('handles a concurrent second redemption safely', async () => { const { tx, service } = fixture(); tx.workspaceInvite.findUnique.mockResolvedValue({ id: 'invite', userId: 'user', accessVersion: 1, user: pending, expiresAt: new Date(Date.now() + 100000) }); tx.workspaceInvite.updateMany.mockResolvedValue({ count: 0 }); await expect(service.accept({ token: 'secret', password: 'a-private-password' })).rejects.toThrow('использовано'); expect(tx.user.update).not.toHaveBeenCalled(); });
    it('activates only the intended manager and increments access version', async () => { const { tx, service } = fixture(); tx.workspaceInvite.findUnique.mockResolvedValue({ id: 'invite', userId: 'user', accessVersion: 1, user: pending, expiresAt: new Date(Date.now() + 100000) }); expect(await service.accept({ token: 'secret', password: 'a-private-password' })).toEqual({ ok: true, email: pending.email, accessToken: 'test-session' }); expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'user', isActive: false, accessVersion: 1 }, data: { passwordHash: 'private-hash', isActive: true, accessVersion: { increment: 1 } } }); });
});
