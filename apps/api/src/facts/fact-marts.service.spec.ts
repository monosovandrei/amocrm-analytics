import { FactMartsService } from './fact-marts.service';

describe('FactMartsService refresh serialization', () => {
  it('takes a database transaction lock before rebuilding fact marts', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const prisma = {
      $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    const service = new FactMartsService(prisma as any) as any;
    service.refreshDealFacts = jest.fn().mockResolvedValue(undefined);
    service.refreshEmailThreadFacts = jest.fn().mockResolvedValue(undefined);
    service.factCounts = jest.fn().mockResolvedValue({
      dealCurrent: 1,
      stageTransitions: 1,
      stageIntervals: 1,
      emailThreads: 1,
    });

    await service.refreshAll();

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(service.refreshDealFacts.mock.invocationCallOrder[0]);
  });

  it('selects delayed CRM changes by local ingestion time', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const service = new FactMartsService(prisma as any) as any;
    service.refreshDeals = jest.fn().mockResolvedValue({
      dealCurrent: 0,
      stageTransitions: 0,
      stageIntervals: 0,
      emailThreads: 0,
    });

    await service.refreshRecentlyChanged(15);

    const query = prisma.$queryRaw.mock.calls[0][0] as unknown as readonly string[];
    const sql = Array.from(query).join(' ');
    expect(sql).toContain('deal."syncedAt"');
    expect(sql).toContain('history."ingestedAt"');
    expect(sql).toContain('contact."updatedAt"');
  });
});
