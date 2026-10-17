import { describe, expect, it } from 'vitest';
import { buildRiskPlan, combineVotes, dominantStrategy, evaluatePrediction } from '../src/ensemble.js';
import { detectRegime } from '../src/regime.js';
import { STRATEGIES, runStrategies, type StrategyContext } from '../src/strategies.js';
import { aggregate } from '../src/marketdata.js';
import { instrumentMeta } from '../src/instruments.js';
import type { Candle, MarketSnapshot, StrategyVote } from '../src/types.js';

const START = Date.parse('2026-01-05T09:00:00.000Z');

function series(count: number, fn: (i: number) => { open: number; high: number; low: number; close: number }): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const prices = fn(i);
    const openTime = new Date(START + i * 60_000).toISOString();
    return {
      pair: 'EUR/USD',
      timeframe: 'M1' as const,
      openTime,
      closeTime: new Date(START + (i + 1) * 60_000).toISOString(),
      ...prices,
      provider: 'test',
      isFinal: true,
    };
  });
}

/** A clean, persistent uptrend. */
const uptrend = () =>
  series(160, (i) => {
    const base = 1.1 + i * 0.00012;
    return { open: base, high: base + 0.00018, low: base - 0.00006, close: base + 0.00012 };
  });

/** A clean downtrend. */
const downtrend = () =>
  series(160, (i) => {
    const base = 1.1 - i * 0.00012;
    return { open: base, high: base + 0.00006, low: base - 0.00018, close: base - 0.00012 };
  });

/** Mean-reverting chop. */
const chop = () =>
  series(160, (i) => {
    const base = 1.1 + Math.sin(i / 3) * 0.0004;
    return { open: base, high: base + 0.00008, low: base - 0.00008, close: base };
  });

function snapshot(m1: Candle[], overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const last = m1[m1.length - 1] as Candle;
  return {
    pair: 'EUR/USD',
    asOf: last.closeTime,
    price: last.close,
    spreadPips: 0.8,
    spreadSource: 'modelled',
    m1,
    m3: aggregate(m1, 'M3', 'test'),
    ageSeconds: 15,
    spreadOk: true,
    dataQuality: 'OK',
    ...overrides,
  };
}

function strategyContext(m1: Candle[], regime = detectRegime(m1)): StrategyContext {
  return {
    m1,
    m3: aggregate(m1, 'M3', 'test'),
    regime,
    spreadPips: 0.8,
    maxSpreadPips: 2.5,
  };
}

describe('strategy library', () => {
  it('every strategy returns a well-formed vote on healthy data', () => {
    const ctx = strategyContext(uptrend());
    const votes = runStrategies(ctx);
    expect(votes).toHaveLength(STRATEGIES.length);
    for (const vote of votes) {
      expect(['BUY', 'SELL', 'NO_TRADE']).toContain(vote.direction);
      expect(vote.strength).toBeGreaterThanOrEqual(0);
      expect(vote.strength).toBeLessThanOrEqual(1);
      expect(vote.reasons.length).toBeGreaterThan(0);
    }
  });

  it('trend following agrees with a persistent uptrend', () => {
    const ctx = strategyContext(uptrend());
    const vote = STRATEGIES.find((s) => s.name === 'trend_follow')!.evaluate(ctx);
    expect(vote.direction).toBe('BUY');
  });

  it('trend following agrees with a persistent downtrend', () => {
    const ctx = strategyContext(downtrend());
    const vote = STRATEGIES.find((s) => s.name === 'trend_follow')!.evaluate(ctx);
    expect(vote.direction).toBe('SELL');
  });

  it('refuses to trade on a wide spread', () => {
    const ctx = { ...strategyContext(uptrend()), spreadPips: 9 };
    const votes = runStrategies(ctx);
    expect(votes.every((v) => v.direction === 'NO_TRADE')).toBe(true);
    expect(votes.every((v) => v.warnings.includes('spread_too_wide'))).toBe(true);
  });

  it('reports NO_TRADE when there is not enough history', () => {
    const ctx = strategyContext(uptrend().slice(0, 12));
    const votes = runStrategies(ctx);
    expect(votes.every((v) => v.direction === 'NO_TRADE')).toBe(true);
  });

  it('never throws when a strategy receives hostile data', () => {
    const broken = uptrend().map((c) => ({ ...c, high: Number.NaN }));
    const ctx = strategyContext(broken);
    const votes = runStrategies(ctx);
    expect(votes).toHaveLength(STRATEGIES.length);
  });
});

