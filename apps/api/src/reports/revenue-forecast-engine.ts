import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma';
import { PrismaService } from '../prisma/prisma.service';
import {
  ForecastBinaryObservation,
  ForecastDeadlineEpisode,
  ForecastDeliveryObservation,
  ForecastDurationObservation,
  ForecastFeatureSet,
  ForecastProbabilityEstimate,
  buildDeadlineProbabilityCurve,
  buildForecastFeatureSet,
  combineEstimateReliability,
  scoreBinaryProbability,
  scoreDeadlineProbability,
  scoreDeliveryProbability,
  weightedDurationQuantile,
} from './revenue-forecast-model';

const DAY_MS = 86_400_000;
const MODEL_VERSION = 'revenue-v2.3';
const ASSEMBLY_COHORT_MONTHS = 6;

type ForecastDeal = {
  id: string;
  externalId: string;
  title: string;
  amount: unknown;
  stageId: string;
  responsibleId?: string | null;
  createdAt: Date;
  customFields?: unknown;
  tags?: string[];
  stage?: { id: string; name: string } | null;
  responsible?: { id: string | null; name: string } | null;
};

export type ForecastPaymentGroup = {
  key: string;
  pipelineId: string;
  stageIds: string[];
  successStageIds: string[];
  lossStageIds: string[];
  deals: ForecastDeal[];
};

export type RevenueForecastPrediction = {
  probability: number;
  probabilityPercent: number;
  baseProbabilityPercent: number;
  reliabilityPercent: number;
  probabilitySample: number;
  probabilitySource: 'cohort_model' | 'deadline_model' | 'delivery_model' | 'stage_model';
  predictedShipAt: Date | null;
  paymentProbabilityPercent: number | null;
  shippingProbabilityPercent: number;
  deliveryAt: Date | null;
  elapsedStageDays: number;
  drivers: ForecastProbabilityEstimate['drivers'];
  featureSummary: ForecastFeatureSet['summary'];
};

export type RevenueForecastEngineResult = {
  modelVersion: string;
  predictions: Map<string, RevenueForecastPrediction>;
  shippingCycle: {
    avgDays: number | null;
    medianDays: number | null;
    p65Days: number | null;
    sampleSize: number;
    basis: string;
  };
  deliveryCalibration: {
    sampleSize: number;
    medianErrorDays: number | null;
  };
  assemblyCohort: {
    monthCount: number;
    sampleSize: number;
    shipped: number;
    shipmentRatePercent: number | null;
  };
  warnings: string[];
  snapshotRows: Array<{
    dealId: string;
    dealExternalId: string;
    stageId: string;
    amount: number;
    prediction: RevenueForecastPrediction;
    featureKeys: string[];
  }>;
};

type EngineInput = {
  now: Date;
  monthTo: Date;
  assemblyDeals: ForecastDeal[];
  assemblyStageIds: string[];
  assemblyStartStageId: string;
  itemsInTransitPosition: number;
  stagePositions: Map<string, number>;
  shippingDoneStageId: string;
  shippingLossStageIds: string[];
  paymentGroups: ForecastPaymentGroup[];
};

type ForecastFieldIds = {
  configuration: string;
  quantity: string;
  delivery: string;
  expressDelivery: string;
  expressAssembly: string;
  country: string;
  corporateEmail: string;
};

type ForecastFeatureInput = Parameters<typeof buildForecastFeatureSet>[0];
type FeatureContext = {
  dealId: string;
  dealExternalId: string;
  amount: number;
  responsibleId: string | null;
  deliveryAt: Date | null;
  input: ForecastFeatureInput;
  features: ForecastFeatureSet;
};

type StageHistoryRow = {
  dealId: string;
  fromStageId: string | null;
  toStageId: string;
  movedAt: Date;
  responsibleId: string | null;
};

type StageEpisodeBundle = {
  byStageId: Map<string, ForecastDeadlineEpisode[]>;
  latestEntryByDealStage: Map<string, Date>;
};

type AssemblyCohortBundle = {
  observations: ForecastBinaryObservation[];
  monthCount: number;
  shipped: number;
};

export class RevenueForecastEngine {
  private readonly featureContexts = new Map<string, FeatureContext>();
  private fieldIds!: ForecastFieldIds;

  constructor(private readonly db: PrismaService) {}

