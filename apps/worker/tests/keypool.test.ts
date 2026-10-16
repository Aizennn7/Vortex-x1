/**
 * KeyPool behaviour.
 *
 * The pool is the only component that holds plaintext provider keys, so these
 * tests assert both the happy path and the honesty/failure rules: quota is
 * reserved before the call, a 429 rotates and refunds, a 401 disables, and
 * an empty pool degrades instead of looping.
 */

import { describe, expect, it } from 'vitest';
import { currentUsage, listKeys, listRequestLog, updateKey } from '@vortex/db';
import { ProviderError } from '@vortex/provider';
import { createHarness, seedKey } from './helpers.js';

const ok = { candles: [] };

describe('key pool — loading and selection', () => {
  it('decrypts enabled keys and never hands out ciphertext', async () => {
    const h = await createHarness();
    try {
      await seedKey(h.client, { label: 'primary' });
      const keys = await h.runtime.keyPool.loadKeys(true);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.label).toBe('primary');
      expect(keys[0]?.maskedKey.startsWith('••')).toBe(true);
      expect(JSON.stringify(keys)).not.toContain('demo-provider-key');
    } finally {
      await h.close();
    }
  });

  it('skips a key whose ciphertext cannot be decrypted', async () => {
    const h = await createHarness();
    try {
      const good = await seedKey(h.client, { label: 'good' });
      const bad = await seedKey(h.client, { label: 'tampered' });
      await h.client.query('update provider_keys set ciphertext = $2 where id = $1', [
        bad.id,
        'v1:00000000000000000000000000000000:00000000000000000000000000000000:00',
      ]);
      const keys = await h.runtime.keyPool.loadKeys(true);
      expect(keys.map((k) => k.id)).toEqual([good.id]);
      // The undecryptable key still exists — we report, we do not delete.
      const stored = await listKeys(h.client);
      expect(stored).toHaveLength(2);
    } finally {
      await h.close();
    }
  });

  it('reports exhausted (not an exception) when no key is usable', async () => {
    const h = await createHarness();
    try {
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);
      expect(result.ok).toBe(false);
      expect(result.exhausted).toBe(true);
      expect(result.reason).toBe('no_keys_enabled');
      expect(result.error).toContain('No provider API keys are enabled');
    } finally {
      await h.close();
    }
  });

  it('reports exhausted when every key is disabled', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client);
      await updateKey(h.client, key.id, { enabled: false });
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);
      expect(result.exhausted).toBe(true);
      expect(result.ok).toBe(false);
    } finally {
      await h.close();
    }
  });
});

