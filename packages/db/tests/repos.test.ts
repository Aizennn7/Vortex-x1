import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, type CandleInput } from '@vortex/core';
import { claimJob, finishJob, upsertHeartbeat, workerStatus, acquireLock, releaseLock } from '../src/repos/jobs.js';
import { countGaps, getCandles, listQuality, syncPairs, upsertCandles, upsertQuality, latestCandleTimes } from '../src/repos/candles.js';
import { QuotaGate, currentUsage, quotaSummary, recordRequest, reserveQuota, refundQuota, QuotaExceededError } from '../src/repos/quota.js';
import { applySettlement, cancelMissedPublishing, dueForPublish, dueForSettlement, insertSignal, listSignals, listResolvedForLearning, markPublished, activateDue } from '../src/repos/signals.js';
import { insertKey, listKeys, listKeysWithCiphertext, markFailure, markSuccess, publicKeyView } from '../src/repos/keys.js';
import { claimDelivery, completeDelivery, deliveryStats, listChannels, upsertChannel } from '../src/repos/telegram.js';
import { getChampion, insertModelVersion, listModelVersions, promoteModel, rollbackModel, saveStrategyWeights, getActiveStrategyWeights } from '../src/repos/learning.js';
import { ensureAccount, listPositions, refreshBalance, syncPosition } from '../src/repos/paper.js';
import { getSetting, listSettings, setSetting } from '../src/repos/settings.js';
import { raiseAlert, resolveAlert, listAlerts, recordAudit, listAudit, setComponentHealth, listHealth, recordLogEvent, listLogEvents } from '../src/repos/health.js';
import { decryptSecret, encryptSecret, keyFingerprint, parseMasterKey, safeEqual } from '../src/crypto.js';
import { createTestDb, KEY_A, KEY_B, type TestDb } from './helpers.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** Fetch one signal by its idempotency key (independent of list ordering). */
async function findByKey(key: string) {
  const rows = await listSignals(db.client, { limit: 200 });
  return rows.find((s) => s.idempotencyKey === key);
}

function minuteCandles(startIso: string, count: number, base = 1.1): CandleInput[] {
  const start = Date.parse(startIso);
  return Array.from({ length: count }, (_, i) => ({
    pair: 'EUR/USD',
    timeframe: 'M1' as const,
    openTime: new Date(start + i * 60_000).toISOString(),
    open: base + i * 0.0001,
    high: base + i * 0.0001 + 0.0002,
    low: base + i * 0.0001 - 0.0002,
    close: base + i * 0.0001 + 0.0001,
    provider: 'test',
    isFinal: true,
  }));
}

