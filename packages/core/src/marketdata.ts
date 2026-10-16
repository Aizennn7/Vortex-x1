/**
 * Market-data validation, deduplication, gap detection and freshness.
 *
 * Rules enforced here (all unit tested):
 *  - A candle is only usable for signals once `isFinal` is true. Providers
 *    re-issue the in-progress candle, so acting on it would inject
 *    look-ahead/partial-candle bias.
 *  - OHLC must be self-consistent and finite.
 *  - Within a batch, duplicate open times are collapsed keeping the newest
 *    revision; a revision newer than the stored one replaces it.
 *  - Gaps are reported, never silently interpolated.
 */

import { TIMEFRAME_SECONDS, type Candle, type DataQuality, type Pair, type Timeframe } from './types.js';
import { diffSeconds, toDate, toIso, type TimeInput } from './time.js';
import { normalizePair } from './instruments.js';

export interface CandleInput {
  pair: string;
  timeframe: Timeframe;
  openTime: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  provider: string;
  isFinal?: boolean;
  revision?: number;
  receivedAt?: string;
}

/** Structural validation of a single candle. Returns a reason when invalid. */
export function validateCandle(input: CandleInput): { ok: boolean; reason?: string; candle?: Candle } {
  const pair = normalizePair(input.pair);
  const prices = [input.open, input.high, input.low, input.close];
  if (prices.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p <= 0)) {
    return { ok: false, reason: 'non-finite or non-positive OHLC value' };
  }
  const [o, h, l, c] = prices as [number, number, number, number];
  if (h < l) return { ok: false, reason: 'high below low' };
  if (h < Math.max(o, c) - 1e-12) return { ok: false, reason: 'high below open/close' };
  if (l > Math.min(o, c) + 1e-12) return { ok: false, reason: 'low above open/close' };
  const openDate = new Date(input.openTime);
  if (Number.isNaN(openDate.getTime())) return { ok: false, reason: 'invalid open time' };
  const step = TIMEFRAME_SECONDS[input.timeframe];
  if (openDate.getTime() % (step * 1000) !== 0) {
    return { ok: false, reason: `open time is not aligned to the ${input.timeframe} boundary` };
  }
  const candle: Candle = {
    pair,
    timeframe: input.timeframe,
    openTime: openDate.toISOString(),
    closeTime: toIso(openDate.getTime() + step * 1000),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: input.volume ?? null,
    provider: input.provider,
    isFinal: input.isFinal ?? true,
    revision: input.revision ?? 1,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
  };
  return { ok: true, candle };
}

/**
 * Validate and dedupe a batch of candles for one pair/timeframe.
 * Sorting is ascending by open time; the newest revision wins.
 */
