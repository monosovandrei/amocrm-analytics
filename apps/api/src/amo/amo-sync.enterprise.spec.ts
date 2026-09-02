import { AmoSyncService } from './amo-sync.service';

function createService(prisma: Record<string, any>) {
  return new AmoSyncService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { get: jest.fn() } as any,
  ) as any;
}

describe('AmoSyncService full snapshot safeguards', () => {
  it('resumes a failed pull from the interrupted stage and skips completed stages', () => {
    const service = createService({});
    const resumeStage = service.pullResumeStage({
      startedAt: new Date('2026-09-01T10:00:00.000Z'),
      cursor: { step: 'events:saved:565000' },
    });

    expect(resumeStage).toBe('events');
    expect(service.shouldRunPullStage('notes', resumeStage)).toBe(false);
    expect(service.shouldRunPullStage('events', resumeStage)).toBe(true);
    expect(service.shouldRunPullStage('fact_marts', resumeStage)).toBe(true);
  });

  it('starts a fresh pull from the beginning', () => {
    const service = createService({});

    expect(service.pullResumeStage({ startedAt: null, cursor: { step: 'events' } })).toBeNull();
  });

  it('streams events into storage and deduplicates repeated event categories', async () => {
    const service = createService({});
    service.upsertCrmEvent = jest.fn().mockResolvedValue(undefined);
    service.backfillStageHistoryFromStoredEvents = jest.fn().mockResolvedValue(undefined);
    service.touchJob = jest.fn().mockResolvedValue(undefined);
    const client = {
      paginateBatch: jest.fn(async (_path: string, _key: string, _params: unknown, onPage: any) => {
        await onPage([
          { id: 1, payload: 'first' },
          { id: 2, payload: 'second' },
        ], 1);
      }),
    };
    const stats: Record<string, number> = {};

    await service.syncEvents(client, {}, stats, undefined, 'job-1');

    expect(service.upsertCrmEvent).toHaveBeenCalledTimes(2);
    expect(service.upsertCrmEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 1 }), {});
    expect(service.upsertCrmEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 2 }), {});
    expect(stats.events).toBe(2);
    expect(service.backfillStageHistoryFromStoredEvents).toHaveBeenCalled();
  });

  it('marks deals absent from a complete amoCRM snapshot as deleted and verifies parity', async () => {
    const prisma = {
      deal: {
        findMany: jest.fn().mockResolvedValue([
          { externalId: '1' },
          { externalId: '2' },
          { externalId: 'old' },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(2),
      },
    };
    const service = createService(prisma);
    service.upsertDeal = jest.fn().mockResolvedValue({});
    const client = {
      paginateBatch: jest.fn(async (_path: string, _key: string, _params: unknown, onPage: any) => {
        await onPage([{ id: 1 }, { id: 2 }], 1);
      }),
    };
    const stats: Record<string, number> = {};

    await service.syncDeals(client, {}, stats, undefined, undefined, true);

    expect(prisma.deal.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalId: { in: ['old'] }, deletedAt: null },
    }));
    expect(stats).toEqual(expect.objectContaining({ dealsSource: 2, dealsVerified: 2, dealsDeleted: 1 }));
  });

  it('refuses destructive reconciliation when the source snapshot is suspiciously incomplete', async () => {
    const prisma = {
      deal: {
        findMany: jest.fn().mockResolvedValue(Array.from({ length: 100 }, (_, index) => ({ externalId: String(index) }))),
        updateMany: jest.fn(),
        count: jest.fn(),
      },
    };
    const service = createService(prisma);
    service.upsertDeal = jest.fn().mockResolvedValue({});
    const client = {
      paginateBatch: jest.fn(async (_path: string, _key: string, _params: unknown, onPage: any) => {
        await onPage(Array.from({ length: 10 }, (_, index) => ({ id: index })), 1);
      }),
    };

    await expect(service.syncDeals(client, {}, {}, undefined, undefined, true)).rejects.toThrow('suspiciously small');
    expect(prisma.deal.updateMany).not.toHaveBeenCalled();
  });

  it('restores a deal if it reappears in amoCRM after being marked deleted', async () => {
    const prisma = {
      pipelineStage: { findUnique: jest.fn().mockResolvedValue({ isWon: false }) },
      deal: {
        findUnique: jest.fn().mockResolvedValue({ id: 'deal-1', stageId: 'stage-1', responsibleId: null }),
        update: jest.fn().mockResolvedValue({ id: 'deal-1' }),
      },
    };
    const service = createService(prisma);
    service.syncDealProducts = jest.fn().mockResolvedValue(undefined);
    const maps = {
      pipelines: new Map([['pipeline-external', 'pipeline-1']]),
      stages: new Map([['pipeline-external_stage-external', 'stage-1']]),
      users: new Map(),
      contacts: new Map(),
      lossReasons: new Map(),
    };

    await service.upsertDeal({
      id: 'lead-1',
      pipeline_id: 'pipeline-external',
      status_id: 'stage-external',
      name: 'Lead',
      price: 100,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_100,
      _embedded: {},
    }, maps);

    expect(prisma.deal.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deletedAt: null }),
    }));
  });
});
