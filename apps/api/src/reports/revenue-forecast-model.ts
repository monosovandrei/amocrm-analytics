export type ForecastOutcome = 'won' | 'lost' | 'open';

export type ForecastDeadlineEpisode = {
  entryAt: Date;
  observedUntil: Date;
  outcome: ForecastOutcome;
  outcomeAt?: Date | null;
  exitedAt?: Date | null;
  featureKeys: string[];
};

export type ForecastDurationObservation = {
  observedAt: Date;
  durationDays: number;
  featureKeys: string[];
};

export type ForecastDeliveryObservation = {
  observedAt: Date;
  errorDays: number;
  featureKeys: string[];
};

export type ForecastFeatureSet = {
  keys: string[];
  labels: Record<string, string>;
  summary: {
    condition: 'new' | 'refurbished' | 'unknown';
    serverBase: string | null;
    quantity: number | null;
    complexity: 'low' | 'medium' | 'high';
    country: string | null;
    emailKind: 'corporate' | 'free' | 'unknown';
  };
};

export type ForecastProbabilityDriver = {
  key: string;
  label: string;
  direction: 'up' | 'down';
  impactPoints: number;
  sampleWeight: number;
};

export type ForecastProbabilityEstimate = {
  probability: number;
  baseProbability: number;
  sampleSize: number;
  sampleWeight: number;
  confidence: number;
  source: 'model' | 'prior';
  drivers: ForecastProbabilityDriver[];
};

type ScoreOptions = {
  now: Date;
  horizonDays: number;
  elapsedDays?: number;
  currentFeatures?: ForecastFeatureSet;
  priorProbability?: number;
  priorWeight?: number;
  halfLifeDays?: number;
};

type WeightedBinaryObservation = {
  value: boolean;
  weight: number;
  featureKeys: Set<string>;
};

const DAY_MS = 86_400_000;
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'mail.ru',
  'yandex.ru',
  'proton.me',
  'protonmail.com',
]);

const DRIVER_LABELS: Record<string, string> = {
  manager: 'история ответственного',
  client: 'история клиента',
  amount: 'сумма сделки',
  condition: 'новое / Refurbished',
  base: 'серверная база',
  quantity: 'количество единиц',
  complexity: 'сложность конфигурации',
  country: 'страна и маршрут',
  source: 'источник лида',
  domain: 'тип email-домена',
  phone: 'код страны телефона',
  express: 'Express',
  tag: 'теги сделки',
};

const FAMILY_WEIGHTS: Record<string, number> = {
  manager: 0.9,
  client: 0.75,
  amount: 0.45,
  condition: 0.45,
  base: 0.35,
  quantity: 0.35,
  complexity: 0.4,
  country: 0.35,
  source: 0.25,
  domain: 0.25,
  phone: 0.2,
  express: 0.4,
  tag: 0.2,
};

export function scoreDeadlineProbability(
  episodes: ForecastDeadlineEpisode[],
  options: ScoreOptions,
): ForecastProbabilityEstimate {
  const horizonDays = Math.max(0, options.horizonDays);
  if (horizonDays <= 0) return emptyEstimate(0);
  const elapsedDays = Math.max(0, options.elapsedDays ?? 0);
  const observations: WeightedBinaryObservation[] = [];

  for (const episode of episodes) {
    const observedDays = durationDays(episode.entryAt, episode.observedUntil);
    const outcomeDays = episode.outcomeAt ? durationDays(episode.entryAt, episode.outcomeAt) : null;
    const exitedDays = episode.exitedAt ? durationDays(episode.entryAt, episode.exitedAt) : null;

    if (outcomeDays !== null && outcomeDays <= elapsedDays) continue;
    if (exitedDays !== null && exitedDays <= elapsedDays) continue;

    const terminal = episode.outcome !== 'open' && outcomeDays !== null;
    if (!terminal && observedDays < elapsedDays + horizonDays) continue;

    observations.push({
      value: episode.outcome === 'won' && outcomeDays !== null && outcomeDays <= elapsedDays + horizonDays,
      weight: recencyWeight(episode.entryAt, options.now, options.halfLifeDays ?? 60),
      featureKeys: new Set(episode.featureKeys),
    });
  }

  return scoreWeightedBinary(observations, options);
}

