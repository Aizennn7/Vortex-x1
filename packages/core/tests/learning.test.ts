import { describe, expect, it } from 'vitest';
import {
  FEATURE_NAMES,
  auditDataset,
  buildDataset,
  chronologicalSplit,
  decidePromotion,
  detectDrift,
  evaluate,
  fnv1a64,
  learnStrategyWeights,
  predictLogistic,
  trainLogistic,
  walkForward,
  type ResolvedRecord,
  type TrainingSample,
} from '../src/index.js';

const FEATURE_COUNT = FEATURE_NAMES.length;

/** A genuinely learnable synthetic population: signal sign drives the label. */
function makeRecords(count: number, options: { noisy?: number; startIso?: string } = {}): ResolvedRecord[] {
  const noisy = options.noisy ?? 0.15;
  const start = Date.parse(options.startIso ?? '2026-01-01T00:00:00.000Z');
  const records: ResolvedRecord[] = [];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < count; i += 1) {
    const features = new Array(FEATURE_COUNT).fill(0);
    const signal = rand() * 2 - 1;
    features[0] = signal; // 'bias'
    features[1] = 0.5 + rand() * 0.5; // confidence
    const inverse = signal < 0 ? 1 - signal : 1 - signal; // 1 - bias in (0,2)
    features[2] = signal * (0.6 + rand() * 0.4); // 'rsi' proxy carrying signal info
    const winProbability = 0.5 + signal * 0.35 - (features[1] as number) * 0.1 * inverse * 0;
    const isWin = rand() < Math.min(0.95, Math.max(0.05, winProbability - noisy * 0.1));
    records.push({
      signalId: `sig-${i}`,
      pair: i % 2 === 0 ? 'EUR/USD' : 'GBP/USD',
      strategy: i % 3 === 0 ? 'trend_follow' : 'momentum',
      regime: 'TREND_UP',
      confidence: features[1] as number,
      decidedAt: new Date(start + i * 300_000).toISOString(),
      horizonSeconds: 60,
      outcome: isWin ? 'WIN' : 'LOSS',
      outcomeFlags: [],
      features,
      engineVersion: 'test',
    });
  }
  return records;
}

describe('dataset construction', () => {
  it('keeps only decisive, intact outcomes and counts exclusions', () => {
    const records = makeRecords(50);
    records.push(
      { ...makeRecords(1)[0]!, signalId: 'draw-1', outcome: 'DRAW' },
      { ...makeRecords(1)[0]!, signalId: 'unres-1', outcome: 'UNRESOLVED' },
      { ...makeRecords(1)[0]!, signalId: 'late-1', outcomeFlags: ['entry_price_late'] },
      { ...makeRecords(1)[0]!, signalId: 'null-1', outcome: null },
    );
    const dataset = buildDataset(records);
    expect(dataset.samples.every((s) => s.label === 0 || s.label === 1)).toBe(true);
    expect(dataset.exclusions.draw).toBe(1);
    expect(dataset.exclusions.unresolved).toBe(1);
    expect(dataset.exclusions.ineligibleFlags).toBe(1);
    expect(dataset.exclusions.notResolved).toBe(1);
  });

  it('drops duplicate (pair, decision time) rows', () => {
    const base = makeRecords(2);
    const dataset = buildDataset([base[0]!, { ...base[1]!, pair: base[0]!.pair, decidedAt: base[0]!.decidedAt }]);
    expect(dataset.samples).toHaveLength(1);
    expect(dataset.exclusions.duplicate).toBe(1);
  });

  it('rejects malformed feature vectors', () => {
    const dataset = buildDataset([{ ...makeRecords(1)[0]!, features: [1, 2, 3] }]);
    expect(dataset.samples).toHaveLength(0);
    expect(dataset.exclusions.invalidFeatures).toBe(1);
  });

  it('produces a stable checksum for identical data and a different one otherwise', () => {
    const a = buildDataset(makeRecords(30));
    const b = buildDataset(makeRecords(30));
    const c = buildDataset(makeRecords(31));
    expect(a.checksum).toBe(b.checksum);
    expect(a.checksum).not.toBe(c.checksum);
    expect(a.checksum).toMatch(/^[0-9a-f]{16}$/);
  });

  it('orders samples chronologically', () => {
    const records = makeRecords(20).reverse();
    const dataset = buildDataset(records);
    const times = dataset.samples.map((s) => Date.parse(s.decidedAt));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });
});