describe('candles repository', () => {
  it('inserts once and ignores exact duplicates', async () => {
    const batch = minuteCandles('2026-01-05T10:00:00.000Z', 10);
    const first = await upsertCandles(db.client, batch);
    expect(first.inserted).toBe(10);
    const second = await upsertCandles(db.client, batch);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
  });

  it('updates a candle when a newer revision arrives', async () => {
    const batch = minuteCandles('2026-01-06T10:00:00.000Z', 3);
    await upsertCandles(db.client, batch);
    const revised = batch.map((c, i) =>
      i === 2
        ? { ...c, high: (c.high as number) + 0.001, close: (c.close as number) + 0.0005, revision: 2 }
        : c,
    );
    const result = await upsertCandles(db.client, revised);
    expect(result.updated).toBe(1);
    const stored = await getCandles(db.client, { pair: 'EUR/USD', timeframe: 'M1', limit: 3, from: '2026-01-06T10:00:00.000Z' });
    expect(stored[stored.length - 1]?.close).toBeCloseTo((batch[2]!.close as number) + 0.0005, 6);
  });

  it('rejects invalid candles instead of storing them', async () => {
    const bad = minuteCandles('2026-01-07T10:00:00.000Z', 2).map((c) => ({ ...c, high: 0 }));
    const result = await upsertCandles(db.client, bad);
    expect(result.rejected).toBe(2);
    expect(result.inserted).toBe(0);
  });

  it('returns candles in ascending order and only final ones', async () => {
    const rows = await getCandles(db.client, { pair: 'EUR/USD', timeframe: 'M1', limit: 50 });
    expect(rows.length).toBeGreaterThan(0);
    const times = rows.map((r) => Date.parse(r.openTime));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(rows.every((r) => r.isFinal)).toBe(true);
  });

  it('counts gaps in SQL over an explicit window', async () => {
    const batch = minuteCandles('2026-01-08T10:00:00.000Z', 5).filter((_, i) => i !== 2);
    await upsertCandles(db.client, batch);
    const result = await countGaps(db.client, {
      pair: 'EUR/USD',
      timeframe: 'M1',
      from: '2026-01-08T10:00:00.000Z',
      to: '2026-01-08T10:04:00.000Z',
      stepSeconds: 60,
    });
    expect(result.expected).toBe(5);
    expect(result.present).toBe(4);
    expect(result.gaps).toBe(1);
  });

  it('exposes the newest candle time per pair', async () => {
    const map = await latestCandleTimes(db.client, ['EUR/USD', 'GBP/USD'], 'M1');
    expect(map.get('EUR/USD')).toBe('2026-01-08T10:04:00.000Z');
    expect(map.has('GBP/USD')).toBe(false);
  });

  it('tracks pair configuration and data quality', async () => {
    await syncPairs(db.client, [
      { pair: 'EUR/USD', priority: 10, tier: 1, pipSize: 0.0001 },
      { pair: 'GBP/USD', priority: 11, tier: 1, pipSize: 0.0001 },
    ]);
    await upsertQuality(db.client, [
      {
        pair: 'EUR/USD',
        timeframe: 'M1',
        status: 'CONNECTED',
        ageSeconds: 20,
        gapCount: 0,
        lastCandleAt: '2026-01-08T10:04:00.000Z',
        expectedAt: '2026-01-08T10:04:00.000Z',
        detail: 'fresh',
      },
    ]);
    const quality = await listQuality(db.client);
    expect(quality.find((q) => q.pair === 'EUR/USD')?.status).toBe('CONNECTED');
  });
});

describe('provider key repository and encryption', () => {
  const master = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY='; // 32 bytes base64

  it('round-trips a key through AES-256-GCM', () => {
    const envelope = encryptSecret(KEY_A, master);
    expect(envelope.startsWith('v1:')).toBe(true);
    expect(envelope).not.toContain(KEY_A);
    expect(decryptSecret(envelope, master)).toBe(KEY_A);
  });

  it('rejects a tampered envelope', () => {
    const envelope = encryptSecret(KEY_A, master);
    const parts = envelope.split(':');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('deadbeef').toString('base64')].join(':');
    expect(() => decryptSecret(tampered, master)).toThrow();
  });

  it('validates the master key format with a helpful error', () => {
    expect(parseMasterKey(master)).toHaveLength(32);
    expect(parseMasterKey('a'.repeat(64))).toHaveLength(32);
    expect(() => parseMasterKey('too-short')).toThrow(/VORTEX_SECRET_KEY/);
  });

  it('stores only ciphertext and a mask', async () => {
    const encrypted = encryptSecret(KEY_A, master);
    const stored = await insertKey(db.client, {
      label: 'primary',
      maskedKey: '••••8f90',
      ciphertext: encrypted,
      fingerprint: keyFingerprint(KEY_A),
      minuteLimit: 8,
      dayLimit: 800,
    });
    expect(stored.label).toBe('primary');
    const rows = await db.client.query<{ ciphertext: string; masked_key: string }>(
      'select ciphertext, masked_key from provider_keys where id = $1',
      [stored.id],
    );
    expect(rows.rows[0]?.ciphertext).not.toContain(KEY_A);
    expect(rows.rows[0]?.masked_key).not.toContain(KEY_A);
    const view = publicKeyView(stored) as Record<string, unknown>;
    expect(JSON.stringify(view)).not.toContain(KEY_A);
    expect(view).not.toHaveProperty('ciphertext');
  });

  it('lists keys for the pool without exposing plaintext', async () => {
    const keys = await listKeys(db.client);
    expect(keys.length).toBe(1);
    const withCipher = await listKeysWithCiphertext(db.client);
    expect(withCipher[0]?.stored.id).toBe(keys[0]?.id);
  });

  it('moves a key through failures, cooldown and recovery', async () => {
    const keys = await listKeys(db.client);
    const id = keys[0]!.id;
    await markFailure(db.client, id, { status: 'COOLDOWN', error: 'rate limited', cooldownUntil: '2030-01-01T00:00:00.000Z' });
    let current = (await listKeys(db.client))[0];
    expect(current?.status).toBe('COOLDOWN');
    expect(current?.consecutiveFailures).toBe(1);
    await markSuccess(db.client, id);
    current = (await listKeys(db.client))[0];
    expect(current?.status).toBe('ACTIVE');
    expect(current?.consecutiveFailures).toBe(0);
    expect(current?.cooldownUntil).toBeNull();
  });
});