describe('regime detection', () => {
  it('classifies a trend', () => {
    const regime = detectRegime(uptrend(), aggregate(uptrend(), 'M3', 'test'));
    expect(['TREND_UP', 'VOLATILE']).toContain(regime.regime);
    expect(regime.atrPips).toBeGreaterThan(0);
  });

  it('classifies chop as range or quiet, never as a trend', () => {
    const regime = detectRegime(chop(), aggregate(chop(), 'M3', 'test'));
    expect(['RANGE', 'QUIET', 'VOLATILE']).toContain(regime.regime);
  });

  it('returns UNKNOWN with insufficient history instead of guessing', () => {
    const regime = detectRegime(uptrend().slice(0, 10));
    expect(regime.regime).toBe('UNKNOWN');
    expect(regime.confidence).toBe(0);
  });
});

describe('vote combination', () => {
  const vote = (strategy: string, direction: StrategyVote['direction'], strength: number): StrategyVote => ({
    strategy,
    direction,
    strength,
    reasons: [],
    warnings: [],
  });

  it('weights trend strategies higher in a trend regime', () => {
    const regime = { regime: 'TREND_UP' as const, confidence: 0.8, atrPips: 8, atrPercentile: 0.5, adx: 30, reasons: [] };
    const combined = combineVotes([vote('trend_follow', 'BUY', 0.8), vote('mean_reversion', 'SELL', 0.8)], regime);
    expect(combined.direction).toBe('BUY');
  });

  it('returns NO_TRADE when there is no consensus', () => {
    const regime = { regime: 'RANGE' as const, confidence: 0.5, atrPips: 8, atrPercentile: 0.5, adx: 15, reasons: [] };
    const combined = combineVotes([vote('trend_follow', 'BUY', 0.5), vote('mean_reversion', 'SELL', 0.5)], regime);
    expect(combined.agreement).toBeCloseTo(0.5, 5);
    expect(Math.abs(combined.score)).toBeLessThan(0.5);
  });

  it('returns NO_TRADE when every strategy abstains', () => {
    const regime = { regime: 'QUIET' as const, confidence: 0.5, atrPips: 4, atrPercentile: 0.1, adx: 10, reasons: [] };
    const combined = combineVotes([vote('trend_follow', 'NO_TRADE', 0), vote('momentum', 'NO_TRADE', 0)], regime);
    expect(combined.direction).toBe('NO_TRADE');
    expect(combined.score).toBe(0);
  });
});

