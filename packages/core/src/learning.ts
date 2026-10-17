/**
 * Self-learning pipeline (real, measurable, reversible).
 *
 * Guarantees enforced here:
 *  - Only resolved, verified WIN/LOSS records with intact market data become
 *    labels. DRAW and UNRESOLVED are excluded (and counted as excluded).
 *  - Datasets are ordered chronologically; splits are chronological with an
 *    embargo so no test row can share a horizon window with a training row.
 *  - Every artefact carries a checksum over the canonical dataset + feature
 *    list + hyper-parameters, so a model can always be traced back to data.
 *  - Promotion requires beating explicit quality, calibration and regression
 *    gates against the current champion. Failure leaves the champion in place.
 */

import {
  FEATURE_NAMES,
  FEATURE_SET_VERSION,
  fromFeatureArray,
  toFeatureArray,
  type FeatureVector,
} from './features.js';
import { evaluate, logLoss, sigmoid, type EvaluationMetrics } from './stats.js';

export const LEARNING_VERSION = 'vortex-learning-1.0.0';

export interface ResolvedRecord {
  signalId: string;
  pair: string;
  strategy: string;
  regime: string;
  confidence: number;
  /** Entry boundary, ISO — the chronological key. */
  decidedAt: string;
  horizonSeconds: number;
  outcome: 'WIN' | 'LOSS' | 'DRAW' | 'UNRESOLVED' | null;
  outcomeFlags: string[];
  /** Persisted feature vector (FEATURE_NAMES order). */
  features: number[] | FeatureVector;
  modelProbability?: number | null;
  engineVersion?: string;
}

export interface DatasetExclusions {
  notResolved: number;
  draw: number;
  unresolved: number;
  invalidFeatures: number;
  duplicate: number;
  ineligibleFlags: number;
  /**
   * Rows recorded against a different prediction horizon (or without a usable
   * one). Mixing horizons would mix label semantics, so they are excluded and
   * counted rather than silently pooled.
   */
  horizonMismatch: number;
}

export interface TrainingSample {
  signalId: string;
  features: number[];
  label: 0 | 1;
  decidedAt: string;
  pair: string;
  strategy: string;
  regime: string;
  confidence: number;
  engineVersion: string;
}

export interface Dataset {
  samples: TrainingSample[];
  featureNames: readonly string[];
  exclusions: DatasetExclusions;
  from: string | null;
  to: string | null;
  checksum: string;
}

const DISQUALIFYING_FLAGS = [
  'entry_price_late',
  'exit_price_early',
  'missing_entry_candle',
  'missing_exit_candle',
  'invalid_price',
  'too_early',
  'exit_price_far_from_horizon',
];