  async compute(input: EngineInput): Promise<RevenueForecastEngineResult> {
    this.fieldIds = await this.resolveFieldIds();
    const warnings: string[] = [];
    const predictions = new Map<string, RevenueForecastPrediction>();

    const shippingBundle = await this.buildStageEpisodes({
      stageIds: input.assemblyStageIds,
      successStageIds: [input.shippingDoneStageId],
      lossStageIds: input.shippingLossStageIds,
      now: input.now,
    });
    const paymentBundles = new Map<string, StageEpisodeBundle>();
    for (const group of input.paymentGroups) {
      paymentBundles.set(group.key, await this.buildStageEpisodes({
        stageIds: group.stageIds,
        successStageIds: group.successStageIds,
        lossStageIds: group.lossStageIds,
        now: input.now,
      }));
    }

    const currentDealIds = [
      ...input.assemblyDeals.map((deal) => deal.id),
      ...input.paymentGroups.flatMap((group) => group.deals.map((deal) => deal.id)),
    ];
    await this.loadFeatureContexts(currentDealIds);

    const shippingDurations = completedDurations(shippingBundle.byStageId.get(input.assemblyStartStageId) ?? []);
    const deliveryObservations = await this.loadDeliveryObservations(input.shippingDoneStageId, input.now);
    const deliveryErrors = deliveryObservations.map((item) => ({
      observedAt: item.observedAt,
      durationDays: item.errorDays,
      featureKeys: item.featureKeys,
    }));
    const daysLeft = Math.max(0, durationDays(input.now, input.monthTo));
    const assemblyCohort = await this.buildAssemblyMonthlyCohort({
      stageIds: input.assemblyStageIds,
      shippingDoneStageId: input.shippingDoneStageId,
      now: input.now,
      daysLeft,
    });
    this.retainFeatureContexts(currentDealIds);

    for (const deal of input.assemblyDeals) {
      const context = this.featureContexts.get(deal.id) ?? fallbackFeatureContext(deal);
      const features = context.features;
      const stageEpisodes = shippingBundle.byStageId.get(deal.stageId) ?? [];
      const enteredAt = shippingBundle.latestEntryByDealStage.get(dealStageKey(deal.id, deal.stageId)) ?? deal.createdAt;
      const elapsedStageDays = durationDays(enteredAt, input.now);
      const cohortFeatures = assemblyCohortFeatures(
        features,
        deal.stageId,
        deal.stage?.name ?? '',
        elapsedStageDays,
      );
      const stageEstimate = assemblyCohort.observations.length
        ? scoreBinaryProbability(assemblyCohort.observations, {
            now: input.now,
            currentFeatures: cohortFeatures,
            priorProbability: 0.5,
            priorWeight: 4,
            halfLifeDays: 180,
          })
        : scoreDeadlineProbability(stageEpisodes, {
            now: input.now,
            horizonDays: daysLeft,
            elapsedDays: elapsedStageDays,
            currentFeatures: features,
            priorProbability: conservativeStagePrior(input.stagePositions.get(deal.stageId) ?? 0),
            priorWeight: 8,
          });
      const deliveryAt = context.deliveryAt;
      let estimate = stageEstimate;
      let probabilitySource: RevenueForecastPrediction['probabilitySource'] = assemblyCohort.observations.length
        ? 'cohort_model'
        : 'stage_model';
      let predictedShipAt = this.stagePredictedDate(stageEpisodes, elapsedStageDays, input.now, features);

      if (deliveryAt) {
        const minimumErrorDays = moscowCalendarDayDiff(deliveryAt, input.now);
        const maximumErrorDays = moscowCalendarDayDiff(deliveryAt, input.monthTo);
        const deliveryPriorWeight = Math.max(4, Math.min(12, stageEstimate.sampleWeight));
        const deliveryEstimate = scoreDeliveryProbability(deliveryObservations, maximumErrorDays, {
          now: input.now,
          currentFeatures: features,
          priorProbability: stageEstimate.probability,
          priorWeight: deliveryPriorWeight,
          minimumErrorDays,
        });
        estimate = combineEstimateReliability(deliveryEstimate, stageEstimate, deliveryPriorWeight);
        probabilitySource = 'delivery_model';
        const conditionalErrors = deliveryErrors.filter((item) => item.durationDays > minimumErrorDays);
        const medianError = weightedDurationQuantile(conditionalErrors, 0.5, input.now, features.keys);
        const deliveryPrediction = addDays(deliveryAt, medianError ?? Math.max(0, minimumErrorDays));
        predictedShipAt = deliveryPrediction > input.now ? deliveryPrediction : input.now;
      }

      const prediction = buildPrediction({
        estimate,
        probabilitySource,
        predictedShipAt,
        paymentProbability: null,
        shippingProbability: estimate.probability,
        deliveryAt,
        elapsedStageDays,
        features,
      });
      predictions.set(deal.id, prediction);
    }

    const assemblyStartEpisodes = shippingBundle.byStageId.get(input.assemblyStartStageId) ?? [];
    const medianShippingDays = weightedDurationQuantile(shippingDurations, 0.5, input.now);
    for (const group of input.paymentGroups) {
      const bundle = paymentBundles.get(group.key)!;
      const pipelineEpisodes = [...bundle.byStageId.values()].flat();
      for (const deal of group.deals) {
        const context = this.featureContexts.get(deal.id) ?? fallbackFeatureContext(deal);
        const features = context.features;
        const stageEpisodes = bundle.byStageId.get(deal.stageId) ?? [];
        const enteredAt = bundle.latestEntryByDealStage.get(dealStageKey(deal.id, deal.stageId)) ?? deal.createdAt;
        const elapsedStageDays = durationDays(enteredAt, input.now);
        const broadEstimate = scoreDeadlineProbability(pipelineEpisodes, {
          now: input.now,
          horizonDays: daysLeft,
          elapsedDays: elapsedStageDays,
          currentFeatures: features,
          priorProbability: 0.2,
          priorWeight: 8,
        });
        const paymentCurve = buildDeadlineProbabilityCurve(stageEpisodes, {
          now: input.now,
          maxHorizonDays: Math.ceil(daysLeft),
          elapsedDays: elapsedStageDays,
          currentFeatures: features,
          priorProbability: broadEstimate.probability,
          priorWeight: 8,
        });

        let previousPaymentProbability = 0;
        let jointProbability = 0;
        let weightedShippingProbability = 0;
        for (let day = 1; day <= paymentCurve.length; day += 1) {
          const paymentProbability = paymentCurve[day - 1].probability;
          const paymentOnDayProbability = Math.max(0, paymentProbability - previousPaymentProbability);
          const remainingShippingDays = Math.max(0, daysLeft - day);
          const shippingEstimate = scoreDeadlineProbability(assemblyStartEpisodes, {
            now: input.now,
            horizonDays: remainingShippingDays,
            elapsedDays: 0,
            currentFeatures: features,
            priorProbability: 0.35,
            priorWeight: 8,
          });
          jointProbability += paymentOnDayProbability * shippingEstimate.probability;
          weightedShippingProbability += paymentOnDayProbability * shippingEstimate.probability;
          previousPaymentProbability = paymentProbability;
        }

        const finalPaymentEstimate = paymentCurve[paymentCurve.length - 1] ?? broadEstimate;
        const predictedPaymentDay = probabilityMedianDay(paymentCurve);
        const predictedShipAt = predictedPaymentDay === null
          ? null
          : addDays(input.now, predictedPaymentDay + (medianShippingDays ?? 0));
        const estimate: ForecastProbabilityEstimate = {
          ...finalPaymentEstimate,
          probability: clamp(jointProbability, 0, 0.995),
          baseProbability: clamp(finalPaymentEstimate.baseProbability, 0, 0.995),
        };
        const prediction = buildPrediction({
          estimate,
          probabilitySource: 'deadline_model',
          predictedShipAt,
          paymentProbability: finalPaymentEstimate.probability,
          shippingProbability: previousPaymentProbability > 0
            ? weightedShippingProbability / previousPaymentProbability
            : 0,
          deliveryAt: null,
          elapsedStageDays,
          features,
        });
        predictions.set(deal.id, prediction);
      }
    }

    if (deliveryObservations.length < 30) {
      warnings.push('История Delivery пока мала: дата дополнительно сглаживается историей текущего этапа.');
    }

    const durationValues = shippingDurations.map((item) => item.durationDays);
    const snapshotRows = currentDealIds.map((dealId) => {
      const deal = input.assemblyDeals.find((item) => item.id === dealId)
        ?? input.paymentGroups.flatMap((group) => group.deals).find((item) => item.id === dealId)!;
      const context = this.featureContexts.get(dealId) ?? fallbackFeatureContext(deal);
      return {
        dealId,
        dealExternalId: deal.externalId,
        stageId: deal.stageId,
        amount: Number(deal.amount ?? 0),
        prediction: predictions.get(dealId)!,
        featureKeys: scrubFeatureKeys(context.features.keys),
      };
    });

    return {
      modelVersion: MODEL_VERSION,
      predictions,
      shippingCycle: {
        avgDays: average(durationValues),
        medianDays: weightedDurationQuantile(shippingDurations, 0.5, input.now),
        p65Days: weightedDurationQuantile(shippingDurations, 0.65, input.now),
        sampleSize: shippingDurations.length,
        basis: 'Когорты Сборки за 180 дней с пониженным весом старых сделок',
      },
      deliveryCalibration: {
        sampleSize: deliveryObservations.length,
        medianErrorDays: weightedDurationQuantile(deliveryErrors, 0.5, input.now),
      },
      assemblyCohort: {
        monthCount: assemblyCohort.monthCount,
        sampleSize: assemblyCohort.observations.length,
        shipped: assemblyCohort.shipped,
        shipmentRatePercent: assemblyCohort.observations.length
          ? Math.round((assemblyCohort.shipped / assemblyCohort.observations.length) * 1000) / 10
          : null,
      },
      warnings,
      snapshotRows,
    };
  }