describe('chronological splitting', () => {
  const samples: TrainingSample[] = makeRecords(100).map((r, i) => ({
    signalId: r.signalId,
    features: r.features as number[],
    label: r.outcome === 'WIN' ? 1 : 0,
    decidedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 300_000).toISOString(),
    pair: r.pair,
    strategy: r.strategy,
    regime: r.regime,
    confidence: r.confidence,
    engineVersion: 'test',
  }));

  it('keeps every training row strictly before every test row', () => {
    const split = chronologicalSplit(samples, { train: 0.6, validation: 0.2, test: 0.2 }, 60);
    const latestTrain = Math.max(...split.train.map((s) => Date.parse(s.decidedAt)));
    const earliestValidation = Math.min(...split.validation.map((s) => Date.parse(s.decidedAt)));
    const earliestTest = Math.min(...split.test.map((s) => Date.parse(s.decidedAt)));
    expect(earliestValidation - latestTrain).toBeGreaterThanOrEqual(60_000);
    expect(earliestTest - Math.max(...split.validation.map((s) => Date.parse(s.decidedAt)))).toBeGreaterThanOrEqual(60_000);
  });

  it('never puts a row in two splits', () => {
    const split = chronologicalSplit(samples, { train: 0.5, validation: 0.25, test: 0.25 }, 60);
    const ids = new Set<string>();
    for (const row of [...split.train, ...split.validation, ...split.test]) {
      expect(ids.has(row.signalId)).toBe(false);
      ids.add(row.signalId);
    }
  });

  it('handles an empty dataset without throwing', () => {
    const split = chronologicalSplit([], { train: 0.6, validation: 0.2, test: 0.2 }, 60);
    expect(split.train).toHaveLength(0);
    expect(split.boundaries.trainEnd).toBeNull();
  });
});

describe('model training and evaluation', () => {
  it('learns a signal that exists in the data', () => {
    const dataset = buildDataset(makeRecords(600));
    const split = chronologicalSplit(dataset.samples, { train: 0.6, validation: 0.2, test: 0.2 }, 60);
    const model = trainLogistic(split.train, {
      trainedAt: new Date().toISOString(),
      datasetChecksum: dataset.checksum,
      version: 'test-model',
      epochs: 400,
    });
    const probabilities = split.test.map((s) => predictLogistic(model, s.features));
    const metrics = evaluate(
      split.test.map((s) => s.label),
      probabilities,
    );
    expect(metrics.accuracy).toBeGreaterThan(0.55);
    expect(metrics.auc).not.toBeNull();
    expect(metrics.auc as number).toBeGreaterThan(0.55);
    expect(metrics.samples).toBe(split.test.length);
  });

  it('is deterministic for the same input', () => {
    const dataset = buildDataset(makeRecords(200));
    const opts = { trainedAt: '2026-01-02T00:00:00.000Z', datasetChecksum: dataset.checksum, version: 'v', epochs: 50 };
    const a = trainLogistic(dataset.samples, opts);
    const b = trainLogistic(dataset.samples, opts);
    expect(a.coefficients).toEqual(b.coefficients);
    expect(a.intercept).toBe(b.intercept);
  });

  it('refuses to train on an empty dataset', () => {
    expect(() =>
      trainLogistic([], { trainedAt: new Date().toISOString(), datasetChecksum: 'x', version: 'v' }),
    ).toThrow(/empty dataset/);
  });

  it('produces walk-forward folds that only ever train on the past', () => {
    const dataset = buildDataset(makeRecords(500));
    const folds = walkForward(dataset.samples, {
      folds: 4,
      minTrainSize: 150,
      embargoSeconds: 60,
      train: (trainSamples) => {
        const model = trainLogistic(trainSamples, {
          trainedAt: '2026-01-02T00:00:00.000Z',
          datasetChecksum: dataset.checksum,
          version: 'fold',
          epochs: 150,
        });
        return { predict: (features: number[]) => predictLogistic(model, features) };
      },
    });
    expect(folds.length).toBeGreaterThanOrEqual(3);
    for (const fold of folds) {
      expect(fold.trainSize).toBeGreaterThanOrEqual(150);
      expect(fold.validationSize).toBeGreaterThan(0);
      expect(fold.metrics.samples).toBe(fold.validationSize);
    }
    expect(folds[0]!.trainSize).toBeLessThan(folds[folds.length - 1]!.trainSize);
  });
});

