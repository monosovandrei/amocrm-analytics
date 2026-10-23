import { RevenueForecastEngine } from './revenue-forecast-engine';

describe('revenue forecast engine cohorts', () => {
  it('shares only calibration, not personal predictions, and invalidates when source changes',async()=>{
    const db={} as any;
    const training=jest.fn().mockResolvedValue({byStageId:new Map(),latestEntryByDealStage:new Map()});
    function engine(revision:string){const e=new RevenueForecastEngine(db,revision) as any;e.resolveFieldIds=jest.fn().mockResolvedValue({});e.buildStageEpisodes=training;e.loadDeliveryObservations=jest.fn().mockResolvedValue([]);e.buildAssemblyMonthlyCohort=jest.fn().mockResolvedValue({observations:[],monthCount:0,shipped:0});e.loadFeatureContexts=jest.fn().mockResolvedValue(undefined);return e;}
    const input={now:new Date('2026-10-23T12:00:00Z'),monthTo:new Date('2026-10-31T20:59:59Z'),assemblyDeals:[],assemblyStageIds:['stage'],assemblyStartStageId:'start',itemsInTransitPosition:1,stagePositions:new Map(),shippingDoneStageId:'shipped',shippingLossStageIds:[],paymentGroups:[]};
    const first=await engine('one').compute(input),second=await engine('one').compute(input);
    expect(first).toEqual(second);expect(first.predictions).not.toBe(second.predictions);expect(training).toHaveBeenCalledTimes(1);
    await engine('two').compute(input);expect(training).toHaveBeenCalledTimes(2);
  });
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
