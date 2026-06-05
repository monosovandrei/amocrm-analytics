import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('lists audit logs with bounded limit and filters', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new AuditService({
      auditLog: { findMany },
    } as any);

    await service.list({
      limit: 9999,
      action: 'auth.login.success',
      entity: 'User',
      userId: 'user-1',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        action: 'auth.login.success',
        entity: 'User',
        userId: 'user-1',
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        user: {
          select: { id: true, email: true, name: true, role: true },
        },
      },
    });
  });
});