export function buildDeadlineProbabilityCurve(
  episodes: ForecastDeadlineEpisode[],
  options: Omit<ScoreOptions, 'horizonDays'> & { maxHorizonDays: number },
) {
  const curve: ForecastProbabilityEstimate[] = [];
  let previous = 0;
  for (let day = 1; day <= Math.max(0, Math.ceil(options.maxHorizonDays)); day += 1) {
    const estimate = scoreDeadlineProbability(episodes, { ...options, horizonDays: day });
    const probability = Math.max(previous, estimate.probability);
    curve.push({ ...estimate, probability });
    previous = probability;
  }
  return curve;
}

export function scoreDurationProbability(
  observations: ForecastDurationObservation[],
  maxDurationDays: number,
  options: Omit<ScoreOptions, 'horizonDays' | 'elapsedDays'>,
) {
  if (maxDurationDays < 0) return emptyEstimate(0);
  return scoreWeightedBinary(
    observations.map((item) => ({
      value: item.durationDays <= maxDurationDays,
      weight: recencyWeight(item.observedAt, options.now, options.halfLifeDays ?? 60),
      featureKeys: new Set(item.featureKeys),
    })),
    { ...options, horizonDays: maxDurationDays },
  );
}

export function scoreDeliveryProbability(
  observations: ForecastDeliveryObservation[],
  maximumErrorDays: number,
  options: Omit<ScoreOptions, 'horizonDays' | 'elapsedDays'>,
) {
  return scoreWeightedBinary(
    observations.map((item) => ({
      value: item.errorDays <= maximumErrorDays,
      weight: recencyWeight(item.observedAt, options.now, options.halfLifeDays ?? 90),
      featureKeys: new Set(item.featureKeys),
    })),
    { ...options, horizonDays: Math.max(1, maximumErrorDays) },
  );
}

export function weightedDurationQuantile(
  observations: ForecastDurationObservation[],
  quantile: number,
  now: Date,
  featureKeys: string[] = [],
) {
  const requested = new Set(featureKeys);
  const matching = observations.filter((item) => item.featureKeys.some((key) => requested.has(key)));
  const source = matching.length >= 8 ? matching : observations;
  const values = source
    .filter((item) => Number.isFinite(item.durationDays))
    .map((item) => ({
      value: item.durationDays,
      weight: recencyWeight(item.observedAt, now, 90),
    }))
    .sort((a, b) => a.value - b.value);
  if (!values.length) return null;
  const target = clamp(quantile, 0, 1) * values.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of values) {
    cumulative += item.weight;
    if (cumulative >= target) return item.value;
  }
  return values[values.length - 1].value;
}

export function buildForecastFeatureSet(input: {
  managerId?: string | null;
  amount?: number | null;
  tags?: string[] | null;
  configuration?: string | null;
  quantity?: number | null;
  country?: string | null;
  email?: string | null;
  phone?: string | null;
  clientKey?: string | null;
  express?: boolean;
}): ForecastFeatureSet {
  const keys = new Set<string>();
  const labels: Record<string, string> = {};
  const add = (family: string, value: unknown, label?: string) => {
    const normalized = normalizeToken(value);
    if (!normalized) return;
    const key = `${family}:${normalized}`;
    keys.add(key);
    labels[key] = label ?? DRIVER_LABELS[family] ?? family;
  };

  add('manager', input.managerId);
  add('amount', amountBand(Number(input.amount ?? 0)));
  if (input.clientKey) add('client', input.clientKey);

  const configuration = String(input.configuration ?? '');
  const configurationNormalized = normalizeText(configuration);
  const condition = /refurb|renew|used|second\s*hand|\bbu\b/.test(configurationNormalized)
    ? 'refurbished'
    : /\bnew\b|factory|brand\s*new/.test(configurationNormalized)
      ? 'new'
      : 'unknown';
  if (condition !== 'unknown') add('condition', condition);

  const serverBase = extractServerBase(configurationNormalized);
  if (serverBase) add('base', serverBase);

  const quantity = normalizeQuantity(input.quantity, configurationNormalized);
  if (quantity !== null) add('quantity', quantityBand(quantity));

  const complexity = configurationComplexity(configurationNormalized, quantity);
  add('complexity', complexity);

  const tagValues = (input.tags ?? []).map((tag) => normalizeText(tag)).filter(Boolean);
  for (const tag of tagValues) {
    if (/^(source|dest)[-_\s]/.test(tag)) {
      const [prefix, ...rest] = tag.split(/[-_\s]+/);
      add(prefix === 'source' ? 'source' : 'country', rest.join('-'));
      continue;
    }
    if (tag.includes('express')) add('express', 'yes');
    if (['regular', 'ntr', 'не сервер'].includes(tag)) add('tag', tag);
  }

  const country = normalizeText(input.country);
  if (country) add('country', country);
  if (input.express) add('express', 'yes');

  const domain = emailDomain(input.email);
  const emailKind = domain ? (FREE_EMAIL_DOMAINS.has(domain) ? 'free' : 'corporate') : 'unknown';
  if (emailKind !== 'unknown') add('domain', emailKind);

  const phonePrefix = normalizePhonePrefix(input.phone);
  if (phonePrefix) add('phone', phonePrefix);

  return {
    keys: [...keys],
    labels,
    summary: {
      condition,
      serverBase,
      quantity,
      complexity,
      country: country || tagCountry(tagValues),
      emailKind,
    },
  };
}

