import { WorkspaceAccessService } from './workspace-access.service';
import { WorkspaceBoundaryInterceptor } from './workspace-boundary.interceptor';
describe('workspace access boundary', () => {
    const next = { handle: jest.fn().mockReturnValue({}) };
    const base = { id: 'account', role: 'ROP', businessRole: 'MANAGER', departmentKey: 'sales',
        crmUserId: 'manager-a', isActive: true, accessVersion: 1, crmUser: { isActive: true } };
    function fixture(patch = {}) {
        const p = { user: { findUnique: jest.fn().mockResolvedValue({ ...base, ...patch }) },
            workspaceDepartment: { findUnique: jest.fn().mockResolvedValue({ key: 'sales', groupId: 'sales-group' }) },
            crmUser: { findMany: jest.fn().mockResolvedValue([{ id: 'manager-a' }]) },
            commercialShipmentLink: { findMany: jest.fn().mockResolvedValue([{ managerId: 'former-seller' }]) } };
        return { p, access: new WorkspaceAccessService(p as any) };
    }
    it('does not mistake technical ROP for a business manager permission', async () => {
        const { access } = fixture();
        expect(await access.resolve('account')).toMatchObject({ role: 'MANAGER', managerId: 'manager-a' });
    });
    it.each([{ role: 'ADMIN' }, { businessRole: 'OWNER' }])('preserves explicit administrative accounts: %j', async (patch) => {
        expect((await fixture({ ...patch, departmentKey: null, crmUserId: null }).access.resolve('account')).role).toBe('ADMIN');
    });
    it.each([{ isActive: false }, { departmentKey: null }, { crmUserId: null }, { crmUser: { isActive: false } }])('fails closed for incomplete/inactive manager: %j', async (patch) => {
        await expect(fixture(patch).access.resolve('account')).rejects.toThrow();
    });
    it('requires an explicitly assigned department for a ROP', async () => {
        await expect(fixture({ businessRole: 'ROP', departmentKey: null }).access.resolve('account')).rejects.toThrow('отдел');
    });
    it('never allows a manager to request another employee', async () => {
        const { access } = fixture();
        const scope = await access.resolve('account');
        await expect(access.managerIds(scope, { key: 'sales', groupId: 'sales-group' }, 'manager-b')).rejects.toThrow();
        expect(await access.managerIds(scope, { key: 'sales', groupId: 'sales-group' })).toEqual(['manager-a']);
    });
    it('does not allow a department switch by request parameter', async () => {
        const { access } = fixture({ businessRole: 'ROP' });
        await expect(access.department(await access.resolve('account'), 'csm')).rejects.toThrow();
    });
    it('preserves a former seller with confirmed shipments in the department', async () => {
        const { access } = fixture({ businessRole: 'ROP' });
        expect(await access.managerIds(await access.resolve('account'), { key: 'sales', groupId: 'sales-group' })).toEqual(['former-seller', 'manager-a']);
    });
    it('changes access fingerprint when role, department or binding changes', async () => {
        const first = await fixture().access.resolve('account');
        for (const patch of [{ accessVersion: 2 }, { departmentKey: 'csm' }, { crmUserId: 'other' }, { businessRole: 'ROP' }]) {
            expect((await fixture(patch).access.resolve('account')).fingerprint).not.toBe(first.fingerprint);
        }
    });
    function context(url: string, user = { id: 'account' }) {
        return { switchToHttp: () => ({ getRequest: () => ({ url, user }) }) } as any;
    }
    it.each(['/platform/plans/items', '/reports/compute', '/settings/options', '/quality/incidents/secret', '/amo/sync-jobs/secret'])('blocks legacy data access for managers and ROPs: %s', async (path) => {
        const { access } = fixture();
        const boundary = new WorkspaceBoundaryInterceptor(access);
        await expect(boundary.intercept(context(`/api/v1${path}`), next)).rejects.toThrow();
    });
    it.each(['/crm-control', '/crm-control/evidence/x', '/platform/rop-dashboard', '/platform/rop-dashboard-v2', '/platform/email-threads/pending'])('retires old routes even for administrators: %s', async (path) => {
        const { access } = fixture({ role: 'ADMIN' });
        const boundary = new WorkspaceBoundaryInterceptor(access);
        await expect(boundary.intercept(context(`/api/v1${path}`), next)).rejects.toThrow('удалён');
    });
    it('allows the bounded workspace controller', async () => {
        const boundary = new WorkspaceBoundaryInterceptor(fixture().access);
        const stream = {};
        expect(await boundary.intercept(context('/api/v1/workspaces/plans?month=2026-10'), { handle: jest.fn().mockReturnValue(stream) })).toBe(stream);
    });
    it('closes the old role editor even for an administrator',async()=>{
        const boundary=new WorkspaceBoundaryInterceptor(fixture({role:'ADMIN'}).access);
        const request={switchToHttp:()=>({getRequest:()=>({url:'/api/v1/platform/admin/user-links/a',method:'PATCH',user:{id:'account'}})})} as any;
        await expect(boundary.intercept(request,next)).rejects.toThrow('новых настройках');
    });
    it('allows unconfigured accounts to obtain their session explanation, not reports', async () => {
        const boundary = new WorkspaceBoundaryInterceptor(fixture({ departmentKey: null }).access);
        expect(await boundary.intercept(context('/api/v1/workspaces/session'), next)).toBeDefined();
        await expect(boundary.intercept(context('/api/v1/workspaces/reports/sales_funnel_steps'), next)).rejects.toThrow();
    });
});
