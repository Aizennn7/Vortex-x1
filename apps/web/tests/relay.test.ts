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
  normalizeWorkerLiveness,
  reduceRelayState,
  stalePairs,
  relay,
  summarizeLearningRuns,
  summarizeModelVersions,
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
        metrics: { accuracy: 0.58, auc: 0.61, logLoss: 0.66, ece: 0.08, samples: 180, baseRate: 0.5 },
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