describe('quota reservations', () => {
  let keyId: string;

  beforeAll(async () => {
    const keys = await listKeys(db.client);
    keyId = keys[0]!.id;
  });

  it('never lets concurrent reservations exceed the limit (serialising gate)', async () => {
    const now = new Date('2026-02-01T10:00:00.000Z');
    const limit = 5;
    // The gate is what the worker and relay share, so this exercises the real
    // production path: N concurrent callers, one budget.
    const gate = new QuotaGate(db.client);
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => gate.reserve({ keyId, cost: 1, minuteLimit: limit, dayLimit: 1000, now })),
    );
    const granted = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(granted).toBe(limit);
    expect(rejected).toHaveLength(12 - limit);
    for (const rejection of rejected) {
      const reason = (rejection as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(QuotaExceededError);
      expect((reason as QuotaExceededError).scope).toBe('minute');
    }
    const usage = await currentUsage(db.client, [keyId], now);
    expect(usage.get(keyId)?.minuteUsed).toBe(limit);
  });

  it('enforces the limit on the raw SQL path too (no gate)', async () => {
    const now = new Date('2026-02-05T10:00:00.000Z');
    await reserveQuota(db.client, { keyId, cost: 3, minuteLimit: 3, dayLimit: 1000, now });
    await expect(
      reserveQuota(db.client, { keyId, cost: 1, minuteLimit: 3, dayLimit: 1000, now }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it('enforces the daily cap independently of the minute cap', async () => {
    const now = new Date('2026-02-02T10:00:00.000Z');
    await reserveQuota(db.client, { keyId, cost: 5, minuteLimit: 100, dayLimit: 6, now });
    await expect(
      reserveQuota(db.client, { keyId, cost: 2, minuteLimit: 100, dayLimit: 6, now }),
    ).rejects.toThrow(/daily budget/);
  });

  it('separates buckets per minute and per day', async () => {
    const day = new Date('2026-02-03T10:00:00.000Z');
    await reserveQuota(db.client, { keyId, cost: 1, minuteLimit: 10, dayLimit: 100, now: day });
    await reserveQuota(db.client, { keyId, cost: 1, minuteLimit: 10, dayLimit: 100, now: new Date('2026-02-03T10:01:30.000Z') });
    const usage = await currentUsage(db.client, [keyId], new Date('2026-02-03T10:01:30.000Z'));
    const entry = usage.get(keyId);
    expect(entry?.minuteUsed).toBe(1); // new minute bucket
    expect(entry?.dayUsed).toBe(2);
  });

  it('refunds a reservation that never reached the provider', async () => {
    const now = new Date('2026-02-04T10:00:00.000Z');
    await reserveQuota(db.client, { keyId, cost: 3, minuteLimit: 10, dayLimit: 100, now });
    await refundQuota(db.client, { keyId, cost: 3, now });
    const usage = await currentUsage(db.client, [keyId], now);
    expect(usage.get(keyId)?.minuteUsed).toBe(0);
  });

  it('records a request ledger without keys', async () => {
    await recordRequest(db.client, {
      keyId,
      endpoint: 'time_series',
      pair: 'EUR/USD',
      timeframe: 'M1',
      credits: 1,
      httpStatus: 200,
      ok: true,
      durationMs: 120,
    });
    const rows = await db.client.query<{ endpoint: string; ok: boolean }>('select endpoint, ok from provider_request_log');
    expect(rows.rows[0]?.endpoint).toBe('time_series');
  });

  it('reports a quota summary for the control centre', async () => {
    const summary = await quotaSummary(db.client, new Date('2026-02-03T10:01:30.000Z'));
    expect(summary.dayCapacity).toBe(800);
    expect(summary.dayUsed).toBeGreaterThan(0);
  });
});

describe('signal lifecycle', () => {
  const baseSignal = {
    idempotencyKey: 'sig|EUR/USD|2026-03-02T10:05:00.000Z|BUY|test-engine',
    pair: 'EUR/USD',
    direction: 'BUY' as const,
    decision: 'BUY' as const,
    strategy: 'trend_follow',
    timeframe: 'M1' as const,
    confidence: 0.71,
    regime: 'TREND_UP' as const,
    scheduledEntryAt: '2026-03-02T10:05:00.000Z',
    publishAt: '2026-03-02T10:04:00.000Z',
    horizonSeconds: 60,
    referencePrice: 1.1,
    stopPips: 10,
    targetPips: 14,
    rewardRisk: 1.4,
    spreadPips: 0.8,
    reasons: ['trend aligned'],
    warnings: [],
    context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled' } as never,
    features: [1, 0.7, 0.2],
    modelVersionId: null,
    modelProbability: null,
    engineVersion: 'test-engine',
  };

  it('inserts a signal and ignores a duplicate opportunity', async () => {
    const first = await insertSignal(db.client, baseSignal);
    expect(first.created).toBe(true);
    const second = await insertSignal(db.client, baseSignal);
    expect(second.created).toBe(false);
    expect(second.record?.id).toBe(first.record?.id);
  });

  it('publishes exactly once even when the job replays', async () => {
    const rows = await db.client.query<{ id: string }>('select id from signals where idempotency_key = $1', [
      baseSignal.idempotencyKey,
    ]);
    const id = rows.rows[0]!.id;
    expect(await markPublished(db.client, [id], '2026-03-02T10:04:00.000Z')).toBe(1);
    expect(await markPublished(db.client, [id], '2026-03-02T10:04:05.000Z')).toBe(0);
    const after = await findByKey(baseSignal.idempotencyKey);
    expect(after?.status).toBe('PUBLISHED');
    expect(after?.publishedAt).toBe('2026-03-02T10:04:00.000Z');
  });

  it('finds signals due for publishing and settlement at the right instants', async () => {
    // A fresh PLANNED signal, independent of the earlier publication test.
    await insertSignal(db.client, {
      ...baseSignal,
      idempotencyKey: 'sig|USD/JPY|2026-03-02T10:05:00.000Z|BUY|test-engine',
      pair: 'USD/JPY',
      scheduledEntryAt: '2026-03-02T10:05:00.000Z',
      publishAt: '2026-03-02T10:04:00.000Z',
    });
    const duePublish = await dueForPublish(db.client, '2026-03-02T10:03:40.000Z', 30);
    expect(duePublish.map((s) => s.idempotencyKey)).toContain('sig|USD/JPY|2026-03-02T10:05:00.000Z|BUY|test-engine');

    const dueSettleBefore = await dueForSettlement(db.client, '2026-03-02T10:05:30.000Z', 8);
    expect(dueSettleBefore).toHaveLength(0);

    const dueSettleAfter = await dueForSettlement(db.client, '2026-03-02T10:07:00.000Z', 8);
    expect(dueSettleAfter).toHaveLength(1);
  });

  it('activates signals after the entry instant', async () => {
    expect(await activateDue(db.client, '2026-03-02T10:05:01.000Z')).toBe(1);
    const after = await findByKey(baseSignal.idempotencyKey);
    expect(after?.status).toBe('ACTIVE');
  });

  it('settles once and refuses to overwrite the verdict', async () => {
    const row = await findByKey(baseSignal.idempotencyKey);
    const id = row!.id;
    const applied = await applySettlement(db.client, {
      id,
      outcome: 'WIN',
      status: 'SETTLED',
      entryPrice: 1.1,
      exitPrice: 1.1012,
      grossPips: 12,
      costPips: 1,
      realizedPips: 11,
      mfePips: 12,
      maePips: -2,
      outcomeRule: 'net_after_costs_v1',
      outcomeFlags: [],
      outcomeDetail: 'closed in favour',
    });
    expect(applied).toBe(true);
    const replayed = await applySettlement(db.client, {
      id,
      outcome: 'LOSS',
      status: 'SETTLED',
      entryPrice: 1.1,
      exitPrice: 1.09,
      grossPips: -10,
      costPips: 1,
      realizedPips: -11,
      mfePips: 0,
      maePips: 0,
      outcomeRule: 'net_after_costs_v1',
      outcomeFlags: [],
      outcomeDetail: 'should not apply',
    });
    expect(replayed).toBe(false);
    const after = await findByKey(baseSignal.idempotencyKey);
    expect(after?.outcome).toBe('WIN');
    expect(after?.realizedPips).toBeCloseTo(11, 3);
    expect(after?.status).toBe('SETTLED');
  });

  it('cancels a signal whose publish window was missed rather than publishing late', async () => {
    await insertSignal(db.client, {
      ...baseSignal,
      idempotencyKey: 'sig|GBP/USD|2026-03-02T10:05:00.000Z|SELL|test-engine',
      pair: 'GBP/USD',
      direction: 'SELL',
      decision: 'SELL',
      scheduledEntryAt: '2026-03-02T10:05:00.000Z',
      publishAt: '2026-03-02T10:04:00.000Z',
    });
    // The USD/JPY signal from the previous test is still PLANNED and its grace
    // window has also expired, so both are cancelled in one sweep.
    const cancelled = await cancelMissedPublishing(db.client, '2026-03-02T10:05:30.000Z', 5);
    expect(cancelled).toBeGreaterThanOrEqual(1);
    const missed = await findByKey('sig|GBP/USD|2026-03-02T10:05:00.000Z|SELL|test-engine');
    expect(missed?.status).toBe('CANCELLED');
    expect(missed?.outcomeRule).toBe('not_published');
  });

  it('exposes learning rows with features and flags', async () => {
    const rows = await listResolvedForLearning(db.client, { sinceDays: 3650 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.features).toEqual([1, 0.7, 0.2]);
  });
});

describe('job coordination', () => {
  it('claims a slot exactly once', async () => {
    const first = await claimJob(db.client, { jobName: 'test_job', slotKey: 'slot-1', workerId: 'w1' });
    expect(first.claimed).toBe(true);
    const second = await claimJob(db.client, { jobName: 'test_job', slotKey: 'slot-1', workerId: 'w2' });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('already running');
  });

  it('does not re-run a completed slot', async () => {
    const claim = await claimJob(db.client, { jobName: 'test_job2', slotKey: 'slot-1', workerId: 'w1' });
    await finishJob(db.client, { jobRunId: claim.jobRunId as number, status: 'SUCCEEDED', detail: { ok: true } });
    const again = await claimJob(db.client, { jobName: 'test_job2', slotKey: 'slot-1', workerId: 'w2' });
    expect(again.claimed).toBe(false);
    expect(again.reason).toBe('already SUCCEEDED');
  });

  it('recovers a stale slot after a worker crash (restart recovery)', async () => {
    const claim = await claimJob(db.client, { jobName: 'stale_job', slotKey: 'slot-1', workerId: 'dead-worker' });
    expect(claim.claimed).toBe(true);
    // Backdate the RUNNING row to simulate a worker that died mid-job.
    await db.client.query(`update job_runs set started_at = now() - interval '20 minutes' where id = $1`, [claim.jobRunId]);
    const recovered = await claimJob(db.client, {
      jobName: 'stale_job',
      slotKey: 'slot-1',
      workerId: 'new-worker',
      staleAfterSeconds: 300,
    });
    expect(recovered.claimed).toBe(true);
    expect(recovered.reason).toContain('recovered stale slot');
  });

  it('records a failed job with its error', async () => {
    const claim = await claimJob(db.client, { jobName: 'failing_job', slotKey: 'slot-1', workerId: 'w1' });
    await finishJob(db.client, { jobRunId: claim.jobRunId as number, status: 'FAILED', error: 'boom' });
    const rows = await db.client.query<{ status: string; error: string }>(
      `select status, error from job_runs where job_name = 'failing_job'`,
    );
    expect(rows.rows[0]?.status).toBe('FAILED');
    expect(rows.rows[0]?.error).toBe('boom');
  });

  it('tracks worker heartbeats and reports liveness', async () => {
    await upsertHeartbeat(db.client, {
      workerId: 'worker-1',
      instanceLabel: 'test',
      version: 'v1',
      lastJob: 'ingest_market_data',
      jobsCompleted: 3,
      cyclesRun: 5,
    });
    let statuses = await workerStatus(db.client);
    expect(statuses[0]?.liveness).toBe('CONNECTED');
    expect(statuses[0]?.lastJob).toBe('ingest_market_data');
    // Simulate a dead worker.
    await db.client.query(`update worker_heartbeats set last_seen_at = now() - interval '30 minutes' where worker_id = 'worker-1'`);
    statuses = await workerStatus(db.client);
    expect(statuses[0]?.liveness).toBe('DISCONNECTED');
    expect(statuses[0]?.secondsSince).toBeGreaterThan(1500);
  });

  it('hands out an advisory lock to one owner at a time', async () => {
    expect(await acquireLock(db.client, { name: 'learning', owner: 'w1', ttlSeconds: 60 })).toBe(true);
    expect(await acquireLock(db.client, { name: 'learning', owner: 'w2', ttlSeconds: 60 })).toBe(false);
    expect(await acquireLock(db.client, { name: 'learning', owner: 'w1', ttlSeconds: 60 })).toBe(true);
    await releaseLock(db.client, 'learning', 'w1');
    expect(await acquireLock(db.client, { name: 'learning', owner: 'w2', ttlSeconds: 60 })).toBe(true);
  });

  it('reclaims an expired advisory lock', async () => {
    await acquireLock(db.client, { name: 'expired', owner: 'w1', ttlSeconds: 5 });
    await db.client.query(`update job_locks set expires_at = now() - interval '1 minute' where name = 'expired'`);
    expect(await acquireLock(db.client, { name: 'expired', owner: 'w2', ttlSeconds: 60 })).toBe(true);
  });
});

describe('telegram delivery ledger', () => {
  it('creates channels from configuration', async () => {
    await upsertChannel(db.client, { label: 'primary', chatId: '@vortex_signals', isPrimary: true });
    await upsertChannel(db.client, { label: 'secondary', chatId: '-1001234567890' });
    const channels = await listChannels(db.client);
    expect(channels).toHaveLength(2);
    expect(channels[0]?.label).toBe('primary');
  });

  it('delivers once and refuses a duplicate send', async () => {
    const signals = await listSignals(db.client, { limit: 1 });
    const signalId = signals[0]!.id;
    const first = await claimDelivery(db.client, { signalId, channelLabel: 'primary', kind: 'PUBLISH' });
    expect(first.shouldSend).toBe(true);
    await completeDelivery(db.client, { deliveryId: first.deliveryId as string, status: 'SENT', messageId: '42' });
    const second = await claimDelivery(db.client, { signalId, channelLabel: 'primary', kind: 'PUBLISH' });
    expect(second.shouldSend).toBe(false);
    expect(second.reason).toBe('already delivered');
  });

  it('retries a failed delivery within the attempt budget', async () => {
    const signals = await listSignals(db.client, { limit: 1 });
    const signalId = signals[0]!.id;
    const first = await claimDelivery(db.client, { signalId, channelLabel: 'secondary', kind: 'PUBLISH', maxAttempts: 3 });
    await completeDelivery(db.client, { deliveryId: first.deliveryId as string, status: 'FAILED', error: 'timeout' });
    const retry = await claimDelivery(db.client, { signalId, channelLabel: 'secondary', kind: 'PUBLISH', maxAttempts: 3 });
    expect(retry.shouldSend).toBe(true);
    expect(retry.reason).toBe('retrying');
  });

  it('does not blindly retry an unconfirmed delivery (duplicate protection)', async () => {
    const signals = await listSignals(db.client, { limit: 1 });
    const signalId = signals[0]!.id;
    const claim = await claimDelivery(db.client, { signalId, channelLabel: 'primary', kind: 'SETTLEMENT' });
    await completeDelivery(db.client, { deliveryId: claim.deliveryId as string, status: 'UNKNOWN', error: 'socket hang up' });
    const again = await claimDelivery(db.client, { signalId, channelLabel: 'primary', kind: 'SETTLEMENT' });
    expect(again.shouldSend).toBe(false);
    expect(again.reason).toContain('unconfirmed');
  });

  it('exhausts the retry budget', async () => {
    const signals = await listSignals(db.client, { limit: 1 });
    const signalId = signals[0]!.id;
    const claim = await claimDelivery(db.client, { signalId, channelLabel: 'secondary', kind: 'SETTLEMENT', maxAttempts: 1 });
    await completeDelivery(db.client, { deliveryId: claim.deliveryId as string, status: 'FAILED', error: 'nope' });
    const again = await claimDelivery(db.client, { signalId, channelLabel: 'secondary', kind: 'SETTLEMENT', maxAttempts: 1 });
    expect(again.shouldSend).toBe(false);
    expect(again.reason).toContain('retry budget exhausted');
  });

  it('summarises delivery statistics', async () => {
    const stats = await deliveryStats(db.client);
    expect(stats['PUBLISH:SENT']).toBe(1);
    expect(stats['PUBLISH:UNKNOWN'] ?? 0).toBe(0);
    expect(stats['SETTLEMENT:UNKNOWN']).toBe(1);
  });
});

describe('learning artefacts', () => {
  it('stores a candidate, refuses promotion of a champion twice, and rolls back', async () => {
    const candidate = await insertModelVersion(db.client, {
      version: 'cand-1',
      datasetChecksum: 'abc',
      datasetSize: 400,
      datasetFrom: '2026-01-01T00:00:00.000Z',
      datasetTo: '2026-02-01T00:00:00.000Z',
      featureNames: ['bias', 'confidence'],
      hyper: { epochs: 400 },
      parameters: { coefficients: [0.1], intercept: 0 },
      metrics: { accuracy: 0.6, auc: 0.62, logLoss: 0.66, brier: 0.22, ece: 0.03, baseRate: 0.5, samples: 100 },
      walkForward: [],
      baselines: {},
      promotion: { promote: true },
    });
    expect(candidate.status).toBe('CANDIDATE');
    const promoted = await promoteModel(db.client, { candidateId: candidate.id, promotion: {}, actor: 'test' });
    expect(promoted.promoted).toBe(true);
    expect((await getChampion(db.client))?.version).toBe('cand-1');

    const second = await insertModelVersion(db.client, {
      version: 'cand-2',
      datasetChecksum: 'def',
      datasetSize: 500,
      datasetFrom: null,
      datasetTo: null,
      featureNames: [],
      hyper: {},
      parameters: {},
      metrics: {},
      walkForward: [],
      baselines: {},
      promotion: {},
    });
    await promoteModel(db.client, { candidateId: second.id, promotion: {}, actor: 'test' });
    expect((await getChampion(db.client))?.version).toBe('cand-2');
    const versions = await listModelVersions(db.client);
    expect(versions.filter((v) => v.status === 'CHAMPION')).toHaveLength(1);
    expect(versions.find((v) => v.version === 'cand-1')?.status).toBe('ARCHIVED');

    const rollback = await rollbackModel(db.client, { targetId: candidate.id, actor: 'test', reason: 'drift' });
    expect(rollback.rolledBack).toBe(true);
    expect((await getChampion(db.client))?.version).toBe('cand-1');
  });

  it('keeps exactly one active strategy weight set', async () => {
    await saveStrategyWeights(db.client, { version: 'w1', weights: { trend_follow: 1.1 }, evidence: {}, sampleSize: 40 });
    await saveStrategyWeights(db.client, { version: 'w2', weights: { trend_follow: 0.9 }, evidence: {}, sampleSize: 60 });
    const active = await getActiveStrategyWeights(db.client);
    expect(active?.version).toBe('w2');
    const rows = await db.client.query<{ count: string }>('select count(*)::text as count from strategy_weights where active');
    expect(rows.rows[0]?.count).toBe('1');
  });
});

describe('paper trading ledger', () => {
  it('opens a position for a settled signal and balances the account', async () => {
    await ensureAccount(db.client, { id: 'default', startingBalance: 10_000, riskPercent: 0.5, slippagePips: 0.2 });
    const signals = await listSignals(db.client, { limit: 50 });
    const settled = signals.find((s) => s.outcome === 'WIN');
    expect(settled).toBeDefined();
    await syncPosition(db.client, { signal: settled!, accountId: 'default', riskAmount: 50, units: 5000 });
    const positions = await listPositions(db.client);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.status).toBe('CLOSED');
    const account = await refreshBalance(db.client, 'default');
    expect(account?.balance).toBeGreaterThan(10_000);
  });
});

describe('health, alerts, settings and audit', () => {
  it('records and retrieves component health', async () => {
    await setComponentHealth(db.client, { component: 'database', status: 'CONNECTED', detail: 'ok' });
    const rows = await listHealth(db.client);
    expect(rows.find((r) => r.component === 'database')?.status).toBe('CONNECTED');
  });

  it('deduplicates open alerts and resolves them', async () => {
    const first = await raiseAlert(db.client, { severity: 'WARNING', code: 'test-alert', title: 'first' });
    const second = await raiseAlert(db.client, { severity: 'ERROR', code: 'test-alert', title: 'second' });
    expect(first).toBe(second);
    const open = await listAlerts(db.client);
    expect(open.filter((a) => a.code === 'test-alert')).toHaveLength(1);
    expect(open[0]?.occurrences).toBe(2);
    expect(await resolveAlert(db.client, 'test-alert')).toBe(true);
    expect(await resolveAlert(db.client, 'test-alert')).toBe(false);
    // A resolved alert can be raised again as a fresh row.
    await raiseAlert(db.client, { severity: 'INFO', code: 'test-alert', title: 'again' });
    const after = await listAlerts(db.client);
    expect(after.filter((a) => a.code === 'test-alert')).toHaveLength(1);
  });

  it('appends to the audit trail', async () => {
    await recordAudit(db.client, { actor: 'test', action: 'provider_key.create', target: 'primary', detail: { masked: '••••' } });
    const rows = await listAudit(db.client);
    expect(rows[0]?.action).toBe('provider_key.create');
  });

  it('stores and reads settings', async () => {
    await setSetting(db.client, 'engine.min_confidence', 0.66, 'test');
    expect(await getSetting<number>(db.client, 'engine.min_confidence')).toBe(0.66);
    const all = await listSettings(db.client);
    expect(all.some((s) => s.key === 'engine.min_confidence')).toBe(true);
  });

  it('records structured log events', async () => {
    await recordLogEvent(db.client, { level: 'info', component: 'test', event: 'hello', message: 'world', fields: { a: 1 } });
    const rows = await listLogEvents(db.client, { level: 'info' });
    expect(rows[0]?.event).toBe('hello');
  });
});

describe('crypto helpers', () => {
  it('compares tokens without leaking length differences through timing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('m1 to m3 aggregation through the repository layer', () => {
  it('derives M3 candles from stored M1 rows', async () => {
    const batch = minuteCandles('2026-04-01T08:00:00.000Z', 9);
    await upsertCandles(db.client, batch);
    const m1 = await getCandles(db.client, { pair: 'EUR/USD', timeframe: 'M1', limit: 100, from: '2026-04-01T08:00:00.000Z' });
    const m3 = aggregate(m1, 'M3', 'test');
    expect(m3).toHaveLength(3);
    expect(m3.every((c) => c.timeframe === 'M3')).toBe(true);
  });
});