/** Deterministic 64-bit FNV-1a hex digest (no native crypto dependency). */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) throw new Error('canonicalJson: circular structure');
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = walk((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export interface BuildDatasetOptions {
  /** Hash function for the checksum (sha256 in the worker, fnv1a64 in tests). */
  checksum?: (input: string) => string;
  /** Defaults to FEATURE_NAMES length. */
  expectedFeatures?: number;
  /**
   * When set, rows whose recorded horizon differs from this value (or cannot
   * be verified) are excluded as `horizonMismatch`. Callers that know the
   * configured horizon should always pass it: a 60-second label and a
   * one-hour label are not the same target.
   */
  expectedHorizonSeconds?: number;
}

export function buildDataset(records: ResolvedRecord[], options: BuildDatasetOptions = {}): Dataset {
  const checksumFn = options.checksum ?? fnv1a64;
  const expected = options.expectedFeatures ?? FEATURE_NAMES.length;
  const expectedHorizon =
    typeof options.expectedHorizonSeconds === 'number' && Number.isFinite(options.expectedHorizonSeconds)
      ? Math.round(options.expectedHorizonSeconds)
      : null;
  const exclusions: DatasetExclusions = {
    notResolved: 0,
    draw: 0,
    unresolved: 0,
    invalidFeatures: 0,
    duplicate: 0,
    ineligibleFlags: 0,
    horizonMismatch: 0,
  };
  const seen = new Set<string>();
  const samples: TrainingSample[] = [];

  for (const record of records) {
    if (!record.outcome) {
      exclusions.notResolved += 1;
      continue;
    }
    if (record.outcome === 'DRAW') {
      exclusions.draw += 1;
      continue;
    }
    if (record.outcome === 'UNRESOLVED') {
      exclusions.unresolved += 1;
      continue;
    }
    if (DISQUALIFYING_FLAGS.some((flag) => (record.outcomeFlags ?? []).includes(flag))) {
      exclusions.ineligibleFlags += 1;
      continue;
    }
    if (expectedHorizon !== null) {
      const horizon = record.horizonSeconds;
      const usable =
        typeof horizon === 'number' && Number.isFinite(horizon) && horizon > 0 && Math.round(horizon) === expectedHorizon;
      if (!usable) {
        exclusions.horizonMismatch += 1;
        continue;
      }
    }
    const features = Array.isArray(record.features) ? record.features : toFeatureArray(record.features as FeatureVector);
    if (features.length !== expected || features.some((f) => typeof f !== 'number' || !Number.isFinite(f))) {
      exclusions.invalidFeatures += 1;
      continue;
    }
    const key = `${record.pair}|${record.decidedAt}`;
    if (seen.has(key)) {
      exclusions.duplicate += 1;
      continue;
    }
    seen.add(key);
    samples.push({
      signalId: record.signalId,
      features: [...features],
      label: record.outcome === 'WIN' ? 1 : 0,
      decidedAt: record.decidedAt,
      pair: record.pair,
      strategy: record.strategy,
      regime: record.regime,
      confidence: record.confidence,
      engineVersion: record.engineVersion ?? 'unknown',
    });
  }

  samples.sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime() || a.signalId.localeCompare(b.signalId));

  const checksumPayload = {
    learningVersion: LEARNING_VERSION,
    featureSetVersion: FEATURE_SET_VERSION,
    featureNames: FEATURE_NAMES,
    // The target's horizon is part of the dataset identity: identical rows
    // scored against a different horizon are a different learning problem.
    horizonSeconds: expectedHorizon,
    samples: samples.map((s) => ({
      id: s.signalId,
      t: s.decidedAt,
      f: s.features.map((f) => Number(f.toFixed(8))),
      y: s.label,
    })),
  };

  return {
    samples,
    featureNames: FEATURE_NAMES,
    exclusions,
    from: samples[0]?.decidedAt ?? null,
    to: samples[samples.length - 1]?.decidedAt ?? null,
    checksum: checksumFn(canonicalJson(checksumPayload)),
  };
}

/* ------------------------------------------------------------------------- */
/* Chronological splitting                                                    */
/* ------------------------------------------------------------------------- */

export interface Split {
  train: TrainingSample[];
  validation: TrainingSample[];
  test: TrainingSample[];
  embargoSeconds: number;
  /** Number of rows removed by the embargo at each boundary. */
  embargoed: { validation: number; test: number };
  boundaries: { trainEnd: string | null; validationEnd: string | null };
}

/**
 * Chronological split with an embargo.
 *
 * `embargoSeconds` MUST be at least the prediction horizon: two rows whose
 * decision times are closer than one horizon share outcome candles, so a test
 * row inside that window would leak information back into training. Callers
 * that know the horizon should pass it (see `embargoForRecords`); the default
 * is a conservative floor, never a licence to use a shorter window.
 *
 * The embargo is measured from the last row RETAINED in the earlier split, not
 * from the intended index boundary, so dropping a row can never shorten the
 * gap.
 */
export function chronologicalSplit(
  samples: TrainingSample[],
  ratios: { train: number; validation: number; test: number } = { train: 0.6, validation: 0.2, test: 0.2 },
  embargoSeconds = 60,
): Split {
  const ordered = [...samples].sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime());
  const n = ordered.length;
  const embargo = Math.max(0, Math.floor(embargoSeconds));
  const empty: Split = {
    train: [],
    validation: [],
    test: [],
    embargoSeconds: embargo,
    embargoed: { validation: 0, test: 0 },
    boundaries: { trainEnd: null, validationEnd: null },
  };
  if (n === 0) return empty;

  const trainEnd = Math.max(0, Math.min(n, Math.floor(n * ratios.train)));
  const validationEnd = Math.max(trainEnd, Math.min(n, trainEnd + Math.floor(n * ratios.validation)));

  const timeOf = (sample: TrainingSample): number => new Date(sample.decidedAt).getTime();

  const train = ordered.slice(0, trainEnd);
  const lastTrainMs = train.length > 0 ? Math.max(...train.map(timeOf)) : Number.NEGATIVE_INFINITY;
  const validationCut = validationEnd;

  let validation = ordered
    .slice(trainEnd, validationCut)
    .filter((s) => timeOf(s) >= lastTrainMs + embargo * 1000);
  const validationDropped = validationCut - trainEnd - validation.length;

  const lastValidationMs = validation.length > 0 ? Math.max(...validation.map(timeOf)) : null;
  // The test embargo is anchored to the last RETAINED validation row; when the
  // embargo emptied the validation block, it is anchored to the last train row
  // so the test block still cannot touch the training window.
  const testAnchorMs = lastValidationMs ?? lastTrainMs;
  const testSlice = ordered.slice(validationEnd);
  let test = testSlice.filter((s) => timeOf(s) >= testAnchorMs + embargo * 1000);
  const testDropped = testSlice.length - test.length;

  return {
    train,
    validation,
    test,
    embargoSeconds: embargo,
    embargoed: { validation: validationDropped, test: testDropped },
    boundaries: {
      trainEnd: lastTrainMs === Number.NEGATIVE_INFINITY ? null : train[train.length - 1]!.decidedAt,
      validationEnd:
        validation.length > 0
          ? validation[validation.length - 1]!.decidedAt
          : (ordered[Math.min(validationEnd, n) - 1]?.decidedAt ?? null),
    },
  };
}

