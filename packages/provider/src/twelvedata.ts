/**
 * Twelve Data adapter.
 *
 * Documentation-aligned behaviour:
 *  - `GET /time_series?symbol=EUR/USD&interval=1min&outputsize=N`
 *  - `GET /quote?symbol=EUR/USD` for the current price (bid/ask only when the
 *    provider actually returns them, otherwise the spread is MODELLED and
 *    flagged as such).
 *  - `GET /api_usage` for the account-level credit consumption, used by the
 *    control centre to reconcile our own accounting with the provider's.
 *    The key stays server-side; the response is summarised, never proxied raw.
 *  - Quota/rate errors are surfaced as {@link ProviderError} so the pool can
 *    rotate keys and back off instead of hammering the API.
 */

import type { CandleInput, Timeframe } from '@vortex/core';
import {
  MODELLED_SPREAD_PIPS,
  ProviderError,
  type KeyVerification,
  type MarketDataProvider,
  type QuoteResult,
  type TimeSeriesRequest,
  type TimeSeriesResult,
} from './types.js';

export interface TwelveDataOptions {
  baseUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  onRequest?: (info: { url: string; status: number; durationMs: number; attempt: number }) => void;
}

const INTERVAL_MAP: Record<Timeframe, string> = {
  M1: '1min',
  M3: '3min',
  M5: '5min',
  M15: '15min',
  H1: '1h',
};

interface TwelveDataErrorBody {
  status?: string;
  code?: number;
  message?: string;
}

interface TwelveDataSeriesBody {
  meta?: { symbol?: string; interval?: string; type?: string };
  values?: { datetime: string; open: string; high: string; low: string; close: string; volume?: string }[];
  status?: string;
  code?: number;
  message?: string;
}

interface TwelveDataQuoteBody {
  symbol?: string;
  name?: string;
  close?: string;
  bid?: string;
  ask?: string;
  timestamp?: number;
  status?: string;
  code?: number;
  message?: string;
}

