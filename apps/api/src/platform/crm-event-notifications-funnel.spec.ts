import { CrmEventNotificationsService } from './crm-event-notifications.service';

describe('CSM notification funnel alignment', () => {
  const startAt = new Date('2026-09-24T21:00:00.000Z');
  const endAt = new Date('2026-09-25T10:00:00.000Z');

  it('counts first-ever stage entries by current owner, including deals moved out of CSM pipelines', async () => {
    const prisma = {
      crmUser: {
        findMany: jest.fn().mockResolvedValue([{ id: 'current-csm-owner' }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([
        { dealId: 'moved-to-assembly', movedAt: startAt, responsibleId: 'current-csm-owner' },
        { dealId: 'moved-to-assembly', movedAt: endAt, responsibleId: 'current-csm-owner' },
        { dealId: 'old-first-entry', movedAt: new Date('2026-09-24T10:00:00.000Z'), responsibleId: 'current-csm-owner' },
        { dealId: 'old-first-entry', movedAt: endAt, responsibleId: 'current-csm-owner' },
        { dealId: 'other-new-deal', movedAt: endAt, responsibleId: 'current-csm-owner' },
      ]),
    };
    const service = new CrmEventNotificationsService(prisma as any, {} as any);

    const counts = await (service as any).countFirstStageReachedByManager(
      ['base-offer', 'assigned-offer'],
      { csmGroupId: 'csm-group' },
      startAt,
      endAt,
    );

    expect([...counts.entries()]).toEqual([['current-csm-owner', 2]]);
    expect(prisma.crmUser.findMany).toHaveBeenCalledWith({
      where: { isActive: true, groupId: 'csm-group' },
      select: { id: true },
    });
    const sql = prisma.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toContain('transition."to_stage_id" IN');
    expect(sql).toContain('deal."responsible_id" AS "responsibleId"');
    expect(sql).toContain('deal."responsible_id" IN');
    expect(sql).toContain('deal."deleted_at" IS NULL');
    expect(sql).toContain('ORDER BY transition."deal_id" ASC, transition."moved_at" ASC');
    expect(sql).not.toContain('deal."pipeline_id"');
  });

  it('does not query stage history when there are no active CSM managers', async () => {
    const prisma = {
      crmUser: { findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn(),
    };
    const service = new CrmEventNotificationsService(prisma as any, {} as any);

    const counts = await (service as any).countFirstStageReachedByManager(
      ['base-offer', 'assigned-offer'],
      { csmGroupId: 'csm-group' },
      startAt,
      endAt,
    );

    expect(counts.size).toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