/**
 * The embargo that keeps overlapping outcome windows apart, derived from the
 * records themselves: one full horizon (never less than 60s).
 */
export function embargoForRecords(records: { horizonSeconds?: number | null }[], fallbackSeconds = 60): number {
  const horizons = records
    .map((r) => (typeof r.horizonSeconds === 'number' && Number.isFinite(r.horizonSeconds) ? r.horizonSeconds : 0))
    .filter((h) => h > 0);
  const horizon = horizons.length === 0 ? 0 : Math.max(...horizons);
  return Math.max(60, Math.ceil(horizon));
}

export interface WalkForwardFold {
  fold: number;
  trainSize: number;
  validationSize: number;
  /** Rows removed at this fold's boundary because they fell inside the embargo. */
  embargoedSamples: number;
  trainingCutoffAt: string | null;
  validationFrom: string | null;
  validationTo: string | null;
  metrics: EvaluationMetrics;
  probabilityRange: { min: number; max: number } | null;
}

/**
 * Expanding-window walk-forward evaluation.
 *
 * For fold `f` the model is fitted on rows that END at `validationStart` and
 * the block `[validationStart, validationEnd)` is scored — but only after rows
 * lying inside the embargo (one full prediction horizon) after the last
 * training row are removed. The training slice is passed to `train` unchanged,
 * so `trainSize` is exactly what the model saw.
 */
