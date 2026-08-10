import { RevenueForecastEngine } from './revenue-forecast-engine';

describe('revenue forecast engine cohorts', () => {
  it('rebuilds the equivalent historical month snapshot and keeps non-shipped deals in the denominator', async () => {
    const intervals = [
      {
        dealId: 'shipped',
        stageId: 'items-in-transit',
        stageName: 'ITEMS IN TRANSIT',
        enteredAt: new Date('2026-07-01T09:00:00.000Z'),
        exitedAt: new Date('2026-07-15T09:00:00.000Z'),
      },
      {
        dealId: 'open',
        stageId: 'items-in-transit',
        stageName: 'ITEMS IN TRANSIT',
        enteredAt: new Date('2026-07-02T09:00:00.000Z'),
        exitedAt: null,
      },
    ];
    const db = {
      factDealStageInterval: { findMany: jest.fn().mockResolvedValue(intervals) },
      factStageTransition: {
        findMany: jest.fn().mockResolvedValue([
          { dealId: 'shipped', movedAt: new Date('2026-07-20T09:00:00.000Z') },
        ]),
      },
    };
    const engine = new RevenueForecastEngine(db as any) as any;
    engine.loadFeatureContexts = jest.fn().mockResolvedValue(undefined);
    const now = new Date('2026-08-10T13:00:00.000Z');
    const monthTo = new Date('2026-08-31T20:59:59.999Z');

    const result = await engine.buildAssemblyMonthlyCohort({
      stageIds: ['items-in-transit'],
      shippingDoneStageId: 'shipped',
      now,
      daysLeft: (monthTo.getTime() - now.getTime()) / 86_400_000,
    });

    expect(result.monthCount).toBe(1);
    expect(result.observations).toHaveLength(2);
    expect(result.shipped).toBe(1);
    expect(result.observations.map((item: { value: boolean }) => item.value).sort()).toEqual([false, true]);
  });
});
