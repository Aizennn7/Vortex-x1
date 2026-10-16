/**
 * Relay client behaviour.
 *
 * The dashboard must never invent data: when the relay is unreachable or
 * answers with an error envelope, the client reports a failure instead of
 * returning an empty object that a component could render as "all good".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeMarketDataStaleness,
  createSnapshotClient,
  createSupabasePublicClient,
  normalizeWorkerLiveness,
  relay,
  RELAY_BASE,
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