  private async buildAssemblyMonthlyCohort(options: {
    stageIds: string[];
    shippingDoneStageId: string;
    now: Date;
    daysLeft: number;
  }): Promise<AssemblyCohortBundle> {
    const windows = historicalAssemblyCohortWindows(options.now, options.daysLeft, ASSEMBLY_COHORT_MONTHS);
    if (!windows.length || !options.stageIds.length) return { observations: [], monthCount: 0, shipped: 0 };

    const earliestCutoff = windows[0].cutoffAt;
    const latestCutoff = windows[windows.length - 1].cutoffAt;
    const latestMonthEnd = windows[windows.length - 1].monthEnd;
    const intervals = await this.db.factDealStageInterval.findMany({
      where: {
        stageId: { in: options.stageIds },
        enteredAt: { lte: latestCutoff },
        OR: [{ exitedAt: null }, { exitedAt: { gt: earliestCutoff } }],
      },
      select: {
        dealId: true,
        stageId: true,
        stageName: true,
        enteredAt: true,
        exitedAt: true,
      },
    });
    const dealIds = [...new Set(intervals.map((interval) => interval.dealId))];
    if (!dealIds.length) return { observations: [], monthCount: 0, shipped: 0 };

    const shipments = await this.db.factStageTransition.findMany({
      where: {
        dealId: { in: dealIds },
        toStageId: options.shippingDoneStageId,
        movedAt: { gt: earliestCutoff, lte: latestMonthEnd },
      },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, movedAt: true },
    });
    await this.loadFeatureContexts(dealIds);
    const shipmentsByDeal = groupBy(shipments, (shipment) => shipment.dealId);
    const observations: ForecastBinaryObservation[] = [];
    const sampledMonths = new Set<number>();
    let shipped = 0;