describe('promotion gates', () => {
  const strongMetrics = {
    samples: 400,
    accuracy: 0.62,
    auc: 0.64,
    logLoss: 0.65,
    brier: 0.22,
    precision: 0.6,
    recall: 0.6,
    f1: 0.6,
    confusion: { tp: 120, fp: 80, tn: 128, fn: 72 },
    calibration: [],
    ece: 0.04,
    baseRate: 0.48,
  };
  const folds = [1, 2, 3, 4].map((fold) => ({
    fold,
    trainSize: 200 + fold * 20,
    validationSize: 40,
    metrics: { ...strongMetrics, samples: 40 },
    probabilityRange: { min: 0.2, max: 0.8 },
  }));

  it('promotes a candidate that clears every gate', () => {
    const decision = decidePromotion({
      candidate: { metrics: strongMetrics, walkForward: folds, trainedSamples: 400, version: 'cand-1' },
      champion: null,
    });
    expect(decision.promote).toBe(true);
    expect(decision.summary).toContain('Promoting');
  });

  it('refuses a candidate on too few samples', () => {
    const decision = decidePromotion({
      candidate: { metrics: { ...strongMetrics, samples: 40 }, walkForward: folds, trainedSamples: 40, version: 'cand-2' },
      champion: null,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name === 'sample_size')?.passed).toBe(false);
  });

  it('refuses a candidate that regresses log loss against the champion', () => {
    const decision = decidePromotion({
      candidate: { metrics: { ...strongMetrics, logLoss: 0.75 }, walkForward: folds, trainedSamples: 500, version: 'cand-3' },
      champion: { metrics: { ...strongMetrics, logLoss: 0.6 }, version: 'champ-1' },
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name === 'log_loss_regression')?.passed).toBe(false);
  });

  it('refuses degenerate single-class data', () => {
    const decision = decidePromotion({
      candidate: { metrics: { ...strongMetrics, baseRate: 1 }, walkForward: folds, trainedSamples: 500, version: 'cand-4' },
      champion: null,
    });
    expect(decision.promote).toBe(false);
  });

  it('refuses a candidate whose walk-forward folds are unstable', () => {
    const unstable = folds.map((f) => ({ ...f, metrics: { ...strongMetrics, accuracy: 0.4, samples: 40 } }));
    const decision = decidePromotion({
      candidate: { metrics: strongMetrics, walkForward: unstable, trainedSamples: 500, version: 'cand-5' },
      champion: null,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name === 'walk_forward')?.passed).toBe(false);
  });

  it('refuses a badly calibrated candidate', () => {
    const decision = decidePromotion({
      candidate: { metrics: { ...strongMetrics, ece: 0.4 }, walkForward: folds, trainedSamples: 500, version: 'cand-6' },
      champion: null,
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name === 'calibration')?.passed).toBe(false);
  });
});

describe('strategy weighting', () => {
  it('keeps weights neutral until there is enough evidence', () => {
    const records = makeRecords(20);
    const update = learnStrategyWeights(records, { minSamples: 30, priorStrength: 25 });
    for (const weight of Object.values(update.weights)) {
      expect(weight).toBe(1);
    }
    expect(update.skipped.length).toBeGreaterThan(0);
  });

  it('moves weights only within the documented bounds', () => {
    const records = makeRecords(400);
    const update = learnStrategyWeights(records, { minSamples: 20, priorStrength: 25 });
    for (const weight of Object.values(update.weights)) {
      expect(weight).toBeGreaterThanOrEqual(0.75);
      expect(weight).toBeLessThanOrEqual(1.3);
    }
    expect(Object.keys(update.evidence).length).toBeGreaterThan(0);
  });

  it('does not let one loss swing a strategy weight', () => {
    const records: ResolvedRecord[] = makeRecords(40).map((r, i) => ({
      ...r,
      strategy: 'trend_follow',
      outcome: i === 0 ? 'LOSS' : 'WIN',
    }));
    const update = learnStrategyWeights(records, { minSamples: 10, priorStrength: 25 });
    // Shrinkage keeps the weight well inside the bounds after a single loss.
    expect(update.weights.trend_follow).toBeLessThan(1.3);
  });
});

describe('drift detection', () => {
  it('flags a material drop in recent accuracy', () => {
    const report = detectDrift({ wins: 40, losses: 60 }, { wins: 60, losses: 40 }, { minSamples: 50 });
    expect(report.drifting).toBe(true);
    expect(report.detail).toContain('%');
  });

  it('does not flag on a small sample', () => {
    const report = detectDrift({ wins: 1, losses: 9 }, { wins: 60, losses: 40 }, { minSamples: 50 });
    expect(report.drifting).toBe(false);
    expect(report.recentAccuracy).toBeNull();
  });
});

describe('dataset audit', () => {
  it('rejects a single-class dataset', () => {
    const dataset = buildDataset(makeRecords(100).map((r) => ({ ...r, outcome: 'WIN' as const })));
    const audit = auditDataset(dataset, 50);
    expect(audit.ok).toBe(false);
    expect(audit.issues.join(' ')).toContain('single class');
  });

  it('accepts a healthy dataset', () => {
    const dataset = buildDataset(makeRecords(300));
    const audit = auditDataset(dataset, 100);
    expect(audit.ok).toBe(true);
  });
});

describe('hashing', () => {
  it('fnv1a64 is stable and hex-encoded', () => {
    expect(fnv1a64('vortex')).toBe(fnv1a64('vortex'));
    expect(fnv1a64('vortex')).not.toBe(fnv1a64('vortex '));
    expect(fnv1a64('vortex')).toMatch(/^[0-9a-f]{16}$/);
  });
});