export function walkForward(
  samples: TrainingSample[],
  options: {
    folds?: number;
    minTrainSize?: number;
    embargoSeconds?: number;
    /** Minimum scored rows for a fold to be usable (default 5). */
    minValidationSize?: number;
    train: (trainSamples: TrainingSample[], validationSamples: TrainingSample[]) => { predict: (features: number[]) => number };
  },
): WalkForwardFold[] {
  const folds = Math.max(1, options.folds ?? 4);
  const minTrainSize = Math.max(2, options.minTrainSize ?? 60);
  const embargo = Math.max(0, options.embargoSeconds ?? 60);
  const minValidationSize = Math.max(1, options.minValidationSize ?? 5);
  const ordered = [...samples].sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime());
  const n = ordered.length;
  const results: WalkForwardFold[] = [];
  if (n < minTrainSize + minValidationSize) return results;

  const validationSize = Math.max(minValidationSize, Math.floor((n - minTrainSize) / folds));
  for (let f = 0; f < folds; f += 1) {
    const validationStart = minTrainSize + f * validationSize;
    const validationEnd = Math.min(n, validationStart + validationSize);
    if (validationStart >= n) break;
    const trainSlice = ordered.slice(0, validationStart);
    const cutoff = new Date(trainSlice[trainSlice.length - 1]!.decidedAt).getTime();
    const blockSlice = ordered.slice(validationStart, validationEnd);
    const validationSlice = blockSlice.filter((s) => new Date(s.decidedAt).getTime() >= cutoff + embargo * 1000);
    if (validationSlice.length < minValidationSize) continue;
    const model = options.train(trainSlice, validationSlice);
    const probabilities = validationSlice.map((s) => model.predict(s.features));
    const labels = validationSlice.map((s) => s.label);
    results.push({
      fold: f + 1,
      trainSize: trainSlice.length,
      validationSize: validationSlice.length,
      embargoedSamples: blockSlice.length - validationSlice.length,
      trainingCutoffAt: trainSlice[trainSlice.length - 1]?.decidedAt ?? null,
      validationFrom: validationSlice[0]?.decidedAt ?? null,
      validationTo: validationSlice[validationSlice.length - 1]?.decidedAt ?? null,
      metrics: evaluate(labels, probabilities),
      probabilityRange:
        probabilities.length === 0
          ? null
          : { min: Math.min(...probabilities), max: Math.max(...probabilities) },
    });
  }
  return results;
}

/* ------------------------------------------------------------------------- */
/* Model: standardised L2 logistic regression (deterministic, no deps)        */
/* ------------------------------------------------------------------------- */

export interface LogisticModel {
  kind: 'logistic_regression';
  version: string;
  featureNames: readonly string[];
  mean: number[];
  std: number[];
  coefficients: number[];
  intercept: number;
  hyper: {
    learningRate: number;
    l2: number;
    epochs: number;
    batchSize: number;
    classWeight: number | null;
  };
  trainedAt: string;
  trainedSamples: number;
  datasetChecksum: string;
  trainMetrics?: Partial<EvaluationMetrics>;
  validationMetrics?: Partial<EvaluationMetrics>;
}

export interface TrainOptions {
  learningRate?: number;
  l2?: number;
  epochs?: number;
  seed?: number;
  balanceClasses?: boolean;
  trainedAt: string;
  datasetChecksum: string;
  version: string;
}

function computeStandardization(samples: TrainingSample[]): { mean: number[]; std: number[] } {
  const dims = FEATURE_NAMES.length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(1);
  if (samples.length === 0) return { mean, std };
  for (const s of samples) {
    for (let d = 0; d < dims; d += 1) mean[d] += s.features[d] ?? 0;
  }
  for (let d = 0; d < dims; d += 1) mean[d] /= samples.length;
  for (const s of samples) {
    for (let d = 0; d < dims; d += 1) {
      const diff = (s.features[d] ?? 0) - mean[d];
      std[d] += diff * diff;
    }
  }
  for (let d = 0; d < dims; d += 1) {
    std[d] = Math.sqrt(std[d] / samples.length) || 1;
  }
  return { mean, std };
}

export function standardize(features: number[], mean: number[], std: number[]): number[] {
  return features.map((f, i) => {
    const s = std[i] ?? 1;
    return s === 0 ? 0 : (f - (mean[i] ?? 0)) / s;
  });
}

export function predictLogistic(model: LogisticModel, features: number[]): number {
  const z = standardize(features, model.mean, model.std).reduce(
    (acc, v, i) => acc + v * (model.coefficients[i] ?? 0),
    model.intercept,
  );
  return sigmoid(z);
}