    for (const window of windows) {
      const activeByDeal = new Map<string, typeof intervals[number]>();
      for (const interval of intervals) {
        if (interval.enteredAt > window.cutoffAt) continue;
        if (interval.exitedAt && interval.exitedAt <= window.cutoffAt) continue;
        const current = activeByDeal.get(interval.dealId);
        if (!current || current.enteredAt < interval.enteredAt) activeByDeal.set(interval.dealId, interval);
      }
      if (!activeByDeal.size) continue;
      sampledMonths.add(window.monthEnd.getTime());

      for (const interval of activeByDeal.values()) {
        const didShip = (shipmentsByDeal.get(interval.dealId) ?? []).some((shipment) => (
          shipment.movedAt > window.cutoffAt && shipment.movedAt <= window.monthEnd
        ));
        if (didShip) shipped += 1;
        const context = this.featureContexts.get(interval.dealId);
        const baseFeatures = context?.features ?? buildForecastFeatureSet({});
        const elapsedDays = durationDays(interval.enteredAt, window.cutoffAt);
        const features = assemblyCohortFeatures(
          baseFeatures,
          interval.stageId,
          interval.stageName,
          elapsedDays,
        );
        observations.push({
          observedAt: window.monthEnd,
          value: didShip,
          featureKeys: features.keys,
        });
      }
    }

