/**
 * Deterministic synthetic provider.
 *
 * Used for tests, CI and local development ONLY. Data produced here is
 * labelled `provider: "simulated"` everywhere (candles, UI badges, health)
 * so it can never be mistaken for live market data, and the worker refuses to
 * publish Telegram signals sourced purely from simulated candles unless
 * `allowSyntheticSignals` is explicitly enabled for a demo mode.
 */

import type { CandleInput, Timeframe } from '@vortex/core';
import { TIMEFRAME_SECONDS } from '@vortex/core';
import { MODELLED_SPREAD_PIPS, type MarketDataProvider, type QuoteResult, type TimeSeriesRequest, type TimeSeriesResult } from './types.js';

export interface SimulatorOptions {
  /** Fixed seed keeps fixtures reproducible across runs. */
  seed?: number;
  /** Reference price per pair (defaults to a sensible table). */
  basePrices?: Record<string, number>;
  /** Volatility in pips per minute. */
  volatilityPips?: number;
  /** Deterministic clock override (ms epoch). */
  now?: () => number;
}

const DEFAULT_BASE_PRICES: Record<string, number> = {
  'EUR/USD': 1.0865,
  'GBP/USD': 1.2712,
  'USD/JPY': 151.42,
  'USD/CHF': 0.8842,
  'USD/CAD': 1.3688,
  'AUD/USD': 0.6584,
  'NZD/USD': 0.6042,
  'EUR/GBP': 0.8548,
  'EUR/JPY': 164.52,
  'EUR/CHF': 0.9606,
  'EUR/AUD': 1.6498,
  'EUR/CAD': 1.4872,
  'GBP/JPY': 192.48,
  'GBP/CHF': 1.1238,
  'GBP/AUD': 1.9302,
  'AUD/JPY': 99.68,
  'AUD/CAD': 0.9012,
  'AUD/NZD': 1.0896,
  'CAD/JPY': 110.62,
  'CHF/JPY': 171.28,
  'NZD/JPY': 91.52,
  'USD/SEK': 10.642,
  'USD/NOK': 10.784,
};

/** Mulberry32 — small, fast, fully deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller transform on top of the seeded PRNG. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function pipSizeFor(pair: string): number {
  return pair.endsWith('JPY') ? 0.01 : 0.0001;
}

function digitsFor(pair: string): number {
  return pair.endsWith('JPY') ? 3 : 5;
}

export class SimulatedProvider implements MarketDataProvider {
  readonly name = 'simulated';
  readonly synthetic = true;
  private readonly rand: () => number;
  private readonly basePrices: Record<string, number>;
  private readonly volatilityPips: number;
  private readonly now: () => number;

  constructor(options: SimulatorOptions = {}) {
    this.rand = mulberry32(options.seed ?? 42);
    this.basePrices = { ...DEFAULT_BASE_PRICES, ...(options.basePrices ?? {}) };
    this.volatilityPips = options.volatilityPips ?? 4.5;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Generate candles for a pair. Prices are a seeded random walk anchored at
   * the pair's reference price and re-derivable for any timestamp, so two
   * calls with the same arguments always agree.
   */
  async fetchTimeSeries(request: TimeSeriesRequest, _apiKey: string | null): Promise<TimeSeriesResult> {
    const step = TIMEFRAME_SECONDS[request.timeframe] * 1000;
    const count = Math.min(2000, request.outputsize ?? 200);
    const base = this.basePrices[request.pair] ?? 1.1;
    const pip = pipSizeFor(request.pair);
    const digits = digitsFor(request.pair);
    const nowMs = this.now();
    const lastClosedOpen = Math.floor(nowMs / step) * step - step;

    const end = request.endDate ? new Date(request.endDate).getTime() : lastClosedOpen;
    const start = request.startDate
      ? Math.max(new Date(request.startDate).getTime(), end - step * count)
      : end - step * (count - 1);

    const candles: CandleInput[] = [];
    // Deterministic phase offset per pair so pairs are decorrelated but stable.
    const phase = [...request.pair].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) * 97;
    let price = base;
    const warmupBars = 500;
    const warmupStart = start - step * warmupBars;
    for (let t = warmupStart; t <= end; t += step) {
      const localRand = mulberry32((Math.floor(t / step) ^ (phase + (request.pair.length << 8))) >>> 0);
      const drift = Math.sin((t / (step * 240)) + phase) * this.volatilityPips * 0.18;
      const shock = gaussian(localRand) * this.volatilityPips;
      const move = (drift + shock) * pip;
      const open = price;
      const close = open + move;
      const wick = Math.abs(gaussian(localRand)) * this.volatilityPips * 0.8 * pip;
      const high = Math.max(open, close) + wick;
      const low = Math.min(open, close) - wick * 0.9;
      price = close;
      if (t < start) continue;
      candles.push({
        pair: request.pair,
        timeframe: request.timeframe,
        openTime: new Date(t).toISOString(),
        open: Number(open.toFixed(digits + 1)),
        high: Number(high.toFixed(digits + 1)),
        low: Number(low.toFixed(digits + 1)),
        close: Number(close.toFixed(digits + 1)),
        volume: Math.round(500 + localRand() * 1500),
        provider: this.name,
        isFinal: t + step <= nowMs,
        revision: 1,
      });
    }
    return { pair: request.pair, timeframe: request.timeframe, candles, creditsUsed: 0 };
  }

  async fetchQuote(pair: string, _apiKey: string | null): Promise<QuoteResult> {
    const series = await this.fetchTimeSeries({ pair, timeframe: 'M1', outputsize: 2 }, null);
    const last = series.candles[series.candles.length - 1];
    const lastOpen = last ? new Date(last.openTime).getTime() : this.now();
    const price = last?.close ?? this.basePrices[pair] ?? 1.1;
    const spreadPips = MODELLED_SPREAD_PIPS[pair] ?? 1.8;
    const half = (spreadPips * pipSizeFor(pair)) / 2;
    return {
      pair,
      bid: Number((price - half).toFixed(digitsFor(pair) + 1)),
      ask: Number((price + half).toFixed(digitsFor(pair) + 1)),
      price,
      spreadSource: 'modelled',
      spreadPips,
      asOf: new Date(lastOpen + 60_000).toISOString(),
    };
  }
}