export function trainLogistic(samples: TrainingSample[], options: TrainOptions): LogisticModel {
  if (samples.length === 0) throw new Error('cannot train on an empty dataset');
  const dims = FEATURE_NAMES.length;
  const learningRate = options.learningRate ?? 0.08;
  const l2 = options.l2 ?? 0.01;
  const epochs = options.epochs ?? 400;
  const positives = samples.filter((s) => s.label === 1).length;
  const negatives = samples.length - positives;
  const balance = options.balanceClasses ?? true;
  const { mean, std } = computeStandardization(samples);
  const weightPositive = balance && positives > 0 && negatives > 0 ? samples.length / (2 * positives) : 1;
  const weightNegative = balance && positives > 0 && negatives > 0 ? samples.length / (2 * negatives) : 1;

  const scaled = samples.map((s) => ({ x: standardize(s.features, mean, std), y: s.label }));
  let coefficients = new Array(dims).fill(0);
  let intercept = 0;

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradW = new Array(dims).fill(0);
    let gradB = 0;
    let weightSum = 0;
    for (const row of scaled) {
      const w = row.y === 1 ? weightPositive : weightNegative;
      const p = sigmoid(row.x.reduce((acc, v, i) => acc + v * coefficients[i]!, intercept));
      const error = (p - row.y) * w;
      weightSum += w;
      for (let d = 0; d < dims; d += 1) gradW[d] += error * row.x[d]!;
      gradB += error;
    }
    const norm = weightSum || 1;
    for (let d = 0; d < dims; d += 1) {
      coefficients[d] = coefficients[d]! - learningRate * (gradW[d] / norm + l2 * coefficients[d]!);
    }
    intercept -= learningRate * (gradB / norm);
  }

  const model: LogisticModel = {
    kind: 'logistic_regression',
    version: options.version,
    featureNames: FEATURE_NAMES,
    mean,
    std,
    coefficients: coefficients.map((c) => Number(c.toFixed(6))),
    intercept: Number(intercept.toFixed(6)),
    hyper: {
      learningRate,
      l2,
      epochs,
      batchSize: samples.length,
      classWeight: balance ? weightPositive : null,
    },
    trainedAt: options.trainedAt,
    trainedSamples: samples.length,
    datasetChecksum: options.datasetChecksum,
  };

  const probabilities = samples.map((s) => predictLogistic(model, s.features));
  model.trainMetrics = { ...evaluate(samples.map((s) => s.label), probabilities) };
  return model;
}

/* ------------------------------------------------------------------------- */
/* Promotion                                                                  */
/* ------------------------------------------------------------------------- */

export interface PromotionCriteria {
  minSamples: number;
  /**
   * Minimum number of OUT-OF-SAMPLE rows behind the reported metrics. Without
   * this gate a candidate could be promoted on a handful of holdout rows.
   */
  minEvaluationSamples: number;
  minAccuracy: number;
  /** Balanced accuracy must be strictly above this floor (0.5 = chance). */
  minBalancedAccuracy: number;
  minAuc: number;
  maxLogLossRegression: number;
  /** Maximum expected calibration error allowed on the holdout. */
  maxExpectedCalibrationError: number;
  /** Minimum absolute log-loss improvement required over the champion. */
  minLogLossImprovement: number;
  /** Minimum walk-forward folds that must all exceed the accuracy floor. */
  minWalkForwardFolds: number;
}

export const DEFAULT_PROMOTION_CRITERIA: PromotionCriteria = {
  minSamples: 200,
  minEvaluationSamples: 40,
  minAccuracy: 0.55,
  minBalancedAccuracy: 0.5,
  minAuc: 0.55,
  maxLogLossRegression: 0.02,
  maxExpectedCalibrationError: 0.15,
  minLogLossImprovement: 0,
  minWalkForwardFolds: 3,
};

export interface PromotionDecision {
  promote: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  summary: string;
}