    return { observations, monthCount: sampledMonths.size, shipped };
  }

  private async buildStageEpisodes(options: {
    stageIds: string[];
    successStageIds: string[];
    lossStageIds: string[];
    now: Date;
  }): Promise<StageEpisodeBundle> {
    const trainingFrom = addDays(options.now, -180);
    const entries = await this.db.factStageTransition.findMany({
      where: { toStageId: { in: options.stageIds }, movedAt: { gte: trainingFrom, lte: options.now } },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, fromStageId: true, toStageId: true, movedAt: true, responsibleId: true },
    });
    const latestEntryByDealStage = new Map<string, StageHistoryRow>();
    for (const entry of entries) latestEntryByDealStage.set(dealStageKey(entry.dealId, entry.toStageId), entry);
    const dealIds = [...new Set(entries.map((entry) => entry.dealId))];
    if (!dealIds.length) return { byStageId: new Map(), latestEntryByDealStage: new Map() };

    const histories = await this.db.factStageTransition.findMany({
      where: { dealId: { in: dealIds }, movedAt: { gte: trainingFrom, lte: options.now } },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, fromStageId: true, toStageId: true, movedAt: true, responsibleId: true },
    });
    await this.loadFeatureContexts(dealIds);

    const historiesByDeal = groupBy(histories, (item) => item.dealId);
    const byStageId = new Map<string, ForecastDeadlineEpisode[]>();
    const latestDates = new Map<string, Date>();

    for (const [key, entry] of latestEntryByDealStage) {
      const dealHistory = historiesByDeal.get(entry.dealId) ?? [];
      const afterEntry = dealHistory.filter((item) => item.movedAt > entry.movedAt);
      const terminal = afterEntry.find((item) => (
        options.successStageIds.includes(item.toStageId) || options.lossStageIds.includes(item.toStageId)
      ));
      const exit = afterEntry.find((item) => item.fromStageId === entry.toStageId);
      const context = this.featureContexts.get(entry.dealId);
      const managerId = entry.responsibleId ?? context?.responsibleId ?? null;
      const features = context ? buildForecastFeatureSet({ ...context.input, managerId }) : buildForecastFeatureSet({ managerId });
      const outcome = terminal
        ? (options.successStageIds.includes(terminal.toStageId) ? 'won' : 'lost')
        : 'open';
      const episode: ForecastDeadlineEpisode = {
        entryAt: entry.movedAt,
        observedUntil: terminal?.movedAt ?? options.now,
        outcome,
        outcomeAt: terminal?.movedAt ?? null,
        exitedAt: exit?.movedAt ?? null,
        featureKeys: features.keys,
      };
      const stageEpisodes = byStageId.get(entry.toStageId) ?? [];
      stageEpisodes.push(episode);
      byStageId.set(entry.toStageId, stageEpisodes);
      latestDates.set(key, entry.movedAt);
    }
    return { byStageId, latestEntryByDealStage: latestDates };
  }

  private async loadDeliveryObservations(shippingDoneStageId: string, now: Date) {
    const events = await this.db.crmEvent.findMany({
      where: {
        type: `custom_field_${this.fieldIds.delivery}_value_changed`,
        createdAt: { gte: addDays(now, -365), lte: now },
        dealId: { not: null },
      },
      orderBy: [{ dealId: 'asc' }, { createdAt: 'asc' }],
      select: { dealId: true, createdAt: true, valueAfter: true },
    });
    const usableEvents = events
      .map((event) => ({ ...event, deliveryAt: dateFromEventValue(event.valueAfter) }))
      .filter((event): event is typeof event & { dealId: string; deliveryAt: Date } => Boolean(event.dealId && event.deliveryAt));
    const dealIds = [...new Set(usableEvents.map((event) => event.dealId))];
    if (!dealIds.length) return [];
    const shipments = await this.db.factStageTransition.findMany({
      where: { dealId: { in: dealIds }, toStageId: shippingDoneStageId },
      orderBy: [{ dealId: 'asc' }, { movedAt: 'asc' }],
      select: { dealId: true, movedAt: true },
    });
    await this.loadFeatureContexts(dealIds);
    const shipmentsByDeal = groupBy(shipments, (item) => item.dealId);
    const latestByShipment = new Map<string, typeof usableEvents[number] & { shippedAt: Date }>();
    for (const event of usableEvents) {
      const shippedAt = (shipmentsByDeal.get(event.dealId) ?? []).find((item) => item.movedAt > event.createdAt)?.movedAt;
      if (!shippedAt) continue;
      latestByShipment.set(`${event.dealId}:${shippedAt.toISOString()}`, { ...event, shippedAt });
    }
    const observations: ForecastDeliveryObservation[] = [];
    for (const event of latestByShipment.values()) {
      const features = this.featureContexts.get(event.dealId)?.features ?? buildForecastFeatureSet({});
      observations.push({
        observedAt: event.shippedAt,
        errorDays: moscowCalendarDayDiff(event.deliveryAt, event.shippedAt),
        featureKeys: features.keys,
      });
    }
    return observations;
  }

  private async loadFeatureContexts(dealIds: string[]) {
    const missingIds = [...new Set(dealIds)].filter((dealId) => !this.featureContexts.has(dealId));
    for (let offset = 0; offset < missingIds.length; offset += 500) {
      const chunk = missingIds.slice(offset, offset + 500);
      if (!chunk.length) continue;
      const rows = await this.db.$queryRaw<Array<{
        id: string;
        external_id: string;
        responsible_id: string | null;
        amount: number;
        tags: string[];
        configuration: unknown;
        quantity: unknown;
        delivery: unknown;
        express_delivery: unknown;
        express_assembly: unknown;
        country: unknown;
        corporate_email: unknown;
        email: string | null;
        phone: string | null;
      }>>(Prisma.sql`
        SELECT
          d.id,
          d."externalId" AS external_id,
          d."responsibleId" AS responsible_id,
          d.amount::double precision AS amount,
          d.tags,
          d."customFields" -> ${this.fieldIds.configuration} AS configuration,
          d."customFields" -> ${this.fieldIds.quantity} AS quantity,
          d."customFields" -> ${this.fieldIds.delivery} AS delivery,
          d."customFields" -> ${this.fieldIds.expressDelivery} AS express_delivery,
          d."customFields" -> ${this.fieldIds.expressAssembly} AS express_assembly,
          d."customFields" -> ${this.fieldIds.country} AS country,
          d."customFields" -> ${this.fieldIds.corporateEmail} AS corporate_email,
          COALESCE(c.email, linked.email) AS email,
          COALESCE(c.phone, linked.phone) AS phone
        FROM "Deal" d
        LEFT JOIN "Contact" c ON c.id = d."contactId"
        LEFT JOIN LATERAL (
          SELECT contact.email, contact.phone
          FROM jsonb_array_elements(COALESCE(d.raw->'_embedded'->'contacts', '[]'::jsonb)) AS contact_ref(value)
          JOIN "Contact" contact ON contact."externalId" = contact_ref.value->>'id'
          ORDER BY COALESCE((contact_ref.value->>'is_main')::boolean, false) DESC
          LIMIT 1
        ) linked ON TRUE
        WHERE d.id IN (${Prisma.join(chunk)})
      `);
      for (const row of rows) {
        const configuration = fieldText(row.configuration);
        const quantity = fieldNumber(row.quantity);
        const country = fieldText(row.country);
        const email = row.email ?? fieldText(row.corporate_email);
        const express = fieldBoolean(row.express_delivery) || fieldBoolean(row.express_assembly);
        const clientIdentity = [emailDomain(email), normalizePhone(row.phone)].filter(Boolean).join('|');
        const clientKey = clientIdentity
          ? createHash('sha256').update(clientIdentity).digest('hex').slice(0, 16)
          : null;
        const input: ForecastFeatureInput = {
          managerId: row.responsible_id,
          amount: row.amount,
          tags: row.tags ?? [],
          configuration,
          quantity,
          country,
          email,
          phone: row.phone,
          clientKey,
          express,
        };
        this.featureContexts.set(row.id, {
          dealId: row.id,
          dealExternalId: row.external_id,
          amount: Number(row.amount ?? 0),
          responsibleId: row.responsible_id,
          deliveryAt: dateFromField(row.delivery),
          input,
          features: buildForecastFeatureSet(input),
        });
      }
    }
  }

  private retainFeatureContexts(dealIds: string[]) {
    const keep = new Set(dealIds);
    for (const dealId of this.featureContexts.keys()) {
      if (!keep.has(dealId)) this.featureContexts.delete(dealId);
    }
  }

  private async resolveFieldIds(): Promise<ForecastFieldIds> {
    const fields = await this.db.customFieldDefinition.findMany({
      select: { externalId: true, name: true },
    });
    const byName = (names: string[], fallback: string) => {
      const normalized = names.map(normalizeText);
      return fields.find((field) => normalized.includes(normalizeText(field.name)))?.externalId ?? fallback;
    };
    return {
      configuration: byName(['Конфигурация из КП'], '791441'),
      quantity: byName(['Кол-во серверов', 'Количество серверов'], '791471'),
      delivery: byName(['Отгрузка примерно (Delivery)'], '808613'),
      expressDelivery: byName(['Express Доставка'], '810441'),
      expressAssembly: byName(['Express Сборка'], '810443'),
      country: byName(['Country', 'Страна'], '814703'),
      corporateEmail: byName(['Corporate email', 'Корпоративный email'], '814707'),
    };
  }

  private stagePredictedDate(
    episodes: ForecastDeadlineEpisode[],
    elapsedDays: number,
    now: Date,
    features: ForecastFeatureSet,
  ) {
    const durations = completedDurations(episodes)
      .filter((item) => item.durationDays > elapsedDays)
      .map((item) => ({ ...item, durationDays: item.durationDays - elapsedDays }));
    const remainingMedian = weightedDurationQuantile(durations, 0.5, now, features.keys);
    return remainingMedian === null ? null : addDays(now, remainingMedian);
  }
}

