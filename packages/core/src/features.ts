/**
 * Feature engineering for the prediction engine and for the learning
 * pipeline. The feature vector is built strictly from candles that had
 * already CLOSED at decision time, which makes the offline training set
 * reproducible from persisted signals without look-ahead contamination.
 */

import {
  adx,
  atr,
  bollinger,
  clamp,
  donchian,
  ema,
  lastDefined,
  macd,
  percentileRank,
  rsi,
  slope,
  stochastic,
} from './indicators.js';
import { instrumentMeta } from './instruments.js';
import { sessionOf } from './time.js';
import type { Candle, MarketSnapshot, PredictionContext, RegimeState, StrategyVote } from './types.js';

export const FEATURE_NAMES = [
  'bias',
  'confidence',
  'rsi',
  'adx',
  'emaFastVsSlow',
  'emaVsTrend',
  'macdHistNorm',
  'atrPercentile',
  'bbWidthPercentile',
  'agreement',
  'spreadNorm',
  'regimeTrendUp',
  'regimeTrendDown',
  'regimeRange',
  'regimeVolatile',
  'regimeQuiet',
  'sessionTokyo',
  'sessionLondon',
  'sessionOverlap',
  'sessionNewYork',
  'regimeConfidence',
  'm3Agreement',
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureVector = Record<FeatureName, number>;

export interface FeatureInput {
  snapshot: MarketSnapshot;
  context: PredictionContext;
  regime: RegimeState;
  votes: StrategyVote[];
  decision: 'BUY' | 'SELL' | 'NO_TRADE';
  confidence: number;
}

function normalizePips(value: number, pair: string): number {
  const meta = instrumentMeta(pair);
  return value / meta.pipSize;
}

/**
 * Build the model feature vector. `bias` is +1 for BUY, -1 for SELL and 0 for
 * NO_TRADE — NO_TRADE rows are stored but excluded from binary labels unless a
 * separately validated multi-class method is used.
 */
export function buildFeatures(input: FeatureInput): FeatureVector {
  const { snapshot, context, regime, votes, decision, confidence } = input;
  const pair = snapshot.pair;
  const trendUp = regime.regime === 'TREND_UP' ? 1 : 0;
  const trendDown = regime.regime === 'TREND_DOWN' ? 1 : 0;
  const range = regime.regime === 'RANGE' ? 1 : 0;
  const volatile = regime.regime === 'VOLATILE' ? 1 : 0;
  const quiet = regime.regime === 'QUIET' ? 1 : 0;

  const buyVotes = votes.filter((v) => v.direction === 'BUY').length;
  const sellVotes = votes.filter((v) => v.direction === 'SELL').length;
  const total = Math.max(1, votes.length);

  const atrNorm = context.atrPips === 0 ? 0 : clamp(context.atrPips / 20, 0, 3) / 3;

  return {
    bias: decision === 'BUY' ? 1 : decision === 'SELL' ? -1 : 0,
    confidence: clamp(confidence),
    rsi: clamp((context.rsi - 50) / 50, -1, 1),
    adx: clamp(context.adx / 50, 0, 1),
    emaFastVsSlow: clamp(
      context.emaSlow === 0 ? 0 : (context.emaFast - context.emaSlow) / context.emaSlow * 100 * 20,
      -1,
      1,
    ),
    emaVsTrend: clamp(
      context.emaTrend === 0 ? 0 : ((context.price - context.emaTrend) / context.emaTrend) * 100 * 40,
      -1,
      1,
    ),
    macdHistNorm: clamp(atrNorm === 0 ? 0 : context.macdHist / (atrNorm * 10), -1, 1),
    atrPercentile: clamp(context.atrPercentile),
    bbWidthPercentile: clamp(context.bbWidthPercentile),
    agreement: clamp(context.agreement),
    spreadNorm: clamp(normalizePips(snapshot.spreadPips, pair) / 5, 0, 1),
    regimeTrendUp: trendUp,
    regimeTrendDown: trendDown,
    regimeRange: range,
    regimeVolatile: volatile,
    regimeQuiet: quiet,
    sessionTokyo: context.session === 'TOKYO' ? 1 : 0,
    sessionLondon: context.session === 'LONDON' ? 1 : 0,
    sessionOverlap: context.session === 'OVERLAP' ? 1 : 0,
    sessionNewYork: context.session === 'NEW_YORK' ? 1 : 0,
    regimeConfidence: clamp(regime.confidence),
    m3Agreement: context.m3Trend === 'UP' ? 1 : context.m3Trend === 'DOWN' ? -1 : 0,
  };
}

export function toFeatureArray(vector: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => vector[name]);
}