describe('key pool — successful calls', () => {
  it('reserves quota, records the request and marks the key healthy', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client, { minuteLimit: 4, dayLimit: 40 });
      const seen: string[] = [];
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series', pair: 'EUR/USD' }, async (plaintext, keyId) => {
        seen.push(plaintext);
        expect(keyId).toBe(key.id);
        return { value: 42 };
      });
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ value: 42 });
      expect(result.keyId).toBe(key.id);
      expect(seen).toEqual(['demo-provider-key-abcdef123456']);
      expect(h.runtime.counters.providerRequests).toBe(1);

      const usage = await currentUsage(h.client, [key.id], new Date());
      expect(usage.get(key.id)?.minuteUsed).toBe(1);
      const log = await listRequestLog(h.client, 10);
      expect(log[0]).toMatchObject({ keyId: key.id, endpoint: 'time_series', pair: 'EUR/USD', ok: true, attempt: 1 });
      const stored = (await listKeys(h.client))[0];
      expect(stored?.status).toBe('ACTIVE');
      expect(stored?.consecutiveFailures).toBe(0);
      expect(stored?.lastUsedAt).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it('charges multi-credit calls against the same bucket', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client, { minuteLimit: 10, dayLimit: 100 });
      await h.runtime.keyPool.call({ endpoint: 'time_series', credits: 3 }, async () => ok);
      const usage = await currentUsage(h.client, [key.id], new Date());
      expect(usage.get(key.id)?.minuteUsed).toBe(3);
    } finally {
      await h.close();
    }
  });

  it('serves concurrent callers without overspending the per-minute budget', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client, { minuteLimit: 3, dayLimit: 100, headroomPercent: 0 });
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          h.runtime.keyPool.call({ endpoint: 'time_series', pair: `P${i}` }, async () => ({ i })),
        ),
      );
      const granted = results.filter((r) => r.ok);
      const degraded = results.filter((r) => !r.ok);
      expect(granted).toHaveLength(3);
      expect(degraded.length).toBe(5);
      for (const d of degraded) expect(d.exhausted).toBe(true);
      const usage = await currentUsage(h.client, [key.id], new Date());
      expect(usage.get(key.id)?.minuteUsed).toBe(3);
    } finally {
      await h.close();
    }
  });

  it('marks the key EXHAUSTED once the daily budget is consumed', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client, { minuteLimit: 50, dayLimit: 2, headroomPercent: 0 });
      await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);
      await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);
      const third = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);
      expect(third.ok).toBe(false);
      expect(third.exhausted).toBe(true);
      const stored = (await listKeys(h.client))[0];
      expect(stored?.status).toBe('EXHAUSTED');
      expect(key.id).toBe(stored?.id);
    } finally {
      await h.close();
    }
  });
});

describe('key pool — failure classification and rotation', () => {
  it('rotates to a second key on 429, cools the first down and refunds the credit', async () => {
    const h = await createHarness();
    try {
      const seeded = [await seedKey(h.client, { label: 'first' }), await seedKey(h.client, { label: 'second' })];
      // Which key the pool prefers is deterministic but not insertion order, so
      // ask the pool and make the key it chose the one that fails.
      const firstId = (await h.runtime.keyPool.selection()).selection.keyId as string;
      const secondId = seeded.find((k) => k.id !== firstId)!.id;
      const tried: string[] = [];
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async (_plain, keyId) => {
        tried.push(keyId);
        if (keyId === firstId) throw new ProviderError({ status: 429, message: 'rate limited' });
        return 'second-key-value';
      });
      expect(result.ok).toBe(true);
      expect(result.keyId).toBe(secondId);
      expect(tried).toEqual([firstId, secondId]);

      const keys = await listKeys(h.client);
      const cooled = keys.find((k) => k.id === firstId);
      expect(cooled?.status).toBe('COOLDOWN');
      expect(cooled?.consecutiveFailures).toBe(1);
      expect(cooled?.cooldownUntil).not.toBeNull();

      // The rejected request was refunded, so only the successful call counts.
      const usage = await currentUsage(h.client, [firstId], new Date());
      expect(usage.get(firstId)?.minuteUsed).toBe(0);
      const log = await listRequestLog(h.client, 10);
      expect(log.filter((l) => !l.ok)).toHaveLength(1);
      expect(log.find((l) => !l.ok)?.httpStatus).toBe(429);
    } finally {
      await h.close();
    }
  });

  it('disables a key on 401 instead of retrying it', async () => {
    const h = await createHarness();
    try {
      const seeded = [await seedKey(h.client, { label: 'first' }), await seedKey(h.client, { label: 'second' })];
      const firstId = (await h.runtime.keyPool.selection()).selection.keyId as string;
      const secondId = seeded.find((k) => k.id !== firstId)!.id;
      const tried: string[] = [];
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async (_plain, keyId) => {
        tried.push(keyId);
        if (keyId === firstId) throw new ProviderError({ status: 401, message: 'invalid api key' });
        return 'ok';
      });
      expect(result.ok).toBe(true);
      expect(tried).toEqual([firstId, secondId]);
      const keys = await listKeys(h.client);
      expect(keys.find((k) => k.id === firstId)?.status).toBe('INVALID');
      expect(keys.find((k) => k.id === secondId)?.status).toBe('ACTIVE');
    } finally {
      await h.close();
    }
  });

  it('returns the provider error for a non-rotating 4xx and keeps the reservation', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client);
      const result = await h.runtime.keyPool.call({ endpoint: 'quote', pair: 'XXX/YYY' }, async () => {
        throw new ProviderError({ status: 400, message: 'symbol not found' });
      });
      expect(result.ok).toBe(false);
      expect(result.exhausted).toBe(false);
      expect(result.httpStatus).toBe(400);
      expect(result.error).toBeTruthy();
      // The provider answered, so the credit may have been consumed: we keep it.
      const usage = await currentUsage(h.client, [key.id], new Date());
      expect(usage.get(key.id)?.minuteUsed).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('never loops forever: attempts are capped by the configured maximum', async () => {
    const h = await createHarness();
    try {
      await seedKey(h.client, { label: 'a' });
      await seedKey(h.client, { label: 'b' });
      await seedKey(h.client, { label: 'c' });
      let attempts = 0;
      const result = await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => {
        attempts += 1;
        throw new ProviderError({ status: 503, message: 'upstream unavailable' });
      });
      expect(result.ok).toBe(false);
      expect(attempts).toBeLessThanOrEqual(h.runtime.config.providerMaxAttempts);
      expect(result.httpStatus).toBe(503);
    } finally {
      await h.close();
    }
  });
});