export function forecastExpectedDate(start: Date, medianDays: number | null) {
  if (medianDays === null || !Number.isFinite(medianDays)) return null;
  return new Date(start.getTime() + Math.max(0, medianDays) * DAY_MS);
}

function scoreWeightedBinary(
  observations: WeightedBinaryObservation[],
  options: ScoreOptions,
): ForecastProbabilityEstimate {
  const priorProbability = clamp(options.priorProbability ?? 0.2, 0.01, 0.99);
  const priorWeight = Math.max(1, options.priorWeight ?? 8);
  const sampleWeight = observations.reduce((sum, item) => sum + item.weight, 0);
  const winsWeight = observations.reduce((sum, item) => sum + (item.value ? item.weight : 0), 0);
  const baseProbability = clamp(
    (winsWeight + priorProbability * priorWeight) / Math.max(sampleWeight + priorWeight, 1),
    0.005,
    0.995,
  );
  const featureKeys = options.currentFeatures?.keys ?? [];
  let totalLogitAdjustment = 0;
  const drivers: ForecastProbabilityDriver[] = [];

  for (const key of featureKeys) {
    const family = key.split(':', 1)[0];
    const familyWeight = FAMILY_WEIGHTS[family] ?? 0.15;
    const matching = observations.filter((item) => item.featureKeys.has(key));
    const matchingWeight = matching.reduce((sum, item) => sum + item.weight, 0);
    if (matchingWeight < 2) continue;
    const matchingWins = matching.reduce((sum, item) => sum + (item.value ? item.weight : 0), 0);
    const featurePriorWeight = 14;
    const posterior = clamp(
      (matchingWins + baseProbability * featurePriorWeight) / (matchingWeight + featurePriorWeight),
      0.005,
      0.995,
    );
    const reliability = matchingWeight / (matchingWeight + 8);
    const rawAdjustment = clamp(logit(posterior) - logit(baseProbability), -0.7, 0.7);
    const adjustment = rawAdjustment * familyWeight * reliability;
    if (Math.abs(adjustment) < 0.01) continue;
    totalLogitAdjustment += adjustment;
    const isolatedProbability = sigmoid(logit(baseProbability) + adjustment);
    drivers.push({
      key,
      label: options.currentFeatures?.labels[key] ?? DRIVER_LABELS[family] ?? family,
      direction: adjustment >= 0 ? 'up' : 'down',
      impactPoints: Math.round(Math.abs(isolatedProbability - baseProbability) * 100),
      sampleWeight: Number(matchingWeight.toFixed(1)),
    });
  }

  totalLogitAdjustment = clamp(totalLogitAdjustment, -1.25, 1.25);
  const probability = clamp(sigmoid(logit(baseProbability) + totalLogitAdjustment), 0.005, 0.995);
  const confidence = clamp((sampleWeight / (sampleWeight + 25)) * 0.8 + Math.min(drivers.length, 3) * 0.05, 0, 0.95);

  return {
    probability,
    baseProbability,
    sampleSize: observations.length,
    sampleWeight: Number(sampleWeight.toFixed(1)),
    confidence,
    source: observations.length ? 'model' : 'prior',
    drivers: drivers
      .sort((a, b) => b.impactPoints - a.impactPoints || b.sampleWeight - a.sampleWeight)
      .slice(0, 4),
  };
}

