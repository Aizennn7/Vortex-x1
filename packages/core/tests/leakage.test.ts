/**
 * Leakage, abstention and controlled-learning guards.
 *
 * Every test here protects a property that silently inflates evaluation
 * numbers when it breaks: no future information may enter a feature vector, no
 * holdout row may enter training, and a candidate may not be promoted on a
 * handful of rows.
 */

import { describe, expect, it } from 'vitest';
import { buildDataset, type ResolvedRecord } from '../src/learning.js';
import {
  DEFAULT_PROMOTION_CRITERIA,
  chronologicalSplit,
  decidePromotion,
  embargoForRecords,
  shouldRetrain,
  type TrainingSample,
} from '../src/learning.js';
import { freshness } from '../src/marketdata.js';
import { evaluatePrediction } from '../src/ensemble.js';
import { detectRegime } from '../src/regime.js';
import { aggregate } from '../src/marketdata.js';
import { FEATURE_NAMES } from '../src/features.js';
import { evaluate, type EvaluationMetrics } from '../src/stats.js';
import type { Candle, MarketSnapshot } from '../src/types.js';

const START = Date.parse('2026-01-05T09:00:00.000Z');

function series(count: number, startMs = START, secondsPerBar = 60): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = startMs + i * secondsPerBar * 1000;
    const base = 1.1 + i * 0.0001;
    return {
      pair: 'EUR/USD',
      timeframe: 'M1' as const,
      openTime: new Date(open).toISOString(),
      closeTime: new Date(open + secondsPerBar * 1000).toISOString(),
      open: base,
      high: base + 0.0002,
      low: base - 0.0002,
      close: base + 0.0001,
      provider: 'test',
      isFinal: true,
    };
  });
}

function snapshot(m1: Candle[], overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const last = m1[m1.length - 1] as Candle;
  return {
    pair: 'EUR/USD',
    asOf: last.closeTime,
    price: last.close,
    spreadPips: 0.6,
    spreadSource: 'modelled',
    dataProvider: 'test',
    synthetic: false,
    m1,
    m3: aggregate(m1, 'M3', 'test'),
    ageSeconds: 10,
    spreadOk: true,
    dataQuality: 'OK',
    ...overrides,
  };
}

describe('future-data guard', () => {
  it('marks a candle that closes after `now` as FUTURE_DATA', () => {
    const m1 = series(120);
    const last = m1[m1.length - 1] as Candle;
    // Pretend `now` is 30s before the newest candle even closes.
    const now = new Date(Date.parse(last.closeTime) - 30_000).toISOString();
    const report = freshness(m1, now, 'M1', 90, 30);
    expect(report.futureData).toBe(true);
    expect(report.quality).toBe('FUTURE_DATA');
    expect(report.reasons.join(' ')).toMatch(/future/i);
  });

  it('does not flag ordinary provider latency as future data', () => {
    const m1 = series(120);
    const last = m1[m1.length - 1] as Candle;
    const now = new Date(Date.parse(last.closeTime) + 4_000).toISOString();
    const report = freshness(m1, now, 'M1', 90, 30);
    expect(report.futureData).toBe(false);
    expect(report.quality).toBe('OK');
  });

  it('refuses to trade when the snapshot carries FUTURE_DATA', () => {
    const m1 = series(160);
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const result = evaluatePrediction({
      snapshot: snapshot(m1, { dataQuality: 'FUTURE_DATA' }),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: { engineVersion: 'test', minConfidence: 0.1, minRewardRisk: 1, maxSpreadPips: 3 },
    });
    expect(result.result.decision).toBe('NO_TRADE');
    expect(result.result.gates.find((g) => g.gate === 'data_quality')?.passed).toBe(false);
    expect(result.result.reasons[0]).toMatch(/NO-TRADE/);
  });
});