export function normalizeBatch(
  inputs: CandleInput[],
  expected?: { pair: Pair; timeframe: Timeframe },
): { candles: Candle[]; quality: DataQuality } {
  const quality: DataQuality = { ok: true, gaps: [], duplicates: [], invalid: [], reasons: {} };
  const byTime = new Map<number, Candle>();

  for (const input of inputs) {
    const result = validateCandle(input);
    if (!result.ok || !result.candle) {
      const key = expected ? `${expected.pair}:${toIso(input.openTime)}` : toIso(input.openTime);
      quality.invalid.push(key);
      quality.reasons[key] = result.reason ?? 'unknown';
      continue;
    }
    const candle = result.candle;
    if (expected && (candle.pair !== expected.pair || candle.timeframe !== expected.timeframe)) {
      const key = `${candle.pair}@${candle.timeframe}:${candle.openTime}`;
      quality.invalid.push(key);
      quality.reasons[key] = 'pair/timeframe mismatch in batch';
      continue;
    }
    const ts = new Date(candle.openTime).getTime();
    const existing = byTime.get(ts);
    if (existing) {
      quality.duplicates.push(candle.openTime);
      if ((candle.revision ?? 1) >= (existing.revision ?? 1)) byTime.set(ts, candle);
    } else {
      byTime.set(ts, candle);
    }
  }

  const candles = [...byTime.values()].sort(
    (a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime(),
  );

  if (candles.length > 1) {
    const step = TIMEFRAME_SECONDS[candles[0]!.timeframe] * 1000;
    for (let i = 1; i < candles.length; i += 1) {
      const prev = new Date(candles[i - 1]!.openTime).getTime();
      const cur = new Date(candles[i]!.openTime).getTime();
      const delta = cur - prev;
      if (delta > step) {
        for (let t = prev + step; t < cur; t += step) quality.gaps.push(toIso(t));
      }
    }
  }

  quality.ok = quality.invalid.length === 0;
  return { candles, quality };
}

/** Detect gaps between stored candles across an explicit range. */
export function findGaps(
  candles: Candle[],
  from: string | number,
  to: string | number,
  timeframe: Timeframe,
): string[] {
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  const present = new Set(candles.map((c) => new Date(c.openTime).getTime()));
  const start = Math.floor(new Date(from).getTime() / step) * step;
  const end = Math.floor(new Date(to).getTime() / step) * step;
  const gaps: string[] = [];
  for (let t = start; t <= end; t += step) {
    if (!present.has(t)) gaps.push(toIso(t));
  }
  return gaps;
}

export interface FreshnessReport {
  ageSeconds: number;
  isStale: boolean;
  isGappy: boolean;
  quality: 'OK' | 'STALE' | 'GAPPY' | 'INSUFFICIENT';
  expectedOpenTime: string;
  reasons: string[];
}

/**
 * Freshness of the newest final candle relative to `now`.
 *
 * A final M1 candle that opened at T closes at T+60s and is normally
 * available a few seconds later. `maxAgeSeconds` is measured from the candle
 * CLOSE time (the earliest instant the candle can legitimately exist), which
 * avoids the classic off-by-one-minute false "stale" alarm.
 */
export function freshness(
  candles: Candle[],
  now: TimeInput,
  timeframe: Timeframe,
  maxAgeSeconds: number,
  minCandles = 30,
): FreshnessReport {
  const reasons: string[] = [];
  const step = TIMEFRAME_SECONDS[timeframe];
  const nowMs = toDate(now).getTime();
  const expectedOpen = Math.floor(nowMs / (step * 1000)) * step - step * 1000;
  if (candles.length < minCandles) {
    return {
      ageSeconds: Number.POSITIVE_INFINITY,
      isStale: true,
      isGappy: false,
      quality: 'INSUFFICIENT',
      expectedOpenTime: toIso(expectedOpen),
      reasons: [`only ${candles.length} ${timeframe} candles available (need ${minCandles})`],
    };
  }
  const newest = candles[candles.length - 1]!;
  const candleCloseMs = new Date(newest.closeTime).getTime();
  const ageSeconds = Math.max(0, diffSeconds(nowMs, candleCloseMs));
  const isStale = ageSeconds > maxAgeSeconds;
  if (isStale) reasons.push(`newest ${timeframe} candle closed ${Math.round(ageSeconds)}s ago (limit ${maxAgeSeconds}s)`);

  const recent = candles.slice(-20);
  let gappy = false;
  for (let i = 1; i < recent.length; i += 1) {
    const delta = new Date(recent[i]!.openTime).getTime() - new Date(recent[i - 1]!.openTime).getTime();
    if (delta !== step * 1000) {
      gappy = true;
      break;
    }
  }
  if (gappy) reasons.push('missing candle(s) inside the recent window');

  let quality: FreshnessReport['quality'] = 'OK';
  if (isStale) quality = 'STALE';
  else if (gappy) quality = 'GAPPY';

  return {
    ageSeconds,
    isStale,
    isGappy: gappy,
    quality,
    expectedOpenTime: toIso(expectedOpen),
    reasons,
  };
}

/**
 * Trim a candle array to only final candles and drop the in-progress bar.
 * Guards against provider payloads containing the live, partial candle.
 */
export function onlyFinal(candles: Candle[], now: TimeInput, timeframe: Timeframe): Candle[] {
  const nowMs = toDate(now).getTime();
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  return candles.filter(
    (c) => c.isFinal !== false && new Date(c.closeTime).getTime() <= Math.floor(nowMs / step) * step,
  );
}

/** Merge freshly fetched candles into an existing ascending series. */
export function mergeCandles(existing: Candle[], incoming: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of existing) map.set(new Date(c.openTime).getTime(), c);
  for (const c of incoming) {
    const key = new Date(c.openTime).getTime();
    const prev = map.get(key);
    if (!prev || (c.revision ?? 1) >= (prev.revision ?? 1)) map.set(key, c);
  }
  return [...map.values()].sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
}

/** Aggregate M1 candles into a higher timeframe (left-closed, exact buckets). */
export function aggregate(candles: Candle[], timeframe: Timeframe, provider: string): Candle[] {
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  const buckets = new Map<number, Candle[]>();
  for (const c of candles) {
    const bucket = Math.floor(new Date(c.openTime).getTime() / step) * step;
    const list = buckets.get(bucket) ?? [];
    list.push(c);
    buckets.set(bucket, list);
  }
  const out: Candle[] = [];
  for (const [bucket, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
    const first = sorted[0]!;
    const lastC = sorted[sorted.length - 1]!;
    const bucketClose = bucket + step;
    // Only emit complete buckets. A 3-minute bucket built from a single M1 bar
    // (because the other two are missing) is not a valid M3 candle.
    const complete = new Date(lastC.closeTime).getTime() === bucketClose && sorted.length === step / (60 * 1000);
    out.push({
      pair: first.pair,
      timeframe,
      openTime: toIso(bucket),
      closeTime: toIso(bucketClose),
      open: first.open,
      high: Math.max(...sorted.map((c) => c.high)),
      low: Math.min(...sorted.map((c) => c.low)),
      close: lastC.close,
      volume: sorted.reduce((a, c) => a + (c.volume ?? 0), 0),
      provider,
      isFinal: complete,
      revision: 1,
    });
  }
  return out;
}

/** Timestamp (ISO) of the most recent closed candle boundary. */
export function lastClosedBoundary(now: Date | number, timeframe: Timeframe): string {
  const step = TIMEFRAME_SECONDS[timeframe] * 1000;
  const ms = typeof now === 'number' ? now : now.getTime();
  return toIso(Math.floor(ms / step) * step - step * 1000);
}
