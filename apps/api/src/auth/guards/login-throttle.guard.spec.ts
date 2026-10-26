import { Reflector } from '@nestjs/core';
import { LoginThrottleGuard } from './login-throttle.guard';

describe('office login capacity without weakening per-account protection', () => {
    const allowed = { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
    async function fixture() {
        const storage = { increment: jest.fn().mockResolvedValue(allowed) };
        const guard = new LoginThrottleGuard([{ name: 'default', ttl: 60000, limit: 5 }], storage as any, new Reflector());
        await guard.onModuleInit();
        const request = { ip: 'office-network', body: { email: 'first@workspace.invalid' }, headers: {} };
        const response = { header: jest.fn() };
        class LoginController {} function login() {}
        const context: any = { switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }), getClass: () => LoginController, getHandler: () => login };
        return { guard, storage, request, context };
    }
    it('keeps a shared network ceiling and independent five-attempt account quotas', async () => {
        const {guard,storage,request,context}=await fixture();await guard.canActivate(context);request.body.email='second@workspace.invalid';await guard.canActivate(context);
        expect(storage.increment.mock.calls[0][0]).toBe(storage.increment.mock.calls[2][0]);
        expect(storage.increment.mock.calls[1][0]).not.toBe(storage.increment.mock.calls[3][0]);
        expect(storage.increment.mock.calls[0].slice(1,4)).toEqual([60000,100,60000]);
        expect(storage.increment.mock.calls[1][2]).toBe(5);
        expect(JSON.stringify(storage.increment.mock.calls)).not.toContain('@workspace.invalid');
    });
    it('does not allow case variants to bypass an account quota', async () => { const {guard}=await fixture();expect(await (guard as any).getTracker({ip:'x',body:{email:'FIRST@workspace.invalid'}})).toBe(await (guard as any).getTracker({ip:'x',body:{email:'first@workspace.invalid'}})); });
    it('blocks network floods before account lookup', async () => { const {guard,storage,context}=await fixture();storage.increment.mockResolvedValueOnce({...allowed,isBlocked:true});await expect(guard.canActivate(context)).rejects.toThrow('сети');expect(storage.increment).toHaveBeenCalledTimes(1); });
    it('still blocks an exhausted individual account', async () => { const {guard,storage,context}=await fixture();storage.increment.mockResolvedValueOnce(allowed).mockResolvedValueOnce({...allowed,isBlocked:true});await expect(guard.canActivate(context)).rejects.toThrow(); });
});