export function fromFeatureArray(values: number[]): FeatureVector {
  const out = {} as FeatureVector;
  FEATURE_NAMES.forEach((name, i) => {
    out[name] = values[i] ?? 0;
  });
  return out;
}

/**
 * Compute the market context. Uses only closed candles; the newest element of
 * `m1` is the last final candle. Every indicator is read at that index.
 */
export function computeContext(params: {
  snapshot: MarketSnapshot;
  regime: RegimeState;
  votes: StrategyVote[];
  m1: Candle[];
  m3: Candle[];
}): PredictionContext {
  const { snapshot, regime, votes, m1, m3 } = params;
  const price = m1.length > 0 ? m1[m1.length - 1]!.close : snapshot.price;
  const values = m1.map((c) => c.close);
  const rsiSeries = rsi(values, 14);
  const adxSeries = adx(m1, 14);
  const emaFastSeries = ema(values, 9);
  const emaSlowSeries = ema(values, 21);
  const emaTrendSeries = ema(values, 50);
  const macdResult = macd(values);
  const bb = bollinger(values, 20, 2);
  const m3Closes = m3.map((c) => c.close);
  const m3Slope = slope(m3Closes, 10);
  const m3Trend: PredictionContext['m3Trend'] = m3Slope > 0.0004 ? 'UP' : m3Slope < -0.0004 ? 'DOWN' : 'FLAT';

  const atrSeries = atr(m1, 14);
  const atrValue = lastDefined(atrSeries) ?? 0;
  const atrPercentile = percentileRank(atrSeries, 240);

  const asOfIso = typeof snapshot.asOf === 'number' ? new Date(snapshot.asOf).toISOString() : snapshot.asOf;
  const actionable = votes.filter((v) => v.direction !== 'NO_TRADE');
  const buys = actionable.filter((v) => v.direction === 'BUY').length;
  const sells = actionable.filter((v) => v.direction === 'SELL').length;
  const dominant = Math.max(buys, sells);
  const agreement = actionable.length === 0 ? 0 : dominant / Math.max(actionable.length, 1);

  return {
    pair: snapshot.pair,
    price,
    regime: regime.regime,
    regimeConfidence: regime.confidence,
    atrPips: normalizePips(atrValue, snapshot.pair),
    atrPercentile,
    spreadPips: snapshot.spreadPips,
    spreadSource: snapshot.spreadSource,
    dataProvider: snapshot.dataProvider,
    synthetic: snapshot.synthetic,
    rsi: lastDefined(rsiSeries) ?? 50,
    adx: lastDefined(adxSeries) ?? 0,
    emaFast: lastDefined(emaFastSeries) ?? price,
    emaSlow: lastDefined(emaSlowSeries) ?? price,
    emaTrend: lastDefined(emaTrendSeries) ?? price,
    macdHist: lastDefined(macdResult.histogram) ?? 0,
    bbWidthPercentile: percentileRank(bb.width, 240),
    session: sessionOf(asOfIso),
    hourUtc: new Date(snapshot.asOf).getUTCHours(),
    agreement: agreement * (m3Trend === 'FLAT' ? 0.85 : 1),
    votes,
    m3Trend,
    dataQuality: snapshot.dataQuality,
  };
}
