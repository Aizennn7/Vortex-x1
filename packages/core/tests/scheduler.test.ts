import { describe, expect, it } from 'vitest';
import {
  isSettleable,
  onCadenceBoundary,
  planNextSlot,
  publishability,
  settlementDelaySeconds,
  signalIdempotencyKey,
  slotKeyFor,
} from '../src/scheduler.js';

const OPTIONS = {
  cadenceMinutes: 5,
  publishLeadSeconds: 60,
  horizonSeconds: 60,
  minLeadSeconds: 30,
  respectMarketHours: true,
} as const;

describe('slot planning', () => {
  it('publishes exactly one minute before an exact 5-minute boundary', () => {
    // Monday 2026-01-05, 10:01:00 UTC → next cadence boundary is 10:05:00.
    const plan = planNextSlot('2026-01-05T10:01:00.000Z', OPTIONS);
    expect(plan).not.toBeNull();
    expect(plan?.entryTime).toBe('2026-01-05T10:05:00.000Z');
    expect(plan?.publishAt).toBe('2026-01-05T10:04:00.000Z');
    expect(plan?.horizonEnd).toBe('2026-01-05T10:06:00.000Z');
    expect(plan?.leadSecondsAvailable).toBe(180);
  });

  it('always returns entry instants on the cadence grid', () => {
    for (const minutes of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const now = `2026-01-05T10:0${minutes}:37.000Z`;
      const plan = planNextSlot(now, OPTIONS);
      expect(plan).not.toBeNull();
      expect(onCadenceBoundary(plan!.entryTime, 5)).toBe(true);
      expect(new Date(plan!.entryTime).getUTCSeconds()).toBe(0);
    }
  });

  it('skips a slot when the remaining lead is too short', () => {
    // 10:04:45 → the 10:05:00 entry is only 15s away, below the 30s minimum,
    // so the plan must move to the 10:10:00 boundary.
    const plan = planNextSlot('2026-01-05T10:04:45.000Z', OPTIONS);
    expect(plan?.entryTime).toBe('2026-01-05T10:10:00.000Z');
  });

  it('never plans an entry inside the FX weekend', () => {
    // Friday 20:58 UTC: the market closes at 21:00, so the next usable entry is
    // Sunday 21:00 UTC.
    const plan = planNextSlot('2026-01-09T20:58:00.000Z', OPTIONS);
    expect(plan).not.toBeNull();
    expect(new Date(plan!.entryTime).getUTCDay()).toBe(0);
    expect(plan!.entryTime).toBe('2026-01-11T21:00:00.000Z');
  });

  it('skips the next slot when its publish instant has already passed', () => {
    // Monday 10:04:45, lookahead of exactly one slot: 10:05:00 cannot be
    // published (its publish instant was 10:04:00), so nothing is planned.
    const plan = planNextSlot('2026-01-05T10:04:45.000Z', { ...OPTIONS, maxLookaheadSlots: 1 });
    expect(plan).toBeNull();
  });

  it('still finds the next session even across a weekend', () => {
    const plan = planNextSlot('2026-01-10T12:00:00.000Z', { ...OPTIONS, maxLookaheadSlots: 2 });
    expect(plan?.entryTime).toBe('2026-01-11T21:00:00.000Z');
  });
});

describe('publishability', () => {
  const plan = {
    publishAt: '2026-01-05T10:04:00.000Z',
    entryTime: '2026-01-05T10:05:00.000Z',
  };

  it('allows publication inside the lead window', () => {
    const result = publishability('2026-01-05T10:04:00.000Z', plan, 10);
    expect(result.ok).toBe(true);
    expect(result.secondsToEntry).toBe(60);
  });

  it('refuses when the lead has become too short (late restart)', () => {
    const result = publishability('2026-01-05T10:04:52.000Z', plan, 15);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('insufficient_lead');
  });

  it('refuses after the entry instant has passed', () => {
    const result = publishability('2026-01-05T10:05:01.000Z', plan, 15);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('entry_time_passed');
  });
});

describe('identifiers and settlement timing', () => {
  it('builds a stable idempotency key for the same opportunity', () => {
    const a = signalIdempotencyKey({ pair: 'EUR/USD', entryTime: '2026-01-05T10:05:00.000Z', direction: 'BUY', engineVersion: 'v1' });
    const b = signalIdempotencyKey({ pair: 'EUR/USD', entryTime: '2026-01-05T10:05:00.000Z', direction: 'BUY', engineVersion: 'v1' });
    const c = signalIdempotencyKey({ pair: 'EUR/USD', entryTime: '2026-01-05T10:10:00.000Z', direction: 'BUY', engineVersion: 'v1' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('derives a stable slot key from the entry instant', () => {
    expect(slotKeyFor('2026-01-05T10:05:00.000Z', 5)).toBe(slotKeyFor('2026-01-05T10:05:00.000Z', 5));
    expect(slotKeyFor('2026-01-05T10:05:00.000Z', 5)).not.toBe(slotKeyFor('2026-01-05T10:10:00.000Z', 5));
  });

  it('waits for the provider lag before attempting settlement', () => {
    expect(settlementDelaySeconds('M1', 8)).toBe(68);
    const horizonEnd = '2026-01-05T10:06:00.000Z';
    expect(isSettleable('2026-01-05T10:06:05.000Z', { horizonEnd }, 8)).toBe(false);
    expect(isSettleable('2026-01-05T10:06:09.000Z', { horizonEnd }, 8)).toBe(true);
  });
});