describe('chronological split embargo', () => {
  function samples(count: number, spacingSeconds: number): TrainingSample[] {
    return Array.from({ length: count }, (_, i) => ({
      signalId: `s-${i}`,
      features: FEATURE_NAMES.map(() => 0),
      label: (i % 2) as 0 | 1,
      decidedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * spacingSeconds * 1000).toISOString(),
      pair: 'EUR/USD',
      strategy: 'trend_follow',
      regime: 'TREND_UP',
      confidence: 0.7,
      engineVersion: 'test',
    }));
  }

  it('derives the embargo from the recorded horizons', () => {
    expect(embargoForRecords([{ horizonSeconds: 300 }, { horizonSeconds: 60 }])).toBe(300);
    expect(embargoForRecords([], 60)).toBe(60);
    // A floor of 60s protects the one-minute pipeline when no horizon is stored.
    expect(embargoForRecords([{ horizonSeconds: null }])).toBe(60);
  });

  it('keeps every split at least one horizon away from the previous block', () => {
    const data = samples(200, 60); // one row per minute
    const split = chronologicalSplit(data, { train: 0.6, validation: 0.2, test: 0.2 }, 300);
    const max = (list: TrainingSample[]) => Math.max(...list.map((s) => Date.parse(s.decidedAt)));
    const min = (list: TrainingSample[]) => Math.min(...list.map((s) => Date.parse(s.decidedAt)));
    expect(min(split.validation) - max(split.train)).toBeGreaterThanOrEqual(300_000);
    expect(min(split.test) - max(split.validation)).toBeGreaterThanOrEqual(300_000);
    expect(split.embargoed.validation).toBeGreaterThan(0);
    expect(split.embargoed.test).toBeGreaterThan(0);
  });

  it('drops rows instead of reusing them when the embargo bites', () => {
    const data = samples(100, 30);
    const split = chronologicalSplit(data, { train: 0.6, validation: 0.2, test: 0.2 }, 300);
    const ids = new Set<string>();
    for (const row of [...split.train, ...split.validation, ...split.test]) {
      expect(ids.has(row.signalId)).toBe(false);
      ids.add(row.signalId);
    }
    // A 300s embargo over 30s-spaced rows must remove at least 10 rows per boundary.
    expect(split.embargoed.validation).toBeGreaterThanOrEqual(9);
    expect(split.embargoed.test).toBeGreaterThanOrEqual(9);
  });

  it('still returns usable splits when the embargo is larger than a block', () => {
    const data = samples(60, 600); // 10-minute spacing, 20% blocks are 12 rows
    const split = chronologicalSplit(data, { train: 0.6, validation: 0.2, test: 0.2 }, 900);
    expect(split.train.length).toBeGreaterThan(0);
    expect(split.test.length).toBeGreaterThan(0);
    const minTest = Math.min(...split.test.map((s) => Date.parse(s.decidedAt)));
    const maxTrain = Math.max(...split.train.map((s) => Date.parse(s.decidedAt)));
    expect(minTest - maxTrain).toBeGreaterThanOrEqual(900_000);
  });
});

describe('retraining guard', () => {
  it('skips a dataset that already trained successfully', () => {
    const decision = shouldRetrain({
      datasetChecksum: 'abc123',
      datasetSize: 400,
      previousRuns: [{ status: 'SUCCEEDED', datasetChecksum: 'abc123', datasetSize: 400 }],
    });
    expect(decision.retrain).toBe(false);
    expect(decision.reason).toMatch(/already trained/);
  });

  it('retrains after a failed run with the same dataset', () => {
    const decision = shouldRetrain({
      datasetChecksum: 'abc123',
      datasetSize: 400,
      previousRuns: [{ status: 'FAILED', datasetChecksum: 'abc123', datasetSize: 400 }],
    });
    expect(decision.retrain).toBe(true);
  });

  it('retrains when new outcomes changed the dataset', () => {
    const decision = shouldRetrain({
      datasetChecksum: 'def456',
      datasetSize: 401,
      previousRuns: [{ status: 'SUCCEEDED', datasetChecksum: 'abc123', datasetSize: 400 }],
    });
    expect(decision.retrain).toBe(true);
  });

  it('retrains when there is no history at all', () => {
    expect(shouldRetrain({ datasetChecksum: 'abc123', datasetSize: 10, previousRuns: [] }).retrain).toBe(true);
  });

  it('can be forced for a manual re-run', () => {
    const decision = shouldRetrain({
      datasetChecksum: 'abc123',
      datasetSize: 400,
      previousRuns: [{ status: 'SUCCEEDED', datasetChecksum: 'abc123', datasetSize: 400 }],
      force: true,
    });
    expect(decision.retrain).toBe(true);
  });
});