export function decidePromotion(params: {
  candidate: { metrics: EvaluationMetrics; walkForward: WalkForwardFold[]; trainedSamples: number; version: string };
  champion?: { metrics: EvaluationMetrics; version: string } | null;
  /**
   * No-skill reference measured on the SAME holdout rows. Required in
   * practice: without it, relative skill cannot be verified and promotion is
   * refused (fail-closed), because a high accuracy can be an artefact of class
   * balance rather than information.
   */
  baseline?: EvaluationMetrics | null;
  criteria?: Partial<PromotionCriteria>;
}): PromotionDecision {
  const criteria = { ...DEFAULT_PROMOTION_CRITERIA, ...(params.criteria ?? {}) };
  const { metrics, walkForward: folds, trainedSamples } = params.candidate;
  const checks: PromotionDecision['checks'] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });

  add('sample_size', trainedSamples >= criteria.minSamples, `${trainedSamples} labelled samples (min ${criteria.minSamples})`);
  add(
    'evaluation_size',
    metrics.samples >= criteria.minEvaluationSamples,
    `${metrics.samples} out-of-sample rows (min ${criteria.minEvaluationSamples})`,
  );
  add('accuracy', metrics.accuracy >= criteria.minAccuracy, `accuracy ${metrics.accuracy.toFixed(3)} (min ${criteria.minAccuracy})`);
  add(
    'balanced_accuracy',
    metrics.balancedAccuracy > criteria.minBalancedAccuracy,
    `balanced accuracy ${metrics.balancedAccuracy.toFixed(3)} (must exceed ${criteria.minBalancedAccuracy} = chance)`,
  );
  add('auc', (metrics.auc ?? 0) >= criteria.minAuc, `AUC ${(metrics.auc ?? 0).toFixed(3)} (min ${criteria.minAuc})`);
  // Log loss is a proper scoring rule and the base-rate predictor is the
  // canonical no-skill reference. Requiring a strict improvement on the same
  // rows stops a model that merely learned the class balance from being
  // promoted on accuracy alone.
  if (params.baseline) {
    add(
      'baseline_skill',
      metrics.logLoss < params.baseline.logLoss,
      `holdout log loss ${metrics.logLoss.toFixed(4)} vs base-rate baseline ${params.baseline.logLoss.toFixed(4)} ` +
        `on the same ${params.baseline.samples} rows`,
    );
  } else {
    add('baseline_skill', false, 'no baseline was supplied, so relative skill cannot be verified');
  }
  add(
    'class_balance',
    metrics.baseRate > 0.05 && metrics.baseRate < 0.95,
    `win rate ${(metrics.baseRate * 100).toFixed(1)}% (degenerate data is rejected)`,
  );
  add(
    'calibration',
    metrics.ece <= criteria.maxExpectedCalibrationError,
    `expected calibration error ${metrics.ece.toFixed(3)} (max ${criteria.maxExpectedCalibrationError})`,
  );
  const stableFolds = folds.filter((f) => f.metrics.samples >= 5 && f.metrics.accuracy >= criteria.minAccuracy);
  add(
    'walk_forward',
    folds.length >= criteria.minWalkForwardFolds && stableFolds.length >= Math.ceil(folds.length * 0.7),
    `${stableFolds.length}/${folds.length} folds at or above the accuracy floor (need ${criteria.minWalkForwardFolds} folds total)`,
  );

  if (params.champion) {
    const champion = params.champion.metrics;
    const logLossDelta = metrics.logLoss - champion.logLoss;
    add(
      'log_loss_regression',
      logLossDelta <= criteria.maxLogLossRegression,
      `log loss ${metrics.logLoss.toFixed(4)} vs champion ${champion.logLoss.toFixed(4)} (Δ ${logLossDelta.toFixed(4)})`,
    );
    if (criteria.minLogLossImprovement > 0) {
      add(
        'log_loss_improvement',
        logLossDelta <= -criteria.minLogLossImprovement,
        `required improvement ${criteria.minLogLossImprovement}, got ${(-logLossDelta).toFixed(4)}`,
      );
    }
    add(
      'champion_accuracy',
      metrics.accuracy >= champion.accuracy - 0.01,
      `accuracy ${metrics.accuracy.toFixed(3)} vs champion ${champion.accuracy.toFixed(3)}`,
    );
  } else {
    add('champion_baseline', true, 'no active champion — candidate is measured against the criteria only');
  }

  const promote = checks.every((c) => c.passed);
  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  return {
    promote,
    checks,
    summary: promote
      ? `Promoting ${params.candidate.version}: all ${checks.length} gates passed.`
      : `Keeping the current model — failed gates: ${failed.join(', ')}.`,
  };
}

