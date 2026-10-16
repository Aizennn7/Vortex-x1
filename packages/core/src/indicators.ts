/**
 * Deterministic technical indicators. All functions take plain numbers and
 * return arrays aligned to the input index; leading positions carry `null`
 * instead of NaN so downstream code must handle warm-up explicitly.
 */

import type { Candle } from './types.js';

export type Series = (number | null)[];

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function highs(candles: Candle[]): number[] {
  return candles.map((c) => c.high);
}

export function lows(candles: Candle[]): number[] {
  return candles.map((c) => c.low);
}

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seedSum = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i] as number;
    if (i < period) {
      seedSum += v;
      if (i === period - 1) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + (prev as number) * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function stdev(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 1) return out;
  for (let i = period - 1; i < values.length; i += 1) {
    const slice = values.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = (values[i] as number) - (values[i - 1] as number);
    const g = change > 0 ? change : 0;
    const l = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: Candle[], period = 14): Series {
  const tr = trueRange(candles);
  const out: Series = new Array(candles.length).fill(null);
  if (tr.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i += 1) {
    prev = (prev * (period - 1) + (tr[i] as number)) / period;
    out[i] = prev;
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine: Series = values.map((_, i) => {
    const f = emaFast[i] ?? null;
    const s = emaSlow[i] ?? null;
    return f === null || s === null ? null : f - s;
  });
  const defined = macdLine.filter((v): v is number => v !== null);
  const signalDefined = ema(defined, signalPeriod);
  const signal: Series = new Array(values.length).fill(null);
  let cursor = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (macdLine[i] !== null) {
      signal[i] = signalDefined[cursor] ?? null;
      cursor += 1;
    }
  }
  const histogram: Series = values.map((_, i) => {
    const m = macdLine[i] ?? null;
    const s = signal[i] ?? null;
    return m === null || s === null ? null : m - s;
  });
  return { macd: macdLine, signal, histogram };
}

export interface BollingerResult {
  upper: Series;
  middle: Series;
  lower: Series;
  width: Series;
}

export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const sd = stdev(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  const width: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i += 1) {
    const m = middle[i] ?? null;
    const s = sd[i] ?? null;
    if (m === null || s === null) continue;
    upper[i] = m + mult * s;
    lower[i] = m - mult * s;
    width[i] = m === 0 ? null : ((upper[i]! - lower[i]!) / m) * 100;
  }
  return { upper, middle, lower, width };
}

export function adx(candles: Candle[], period = 14): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length < period * 2) return out;
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  const tr = trueRange(candles);
  for (let i = 1; i < candles.length; i += 1) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }
  const smooth = (arr: number[]): number[] => {
    const res: number[] = new Array(arr.length).fill(0);
    let acc = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    res[period] = acc;
    for (let i = period + 1; i < arr.length; i += 1) {
      acc = acc - acc / period + (arr[i] as number);
      res[i] = acc;
    }
    return res;
  };
  const trS = smooth(tr);
  const pS = smooth(plusDm);
  const mS = smooth(minusDm);
  const dx: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i += 1) {
    const trv = trS[i] as number;
    if (!trv) continue;
    const pdi = 100 * ((pS[i] as number) / trv);
    const mdi = 100 * ((mS[i] as number) / trv);
    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }
  const firstDx = dx.findIndex((v) => v !== null);
  if (firstDx < 0) return out;
  let acc = 0;
  let count = 0;
  const start = firstDx;
  for (let i = start; i < Math.min(start + period, candles.length); i += 1) {
    if (dx[i] !== null) {
      acc += dx[i] as number;
      count += 1;
    }
  }
  if (count === 0) return out;
  let prev = acc / count;
  const firstAdxIndex = start + count - 1;
  out[firstAdxIndex] = prev;
  for (let i = firstAdxIndex + 1; i < candles.length; i += 1) {
    const v = dx[i] ?? null;
    if (v === null) continue;
    prev = (prev * (period - 1) + v) / period;
    out[i] = prev;
  }
  return out;
}

export function stochastic(candles: Candle[], period = 14, smoothK = 3): { k: Series; d: Series } {
  const raw: Series = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...window.map((c) => c.high));
    const ll = Math.min(...window.map((c) => c.low));
    raw[i] = hh === ll ? 50 : ((candles[i]!.close - ll) / (hh - ll)) * 100;
  }
  const defined = raw.filter((v): v is number => v !== null);
  const kDefined = sma(defined, smoothK);
  const k: Series = new Array(candles.length).fill(null);
  let cursor = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (raw[i] !== null) {
      k[i] = kDefined[cursor] ?? null;
      cursor += 1;
    }
  }
  const kValues = k.filter((v): v is number => v !== null);
  const dDefined = sma(kValues, 3);
  const d: Series = new Array(candles.length).fill(null);
  cursor = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (k[i] !== null) {
      d[i] = dDefined[cursor] ?? null;
      cursor += 1;
    }
  }
  return { k, d };
}

export interface DonchianResult {
  upper: Series;
  lower: Series;
  middle: Series;
}

export function donchian(candles: Candle[], period = 20): DonchianResult {
  const upper: Series = new Array(candles.length).fill(null);
  const lower: Series = new Array(candles.length).fill(null);
  const middle: Series = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i += 1) {
    const window = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...window.map((c) => c.high));
    const ll = Math.min(...window.map((c) => c.low));
    upper[i] = hh;
    lower[i] = ll;
    middle[i] = (hh + ll) / 2;
  }
  return { upper, lower, middle };
}

export function last<T>(arr: T[]): T | undefined {
  return arr.length === 0 ? undefined : arr[arr.length - 1];
}

/** Last non-null value of an indicator series. */
export function lastDefined(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i] ?? null;
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
}

/** Percentile rank (0..1) of the final value within the series. */
export function percentileRank(series: Series, lookback = 200): number {
  const values = series.filter((v): v is number => v !== null && Number.isFinite(v));
  if (values.length < 10) return 0.5;
  const window = values.slice(-lookback);
  const target = window[window.length - 1] as number;
  const below = window.filter((v) => v <= target).length;
  return below / window.length;
}

/** Linear-regression slope of the last `lookback` values, normalised by mean. */
export function slope(values: number[], lookback = 20): number {
  const window = values.slice(-lookback);
  const n = window.length;
  if (n < 3) return 0;
  const meanX = (n - 1) / 2;
  const meanY = window.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (i - meanX) * ((window[i] as number) - meanY);
    den += (i - meanX) ** 2;
  }
  if (den === 0) return 0;
  const rawSlope = num / den;
  return meanY === 0 ? 0 : rawSlope / meanY;
}

/** Simple swing-point detection used by the price-action strategy. */
export interface SwingPoints {
  highs: { index: number; price: number }[];
  lows: { index: number; price: number }[];
}

export function swingPoints(candles: Candle[], lookback = 2): SwingPoints {
  const highsOut: { index: number; price: number }[] = [];
  const lowsOut: { index: number; price: number }[] = [];
  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const slice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i]!;
    if (c.high >= Math.max(...slice.map((x) => x.high))) highsOut.push({ index: i, price: c.high });
    if (c.low <= Math.min(...slice.map((x) => x.low))) lowsOut.push({ index: i, price: c.low });
  }
  return { highs: highsOut, lows: lowsOut };
}

export function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function safeDiv(a: number, b: number, fallback = 0): number {
  return b === 0 || !Number.isFinite(b) ? fallback : a / b;
}