function buildPrediction(input: {
  estimate: ForecastProbabilityEstimate;
  probabilitySource: RevenueForecastPrediction['probabilitySource'];
  predictedShipAt: Date | null;
  paymentProbability: number | null;
  shippingProbability: number;
  deliveryAt: Date | null;
  elapsedStageDays: number;
  features: ForecastFeatureSet;
}): RevenueForecastPrediction {
  const probability = clamp(input.estimate.probability, 0, 1);
  return {
    probability,
    probabilityPercent: Math.round(probability * 100),
    baseProbabilityPercent: Math.round(input.estimate.baseProbability * 100),
    reliabilityPercent: Math.round(input.estimate.confidence * 100),
    probabilitySample: input.estimate.sampleSize,
    probabilitySource: input.probabilitySource,
    predictedShipAt: input.predictedShipAt,
    paymentProbabilityPercent: input.paymentProbability === null ? null : Math.round(input.paymentProbability * 100),
    shippingProbabilityPercent: Math.round(clamp(input.shippingProbability, 0, 1) * 100),
    deliveryAt: input.deliveryAt,
    elapsedStageDays: Number(input.elapsedStageDays.toFixed(1)),
    drivers: input.estimate.drivers,
    featureSummary: input.features.summary,
  };
}

function completedDurations(episodes: ForecastDeadlineEpisode[]): ForecastDurationObservation[] {
  return episodes
    .filter((episode) => episode.outcome === 'won' && episode.outcomeAt)
    .map((episode) => ({
      observedAt: episode.outcomeAt!,
      durationDays: durationDays(episode.entryAt, episode.outcomeAt!),
      featureKeys: episode.featureKeys,
    }));
}

