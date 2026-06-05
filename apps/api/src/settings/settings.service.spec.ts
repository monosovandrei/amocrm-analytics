import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  it('writes audit log when dashboard layout is created and updated', async () => {
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const prisma = {
      dashboardLayout: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'layout-1', userId: 'user-1', isDefault: true }),
        create: jest.fn().mockResolvedValue({ id: 'layout-1' }),
        update: jest.fn().mockResolvedValue({ id: 'layout-1' }),
      },
    };
    const service = new SettingsService(prisma as any, audit as any);

    await service.saveDashboardLayout('user-1', { reports: {} });
    await service.saveDashboardLayout('user-1', { reports: { a: { pinned: true } } });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'settings.dashboard_layout.create',
        entity: 'DashboardLayout',
        entityId: 'layout-1',
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        action: 'settings.dashboard_layout.update',
        entity: 'DashboardLayout',
        entityId: 'layout-1',
      }),
    );
  });
});
