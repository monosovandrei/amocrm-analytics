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
});
