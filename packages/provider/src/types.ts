/**
 * Market-data provider contract. Adapters must be pure I/O: they fetch, they
 * normalise, they report cost and never touch the database.
 */

import type { CandleInput } from '@vortex/core';

export interface TimeSeriesRequest {
  pair: string;
  timeframe: 'M1' | 'M3' | 'M5' | 'M15' | 'H1';
  /** Number of candles requested (provider `outputsize`). */
  outputsize?: number;
  /** Inclusive UTC start date/time for backfills. */
  startDate?: string;
  /** Exclusive UTC end date/time for backfills. */
  endDate?: string;
}

export interface TimeSeriesResult {
  pair: string;
  timeframe: TimeSeriesRequest['timeframe'];
  candles: CandleInput[];
  /** Provider-reported credits/quota consumed by this call. */
  creditsUsed: number;
  /** Provider's own rate-limit headers when present. */
  rateLimit?: { remaining?: number; limit?: number; resetAt?: string | null };
  raw?: unknown;
}

export interface QuoteResult {
  pair: string;
  bid?: number;
  ask?: number;
  price: number;
  /** Where the spread came from — never silently presented as live tick data. */
  spreadSource: 'provider' | 'modelled';
  spreadPips: number;
  asOf: string;
  raw?: unknown;
}

export interface ProviderFailure {
  status: number;
  message: string;
  /** Provider-side code, e.g. Twelve Data `code: 429`. */
  code?: number | string;
  retryAfterSeconds?: number;
}

export class ProviderError extends Error implements ProviderFailure {
  readonly status: number;
  readonly code?: number | string;
  readonly retryAfterSeconds?: number;

  constructor(failure: ProviderFailure) {
    super(failure.message);
    this.name = 'ProviderError';
    this.status = failure.status;
    this.code = failure.code;
    this.retryAfterSeconds = failure.retryAfterSeconds;
  }
}

export interface KeyVerification {
  ok: boolean;
  /** HTTP status from the provider, 0 when the request never got an answer. */
  status: number;
  creditsUsed?: number;
  plan?: string;
  detail: string;
}

export interface MarketDataProvider {
  readonly name: string;
  /** True when the data is synthetic and must be labelled as such in the UI. */
  readonly synthetic: boolean;
  fetchTimeSeries(request: TimeSeriesRequest, apiKey: string | null): Promise<TimeSeriesResult>;
  fetchQuote(pair: string, apiKey: string | null): Promise<QuoteResult>;
}

/** Deterministic modelled spreads used only when the provider gives no bid/ask. */
export const MODELLED_SPREAD_PIPS: Record<string, number> = {
  'EUR/USD': 0.8,
  'GBP/USD': 1.1,
  'USD/JPY': 0.9,
  'USD/CHF': 1.2,
  'USD/CAD': 1.3,
  'AUD/USD': 1.0,
  'NZD/USD': 1.6,
  'EUR/GBP': 1.2,
  'EUR/JPY': 1.3,
  'EUR/CHF': 1.6,
  'EUR/AUD': 1.8,
  'EUR/CAD': 1.9,
  'GBP/JPY': 2.0,
  'GBP/CHF': 2.3,
  'GBP/AUD': 2.4,
  'AUD/JPY': 1.7,
  'AUD/CAD': 1.9,
  'AUD/NZD': 2.2,
  'CAD/JPY': 1.8,
  'CHF/JPY': 2.1,
  'NZD/JPY': 2.2,
  'USD/SEK': 3.0,
  'USD/NOK': 3.0,
};

export function modelledSpreadPips(pair: string): number {
  return MODELLED_SPREAD_PIPS[pair] ?? 1.8;
}