describe('key pool — reporting', () => {
  it('summarises usage without exposing secrets', async () => {
    const h = await createHarness();
    try {
      await seedKey(h.client, { label: 'one', minuteLimit: 6, dayLimit: 60 });
      await seedKey(h.client, { label: 'two', minuteLimit: 6, dayLimit: 60 });
      await h.runtime.keyPool.call({ endpoint: 'time_series' }, async () => ok);

      const { snapshots, summary } = await h.runtime.keyPool.usageSnapshots();
      expect(snapshots).toHaveLength(2);
      expect(summary.enabledKeys).toBe(2);
      expect(JSON.stringify({ snapshots, summary })).not.toContain('demo-provider-key');
      expect(snapshots.map((s) => s.label).sort()).toEqual(['one', 'two']);
      expect(snapshots.reduce((sum, s) => sum + s.minuteUsed, 0)).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('plans capacity against the configured cadence', async () => {
    const h = await createHarness();
    try {
      await seedKey(h.client, { label: 'one', minuteLimit: 8, dayLimit: 800 });
      const plan = await h.runtime.keyPool.capacityPlan(2);
      const expectedPerKey = Math.floor(8 * (1 - h.runtime.config.providerHeadroomPercent / 100));
      expect(plan.requestsPerMinute).toBe(expectedPerKey);
      expect(plan.refreshIntervalMinutes).toBeCloseTo(2 / expectedPerKey, 2);
      expect(plan.feasible).toBe(true);
      expect(plan.detail).toContain('5-minute signal cadence');
    } finally {
      await h.close();
    }
  });

  it('says plainly that no keys means no market data', async () => {
    const h = await createHarness();
    try {
      const plan = await h.runtime.keyPool.capacityPlan(2);
      expect(plan.usablePerMinute).toBe(0);
      expect(plan.refreshIntervalMinutes).toBeNull();
      expect(plan.feasible).toBe(false);
      expect(plan.detail).toContain('No usable provider keys');
    } finally {
      await h.close();
    }
  });

  it('exposes ciphertext only through the explicit verification helper', async () => {
    const h = await createHarness();
    try {
      const key = await seedKey(h.client);
      const ciphertext = await h.runtime.keyPool.encryptedFor(key.id);
      expect(ciphertext).toMatch(/^v1:/);
      expect(await h.runtime.keyPool.encryptedFor('00000000-0000-0000-0000-000000000000')).toBeNull();
    } finally {
      await h.close();
    }
  });
});