function probabilityMedianDay(curve: ForecastProbabilityEstimate[]) {
  const finalProbability = curve[curve.length - 1]?.probability ?? 0;
  if (finalProbability <= 0) return null;
  const target = finalProbability / 2;
  const index = curve.findIndex((item) => item.probability >= target);
  return index < 0 ? null : index + 1;
}

function conservativeStagePrior(position: number) {
  if (position >= 170) return 0.65;
  if (position >= 130) return 0.55;
  if (position >= 100) return 0.45;
  if (position >= 70) return 0.35;
  if (position >= 50) return 0.25;
  return 0.15;
}

function historicalAssemblyCohortWindows(now: Date, daysLeft: number, monthCount: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  return Array.from({ length: monthCount }, (_, index) => {
    const monthsBack = monthCount - index;
    const monthEnd = new Date(Date.UTC(year, month - monthsBack, 0, 20, 59, 59, 999));
    const monthStart = new Date(Date.UTC(year, month - monthsBack - 1, 0, 21, 0, 0, 0));
    const requestedCutoff = addDays(monthEnd, -daysLeft);
    return {
      monthEnd,
      cutoffAt: requestedCutoff < monthStart ? monthStart : requestedCutoff,
    };
  });
}

function assemblyCohortFeatures(
  features: ForecastFeatureSet,
  stageId: string,
  stageName: string,
  elapsedDays: number,
): ForecastFeatureSet {
  const elapsed = assemblyElapsedBucket(elapsedDays);
  const stageKey = `assembly_stage:${stageId}`;
  const elapsedKey = `assembly_elapsed:${elapsed.key}`;
  return {
    ...features,
    keys: [...new Set([...features.keys, stageKey, elapsedKey])],
    labels: {
      ...features.labels,
      [stageKey]: stageName ? `история этапа ${stageName}` : 'история этапа сборки',
      [elapsedKey]: `на этапе ${elapsed.label}`,
    },
  };
}

