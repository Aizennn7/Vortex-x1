/**
 * Relay HTTP surface.
 *
 * The relay is the only thing the browser can reach, so these tests are about
 * the security boundary: the public plane is read-only and secret-free, the
 * privileged plane is closed without a token, and no response ever contains a
 * key, a bot token or the admin token itself.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  encryptSecret,
  insertModelVersion,
  insertSignal,
  keyFingerprint,
  listAudit,
  listKeys,
  listModelVersions,
  updateKey,
} from '@vortex/db';
import { maskKey } from '@vortex/core';
import {
  createHarness,
  createProviderStub,
  seedKey,
  TEST_ADMIN_TOKEN,
  TEST_BOT_TOKEN,
  TEST_SECRET_KEY,
  type WorkerHarness,
  type ProviderStub,
} from './helpers.js';
import { createRelay } from '../src/http.js';

const PLAINTEXT_KEY = 'relay-test-provider-key-0123456789';

let harness: WorkerHarness;
let server: Server;
let base = '';

const admin = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

beforeAll(async () => {
  harness = await createHarness({
    env: {
      TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
      TELEGRAM_CHANNELS: '@vortex_test',
      VORTEX_TELEGRAM_ENABLED: 'true',
      VORTEX_CORS_ORIGINS: 'https://dashboard.example.com',
      VORTEX_WORKER_ID: 'relay-test-worker',
    },
  });
  server = createRelay(harness.runtime);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness.close();
});

describe('public plane', () => {
  it('answers /health without leaking configuration', async () => {
    const { status, body } = await api('/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.service).toBe('vortex-si-worker');
    expect(body.data.database.ok).toBe(true);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(TEST_ADMIN_TOKEN);
    expect(raw).not.toContain(TEST_BOT_TOKEN);
    expect(raw).not.toContain(TEST_SECRET_KEY);
  });

  it('publishes the public runtime configuration only', async () => {
    const { status, body } = await api('/api/config');
    expect(status).toBe(200);
    expect(body.data.pairs).toEqual(['EUR/USD', 'GBP/USD']);
    expect(JSON.stringify(body)).not.toContain(TEST_BOT_TOKEN);
    expect(body.data).not.toHaveProperty('databaseUrl');
    expect(body.data).not.toHaveProperty('adminToken');
    expect(body.data).not.toHaveProperty('secretKey');
  });

  it('serves signals, performance and quality read-only', async () => {
    await insertSignal(harness.client, {
      idempotencyKey: 'relay|EUR/USD|2026-04-01T10:05:00.000Z|BUY|relay-engine',
      pair: 'EUR/USD',
      timeframe: 'M1',
      direction: 'BUY',
      decision: 'BUY',
      strategy: 'trend_follow',
      confidence: 0.71,
      regime: 'TREND_UP',
      engineVersion: 'relay-engine',
      scheduledEntryAt: '2026-04-01T10:05:00.000Z',
      publishAt: '2026-04-01T10:04:00.000Z',
      horizonSeconds: 60,
      referencePrice: 1.085,
      stopPips: 10,
      targetPips: 14,
      rewardRisk: 1.4,
      spreadPips: 0.8,
      reasons: ['relay test signal'],
      warnings: [],
      context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled' } as never,
      features: [1, 0.5, 0.25],
      modelVersionId: null,
      modelProbability: null,
    });

    const signals = await api('/api/signals?limit=10');
    expect(signals.status).toBe(200);
    expect(signals.body.data.count).toBeGreaterThanOrEqual(1);
    expect(signals.body.data.signals[0].pair).toBe('EUR/USD');

    const filtered = await api('/api/signals?pairs=GBP/USD');
    expect(filtered.body.data.count).toBe(0);

    const performance = await api('/api/performance');
    expect(performance.status).toBe(200);
    expect(performance.body.data.simulated).toBe(true);
    expect(performance.body.data.overall).toBeTruthy();

    const quality = await api('/api/quality');
    expect(quality.status).toBe(200);
    expect(Array.isArray(quality.body.data.pairs)).toBe(true);

    const health = await api('/api/health');
    expect(health.status).toBe(200);
    expect(Array.isArray(health.body.data.components)).toBe(true);

    const summary = await api('/api/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.data.providerBudget).toBeTruthy();
    expect(summary.body.data.signals.note).toContain('decisive');
  });

  it('reports the last opportunity scan so an empty signal list is explainable', async () => {
    await harness.client.query(
      `insert into job_runs (job_name, slot_key, worker_id, status, started_at, finished_at, duration_ms, detail)
       values ('signal_cycle', 'signal-2026-03-03T10:05:00.000Z', 'relay-test-worker', 'SUCCEEDED',
               now() - interval '2 minutes', now() - interval '2 minutes', 120, $1::jsonb)`,
      [
        JSON.stringify({
          slot: 'slot-2026-03-03T10:05:00.000Z',
          evaluated: 6,
          published: 0,
          noTrade: true,
          blocked: 6,
          bestMiss: 'EUR/USD (confidence)',
          detail: ['NO-TRADE for slot X: 6 pair(s) evaluated'],
        }),
      ],
    );
    const { status, body } = await api('/api/summary');
    expect(status).toBe(200);
    expect(body.data.scan).toMatchObject({
      evaluated: 6,
      published: 0,
      noTrade: true,
      blocked: 6,
      bestMiss: 'EUR/USD (confidence)',
    });
    expect(body.data.scan.notes[0]).toMatch(/NO-TRADE/);
    expect(typeof body.data.scan.ranAt).toBe('string');
  });

  it('omits the scan block entirely when no scan has ever run', async () => {
    // A fresh harness has no signal_cycle job; the dashboard must show
    // "no scan recorded", not a fabricated row of zeros.
    const fresh = await createHarness({ env: { VORTEX_WORKER_ID: 'fresh-scan-worker' } });
    const server2 = createRelay(fresh.runtime);
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    try {
      const address = server2.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/api/summary`);
      const payload = (await response.json()) as { data: { scan: unknown } };
      expect(payload.data.scan).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
      await fresh.close();
    }
  }, 120_000);

  it('never exposes the admin plane through the public plane', async () => {
    const { status } = await api('/admin/status');
    expect(status).toBe(401);
    const notFound = await api('/api/does-not-exist');
    expect(notFound.status).toBe(404);
  });

  it('rejects unsupported methods instead of running them', async () => {
    const { status, body } = await api('/api/summary', { method: 'POST', body: '{}' });
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('applies CORS only for configured origins', async () => {
    const allowed = await api('/health', { headers: { origin: 'https://dashboard.example.com' } });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://dashboard.example.com');
    const denied = await api('/health', { headers: { origin: 'https://evil.example.com' } });
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await fetch(`${base}/api/summary`, { method: 'OPTIONS', headers: { origin: 'https://dashboard.example.com' } });
    expect(preflight.status).toBe(204);
  });

  it('rate-limits anonymous callers', async () => {
    // The limiter is per IP with a 300/minute budget; 404s are cheap and still
    // pass through the limiter, so the boundary is observable.
    let limited = 0;
    for (let i = 0; i < 320; i += 1) {
      const { status } = await api('/api/nope');
      if (status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThan(0);
  });
});

describe('privileged plane — authentication', () => {
  it('refuses without a bearer token', async () => {
    const { status, body } = await api('/admin/status');
    expect(status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('refuses a wrong bearer token', async () => {
    const { status } = await api('/admin/status', { headers: { authorization: 'Bearer wrong-token-value' } });
    expect(status).toBe(401);
  });

  it('serves the control-centre snapshot with a valid token', async () => {
    const { status, body } = await api('/admin/status', { headers: admin });
    expect(status).toBe(200);
    expect(body.data.worker.id).toBeTruthy();
    expect(body.data.config.pairs).toEqual(['EUR/USD', 'GBP/USD']);
    // Secrets are reported as booleans, never as values.
    expect(body.data.environment).toEqual({
      databaseUrl: false,
      adminPlane: true,
      encryptionKey: true,
      telegramDelivery: true,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(TEST_ADMIN_TOKEN);
    expect(raw).not.toContain(TEST_BOT_TOKEN);
  });

  it('closes the whole privileged plane when no token is configured', async () => {
    const bare = await createHarness({ env: { VORTEX_ADMIN_TOKEN: '' } });
    const bareServer = createRelay(bare.runtime);
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const port = (bareServer.address() as AddressInfo).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/admin/status`, { headers: admin });
      expect(response.status).toBe(503);
      const body = (await response.json()) as any;
      expect(body.error.code).toBe('configuration_required');
    } finally {
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
      await bare.close();
    }
  });
});

describe('privileged plane — key management', () => {
  it('stores a new key encrypted and never returns the plaintext', async () => {
    const created = await api('/admin/keys', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'relay-key', apiKey: PLAINTEXT_KEY, minuteLimit: 8, dayLimit: 800 }),
    });
    expect(created.status).toBe(200);
    expect(created.body.data.key.maskedKey).toBe(maskKey(PLAINTEXT_KEY));
    expect(JSON.stringify(created.body)).not.toContain(PLAINTEXT_KEY);

    const rows = await listKeys(harness.client);
    const row = rows.find((k) => k.label === 'relay-key');
    expect(row?.fingerprint).toBe(keyFingerprint(PLAINTEXT_KEY));
    const ciphertext = await harness.client.query<{ ciphertext: string }>(
      'select ciphertext from provider_keys where id = $1',
      [row!.id],
    );
    expect(ciphertext.rows[0]?.ciphertext).not.toContain(PLAINTEXT_KEY);
    expect(ciphertext.rows[0]?.ciphertext.startsWith('v1:')).toBe(true);

    const list = await api('/admin/keys', { headers: admin });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(PLAINTEXT_KEY);
    expect(list.body.data.keys.some((k: any) => k.label === 'relay-key')).toBe(true);

    const audit = await listAudit(harness.client, 20);
    expect(audit.some((a) => a.action === 'provider_key.create')).toBe(true);
  });

  it('validates key input instead of storing junk', async () => {
    const missing = await api('/admin/keys', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('validation_error');

    const shortKey = await api('/admin/keys', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x', apiKey: 'tooshort' }),
    });
    expect(shortKey.status).toBe(400);

    const badJson = await api('/admin/keys', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('bad_json');
  });

  it('rotates key material and records the rotation', async () => {
    const key = await seedKey(harness.client, { label: 'rotate-me' });
    const replacement = 'rotated-provider-key-9876543210';
    const rotated = await api(`/admin/keys/${key.id}`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: replacement }),
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.key.maskedKey).toBe(maskKey(replacement));
    expect(rotated.body.data.rotated).toBe(true);
    expect(JSON.stringify(rotated.body)).not.toContain(replacement);
    const stored = (await listKeys(harness.client)).find((k) => k.id === key.id);
    expect(stored?.fingerprint).toBe(keyFingerprint(replacement));
  });

  it('disables and deletes keys', async () => {
    const key = await seedKey(harness.client, { label: 'to-delete' });
    const patched = await api(`/admin/keys/${key.id}`, {
      method: 'PATCH',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patched.body.data.key.enabled).toBe(false);

    const deleted = await api(`/admin/keys/${key.id}`, { method: 'DELETE', headers: admin });
    expect(deleted.body.data.deleted).toBe(true);
    expect((await listKeys(harness.client)).some((k) => k.id === key.id)).toBe(false);
  });

  describe('key verification against the provider', () => {
    let stub: ProviderStub;
    const realBaseUrl = harness?.runtime.config.providerBaseUrl;

    beforeAll(async () => {
      stub = await createProviderStub();
    });

    afterAll(async () => {
      await stub.close();
      if (harness) harness.runtime.config.providerBaseUrl = realBaseUrl ?? '';
    });

    it('accepts a key the provider answers for, and records the reported credits', async () => {
      stub.setResponse({ status: 200, body: { api_usage: 12, plan_category: 'grow' } });
      harness.runtime.config.providerBaseUrl = stub.url;
      const key = await seedKey(harness.client, { label: 'verifiable' });
      const result = await api(`/admin/keys/${key.id}/verify`, { method: 'POST', headers: admin });
      expect(result.status).toBe(200);
      expect(result.body.data.outcome).toBe('ACCEPTED');
      expect(result.body.data.ok).toBe(true);
      expect(result.body.data.creditsUsed).toBe(12);
      // The real key must be what reaches the provider, never the ciphertext.
      expect(stub.requests.some((url) => url.includes('apikey=demo-provider-key-abcdef123456'))).toBe(true);
      const stored = (await listKeys(harness.client)).find((k) => k.id === key.id);
      expect(stored?.status).toBe('ACTIVE');
      expect(stored?.providerUsageCredits).toBe(12);
      expect(stored?.lastVerifiedAt).not.toBeNull();
    });

    it('rejects a key the provider refuses, and disables it', async () => {
      stub.setResponse({ status: 401, body: { code: 401, status: 'error', message: 'Invalid API key' } });
      harness.runtime.config.providerBaseUrl = stub.url;
      const key = await seedKey(harness.client, { label: 'rejected' });
      const result = await api(`/admin/keys/${key.id}/verify`, { method: 'POST', headers: admin });
      expect(result.body.data.outcome).toBe('REJECTED');
      expect(result.body.data.ok).toBe(false);
      expect(result.body.data.detail).toContain('Invalid API key');
      const stored = (await listKeys(harness.client)).find((k) => k.id === key.id);
      expect(stored?.status).toBe('INVALID');
    });

    it('reports an unreachable provider as unverified rather than disabling the key', async () => {
      // Port 1 is never bound: connection refused immediately, deterministically.
      harness.runtime.config.providerBaseUrl = 'http://127.0.0.1:1';
      const key = await seedKey(harness.client, { label: 'unverifiable' });
      const result = await api(`/admin/keys/${key.id}/verify`, { method: 'POST', headers: admin });
      expect(result.status).toBe(200);
      expect(result.body.data.outcome).toBe('UNVERIFIED');
      expect(result.body.data.ok).toBe(false);
      expect(result.body.data.note).toContain('not disabled');
      const stored = (await listKeys(harness.client)).find((k) => k.id === key.id);
      expect(stored?.status).not.toBe('INVALID');
      expect(stored?.lastVerifiedAt).not.toBeNull();
    });
  });

  it('does not verify an undecryptable key', async () => {
    const key = await seedKey(harness.client, { label: 'undecryptable' });
    await updateKey(harness.client, key.id, {
      ciphertext: encryptSecret('different-provider-key-1234567890', TEST_SECRET_KEY),
    });
    // Overwrite with a payload encrypted using a different master key.
    await harness.client.query('update provider_keys set ciphertext = $2 where id = $1', [
      key.id,
      'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]);
    const result = await api(`/admin/keys/${key.id}/verify`, { method: 'POST', headers: admin });
    expect(result.status).toBe(200);
    expect(result.body.data?.ok, JSON.stringify(result.body)).toBe(false);
    expect(result.body.data?.outcome).toBe('UNVERIFIED');
    expect(result.body.data?.detail).toContain('could not be decrypted');
  });
});

describe('privileged plane — operations', () => {
  it('reports telegram configuration and refuses an unconfigured test', async () => {
    const channels = await api('/admin/telegram/channels', { headers: admin });
    expect(channels.status).toBe(200);
    expect(Array.isArray(channels.body.data.channels)).toBe(true);

    // Intercept only the Telegram API so the assertion is about our behaviour
    // (a rejected credential never reports success) rather than about whether
    // the machine running the tests can reach api.telegram.org. Everything else
    // keeps using the real fetch, including the calls this test makes to the
    // relay itself.
    const realFetch = globalThis.fetch;
    const telegramCalls: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('api.telegram.org')) {
        telegramCalls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 }),
        );
      }
      return realFetch(input as RequestInfo, init);
    });
    try {
      const test = await api('/admin/telegram/test', { method: 'POST', headers: admin });
      expect(test.status).toBe(200);
      expect(test.body.data.ok).toBe(false);
      expect(test.body.data.detail).toContain('Unauthorized');
      expect(JSON.stringify(test.body)).not.toContain(TEST_BOT_TOKEN);
      expect(telegramCalls.length).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('validates settings writes', async () => {
    const bad = await api('/admin/settings', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const good = await api('/admin/settings', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'relay_test_setting', value: 'on' }),
    });
    expect(good.status).toBe(200);
    const list = await api('/admin/settings', { headers: admin });
    expect(list.body.data.settings.some((s: any) => s.key === 'relay_test_setting')).toBe(true);
  });

  it('exposes jobs, alerts, deliveries, logs, audit and paper ledgers', async () => {
    for (const path of ['/admin/jobs', '/admin/alerts', '/admin/deliveries', '/admin/logs', '/admin/audit', '/admin/paper', '/admin/provider', '/admin/models']) {
      const { status, body } = await api(path, { headers: admin });
      expect(status, path).toBe(200);
      expect(body.ok, path).toBe(true);
      expect(JSON.stringify(body), path).not.toContain(PLAINTEXT_KEY);
      expect(JSON.stringify(body), path).not.toContain(TEST_ADMIN_TOKEN);
    }
  });

  it('runs a maintenance cycle on demand and records the job run', async () => {
    const result = await api('/admin/maintenance/run', { method: 'POST', headers: admin });
    expect(result.status).toBe(200);
    expect(result.body.data.components).toBeTruthy();
    const jobs = await api('/admin/jobs', { headers: admin });
    expect(JSON.stringify(jobs.body.data)).toContain('maintenance');
  });

  /**
   * The calendar must not decide what this test proves. When the FX market is
   * closed the cycle returns before it ever looks at the key pool, so the
   * clock is pinned to a weekday inside the session and restored afterwards.
   */
  async function withPinnedClock<T>(iso: string, fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
    try {
      return await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  it('degrades honestly when a job needs provider keys it does not have', async () => {
    const keys = await listKeys(harness.client);
    for (const key of keys) {
      await updateKey(harness.client, key.id, { enabled: false });
    }
    harness.runtime.keyPool.invalidate();
    const result = await withPinnedClock('2026-01-05T10:00:00.000Z', () =>
      api('/admin/ingest/run', { method: 'POST', headers: admin }),
    );
    expect(result.status).toBe(200);
    // The cycle must report the degradation honestly instead of claiming success
    // or spinning on the provider.
    expect(result.body.data.exhausted).toBe(true);
    expect(JSON.stringify(result.body.data.detail)).toMatch(/key|quota|budget/i);
  });

  it('does not blame the credentials for a closed market', async () => {
    // Saturday: ingestion legitimately skips for a calendar reason, which is a
    // different fact from an exhausted key pool and must be reported as such.
    const result = await withPinnedClock('2026-01-10T12:00:00.000Z', () =>
      api('/admin/ingest/run', { method: 'POST', headers: admin }),
    );
    expect(result.status).toBe(200);
    expect(result.body.data.exhausted).toBe(false);
    expect(result.body.data.detail.join(' ')).toMatch(/market closed/i);
  });

  it('refuses to promote a candidate the gates rejected', async () => {
    const candidate = await insertModelVersion(harness.client, {
      version: 'relay-blocked-candidate',
      datasetChecksum: 'checksum-blocked',
      datasetSize: 300,
      datasetFrom: '2026-01-01T00:00:00.000Z',
      datasetTo: '2026-02-01T00:00:00.000Z',
      featureNames: ['bias'],
      hyper: {},
      parameters: {},
      metrics: {},
      walkForward: [],
      baselines: {},
      promotion: { promote: false, summary: 'Keeping the current model — failed gates: baseline_skill' },
    });
    const path = `/admin/models/${candidate.id}/promote`;
    const blocked = await api(path, { method: 'POST', headers: admin });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('promotion_blocked');
    expect(blocked.body.error.message).toMatch(/baseline_skill/);

    // An override must be deliberate and explained.
    const unexplained = await api(path, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ override: true }),
    });
    expect(unexplained.status).toBe(400);

    const overridden = await api(path, {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ override: true, reason: 'operator review after a rejected holdout' }),
    });
    expect(overridden.status).toBe(200);
    expect(overridden.body.data.promoted).toBe(true);
    const stored = (await listModelVersions(harness.client, 10)).find((v) => v.id === candidate.id);
    expect(stored?.status).toBe('CHAMPION');
    expect(stored?.promotion.override).toBe(true);
    expect(String(stored?.promotion.reason)).toMatch(/operator review/);
  });

  it('promotes a candidate whose stored decision passed', async () => {
    const candidate = await insertModelVersion(harness.client, {
      version: 'relay-approved-candidate',
      datasetChecksum: 'checksum-approved',
      datasetSize: 400,
      datasetFrom: '2026-01-01T00:00:00.000Z',
      datasetTo: '2026-02-15T00:00:00.000Z',
      featureNames: ['bias'],
      hyper: {},
      parameters: {},
      metrics: {},
      walkForward: [],
      baselines: {},
      promotion: { promote: true, summary: 'Promoting relay-approved-candidate: all gates passed.' },
    });
    const result = await api(`/admin/models/${candidate.id}/promote`, { method: 'POST', headers: admin });
    expect(result.status).toBe(200);
    expect(result.body.data.promoted).toBe(true);
  });

  it('rejects a body larger than the limit', async () => {
    const huge = 'x'.repeat(300 * 1024);
    const { status } = await api('/admin/settings', {
      method: 'POST',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k', value: huge }),
    });
    expect(status).toBe(413);
  });
});