const BACKOFF_BASE_MS = 400;

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'twelvedata';
  readonly synthetic = false;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onRequest?: TwelveDataOptions['onRequest'];

  constructor(options: TwelveDataOptions = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://api.twelvedata.com').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onRequest = options.onRequest;
  }

  /** Exposed for the control centre's "verify key" action. */
  async verifyKey(apiKey: string): Promise<KeyVerification> {
    try {
      const body = await this.request<{
        api_usage?: number;
        plan_category?: string;
        current_usage?: number;
        plan_limit?: number;
      }>('/api_usage', {}, apiKey);
      return {
        ok: true,
        status: 200,
        creditsUsed: typeof body.current_usage === 'number' ? body.current_usage : body.api_usage,
        plan: body.plan_category,
        detail: 'key accepted by the provider',
      };
    } catch (error) {
      const err = error as ProviderError;
      // `status: 0` means the request never reached the provider (network or
      // timeout), which must NOT be treated as "the provider rejected this key".
      return { ok: false, status: err.status ?? 0, detail: err.message };
    }
  }

  async fetchTimeSeries(request: TimeSeriesRequest, apiKey: string | null): Promise<TimeSeriesResult> {
    const interval = INTERVAL_MAP[request.timeframe];
    const params: Record<string, string> = {
      symbol: request.pair,
      interval,
      outputsize: String(Math.min(5000, request.outputsize ?? 200)),
      format: 'JSON',
      timezone: 'UTC',
      // Only settle on closed candles: prevents partial-bar contamination.
      previous_close: 'false',
    };
    if (request.startDate) params.start_date = request.startDate;
    if (request.endDate) params.end_date = request.endDate;

    const body = await this.request<TwelveDataSeriesBody>('/time_series', params, apiKey ?? '');
    const values = body.values ?? [];
    const candles: CandleInput[] = [];
    const intervalSeconds = request.timeframe === 'M1' ? 60 : request.timeframe === 'M3' ? 180 : request.timeframe === 'M5' ? 300 : request.timeframe === 'M15' ? 900 : 3600;
    for (const row of values) {
      const openTime = normalizeDatetime(row.datetime);
      if (!openTime) continue;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) continue;
      if (high < low || high < Math.max(open, close) - 1e-12 || low > Math.min(open, close) + 1e-12) continue;
      candles.push({
        pair: request.pair,
        timeframe: request.timeframe,
        openTime,
        open,
        high,
        low,
        close,
        volume: row.volume === undefined || row.volume === '' ? null : Number(row.volume),
        provider: this.name,
        // A candle is final when its window has closed. The provider returns
        // the in-progress bar first, so mark by timestamp, not by position.
        isFinal: new Date(openTime).getTime() + intervalSeconds * 1000 <= Date.now(),
        revision: 1,
      });
    }
    return { pair: request.pair, timeframe: request.timeframe, candles, creditsUsed: 1, raw: body.meta };
  }

  async fetchQuote(pair: string, apiKey: string | null): Promise<QuoteResult> {
    const body = await this.request<TwelveDataQuoteBody>('/quote', { symbol: pair }, apiKey ?? '');
    const price = Number(body.close);
    const bid = body.bid !== undefined && body.bid !== '' ? Number(body.bid) : undefined;
    const ask = body.ask !== undefined && body.ask !== '' ? Number(body.ask) : undefined;
    const pipSize = pair.endsWith('JPY') ? 0.01 : 0.0001;
    const hasSpread = typeof bid === 'number' && typeof ask === 'number' && Number.isFinite(bid) && Number.isFinite(ask) && ask > bid;
    const spreadPips = hasSpread ? (ask - bid) / pipSize : MODELLED_SPREAD_PIPS[pair] ?? 1.8;
    return {
      pair,
      bid,
      ask,
      price: Number.isFinite(price) ? price : (bid ?? ask ?? 0),
      spreadSource: hasSpread ? 'provider' : 'modelled',
      spreadPips: Number(spreadPips.toFixed(2)),
      asOf: body.timestamp ? new Date(body.timestamp * 1000).toISOString() : new Date().toISOString(),
      raw: { symbol: body.symbol, name: body.name },
    };
  }

  private async request<T>(path: string, params: Record<string, string>, apiKey: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (apiKey) url.searchParams.set('apikey', apiKey);

    let lastError: ProviderError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url.toString(), {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        clearTimeout(timer);
        this.onRequest?.({ url: redactUrl(url.toString()), status: response.status, durationMs: Date.now() - started, attempt });
        const text = await response.text();
        if (!response.ok) {
          const parsed = safeJson<TwelveDataErrorBody>(text);
          const error = new ProviderError({
            status: response.status,
            message: parsed?.message ?? `provider HTTP ${response.status}`,
            code: parsed?.code,
            retryAfterSeconds: Number(response.headers.get('retry-after')) || undefined,
          });
          // 5xx/408/429 are retried here; auth errors never are.
          if (response.status >= 500 || response.status === 408 || response.status === 429) {
            lastError = error;
            if (attempt < this.maxAttempts) {
              await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
              continue;
            }
          }
          throw error;
        }
        const parsed = safeJson<T>(text);
        if (parsed === null) throw new ProviderError({ status: 502, message: 'provider returned unparseable JSON' });
        const status = (parsed as { status?: string }).status;
        if (status === 'error') {
          const err = parsed as unknown as TwelveDataErrorBody;
          throw new ProviderError({
            status: Number(err.code) === 429 ? 429 : 400,
            message: err.message ?? 'provider reported an error',
            code: err.code,
          });
        }
        return parsed;
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof ProviderError) throw error;
        const aborted = (error as Error).name === 'AbortError';
        lastError = new ProviderError({
          status: aborted ? 408 : 503,
          message: aborted ? 'provider request timed out' : `provider request failed: ${(error as Error).message}`,
        });
        if (attempt < this.maxAttempts) {
          await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          continue;
        }
      }
    }
    throw lastError ?? new ProviderError({ status: 503, message: 'provider request failed' });
  }
}

function safeJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Twelve Data returns "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DD HH:mm" in UTC. */
export function normalizeDatetime(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (match) {
    const [, date, hm, sec] = match;
    const iso = `${date}T${hm}:${sec ?? '00'}.000Z`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function redactUrl(url: string): string {
  return url.replace(/apikey=[^&]+/, 'apikey=[redacted]');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
