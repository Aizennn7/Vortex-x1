import { describe, expect, it } from 'vitest';
import {
  budgetSummary,
  classifyProviderError,
  cooldownSeconds,
  effectiveLimit,
  maskKey,
  nextCooldown,
  planIngestion,
  selectKey,
  type KeyState,
  type PoolLimits,
} from '../src/keys.js';

const LIMITS: PoolLimits = { rpmPerKey: 8, rpdPerKey: 800, headroomPercent: 0 };

function key(overrides: Partial<KeyState> = {}): KeyState {
  return {
    id: 'k1',
    label: 'key-1',
    enabled: true,
    status: 'ACTIVE',
    minuteUsed: 0,
    dayUsed: 0,
    minuteLimit: 8,
    dayLimit: 800,
    cooldownUntil: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

const NOW = '2026-01-05T10:00:00.000Z';

describe('quota selection', () => {
  it('selects the healthiest key with the most headroom', () => {
    const result = selectKey(
      [
        key({ id: 'a', label: 'a', minuteUsed: 7, consecutiveFailures: 0 }),
        key({ id: 'b', label: 'b', minuteUsed: 0, consecutiveFailures: 0 }),
        key({ id: 'c', label: 'c', minuteUsed: 0, consecutiveFailures: 2 }),
      ],
      { now: NOW, cost: 1, usage: {}, limits: LIMITS },
    );
    expect(result.keyId).toBe('b');
    expect(result.reason).toBe('selected');
  });

  it('skips keys that are cooling down after throttling', () => {
    const result = selectKey(
      [
        key({ id: 'a', cooldownUntil: '2026-01-05T10:05:00.000Z' }),
        key({ id: 'b', cooldownUntil: '2026-01-05T09:59:00.000Z' }),
      ],
      { now: NOW, cost: 1, usage: {}, limits: LIMITS },
    );
    expect(result.keyId).toBe('b');
  });

  it('reports exhaustion instead of hammering the provider', () => {
    const result = selectKey([key({ id: 'a', minuteUsed: 8 })], { now: NOW, cost: 1, usage: {}, limits: LIMITS });
    expect(result.keyId).toBeNull();
    expect(result.reason).toBe('exhausted');
    expect(result.detail).toContain('quota');
  });

  it('never uses a key flagged INVALID', () => {
    const result = selectKey([key({ id: 'a', status: 'INVALID' })], { now: NOW, cost: 1, usage: {}, limits: LIMITS });
    expect(result.keyId).toBeNull();
    expect(result.reason).toBe('all_invalid');
  });

  it('ignores disabled keys', () => {
    const result = selectKey([key({ id: 'a', enabled: false })], { now: NOW, cost: 1, usage: {}, limits: LIMITS });
    expect(result.keyId).toBeNull();
    expect(result.reason).toBe('no_keys_enabled');
  });

  it('applies the reserved headroom so interactive traffic keeps working', () => {
    expect(effectiveLimit(8, 15)).toBe(6);
    expect(effectiveLimit(800, 15)).toBe(680);
    const result = selectKey([key({ id: 'a', minuteUsed: 6 })], {
      now: NOW,
      cost: 1,
      usage: {},
      limits: { ...LIMITS, headroomPercent: 15 },
    });
    expect(result.keyId).toBeNull();
  });

  it('respects a shared account budget across keys on the same account', () => {
    const result = selectKey(
      [
        key({ id: 'a', accountId: 'acct-1' }),
        key({ id: 'b', accountId: 'acct-1' }),
        key({ id: 'c', accountId: 'acct-2' }),
      ],
      {
        now: NOW,
        cost: 1,
        usage: {
          a: { minuteUsed: 4, dayUsed: 10, minuteBucket: '', dayBucket: '' },
          b: { minuteUsed: 4, dayUsed: 10, minuteBucket: '', dayBucket: '' },
        },
        limits: { ...LIMITS, accountRpm: 9, accountRpd: 800 },
      },
    );
    expect(result.keyId).toBe('c');
  });

  it('is deterministic — the same state always picks the same key', () => {
    const keys = [key({ id: 'a' }), key({ id: 'b' })];
    const first = selectKey(keys, { now: NOW, cost: 1, usage: {}, limits: LIMITS });
    const second = selectKey(keys, { now: NOW, cost: 1, usage: {}, limits: LIMITS });
    expect(first.keyId).toBe(second.keyId);
  });

  it('reports the remaining pool budget for the operator', () => {
    const result = selectKey([key({ id: 'a', minuteUsed: 2, dayUsed: 100 })], {
      now: NOW,
      cost: 1,
      usage: {},
      limits: LIMITS,
    });
    expect(result.remainingMinute).toBe(6);
    expect(result.remainingDay).toBe(700);
  });
});

describe('failure classification', () => {
  it('cools a key down on HTTP 429', () => {
    const result = classifyProviderError(429, 'You have run out of API credits for the current minute');
    expect(result.status).toBe('COOLDOWN');
    expect(result.rotate).toBe(true);
    expect(result.retry).toBe(false);
  });

  it('marks a key invalid on auth failures and never retries it', () => {
    for (const status of [401, 403]) {
      const result = classifyProviderError(status, 'invalid API key');
      expect(result.status).toBe('INVALID');
      expect(result.rotate).toBe(true);
    }
  });

  it('retries transient server errors on the same key', () => {
    const result = classifyProviderError(503, 'upstream unavailable');
    expect(result.retry).toBe(true);
    expect(result.status).toBeNull();
  });

  it('does not rotate for a bad symbol', () => {
    const result = classifyProviderError(404, 'symbol not found');
    expect(result.rotate).toBe(false);
    expect(result.status).toBeNull();
  });

  it('backs off exponentially and caps the cooldown', () => {
    expect(cooldownSeconds(1)).toBe(20);
    expect(cooldownSeconds(2)).toBe(40);
    expect(cooldownSeconds(3)).toBe(80);
    expect(cooldownSeconds(20)).toBe(900);
    expect(new Date(nextCooldown(NOW, 1)).toISOString()).toBe('2026-01-05T10:00:20.000Z');
  });
});

describe('budget reporting', () => {
  it('summarises capacity and warns when it is thin', () => {
    const summary = budgetSummary([key({ id: 'a', dayUsed: 790, minuteLimit: 8, dayLimit: 800 })], LIMITS);
    expect(summary.enabledKeys).toBe(1);
    expect(summary.dayCapacity).toBe(800);
    expect(summary.dayRemainingPercent).toBeLessThan(10);
    expect(summary.warnings.join(' ')).toContain('nearly spent');
  });

  it('flags the fully-exhausted case as exhausted', () => {
    const summary = budgetSummary([key({ id: 'a', status: 'INVALID' })], LIMITS);
    expect(summary.exhausted).toBe(true);
    expect(summary.warnings.join(' ')).toContain('unavailable');
  });

  it('warns when no keys exist at all', () => {
    const summary = budgetSummary([], LIMITS);
    expect(summary.warnings[0]).toContain('No provider keys');
  });
});

describe('ingestion planning', () => {
  it('never plans more requests than the budget allows', () => {
    const plan = planIngestion({
      pairs: ['A', 'B', 'C', 'D', 'E'],
      remainingMinute: 2,
      outputsize: 10,
    });
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.outputsize === 10)).toBe(true);
  });

  it('prioritises pairs by the supplied ordering', () => {
    const plan = planIngestion({
      pairs: ['EUR/USD', 'GBP/USD', 'USD/JPY'],
      remainingMinute: 2,
      outputsize: 5,
      prioritize: (pair) => (pair === 'USD/JPY' ? 0 : 10),
    });
    expect(plan[0]?.pair).toBe('USD/JPY');
  });

  it('returns nothing when there is no budget', () => {
    expect(planIngestion({ pairs: ['A', 'B'], remainingMinute: 0, outputsize: 5 })).toHaveLength(0);
  });
});

describe('key masking', () => {
  it('never reveals more than the last four characters', () => {
    const masked = maskKey('abcdef0123456789abcdef0123456789');
    expect(masked.endsWith('6789')).toBe(true);
    expect(masked).not.toContain('abcdef');
    expect(maskKey('ab')).toBe('••••');
  });
});