describe('promotion gates', () => {
  const metrics = (overrides: Partial<EvaluationMetrics> = {}): EvaluationMetrics => ({
    ...evaluate(
      Array.from({ length: 400 }, (_, i) => (i % 2) as 0 | 1),
      // Well-separated probabilities: accuracy/AUC well above the gates, and
      // the calibration error of a two-point curve stays inside the ceiling.
      Array.from({ length: 400 }, (_, i) => (i % 2 === 0 ? 0.05 : 0.95)),
    ),
    ...overrides,
  });

  const folds = Array.from({ length: 4 }, (_, i) => ({
    fold: i + 1,
    trainSize: 200,
    validationSize: 40,
    embargoedSamples: 0,
    trainingCutoffAt: null,
    validationFrom: null,
    validationTo: null,
    metrics: metrics(),
    probabilityRange: { min: 0.2, max: 0.8 },
  }));

  it('rejects a candidate whose metrics rest on too few out-of-sample rows', () => {
    const decision = decidePromotion({
      candidate: {
        metrics: metrics({ samples: 12 }),
        walkForward: folds,
        trainedSamples: 500,
        version: 'cand-small-holdout',
      },
    });
    expect(decision.promote).toBe(false);
    expect(decision.checks.find((c) => c.name === 'evaluation_size')?.passed).toBe(false);
    expect(decision.summary).toMatch(/evaluation_size/);
  });

  it('accepts a candidate that clears every gate', () => {
    const decision = decidePromotion({
      candidate: { metrics: metrics(), walkForward: folds, trainedSamples: 500, version: 'cand-good' },
    });
    expect(decision.checks.find((c) => c.name === 'evaluation_size')?.passed).toBe(true);
    expect(decision.promote).toBe(true);
  });

  it('exposes the default minimum holdout size', () => {
    expect(DEFAULT_PROMOTION_CRITERIA.minEvaluationSamples).toBeGreaterThanOrEqual(20);
  });
});

describe('dataset eligibility', () => {
  function record(overrides: Partial<ResolvedRecord> = {}): ResolvedRecord {
    return {
      signalId: 'sig-1',
      pair: 'EUR/USD',
      strategy: 'trend_follow',
      regime: 'TREND_UP',
      confidence: 0.7,
      decidedAt: '2026-01-01T00:00:00.000Z',
      horizonSeconds: 300,
      outcome: 'WIN',
      outcomeFlags: [],
      features: FEATURE_NAMES.map((_, i) => i / 100),
      engineVersion: 'test',
      ...overrides,
    };
  }

  it('excludes records whose prices were guessed and counts them', () => {
    const dataset = buildDataset([
      record({ signalId: 'a' }),
      record({ signalId: 'b', decidedAt: '2026-01-01T00:05:00.000Z', outcome: 'UNRESOLVED', outcomeFlags: ['data_unavailable'] }),
      record({ signalId: 'c', decidedAt: '2026-01-01T00:10:00.000Z', outcome: 'DRAW' }),
      record({ signalId: 'd', decidedAt: '2026-01-01T00:15:00.000Z', outcomeFlags: ['entry_price_late'] }),
    ]);
    expect(dataset.samples).toHaveLength(1);
    expect(dataset.exclusions.unresolved).toBe(1);
    expect(dataset.exclusions.draw).toBe(1);
    expect(dataset.exclusions.ineligibleFlags).toBe(1);
  });
});