function assemblyElapsedBucket(days: number) {
  if (days < 3) return { key: '0-3', label: 'до 3 дней' };
  if (days < 7) return { key: '3-7', label: '3–7 дней' };
  if (days < 14) return { key: '7-14', label: '7–14 дней' };
  if (days < 30) return { key: '14-30', label: '14–30 дней' };
  return { key: '30+', label: 'более 30 дней' };
}

function fallbackFeatureContext(deal: ForecastDeal): FeatureContext {
  const input: ForecastFeatureInput = {
    managerId: deal.responsibleId,
    amount: Number(deal.amount ?? 0),
    tags: deal.tags ?? [],
  };
  return {
    dealId: deal.id,
    dealExternalId: deal.externalId,
    amount: Number(deal.amount ?? 0),
    responsibleId: deal.responsibleId ?? null,
    deliveryAt: null,
    input,
    features: buildForecastFeatureSet(input),
  };
}

function dateFromEventValue(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return null;
  const first = value[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  const customField = (first as any).custom_field_value;
  return dateFromScalar(customField?.timestamp ?? customField?.text ?? null);
}

function dateFromField(field: any) {
  return dateFromScalar(field?.value ?? field?.values?.[0] ?? field);
}

function dateFromScalar(value: unknown) {
  if (value instanceof Date) return value;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value ?? ''))) {
    const number = Number(value);
    const date = new Date(number < 10_000_000_000 ? number * 1000 : number);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

function fieldText(field: any) {
  const value = field?.value ?? field?.values ?? field;
  const values = Array.isArray(value) ? value : [value];
  const text = values
    .flatMap((item) => (item && typeof item === 'object' ? [item.value ?? item.text] : [item]))
    .filter((item) => item !== null && item !== undefined && item !== '')
    .map(String)
    .join(', ')
    .trim();
  return text || null;
}

function fieldNumber(field: any) {
  const text = fieldText(field);
  if (!text) return null;
  const number = Number(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function fieldBoolean(field: any) {
  const value = normalizeText(fieldText(field));
  return ['1', 'true', 'yes', 'да', 'включено'].includes(value);
}

function emailDomain(email: string | null) {
  return String(email ?? '').trim().toLowerCase().match(/@([^\s>,;]+)/)?.[1] ?? '';
}

function normalizePhone(phone: string | null) {
  return String(phone ?? '').replace(/\D/g, '');
}

function scrubFeatureKeys(keys: string[]) {
  return keys.map((key) => key.startsWith('client:') ? 'client:hashed' : key);
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const group = result.get(value) ?? [];
    group.push(item);
    result.set(value, group);
  }
  return result;
}

function dealStageKey(dealId: string, stageId: string) {
  return `${dealId}:${stageId}`;
}

function durationDays(from: Date, to: Date) {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
}

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * DAY_MS);
}

function moscowCalendarDayDiff(from: Date, to: Date) {
  return moscowDateSerial(to) - moscowDateSerial(from);
}

function moscowDateSerial(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
