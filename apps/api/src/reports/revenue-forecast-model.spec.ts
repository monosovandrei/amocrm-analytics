import {
  buildDeadlineProbabilityCurve,
  buildForecastFeatureSet,
  combineEstimateReliability,
  scoreBinaryProbability,
  scoreDeadlineProbability,
  scoreDeliveryProbability,
  weightedDurationQuantile,
} from './revenue-forecast-model';

const now = new Date('2026-08-10T09:00:00.000Z');

describe('revenue forecast model', () => {
  it('includes matured open deals in the deadline denominator', () => {
    const episodes = [
      {
        entryAt: new Date('2026-07-01T09:00:00.000Z'),
        observedUntil: new Date('2026-07-04T09:00:00.000Z'),
        outcome: 'won' as const,
        outcomeAt: new Date('2026-07-04T09:00:00.000Z'),
        featureKeys: [],
      },
      {
        entryAt: new Date('2026-07-01T09:00:00.000Z'),
        observedUntil: now,
        outcome: 'open' as const,
        featureKeys: [],
      },
    ];

    const result = scoreDeadlineProbability(episodes, {
      now,
      horizonDays: 7,
      priorProbability: 0.5,
      priorWeight: 2,
    });

    expect(result.sampleSize).toBe(2);
    expect(result.probability).toBeLessThan(0.75);
  });

  it('conditions the model on the time a current deal already survived in the stage', () => {
    const episodes = [
      {
        entryAt: new Date('2026-07-01T09:00:00.000Z'),
        observedUntil: new Date('2026-07-03T09:00:00.000Z'),
        outcome: 'won' as const,
        outcomeAt: new Date('2026-07-03T09:00:00.000Z'),
        exitedAt: new Date('2026-07-02T09:00:00.000Z'),
        featureKeys: [],
      },
      {
        entryAt: new Date('2026-07-01T09:00:00.000Z'),
        observedUntil: now,
        outcome: 'open' as const,
        featureKeys: [],
      },
    ];

    const result = scoreDeadlineProbability(episodes, {
      now,
      horizonDays: 7,
      elapsedDays: 5,
      priorProbability: 0.2,
      priorWeight: 2,
    });

    expect(result.sampleSize).toBe(1);
    expect(result.probability).toBeLessThan(0.2);
  });

  it('keeps the cumulative probability curve monotonic', () => {
    const curve = buildDeadlineProbabilityCurve([], {
      now,
      maxHorizonDays: 10,
      priorProbability: 0.25,
    });

    expect(curve).toHaveLength(10);
    for (let index = 1; index < curve.length; index += 1) {
      expect(curve[index].probability).toBeGreaterThanOrEqual(curve[index - 1].probability);
    }
  });

  it('calibrates delivery dates against observed shipment errors', () => {
    const observations = [
      { observedAt: now, errorDays: -7, featureKeys: [] },
      { observedAt: now, errorDays: -5, featureKeys: [] },
      { observedAt: now, errorDays: 2, featureKeys: [] },
    ];

    const beforeDelivery = scoreDeliveryProbability(observations, -3, {
      now,
      priorProbability: 0.5,
      priorWeight: 1,
    });
    const afterDelivery = scoreDeliveryProbability(observations, 3, {
      now,
      priorProbability: 0.5,
      priorWeight: 1,
    });

    expect(beforeDelivery.probability).toBeLessThan(afterDelivery.probability);
  });

  it('uses the observed month-end cohort as the base probability', () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      observedAt: new Date(`2026-07-${String(10 + (index % 10)).padStart(2, '0')}T09:00:00.000Z`),
      value: index < 15,
      featureKeys: [],
    }));

    const result = scoreBinaryProbability(observations, {
      now,
      priorProbability: 0.5,
      priorWeight: 2,
    });

    expect(result.sampleSize).toBe(20);
    expect(result.probability).toBeGreaterThan(0.65);
    expect(result.probability).toBeLessThan(0.8);
  });

  it('adjusts the cohort using the current assembly stage without discarding the broad sample', () => {
    const observations = Array.from({ length: 20 }, (_, index) => ({
      observedAt: now,
      value: index < 9 || (index >= 10 && index < 12),
      featureKeys: [index < 10 ? 'assembly_stage:fast' : 'assembly_stage:slow'],
    }));
    const baseline = scoreBinaryProbability(observations, {
      now,
      priorProbability: 0.5,
      priorWeight: 2,
    });
    const stageAdjusted = scoreBinaryProbability(observations, {
      now,
      priorProbability: 0.5,
      priorWeight: 2,
      currentFeatures: {
        keys: ['assembly_stage:fast'],
        labels: { 'assembly_stage:fast': 'история этапа Fast' },
        summary: {
          condition: 'unknown',
          serverBase: null,
          quantity: null,
          complexity: 'low',
          country: null,
          emailKind: 'unknown',
        },
      },
    });

    expect(stageAdjusted.sampleSize).toBe(baseline.sampleSize);
    expect(stageAdjusted.probability).toBeGreaterThan(baseline.probability);
  });

  it('conditions an overdue delivery on the delay already observed', () => {
    const observations = [-6, 0, 2, 20, 30].map((errorDays) => ({
      observedAt: now,
      errorDays,
      featureKeys: [],
    }));
    const unconditional = scoreDeliveryProbability(observations, 25, {
      now,
      priorProbability: 0.5,
      priorWeight: 1,
    });
    const overdue = scoreDeliveryProbability(observations, 25, {
      now,
      minimumErrorDays: 10,
      priorProbability: 0.5,
      priorWeight: 1,
    });

    expect(overdue.sampleSize).toBe(2);
    expect(overdue.probability).toBeLessThan(unconditional.probability);
    expect(scoreDeliveryProbability(observations, 10, {
      now,
      minimumErrorDays: 10,
      priorProbability: 0.5,
      priorWeight: 1,
    }).probability).toBe(0);
  });

  it('keeps cohort reliability when Delivery has no comparable observations', () => {
    const cohort = scoreBinaryProbability(
      Array.from({ length: 20 }, (_, index) => ({ observedAt: now, value: index < 15, featureKeys: [] })),
      { now, priorProbability: 0.5, priorWeight: 2 },
    );
    const delivery = scoreDeliveryProbability([], 10, {
      now,
      priorProbability: cohort.probability,
      priorWeight: 12,
    });
    const combined = combineEstimateReliability(delivery, cohort, 12);

    expect(delivery.confidence).toBe(0);
    expect(combined.confidence).toBeCloseTo(cohort.confidence);
    expect(combined.probability).toBe(delivery.probability);
  });

  it('extracts stable commercial and configuration features', () => {
    const features = buildForecastFeatureSet({
      managerId: 'manager-1',
      amount: 24_000,
      tags: ['source-ES', 'dest-Germany', 'Express'],
      configuration: '5 x Dell R660 NVMe (Refurbished)\nRAID 60\nGPU Tesla',
      email: 'buyer@example.de',
      phone: '+491234567890',
    });

    expect(features.keys).toEqual(expect.arrayContaining([
      'manager:manager-1',
      'condition:refurbished',
      'base:r660',
      'country:germany',
      'source:es',
      'express:yes',
    ]));
    expect(features.summary.quantity).toBe(5);
    expect(features.summary.complexity).toBe('high');
    expect(features.summary.emailKind).toBe('corporate');
  });

  it('uses feature-matched duration observations when the sample is sufficient', () => {
    const observations = Array.from({ length: 8 }, (_, index) => ({
      observedAt: now,
      durationDays: 2 + index / 10,
      featureKeys: ['express:yes'],
    })).concat([
      { observedAt: now, durationDays: 20, featureKeys: [] },
      { observedAt: now, durationDays: 25, featureKeys: [] },
    ]);

    expect(weightedDurationQuantile(observations, 0.5, now, ['express:yes'])).toBeLessThan(5);
  });
});
