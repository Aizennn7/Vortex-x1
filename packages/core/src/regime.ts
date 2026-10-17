/**
 * Market-regime detection. Regime drives strategy weighting so the ensemble
 * does not apply a trend-following logic in a chop market (and vice versa).
 */

import { adx, atr, lastDefined, percentileRank, slope } from './indicators.js';
import { instrumentMeta } from './instruments.js';
import type { Candle, RegimeState } from './types.js';

export function detectRegime(m1: Candle[], m3: Candle[] = []): RegimeState {
  const reasons: string[] = [];
  if (m1.length < 60) {
    return { regime: 'UNKNOWN', confidence: 0, atrPips: 0, atrPercentile: 0.5, adx: 0, reasons: ['insufficient history'] };
  }
  const values = m1.map((c) => c.close);
  const atrSeries = atr(m1, 14);
  const adxSeries = adx(m1, 14);
  const atrValue = lastDefined(atrSeries) ?? 0;
  const adxValue = lastDefined(adxSeries) ?? 0;
  const atrPct = percentileRank(atrSeries, 240);
  const meta = instrumentMeta(m1[0]!.pair);
  const atrPips = atrValue / meta.pipSize;

  // `slope()` returns a slope NORMALISED by the mean price, i.e. a fractional
  // change per bar, not a price distance. 0.00012 therefore means "0.012% per
  // bar" on every instrument, which is why one constant is comparable across
  // EUR/USD and USD/JPY. (Interpreting it as pips would be a 100x error on a
  // JPY cross: 0.012 pips/bar instead of 1.2.)
  const slopeM1 = slope(values, 30);
  const slopeM3 = slope(m3.map((c) => c.close), 10);
  const directional = (slopeM1 + slopeM3) / 2;

  const trending = adxValue >= 22 && Math.abs(directional) > 0.00012;
  const volatile = atrPct >= 0.85;
  const quiet = atrPct <= 0.2;

  let regime: RegimeState['regime'];
  let confidence: number;

  if (trending) {
    regime = directional > 0 ? 'TREND_UP' : 'TREND_DOWN';
    confidence = Math.min(0.95, 0.45 + (adxValue - 22) / 40 + Math.min(0.2, Math.abs(directional) * 400));
    reasons.push(`ADX ${adxValue.toFixed(1)} with ${regime === 'TREND_UP' ? 'positive' : 'negative'} structure`);
  } else if (volatile) {
    regime = 'VOLATILE';
    confidence = Math.min(0.9, 0.5 + (atrPct - 0.85) * 2);
    reasons.push(`ATR in the ${(atrPct * 100).toFixed(0)}th percentile`);
  } else if (quiet) {
    regime = 'QUIET';
    confidence = Math.min(0.9, 0.5 + (0.2 - atrPct) * 2);
    reasons.push(`ATR in the ${(atrPct * 100).toFixed(0)}th percentile — thin conditions`);
  } else {
    regime = 'RANGE';
    confidence = Math.min(0.85, 0.4 + (24 - Math.min(adxValue, 24)) / 40);
    reasons.push(`ADX ${adxValue.toFixed(1)} below trend threshold`);
  }

  return { regime, confidence, atrPips, atrPercentile: atrPct, adx: adxValue, reasons };
}

/** Strategy weighting for a regime. Trend logic is muted in chop, etc. */
export const REGIME_WEIGHTS: Record<RegimeState['regime'], Record<string, number>> = {
  TREND_UP: { trend_follow: 1.3, momentum: 1.15, breakout: 1.05, mean_reversion: 0.6, price_action: 1.0, volatility: 0.9, multi_timeframe: 1.2 },
  TREND_DOWN: { trend_follow: 1.3, momentum: 1.15, breakout: 1.05, mean_reversion: 0.6, price_action: 1.0, volatility: 0.9, multi_timeframe: 1.2 },
  RANGE: { trend_follow: 0.6, momentum: 0.8, breakout: 0.75, mean_reversion: 1.35, price_action: 1.1, volatility: 0.9, multi_timeframe: 0.9 },
  VOLATILE: { trend_follow: 1.0, momentum: 0.95, breakout: 1.1, mean_reversion: 0.7, price_action: 0.95, volatility: 1.25, multi_timeframe: 1.0 },
  QUIET: { trend_follow: 0.9, momentum: 0.85, breakout: 0.7, mean_reversion: 1.1, price_action: 1.0, volatility: 0.6, multi_timeframe: 0.95 },
  UNKNOWN: { trend_follow: 1, momentum: 1, breakout: 1, mean_reversion: 1, price_action: 1, volatility: 1, multi_timeframe: 1 },
};
