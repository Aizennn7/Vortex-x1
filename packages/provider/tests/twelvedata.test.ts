/**
 * Twelve Data adapter behaviour under failure.
 *
 * Everything here runs against a mocked `fetch`: no live API, no credentials,
 * no quota consumption. The properties under test are the ones that decide
 * whether a provider outage degrades the system honestly or silently corrupts
 * it (bad candles accepted, retry storms, or a key leaking into a log line).
 */

import { describe, expect, it } from 'vitest';
import { ProviderError } from '../src/types.js';
import { TwelveDataProvider, normalizeDatetime } from '../src/twelvedata.js';

const FIXED_NOW = Date.parse('2026-01-05T10:05:00.000Z');

interface Call {
  url: string;
  attempt: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function provider(
  handler: (url: URL, call: number) => Response | Promise<Response>,
  options: { maxAttempts?: number; onRequest?: (info: { url: string; status: number; attempt: number }) => void } = {},
) {
  const calls: Call[] = [];
  let n = 0;
  const instance = new TwelveDataProvider({
    maxAttempts: options.maxAttempts ?? 3,
    timeoutMs: 50,
    nowMs: () => FIXED_NOW,
    onRequest: options.onRequest,
    fetchImpl: (async (input: RequestInfo | URL, _init?: RequestInit) => {
      n += 1;
      const url = new URL(String(input));
      calls.push({ url: url.toString(), attempt: n });
      return handler(url, n);
    }) as typeof fetch,
  });
  return { instance, calls };
}

const seriesBody = {
  meta: { symbol: 'EUR/USD', interval: '1min', type: 'forex' },
  values: [
    { datetime: '2026-01-05 10:03:00', open: '1.1000', high: '1.1010', low: '1.0995', close: '1.1005', volume: '900' },
    { datetime: '2026-01-05 10:04:00', open: '1.1005', high: '1.1015', low: '1.1000', close: '1.1012' },
  ],
  status: 'ok',
};

describe('response validation', () => {
  it('normalises provider timestamps to UTC ISO and marks closed bars final', async () => {
    const { instance } = provider(() => jsonResponse(seriesBody));
    const result = await instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k');
    expect(result.candles.map((c) => c.openTime)).toEqual([
      '2026-01-05T10:03:00.000Z',
      '2026-01-05T10:04:00.000Z',
    ]);
    // Both windows closed at 10:05:00 (the newest bar closes exactly at now).
    expect(result.candles.every((c) => c.isFinal)).toBe(true);
  });

  it('never marks the in-progress bar final', async () => {
    const { instance } = provider(() =>
      jsonResponse({
        ...seriesBody,
        values: [...seriesBody.values, { datetime: '2026-01-05 10:05:00', open: '1.1012', high: '1.1013', low: '1.1011', close: '1.1012' }],
      }),
    );
    const result = await instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k');
    expect(result.candles[2]?.openTime).toBe('2026-01-05T10:05:00.000Z');
    expect(result.candles[2]?.isFinal).toBe(false);
  });

  it('drops malformed and OHLC-inconsistent rows instead of persisting them', async () => {
    const { instance } = provider(() =>
      jsonResponse({
        ...seriesBody,
        values: [
          { datetime: '2026-01-05 10:03:00', open: '1.1000', high: '1.1010', low: '1.0995', close: '1.1005' },
          // NaN close
          { datetime: '2026-01-05 10:04:00', open: '1.1000', high: '1.1010', low: '1.0995', close: 'n/a' },
          // zero/negative price
          { datetime: '2026-01-05 10:05:00', open: '0', high: '0', low: '0', close: '0' },
          // high below close
          { datetime: '2026-01-05 10:06:00', open: '1.1000', high: '1.0990', low: '1.0980', close: '1.1005' },
          // low above open
          { datetime: '2026-01-05 10:07:00', open: '1.1000', high: '1.1010', low: '1.1015', close: '1.1005' },
          // unparseable timestamp
          { datetime: 'not-a-date', open: '1.1', high: '1.1', low: '1.1', close: '1.1' },
        ],
      }),
    );
    const result = await instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k');
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]?.openTime).toBe('2026-01-05T10:03:00.000Z');
  });

  it('treats an empty result set as empty, not as an error', async () => {
    const { instance } = provider(() => jsonResponse({ meta: { symbol: 'EUR/USD' }, values: [], status: 'ok' }));
    const result = await instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k');
    expect(result.candles).toHaveLength(0);
  });

  it('escalates an unparseable body rather than returning a silent empty series', async () => {
    const { instance } = provider(() => new Response('<html>gateway</html>', { status: 200 }));
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toBeInstanceOf(ProviderError);
  });

  it('escalates a 200 response that still reports status:error', async () => {
    const { instance } = provider(() => jsonResponse({ status: 'error', code: 400, message: 'bad symbol' }));
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toThrow(/bad symbol/);
  });

  it('normalises the provider datetime formats it actually emits', () => {
    expect(normalizeDatetime('2026-01-05 10:03:00')).toBe('2026-01-05T10:03:00.000Z');
    expect(normalizeDatetime('2026-01-05 10:03')).toBe('2026-01-05T10:03:00.000Z');
    expect(normalizeDatetime('2026-01-05T10:03:07Z')).toBe('2026-01-05T10:03:07.000Z');
    expect(normalizeDatetime('rubbish')).toBeNull();
  });
});

