/**
 * Relay client behaviour.
 *
 * The dashboard must never invent data: when the relay is unreachable or
 * answers with an error envelope, the client reports a failure instead of
 * returning an empty object that a component could render as "all good".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDashboardBanner,
  classifyFailure,
  computeMarketDataStaleness,
  createSnapshotClient,
  createSupabasePublicClient,
  failureGuidance,
  isSetupRequiredError,
  marketDataBadge,
  marketDataLabel,
  nextPollDelayMs,
  normalizeBreakdownRows,
  scanVerdict,
  toScanSummary,
  normalizeWorkerLiveness,
  reduceRelayState,
  stalePairs,
  relay,
  summarizeLearningRuns,
  summarizeModelVersions,
  toPerformanceOverview,
  wilsonInterval,
  workerBadge,
  RELAY_BASE,
  type MarketQualityRow,
  type RelayFailureKind,
  type RelayResult,
} from '../src/relay.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('relay client', () => {
  it('defaults to same-origin requests (no baked-in host)', () => {
    expect(RELAY_BASE).toBe('');
  });

  it('unwraps the ok/data envelope', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, data: { status: 'ok' } })));
    const result = await relay.health();
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ status: 'ok' });
    expect(result.error).toBeNull();
  });

  it('reports an error envelope instead of passing it on as data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: false, error: { code: 'not_ready', message: 'worker not ready' } }, 503)),
    );
    const result = await relay.summary();
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
    expect(result.data).toBeNull();
    expect(result.error).toBe('worker not ready');
  });

  it('reports an unreachable relay as an error, never as empty data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const result = await relay.signals(10);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.data).toBeNull();
    expect(result.error).toContain('relay unreachable');
  });

  it('sends the requested limit and accepts only JSON', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { signals: [], count: 0 } }));
    vi.stubGlobal('fetch', fetchMock);
    await relay.signals(5);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/signals?limit=5');
    expect((init.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('requests a bounded M1 candle window from the HTTP relay', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, data: { pair: 'EUR/USD', timeframe: 'M1', candles: [], count: 0, finalOnly: true, note: 'stored final candles only' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await relay.candles?.('EUR/USD', 12);
    expect(result?.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/candles?pair=EUR%2FUSD&timeframe=M1&limit=12');
  });

  it('never pretends a stopped or stale worker is running', () => {
    expect(normalizeWorkerLiveness(null)).toBeNull();
    expect(
      normalizeWorkerLiveness({
        workerId: 'gha-1',
        liveness: 'STOPPING',
        running: false,
        secondsSince: 5,
        lastJob: 'run_maintenance',
      }),
    ).toEqual({
      workerId: 'gha-1',
      liveness: 'DISCONNECTED',
      running: false,
      secondsSince: 5,
      lastJob: 'run_maintenance',
    });
    expect(
      normalizeWorkerLiveness({
        workerId: 'gha-2',
        liveness: 'CONNECTED',
        secondsSince: 900,
        lastJob: 'ingest_market_data',
      }),
    ).toEqual({
      workerId: 'gha-2',
      liveness: 'DISCONNECTED',
      running: false,
      secondsSince: 900,
      lastJob: 'ingest_market_data',
    });
  });

  it('recomputes candle age and marks stale market data relative to browser time', () => {
    const nowMs = Date.parse('2026-03-04T12:20:00.000Z');
    const rows = computeMarketDataStaleness(
      [
        {
          pair: 'EUR/USD',
          status: 'CONNECTED',
          ageSeconds: 30,
          detail: 'fresh at check time',
          checkedAt: '2026-03-04T12:00:00.000Z',
        },
      ],
      90,
      nowMs,
    );
    expect(rows[0]?.ageSeconds).toBe(1230);
    expect(rows[0]?.status).toBe('DISCONNECTED');
    expect(rows[0]?.stale).toBe(true);
  });

  it('reads Supabase public_* read-only views directly without a persistent relay', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.includes('public_worker_status')) {
        return jsonResponse([
          {
            worker_id: 'gha-cycle-101',
            version: 'vortex-engine-1.0.0',
            last_seen_at: '2026-03-04T10:00:05.000Z',
            last_job: 'run_maintenance',
            last_job_at: '2026-03-04T10:00:05.000Z',
            seconds_since_heartbeat: 240,
            liveness: 'STOPPING',
            metadata: {
              stopping: true,
              active: false,
              lastSuccessfulJob: {
                jobName: 'ingest_market_data',
                slotKey: '2026-03-04T10:00',
                finishedAt: '2026-03-04T10:00:04.000Z',
              },
            },
          },
        ]);
      }
      if (input.includes('public_market_quality')) {
        return jsonResponse([
          {
            pair: 'EUR/USD',
            status: 'CONNECTED',
            age_seconds: 25,
            detail: 'ok',
            last_candle_at: '2026-03-04T09:59:00.000Z',
            checked_at: '2026-03-04T10:00:00.000Z',
          },
        ]);
      }
      if (input.includes('public_provider_budget')) {
        return jsonResponse([{ enabled_keys: 1, usable_keys: 1, configured_day_capacity: 680 }]);
      }
      if (input.includes('public_quota_usage')) {
        return jsonResponse([{ bucket: 'day', bucket_start: '2026-03-04T00:00:00.000Z', used: 68 }]);
      }
      if (input.includes('public_overall_performance')) {
        return jsonResponse([{ decisive: 10, wins: 6, losses: 4, draws: 1, unresolved: 0, pending: 1, accuracy: 0.6 }]);
      }
      if (input.includes('public_telegram_delivery')) {
        return jsonResponse([{ status: 'SENT' }, { status: 'SENT' }]);
      }
      if (input.includes('public_alerts')) {
        return jsonResponse([]);
      }
      if (input.includes('public_agent_status')) {
        return jsonResponse([{ component: 'telegram', status: 'CONNECTED', detail: 'ok', metadata: {} }]);
      }
      return jsonResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const supa = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'sb_publishable_test_anon' });
    const summary = await supa.summary();
    expect(summary.ok).toBe(true);
    expect(summary.data?.worker?.liveness).toBe('DISCONNECTED');
    expect(summary.data?.worker?.running).toBe(false);
    expect(summary.data?.lastSuccessfulJob?.jobName).toBe('ingest_market_data');
    expect(summary.data?.providerBudget?.dayRemainingPercent).toBe(90);
    expect(summary.data?.signals?.accuracy).toBe(60);
    expect(summary.data?.marketData[0]?.stale).toBe(true);
  });

  it('reads static snapshot.json and dynamically ages worker and candle staleness', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          configured: true,
          generatedAt: '2026-03-04T10:00:00.000Z',
          health: {
            service: 'vortex-si-snapshot',
            status: 'ok',
            version: 'vortex-engine-1.0.0',
            uptimeSeconds: 0,
            database: { ok: true, detail: 'ok' },
            provider: { name: 'twelvedata', synthetic: false },
            ready: true,
            reasons: [],
            note: 'static snapshot',
            timestamp: '2026-03-04T10:00:00.000Z',
          },
          summary: {
            worker: {
              workerId: 'gha-1',
              liveness: 'DISCONNECTED',
              running: false,
              secondsSince: 10,
              lastJob: 'run_maintenance',
            },
            lastSuccessfulJob: {
              jobName: 'ingest_market_data',
              slotKey: '2026-03-04T10:00',
              finishedAt: '2026-03-04T10:00:00.000Z',
              ageSeconds: 5,
            },
            marketData: [
              {
                pair: 'EUR/USD',
                status: 'CONNECTED',
                ageSeconds: 30,
                detail: 'ok',
                checkedAt: '2026-03-04T10:00:00.000Z',
              },
            ],
            providerBudget: null,
            signals: null,
            telegram: { configuration: { status: 'NOT CONFIGURED', detail: 'disabled' }, sent: 0, failed: 0, unconfirmed: 0 },
            alerts: [],
          },
          config: {},
          signals: { signals: [], count: 0 },
        }),
      ),
    );
    const snap = createSnapshotClient('./snapshot.json');
    const summary = await snap.summary();
    expect(summary.ok).toBe(true);
    expect(summary.data?.worker?.liveness).toBe('DISCONNECTED');
    expect(summary.data?.worker?.running).toBe(false);
    expect(summary.data?.lastSuccessfulJob?.ageSeconds).toBeGreaterThan(600);
    expect(summary.data?.marketData[0]?.stale).toBe(true);
  });
});

describe('failure classification', () => {
  it('recognises missing Supabase tables/views as a setup problem, not a bug', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { code: '42P01', message: 'relation "public.public_worker_status" does not exist' },
          404,
        ),
      ),
    );
    const client = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'anon' });
    const result = await client.summary();
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('setup-required');
  });

  it('reports an unreachable origin as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const client = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'anon' });
    const result = await client.health();
    expect(result.kind).toBe('unreachable');
  });

  it('reports a rejected key as unauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Invalid API key' }, 401)));
    const client = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'anon' });
    const result = await client.signals(5);
    expect(result.kind).toBe('unauthorized');
  });

  it('classifies plain server errors as errors', () => {
    expect(classifyFailure(500, 'boom')).toBe('error');
    expect(classifyFailure(0, 'offline')).toBe('unreachable');
    expect(classifyFailure(404, 'relation "x" does not exist')).toBe('setup-required');
    expect(isSetupRequiredError(400, 'Could not find the table public.public_alerts')).toBe(true);
    expect(isSetupRequiredError(200, 'fine')).toBe(false);
  });

  it('gives mode-specific guidance for a missing schema', () => {
    expect(failureGuidance('setup-required', 'supabase')).toMatch(/migrations/);
    expect(failureGuidance('unreachable', 'relay')).toMatch(/could not reach/);
  });
});

describe('model and learning panels', () => {
  it('reports no champion honestly when only rejected candidates exist', () => {
    const summary = summarizeModelVersions([
      {
        id: 'm1',
        version: 'candidate-1',
        status: 'REJECTED',
        dataset_size: 220,
        dataset_from: null,
        dataset_to: null,
        metrics: { accuracy: 0.51 },
        walk_forward: [],
        promoted_at: null,
        created_at: '2026-03-01T00:00:00.000Z',
      },
    ]);
    expect(summary.champion).toBeNull();
    expect(summary.rejectedCount).toBe(1);
    expect(summary.note).toMatch(/rule ensemble keeps serving/);
  });

  it('surfaces the champion metrics and its walk-forward folds', () => {
    const summary = summarizeModelVersions([
      {
        id: 'm2',
        version: 'candidate-2',
        status: 'CHAMPION',
        dataset_size: 900,
        dataset_from: '2026-01-01T00:00:00.000Z',
        dataset_to: '2026-03-01T00:00:00.000Z',
        metrics: {
          accuracy: 0.58,
          balancedAccuracy: 0.57,
          auc: 0.61,
          logLoss: 0.66,
          ece: 0.08,
          samples: 180,
          baseRate: 0.5,
        },
        walk_forward: [
          { fold: 1, trainSize: 400, validationSize: 60, metrics: { accuracy: 0.57 } },
          { fold: 2, trainSize: 500, validationSize: 60, metrics: { accuracy: 0.6 } },
        ],
        promoted_at: '2026-03-02T00:00:00.000Z',
        created_at: '2026-03-01T12:00:00.000Z',
      },
    ]);
    expect(summary.champion?.version).toBe('candidate-2');
    expect(summary.champion?.metrics?.auc).toBeCloseTo(0.61, 5);
    expect(summary.champion?.metrics?.balancedAccuracy).toBeCloseTo(0.57, 5);
    expect(summary.champion?.walkForward.map((f) => f.accuracy)).toEqual([0.57, 0.6]);
  });

  it('explains a skipped learning run instead of hiding it', () => {
    const summary = summarizeLearningRuns([
      {
        started_at: '2026-03-04T03:00:00.000Z',
        finished_at: '2026-03-04T03:00:02.000Z',
        status: 'SKIPPED',
        dataset_size: 400,
        dataset_from: null,
        dataset_to: null,
        error: 'dataset abc… was already trained successfully',
      },
      {
        started_at: '2026-03-03T03:00:00.000Z',
        finished_at: '2026-03-03T03:01:00.000Z',
        status: 'SUCCEEDED',
        dataset_size: 390,
        dataset_from: null,
        dataset_to: null,
        error: null,
      },
    ]);
    expect(summary.lastRun?.status).toBe('SKIPPED');
    expect(summary.lastRun?.reason).toMatch(/already trained/);
    expect(summary.counts).toEqual({ SKIPPED: 1, SUCCEEDED: 1 });
  });

  it('returns an empty learning panel when no run exists', () => {
    const summary = summarizeLearningRuns([]);
    expect(summary.lastRun).toBeNull();
    expect(summary.counts).toEqual({});
  });
});

describe('accuracy uncertainty helpers', () => {
  it('widens the interval as the sample shrinks', () => {
    const small = wilsonInterval(6, 10);
    const large = wilsonInterval(600, 1000);
    expect(small).not.toBeNull();
    expect(large).not.toBeNull();
    expect(small!.upper - small!.lower).toBeGreaterThan(large!.upper - large!.lower);
    expect(small!.lower).toBeLessThan(0.6);
    expect(small!.upper).toBeGreaterThan(0.6);
  });

  it('has no interval without a sample', () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
});

describe('snapshot client caching', () => {
  it('serves one download for a burst of reads inside the cache window', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        ok: true,
        configured: true,
        generatedAt: new Date().toISOString(),
        health: {
          service: 'vortex-si-snapshot',
          status: 'ok',
          version: 'v',
          uptimeSeconds: 0,
          database: { ok: true, detail: 'ok' },
          provider: { name: 'twelvedata', synthetic: false },
          ready: true,
          reasons: [],
          note: 'snapshot',
          timestamp: new Date().toISOString(),
        },
        summary: {
          worker: null,
          lastSuccessfulJob: null,
          marketData: [],
          providerBudget: null,
          signals: null,
          telegram: { configuration: { status: 'NOT CONFIGURED', detail: 'off' }, sent: 0, failed: 0, unconfirmed: 0 },
          alerts: [],
        },
        config: {},
        signals: { signals: [], count: 0 },
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const client = createSnapshotClient('./snapshot.json', { cacheMs: 1_000 });
    await Promise.all([client.health(), client.summary(), client.signals(), client.config()]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-downloads once the cache window has passed', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ ok: true, configured: false }));
    vi.stubGlobal('fetch', fetchSpy);
    const client = createSnapshotClient('./snapshot.json', { cacheMs: 0 });
    await client.health();
    await client.health();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('dashboard state reducers', () => {
  const ok = <T,>(data: T): RelayResult<T> => ({ ok: true, status: 200, data, error: null, kind: 'none' });
  const failed = <T,>(message: string, kind: RelayFailureKind = 'error'): RelayResult<T> => ({
    ok: false,
    status: 500,
    data: null,
    error: message,
    kind,
  });

  it('reports an error state when the very first read fails', () => {
    const state = reduceRelayState({ result: { state: 'loading' }, lastError: null, refreshedAt: null }, failed('boom'));
    expect(state.result).toEqual({ state: 'error', message: 'boom', kind: 'error' });
    expect(state.lastError?.message).toBe('boom');
  });

  it('keeps the last good payload when a later refresh fails', () => {
    const first = reduceRelayState(
      { result: { state: 'loading' }, lastError: null, refreshedAt: null },
      ok({ value: 42 }),
      '2026-03-01T00:00:00.000Z',
    );
    const second = reduceRelayState(first, failed('relay unreachable', 'unreachable'), '2026-03-01T00:05:00.000Z');
    expect(second.result).toEqual({ state: 'ready', value: { value: 42 } });
    expect(second.lastError?.kind).toBe('unreachable');
    // The timestamp must keep pointing at the last SUCCESSFUL read.
    expect(second.refreshedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('clears the error once a refresh succeeds again', () => {
    const withError = reduceRelayState(
      { result: { state: 'ready', value: 1 }, lastError: { message: 'boom', kind: 'error' }, refreshedAt: '2026-03-01T00:00:00.000Z' },
      ok(2),
      '2026-03-01T00:10:00.000Z',
    );
    expect(withError.result).toEqual({ state: 'ready', value: 2 });
    expect(withError.lastError).toBeNull();
    expect(withError.refreshedAt).toBe('2026-03-01T00:10:00.000Z');
  });

  it('never treats a successful-but-empty read as data', () => {
    const state = reduceRelayState(
      { result: { state: 'loading' }, lastError: null, refreshedAt: null },
      { ok: true, status: 200, data: null, error: null, kind: 'none' },
    );
    expect(state.result.state).toBe('error');
  });
});

describe('dashboard banners and badges', () => {
  it('warns about simulated data before anything else', () => {
    const banner = buildDashboardBanner({ synthetic: true, ready: false, reasons: ['no keys'], stalePairs: ['EUR/USD'] });
    expect(banner?.text).toMatch(/SIMULATED/);
  });

  it('surfaces a not-ready data source', () => {
    const banner = buildDashboardBanner({ synthetic: false, ready: false, reasons: ['database not reachable'], stalePairs: [] });
    expect(banner?.text).toMatch(/database not reachable/);
  });

  it('surfaces stale pairs when everything else is healthy', () => {
    const banner = buildDashboardBanner({ synthetic: false, ready: true, reasons: [], stalePairs: ['GBP/USD'] });
    expect(banner?.text).toMatch(/GBP\/USD/);
    expect(banner?.text).toMatch(/NO-TRADE/);
  });

  it('shows no banner when the deployment is healthy', () => {
    expect(buildDashboardBanner({ synthetic: false, ready: true, reasons: [], stalePairs: [] })).toBeNull();
  });

  it('never reports a stopped worker as connected', () => {
    expect(workerBadge({ workerId: 'w', liveness: 'STOPPING', running: false, secondsSince: 5, lastJob: null }, null)).toBe('DISCONNECTED');
    expect(workerBadge({ workerId: 'w', liveness: 'CONNECTED', running: true, secondsSince: 3, lastJob: 'ingest' }, null)).toBe('CONNECTED');
    expect(workerBadge(null, null)).toBe('NOT VERIFIED');
    expect(workerBadge(null, { jobName: 'ingest', slotKey: 's', finishedAt: '2026-03-01T00:00:00.000Z', ageSeconds: 600 })).toBe('DISCONNECTED');
  });

  it('degrades the market-data badge on stale rows and verifies nothing on an empty table', () => {
    const fresh: MarketQualityRow = { pair: 'EUR/USD', status: 'CONNECTED', ageSeconds: 20, detail: null, stale: false };
    const stale: MarketQualityRow = { pair: 'GBP/USD', status: 'DISCONNECTED', ageSeconds: 900, detail: null, stale: true };
    expect(marketDataBadge([fresh])).toBe('CONNECTED');
    expect(marketDataBadge([fresh, stale])).toBe('DEGRADED');
    expect(marketDataBadge([])).toBe('NOT VERIFIED');
    expect(stalePairs([fresh, stale])).toEqual(['GBP/USD']);
  });

  it('labels a stale pair in words, not colour', () => {
    const label = marketDataLabel({ pair: 'EUR/USD', status: 'CONNECTED', ageSeconds: 400, detail: null, stale: true });
    expect(label).toMatch(/STALE/);
    const empty = marketDataLabel({ pair: 'EUR/USD', status: 'NOT VERIFIED', ageSeconds: null, detail: null, stale: false });
    expect(empty).toMatch(/no candles/);
  });
});

describe('performance breakdowns', () => {
  it('normalises the snake_case public view rows', () => {
    const rows = normalizeBreakdownRows([
      { pair: 'EUR/USD', decisive: 8, wins: 5, losses: 3, draws: 1, unresolved: 2, avg_pips: 1.25 },
      { pair: 'GBP/USD', decisive: 0, wins: 0, losses: 0, draws: 0, unresolved: 4, avg_pips: null },
    ]);
    expect(rows[0]).toMatchObject({ key: 'EUR/USD', wins: 5, losses: 3, draws: 1, unresolved: 2, avgPips: 1.25 });
    expect(rows[0]!.accuracy).toBeCloseTo(0.625, 3);
    // Five wins from eight decisive rows: the interval must straddle 62.5% and
    // be wide, because eight observations cannot establish an edge.
    expect(rows[0]!.accuracyInterval?.lower).toBeLessThan(0.625);
    expect(rows[0]!.accuracyInterval?.upper).toBeGreaterThan(0.625);
    expect((rows[0]!.accuracyInterval?.upper ?? 0) - (rows[0]!.accuracyInterval?.lower ?? 0)).toBeGreaterThan(0.3);
    expect(rows[0]!.accuracyConservative).toBeCloseTo(5 / 11, 3);
    // No decisive outcome must read as "no accuracy", never as 0%.
    expect(rows[1]!.accuracy).toBeNull();
    expect(rows[1]!.accuracyInterval).toBeNull();
    expect(rows[1]!.settled).toBe(0);
  });

  it('passes through the camelCase rows the relay already computes', () => {
    const rows = normalizeBreakdownRows([
      { key: 'trend_follow', settled: 10, wins: 6, losses: 4, draws: 0, unresolved: 1, accuracy: 0.6, avgPips: 0.4, totalPips: 4 },
    ]);
    expect(rows[0]).toMatchObject({
      key: 'trend_follow',
      settled: 10,
      wins: 6,
      losses: 4,
      draws: 0,
      unresolved: 1,
      accuracy: 0.6,
      accuracyInterval: expect.any(Object),
      accuracyConservative: Number((6 / 11).toFixed(4)),
      avgPips: 0.4,
      totalPips: 4,
    });
    expect(rows[0]!.accuracyInterval?.lower).toBeCloseTo(0.3127, 3);
    expect(rows[0]!.accuracyInterval?.upper).toBeCloseTo(0.8318, 3);
  });

  it('sorts by sample size and ignores junk rows', () => {
    const rows = normalizeBreakdownRows([
      { strategy: 'tiny', wins: 1, losses: 1 },
      null,
      'nonsense',
      { strategy: 'busy', wins: 20, losses: 10 },
    ]);
    expect(rows.map((r) => r.key)).toEqual(['busy', 'tiny']);
  });

  it('reports an empty breakdown for an empty table', () => {
    expect(normalizeBreakdownRows([])).toEqual([]);
  });

  it('exposes the breakdown through the Supabase client when the views answer', async () => {
    // A missing view must degrade, not fabricate an empty table.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('public_pair_performance')) {
          return jsonResponse([{ pair: 'EUR/USD', decisive: 4, wins: 3, losses: 1, draws: 0, unresolved: 0, avg_pips: 2.1 }]);
        }
        if (url.includes('public_strategy_performance')) {
          return jsonResponse([{ strategy: 'breakout', decisive: 2, wins: 1, losses: 1, draws: 0, unresolved: 0, avg_pips: -0.4 }]);
        }
        if (url.includes('public_worker_status')) {
          return jsonResponse([
            { worker_id: 'w', version: 'v', last_seen_at: new Date().toISOString(), last_job: null, last_job_at: null, seconds_since_heartbeat: 5, liveness: 'CONNECTED', metadata: {} },
          ]);
        }
        return jsonResponse([]);
      }),
    );
    const client = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'anon' });
    const result = await client.performance!();
    expect(result.ok).toBe(true);
    expect(result.data?.byPair[0]?.key).toBe('EUR/USD');
    expect(result.data?.byStrategy[0]?.key).toBe('breakout');
    expect(result.data?.byStrategy[0]?.avgPips).toBeCloseTo(-0.4, 5);
  });
});

describe('performance reader availability', () => {
  it('reports a missing view as an error instead of an empty breakdown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: '42P01', message: 'relation "public.public_pair_performance" does not exist' }, 404)),
    );
    const client = createSupabasePublicClient({ url: 'https://example.supabase.co', anonKey: 'anon' });
    const result = await client.performance!();
    expect(result.ok).toBe(false);
    expect(result.kind).toBe('setup-required');
  });

  it('every client declares a performance reader so the idempotent dashboard can rely on it', () => {
    expect(typeof createSnapshotClient('./snapshot.json').performance).toBe('function');
    expect(typeof createSupabasePublicClient({ url: 'https://x.supabase.co', anonKey: 'anon' }).performance).toBe('function');
    expect(typeof relay.performance).toBe('function');
  });

  it('normalises a relay /api/performance payload', () => {
    const overview = toPerformanceOverview({
      byPair: [{ key: 'EUR/USD', settled: 4, wins: 3, losses: 1, draws: 0, unresolved: 1, accuracy: 0.75, avgPips: 1.1, totalPips: 4.4 }],
      byStrategy: [],
      sampleSize: 5,
      note: 'paper',
    });
    expect(overview.byPair[0]).toMatchObject({ key: 'EUR/USD', wins: 3, unresolved: 1, avgPips: 1.1 });
    expect(overview.sampleSize).toBe(5);
    expect(overview.byStrategy).toEqual([]);
  });

  it('tells the user when a snapshot predates the breakdown export', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          configured: true,
          generatedAt: new Date().toISOString(),
          health: null,
          summary: { worker: null, lastSuccessfulJob: null, marketData: [], providerBudget: null, signals: null, telegram: { configuration: { status: 'OFF', detail: 'off' }, sent: 0, failed: 0, unconfirmed: 0 }, alerts: [] },
          config: {},
          signals: { signals: [], count: 0 },
        }),
      ),
    );
    const client = createSnapshotClient('./snapshot.json', { cacheMs: 0 });
    const result = await client.performance!();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/before per-pair breakdowns/);
  });
});


describe('opportunity scan block', () => {
  it('normalises the recorded scan summary', () => {
    const scan = toScanSummary({
      ranAt: '2026-03-03T10:03:52.000Z',
      slot: 'slot-2026-03-03T10:05:00.000Z',
      evaluated: 8,
      published: 0,
      noTrade: true,
      blocked: 8,
      bestMiss: 'EUR/USD (confidence, strategy_consensus)',
      notes: ['NO-TRADE for slot X: 8 pair(s) evaluated'],
    });
    expect(scan?.evaluated).toBe(8);
    expect(scan?.published).toBe(0);
    expect(scan?.noTrade).toBe(true);
    expect(scan?.bestMiss).toContain('confidence');
    expect(scan?.notes).toHaveLength(1);
  });

  it('treats a block without a timestamp or evaluation count as absent', () => {
    // Rendering zeros would read as "evaluated 0 pairs", which is a different
    // and much more alarming claim than "no scan recorded".
    expect(toScanSummary(null)).toBeNull();
    expect(toScanSummary({ published: 3 })).toBeNull();
    expect(toScanSummary({ ranAt: '2026-03-03T10:03:52.000Z' })).toBeNull();
    expect(toScanSummary('nonsense')).toBeNull();
  });

  it('coerces missing counts to zero only when the block is otherwise valid', () => {
    const scan = toScanSummary({ ranAt: '2026-03-03T10:03:52.000Z', evaluated: 3 });
    expect(scan).toMatchObject({ evaluated: 3, published: 0, blocked: 0, noTrade: false, bestMiss: null });
    expect(scan?.notes).toEqual([]);
  });

  it('rejects non-finite counts rather than passing NaN to the UI', () => {
    const scan = toScanSummary({ ranAt: '2026-03-03T10:03:52.000Z', evaluated: 2, published: Number.NaN });
    expect(scan?.published).toBe(0);
  });
});


describe('poll backoff', () => {
  it('polls at the normal cadence while reads succeed', () => {
    expect(nextPollDelayMs(15_000, 0)).toBe(15_000);
  });

  it('backs off exponentially after consecutive failures and caps at 8x', () => {
    expect(nextPollDelayMs(15_000, 1)).toBe(30_000);
    expect(nextPollDelayMs(15_000, 2)).toBe(60_000);
    expect(nextPollDelayMs(15_000, 3)).toBe(120_000);
    // Capped: a long outage must not turn into an hours-long sleep.
    expect(nextPollDelayMs(15_000, 4)).toBe(120_000);
    expect(nextPollDelayMs(15_000, 99)).toBe(120_000);
  });

  it('never divides by zero or returns a negative delay', () => {
    expect(nextPollDelayMs(0, 3)).toBe(0);
    expect(nextPollDelayMs(-5, 2)).toBe(0);
    expect(nextPollDelayMs(15_000, Number.NaN)).toBe(15_000);
    expect(nextPollDelayMs(15_000, -1)).toBe(15_000);
  });

  it('classifies HTTP 429 as rate-limited rather than a generic error', () => {
    // 429 with a "broken" message must still be reported as backpressure.
    const result = classifyFailure(429, 'Too Many Requests');
    expect(result).toBe('rate-limited');
    expect(failureGuidance('rate-limited', 'relay')).toMatch(/rate-limiting/i);
  });
});


describe('scan verdict', () => {
  const base = {
    ranAt: '2026-03-03T10:03:52.000Z',
    slot: 'slot',
    evaluated: 8,
    published: 0,
    noTrade: true,
    blocked: 8,
    bestMiss: 'EUR/USD (confidence)',
    notes: [] as string[],
  };

  it('separates "nothing to evaluate" from "everything was rejected"', () => {
    // Both end with zero published signals, but only one is a trade decision.
    expect(scanVerdict({ ...base, evaluated: 0, blocked: 0 })).toBe('NO_DATA');
    expect(scanVerdict(base)).toBe('NO_TRADE');
    expect(scanVerdict({ ...base, published: 1, blocked: 7 })).toBe('PUBLISHED');
  });

  it('reports nothing when there is no scan at all', () => {
    expect(scanVerdict(null)).toBeNull();
  });
});