/**
 * The no-skill reference: every row receives the observed base rate of the
 * same holdout. This is the constant that a candidate must beat on a proper
 * scoring rule; unlike a hard 0/1 majority guess it stays honest when the
 * classes are balanced (50/50 has log loss ln 2, not ln 1000).
 *
 * The field is named `majority` for API compatibility with stored runs.
 */
export function baselineMetrics(samples: TrainingSample[]): { majority: EvaluationMetrics; baseRate: number } {
  const labels = samples.map((s) => s.label);
  const baseRate = labels.length === 0 ? 0 : labels.filter((l) => l === 1).length / labels.length;
  const constant = labels.map(() => Math.min(1 - 1e-6, Math.max(1e-6, baseRate)));
  return { majority: evaluate(labels, constant), baseRate };
}

/* ------------------------------------------------------------------------- */
/* Strategy weighting (aggregated, bounded, reversible)                       */
/* ------------------------------------------------------------------------- */

export interface StrategyWeightUpdate {
  weights: Record<string, number>;
  evidence: Record<string, { wins: number; losses: number; draws: number; total: number; winRate: number; applied: boolean }>;
  skipped: string[];
  version: string;
}

export const STRATEGY_WEIGHT_BOUNDS: [number, number] = [0.75, 1.3];

/**
 * Bayesian-shrunk multiplicative weights from resolved outcomes.
 * `priorStrength` pulls small samples back to neutral, so a single loss can
 * never move a strategy's weight materially.
 */
export function learnStrategyWeights(
  records: ResolvedRecord[],
  options: { minSamples?: number; priorStrength?: number; bounds?: [number, number]; version?: string } = {},
): StrategyWeightUpdate {
  const minSamples = options.minSamples ?? 30;
  const prior = options.priorStrength ?? 25;
  const [lo, hi] = options.bounds ?? STRATEGY_WEIGHT_BOUNDS;
  const grouped = new Map<string, { wins: number; losses: number; draws: number }>();
  for (const r of records) {
    if (!r.strategy) continue;
    const key = r.strategy;
    const entry = grouped.get(key) ?? { wins: 0, losses: 0, draws: 0 };
    if (r.outcome === 'WIN') entry.wins += 1;
    else if (r.outcome === 'LOSS') entry.losses += 1;
    else if (r.outcome === 'DRAW') entry.draws += 1;
    grouped.set(key, entry);
  }
  const weights: Record<string, number> = {};
  const evidence: StrategyWeightUpdate['evidence'] = {};
  const skipped: string[] = [];
  for (const [strategy, { wins, losses, draws }] of grouped) {
    const decisive = wins + losses;
    const total = decisive + draws;
    const winRate = decisive === 0 ? 0.5 : wins / decisive;
    const shrunk = (wins + prior * 0.5) / (decisive + prior);
    const applied = decisive >= minSamples;
    const raw = applied ? 0.5 + (shrunk - 0.5) * 2 : 1;
    const weight = Math.min(hi, Math.max(lo, raw));
    weights[strategy] = Number(weight.toFixed(4));
    evidence[strategy] = { wins, losses, draws, total, winRate: Number(winRate.toFixed(4)), applied };
    if (!applied) skipped.push(strategy);
  }
  return { weights, evidence, skipped, version: `${LEARNING_VERSION}#weights` };
}

/* ------------------------------------------------------------------------- */
/* Retraining guards                                                          */
/* ------------------------------------------------------------------------- */

export interface PreviousLearningRun {
  status: string;
  datasetChecksum: string | null;
  datasetSize: number | null;
}

/**
 * Decide whether a learning run has anything new to learn.
 *
 * A dataset whose checksum (and size) matches an already SUCCEEDED run is
 * byte-identical, so retraining would burn CPU to reproduce the same
 * candidate. Failed/skipped runs are ignored: they must be retryable.
 */