describe('failure classification and bounded retries', () => {
  it('retries transient 5xx exactly up to maxAttempts and then fails', async () => {
    const { instance, calls } = provider(() => jsonResponse({ message: 'boom' }, 503), { maxAttempts: 3 });
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });

  it('does not retry an authentication failure', async () => {
    const { instance, calls } = provider(() => jsonResponse({ message: 'invalid api key' }, 401), { maxAttempts: 3 });
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('surfaces a rate limit instead of hammering the provider', async () => {
    const { instance, calls } = provider(() => jsonResponse({ code: 429, message: 'too many requests' }, 429), {
      maxAttempts: 2,
    });
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(2);
  });

  it('treats an aborted (timed out) request as a transient 408', async () => {
    const { instance } = provider(
      () =>
        new Promise<Response>((_resolve, reject) => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }),
      { maxAttempts: 2 },
    );
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toMatchObject({ status: 408 });
  });

  it('reports a network failure as 503, never as a rejected key', async () => {
    const { instance } = provider(
      () => {
        throw new TypeError('fetch failed');
      },
      { maxAttempts: 1 },
    );
    const verification = await instance.verifyKey('k');
    expect(verification.ok).toBe(false);
    expect(verification.status).toBe(503);
    expect(verification.detail).toMatch(/fetch failed/);
  });

  it('reports a real key rejection with its provider status', async () => {
    const { instance } = provider(() => jsonResponse({ message: 'invalid api key' }, 401), { maxAttempts: 1 });
    const verification = await instance.verifyKey('k');
    expect(verification.ok).toBe(false);
    expect(verification.status).toBe(401);
  });
});

describe('secret hygiene', () => {
  it('never puts the API key in the request URL it reports', async () => {
    const seen: string[] = [];
    const { instance, calls } = provider(() => jsonResponse(seriesBody), {
      onRequest: (info) => seen.push(info.url),
    });
    await instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'supersecretkey123');
    expect(calls[0]?.url).toContain('supersecretkey123'); // the real request carries it
    expect(seen).not.toHaveLength(0);
    expect(seen.every((u) => !u.includes('supersecretkey123'))).toBe(true);
    expect(seen[0]).toContain('apikey=[redacted]');
  });

  it('never leaks the key through a thrown error message', async () => {
    const { instance } = provider(() => jsonResponse({ message: 'quota exhausted' }, 429), { maxAttempts: 1 });
    await instance
      .fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'supersecretkey123')
      .then(
        () => {
          throw new Error('expected the call to fail');
        },
        (error: Error) => {
          expect(error.message).not.toContain('supersecretkey123');
        },
      );
  });
});

describe('quotes', () => {
  it('uses the provider bid/ask when both are present', async () => {
    const { instance } = provider(() =>
      jsonResponse({ symbol: 'EUR/USD', close: '1.10000', bid: '1.09995', ask: '1.10010', timestamp: 1767000000 }),
    );
    const quote = await instance.fetchQuote('EUR/USD', 'k');
    expect(quote.spreadSource).toBe('provider');
    expect(quote.spreadPips).toBeCloseTo(1.5, 2);
    expect(quote.asOf).toBe(new Date(1767000000 * 1000).toISOString());
  });

  it('falls back to a modelled spread when the provider returns no bid/ask', async () => {
    const { instance } = provider(() => jsonResponse({ symbol: 'EUR/USD', close: '1.10000' }));
    const quote = await instance.fetchQuote('EUR/USD', 'k');
    expect(quote.spreadSource).toBe('modelled');
    expect(quote.spreadPips).toBeGreaterThan(0);
  });

  it('rejects an inverted bid/ask spread instead of reporting a negative cost', async () => {
    const { instance } = provider(() => jsonResponse({ symbol: 'EUR/USD', close: '1.1', bid: '1.1002', ask: '1.0998' }));
    const quote = await instance.fetchQuote('EUR/USD', 'k');
    expect(quote.spreadPips).toBeGreaterThan(0);
    expect(quote.spreadSource).toBe('modelled');
  });
});

describe('usage reporting', () => {
  it('summarises the account credit usage it is allowed to read', async () => {
    const { instance } = provider(() =>
      jsonResponse({ api_usage: 12, plan_category: 'free', current_usage: 34, plan_limit: 800 }),
    );
    const verification = await instance.verifyKey('k');
    expect(verification.ok).toBe(true);
    expect(verification.creditsUsed).toBe(34);
    expect(verification.plan).toBe('free');
  });
});

describe('attempt bounding', () => {
  it('performs exactly one attempt when maxAttempts is 1', async () => {
    const { instance, calls } = provider(() => jsonResponse({ message: 'boom' }, 500), { maxAttempts: 1 });
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });

  it('clamps a nonsensical maxAttempts below 1 to a single attempt', async () => {
    const { instance, calls } = provider(() => jsonResponse({ message: 'boom' }, 500), { maxAttempts: 0 });
    await expect(instance.fetchTimeSeries({ pair: 'EUR/USD', timeframe: 'M1' }, 'k')).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toHaveLength(1);
  });
});