function emptyEstimate(probability: number): ForecastProbabilityEstimate {
  return {
    probability,
    baseProbability: probability,
    sampleSize: 0,
    sampleWeight: 0,
    confidence: 0,
    source: 'prior',
    drivers: [],
  };
}

function recencyWeight(observedAt: Date, now: Date, halfLifeDays: number) {
  const ageDays = Math.max(0, durationDays(observedAt, now));
  return 0.5 ** (ageDays / Math.max(halfLifeDays, 1));
}

function durationDays(from: Date, to: Date) {
  return Math.max(0, (to.getTime() - from.getTime()) / DAY_MS);
}

function amountBand(amount: number) {
  if (amount <= 2_500) return '0-2500';
  if (amount <= 7_500) return '2500-7500';
  if (amount <= 15_000) return '7500-15000';
  if (amount <= 30_000) return '15000-30000';
  if (amount <= 75_000) return '30000-75000';
  return '75000+';
}

function quantityBand(quantity: number) {
  if (quantity <= 1) return '1';
  if (quantity <= 3) return '2-3';
  if (quantity <= 10) return '4-10';
  return '11+';
}

function normalizeQuantity(value: number | null | undefined, configuration: string) {
  if (Number.isFinite(value) && Number(value) > 0) return Math.round(Number(value));
  const match = configuration.match(/\b(\d{1,3})\s*(?:x|\u00d7)\s*(?:dell|hpe|hp|lenovo|supermicro|r\d{3,4}|dl\d{3,4}|sr\d{3,4})\b/i);
  if (!match) return null;
  const quantity = Number(match[1]);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function extractServerBase(configuration: string) {
  const patterns = [
    /\b(?:dell\s+)?(r\d{3,4}[a-z]{0,2})\b/i,
    /\b(?:hpe?\s+)?(dl\d{3,4}[a-z]{0,2})\b/i,
    /\b(?:lenovo\s+)?(sr\d{3,4}[a-z]{0,2})\b/i,
    /\b(supermicro)\b/i,
  ];
  for (const pattern of patterns) {
    const match = configuration.match(pattern);
    if (match?.[1]) return normalizeToken(match[1]);
  }
  return null;
}

function configurationComplexity(configuration: string, quantity: number | null) {
  let score = 0;
  if ((quantity ?? 1) >= 4) score += 2;
  if ((quantity ?? 1) >= 10) score += 1;
  for (const pattern of [/nvme/, /gpu|tesla|quadro/, /san|storage|jbod/, /custom|nonstandard/, /raid\s*(?:50|60)/, /\b4\s*cpu\b/]) {
    if (pattern.test(configuration)) score += 1;
  }
  if (configuration.split('\n').filter(Boolean).length >= 14) score += 1;
  if (score >= 4) return 'high' as const;
  if (score >= 2) return 'medium' as const;
  return 'low' as const;
}

function emailDomain(email: string | null | undefined) {
  const match = String(email ?? '').trim().toLowerCase().match(/@([^\s>,;]+)/);
  return match?.[1]?.replace(/[)>]+$/, '') ?? null;
}

function normalizePhonePrefix(phone: string | null | undefined) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  const knownPrefixes = [
    '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
    '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86',
    '90', '91', '92', '93', '94', '95', '98', '211', '212', '213', '216', '218', '220', '221', '222', '223', '224',
    '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239',
    '240', '241', '242', '243', '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255',
    '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291',
    '297', '298', '299', '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371',
    '372', '373', '374', '375', '376', '377', '378', '379', '380', '381', '382', '383', '385', '386', '387',
    '389', '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590',
    '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675',
    '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690',
    '691', '692', '850', '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964', '965',
    '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994',
    '995', '996', '998',
  ].sort((a, b) => b.length - a.length);
  const prefix = knownPrefixes.find((candidate) => digits.startsWith(candidate));
  return prefix ? `+${prefix}` : null;
}

function tagCountry(tags: string[]) {
  const tag = tags.find((value) => /^dest[-_\s]/.test(value));
  return tag ? tag.replace(/^dest[-_\s]+/, '') : null;
}

function normalizeText(value: unknown) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

function normalizeToken(value: unknown) {
  return normalizeText(value).replace(/[^a-z0-9а-я+._-]+/gi, '-').replace(/^-+|-+$/g, '');
}

function logit(value: number) {
  const safe = clamp(value, 0.0001, 0.9999);
  return Math.log(safe / (1 - safe));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