describe('ensemble gates', () => {
  const options = {
    engineVersion: 'test',
    minConfidence: 0.62,
    minRewardRisk: 1.2,
    maxSpreadPips: 2.5,
  };

  it('emits NO_TRADE on stale data even if strategies agree', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1, { dataQuality: 'STALE', ageSeconds: 400 }),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options,
    });
    expect(result.decision).toBe('NO_TRADE');
    expect(result.gates.find((g) => g.gate === 'data_quality')?.passed).toBe(false);
  });

  it('emits NO_TRADE when the confidence threshold is not met', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: { ...options, minConfidence: 0.999 },
    });
    expect(result.decision).toBe('NO_TRADE');
    expect(result.reasons[0]).toContain('NO-TRADE');
    expect(result.gates.find((g) => g.gate === 'confidence')?.passed).toBe(false);
  });

  it('records every gate so the operator can see why a trade was skipped', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options,
    });
    expect(result.gates.map((g) => g.gate)).toEqual(
      expect.arrayContaining(['data_quality', 'spread', 'regime_confidence', 'strategy_consensus', 'confidence']),
    );
  });

  it('produces a decisive direction on a clean, strongly trending tape when thresholds allow', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: { ...options, minConfidence: 0.3 },
    });
    expect(result.decision).toBe('BUY');
    expect(result.confidence).toBeGreaterThan(0.3);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('lets a learned model influence confidence without overriding hard gates', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: {
        ...options,
        minConfidence: 0.3,
        model: { versionId: 'model-1', predict: () => 0.95 },
      },
    });
    expect(result.modelProbability).toBeCloseTo(0.95, 5);
    expect(result.modelVersionId).toBe('model-1');
    expect(result.decision).toBe('BUY');
  });

  it('is deterministic: identical inputs produce identical decisions, gates and reasons', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const params = {
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: {
        ...options,
        minConfidence: 0.3,
        model: { versionId: 'model-1', predict: () => 0.7 },
        learnedWeights: { trend_follow: 1.2, mean_reversion: 0.9 },
      },
    };
    const first = evaluatePrediction(params);
    const second = evaluatePrediction(params);
    expect(second.result).toEqual(first.result);
    expect(second.context).toEqual(first.context);
  });

  it('ignores a model that returns an unusable probability and says so', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const ruleOnly = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: { ...options, minConfidence: 0.3 },
    });
    for (const invalid of [Number.NaN, 1.7, -0.2]) {
      const { result } = evaluatePrediction({
        snapshot: snapshot(m1),
        regime,
        m1,
        m3: aggregate(m1, 'M3', 'test'),
        options: { ...options, minConfidence: 0.3, model: { versionId: 'bad-model', predict: () => invalid } },
      });
      expect(result.modelProbability).toBeNull();
      expect(result.modelVersionId).toBeNull();
      expect(result.warnings).toContain('model_invalid_output');
      expect(result.decision).toBe(ruleOnly.result.decision);
      expect(result.confidence).toBe(ruleOnly.result.confidence);
      expect(result.gates.find((g) => g.gate === 'model_agreement')?.passed).toBe(false);
    }
  });

  it('redacts secrets from a model error before it reaches the stored reason', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const secret = '0123456789abcdef0123456789abcdef';
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options: {
        ...options,
        model: {
          versionId: 'broken-model',
          predict: () => {
            throw new Error(`request failed for https://api.twelvedata.com/quote?apikey=${secret}`);
          },
        },
      },
    });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(secret);
    expect(result.warnings).toContain('model_error');
    expect(result.reasons.some((r) => r.startsWith('model unavailable:'))).toBe(true);
  });

  it('treats a non-finite spread as a failed gate rather than a pass', () => {
    const m1 = uptrend();
    const regime = detectRegime(m1, aggregate(m1, 'M3', 'test'));
    const { result } = evaluatePrediction({
      snapshot: snapshot(m1, { spreadPips: Number.NaN, spreadOk: true }),
      regime,
      m1,
      m3: aggregate(m1, 'M3', 'test'),
      options,
    });
    expect(result.decision).toBe('NO_TRADE');
    expect(result.gates.find((g) => g.gate === 'spread')?.passed).toBe(false);
    expect(result.gates.find((g) => g.gate === 'spread')?.detail).toContain('unknown');
  });
});

describe('risk planning', () => {
  it('sizes from ATR, spread and the configured risk budget', () => {
    const plan = buildRiskPlan({
      pair: 'EUR/USD',
      direction: 'BUY',
      price: 1.1,
      atrPips: 6,
      spreadPips: 0.8,
      accountBalance: 10_000,
      riskPercent: 0.5,
    });
    expect(plan.stopPips).toBeGreaterThan(2.5);
    expect(plan.rewardRisk).toBeCloseTo(1.4, 2);
    expect(plan.targetPips).toBeCloseTo(plan.stopPips * 1.4, 2);
    expect(plan.riskAmount).toBe(50);
    expect(plan.positionUnits).toBeGreaterThan(0);
  });

  it('uses 0.01 pip sizing for JPY pairs', () => {
    expect(instrumentMeta('USD/JPY').pipSize).toBe(0.01);
    const plan = buildRiskPlan({
      pair: 'USD/JPY',
      direction: 'SELL',
      price: 151.4,
      atrPips: 5,
      spreadPips: 0.9,
      accountBalance: 10_000,
      riskPercent: 0.5,
    });
    expect(plan.stopPips).toBeGreaterThan(2.5);
  });

  it('picks the strategy that actually drove the decision', () => {
    const votes: StrategyVote[] = [
      { strategy: 'trend_follow', direction: 'BUY', strength: 0.9, reasons: [], warnings: [] },
      { strategy: 'momentum', direction: 'BUY', strength: 0.4, reasons: [], warnings: [] },
    ];
    expect(dominantStrategy(votes, 'BUY')).toBe('trend_follow');
    expect(dominantStrategy(votes, 'NO_TRADE')).toContain('none');
  });
});