export function shouldRetrain(params: {
  datasetChecksum: string;
  datasetSize: number;
  previousRuns: PreviousLearningRun[];
  force?: boolean;
}): { retrain: boolean; reason: string } {
  if (params.force) return { retrain: true, reason: 'forced by the operator' };
  if (params.datasetChecksum.length === 0) return { retrain: true, reason: 'dataset checksum unavailable' };
  const match = params.previousRuns.find(
    (run) =>
      run.status === 'SUCCEEDED' &&
      run.datasetChecksum === params.datasetChecksum &&
      (run.datasetSize === null || run.datasetSize === params.datasetSize),
  );
  if (match) {
    return {
      retrain: false,
      reason: `dataset ${params.datasetChecksum.slice(0, 12)}… (${params.datasetSize} samples) was already trained successfully — nothing has changed since`,
    };
  }
  return { retrain: true, reason: 'dataset differs from every previous successful run' };
}

/**
 * Sanity checks that must pass before a dataset is allowed near training.
 * `nowMs` is injectable so the future-timestamp check is deterministic in
 * tests and in replayed runs.
 */
export function auditDataset(
  dataset: Dataset,
  minSamples: number,
  nowMs: number = Date.now(),
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (dataset.samples.length < minSamples) issues.push(`only ${dataset.samples.length} labelled samples (need ${minSamples})`);
  const duplicates = new Set<string>();
  for (const s of dataset.samples) {
    const key = `${s.pair}|${s.decidedAt}`;
    if (duplicates.has(key)) issues.push(`duplicate sample ${key}`);
    duplicates.add(key);
    if (s.features.some((f) => !Number.isFinite(f))) issues.push(`non-finite feature in ${s.signalId}`);
  }
  const labels = dataset.samples.map((s) => s.label);
  const wins = labels.filter((l) => l === 1).length;
  if (labels.length > 0 && (wins === 0 || wins === labels.length)) issues.push('dataset contains a single class only');
  const times = dataset.samples.map((s) => new Date(s.decidedAt).getTime());
  for (let i = 1; i < times.length; i += 1) {
    if (times[i]! < times[i - 1]!) issues.push('samples are not in chronological order');
  }
  const firstFuture = times.find((t) => t > nowMs + 60_000);
  if (firstFuture) issues.push('dataset contains samples dated in the future');
  return { ok: issues.length === 0, issues };
}

/** Cheap drift check between two windows of live performance. */
export function detectDrift(
  recent: { wins: number; losses: number },
  baseline: { wins: number; losses: number },
  thresholds: { minSamples?: number; accuracyDrop?: number } = {},
): { drifting: boolean; detail: string; recentAccuracy: number | null; baselineAccuracy: number | null } {
  const minSamples = thresholds.minSamples ?? 50;
  const accuracyDrop = thresholds.accuracyDrop ?? 0.12;
  const recentTotal = recent.wins + recent.losses;
  const baselineTotal = baseline.wins + baseline.losses;
  if (recentTotal < minSamples) {
    return { drifting: false, detail: `insufficient recent samples (${recentTotal}/${minSamples})`, recentAccuracy: null, baselineAccuracy: null };
  }
  const recentAccuracy = recent.wins / recentTotal;
  const baselineAccuracy = baselineTotal === 0 ? null : baseline.wins / baselineTotal;
  if (baselineAccuracy === null) {
    return { drifting: false, detail: 'no baseline window yet', recentAccuracy, baselineAccuracy };
  }
  const drop = baselineAccuracy - recentAccuracy;
  return {
    drifting: drop >= accuracyDrop,
    detail: `recent ${(recentAccuracy * 100).toFixed(1)}% vs baseline ${(baselineAccuracy * 100).toFixed(1)}% (drop ${(drop * 100).toFixed(1)}pp)`,
    recentAccuracy,
    baselineAccuracy,
  };
}

export { fromFeatureArray, toFeatureArray, logLoss };
