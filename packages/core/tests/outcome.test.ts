import { describe, expect, it } from 'vitest';
import { EXCLUDED_LABELS, OUTCOME_RULE_VERSION, isLabelEligible, settleSignal, type SettlementInput } from '../src/outcome.js';
import type { Candle } from '../src/types.js';

const ENTRY = '2026-01-05T10:05:00.000Z';

function m1(openTime: string, prices: { open: number; high: number; low: number; close: number }): Candle {
  return {
    pair: 'EUR/USD',
    timeframe: 'M1',
    openTime,
    closeTime: new Date(new Date(openTime).getTime() + 60_000).toISOString(),
    open: prices.open,
    high: prices.high,
    low: prices.low,
    close: prices.close,
    provider: 'test',
    isFinal: true,
  };
}

function base(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    pair: 'EUR/USD',
    direction: 'BUY',
    scheduledEntryAt: ENTRY,
    horizonSeconds: 60,
    stopPips: 10,
    targetPips: 14,
    spreadPips: 0.8,
    slippagePips: 0.2,
    candles: [],
    now: '2026-01-05T10:07:00.000Z',
    ...overrides,
  };
}

describe('settlement rules (net_after_costs_v1)', () => {
  it('uses the entry candle open and the horizon candle close', () => {
    const result = settleSignal(
      base({
        candles: [
          m1(ENTRY, { open: 1.1, high: 1.1005, low: 1.0998, close: 1.1002 }),
        ],
      }),
    );
    expect(result.rule).toBe(OUTCOME_RULE_VERSION);
    expect(result.entryPrice).toBe(1.1);
    expect(result.exitPrice).toBe(1.1002);
    // 2 pips gross − 1.0 pip of costs = 1.0 pip net → WIN
    expect(result.grossPips).toBeCloseTo(2, 5);
    expect(result.costPips).toBeCloseTo(1, 5);
    expect(result.realizedPips).toBeCloseTo(1, 5);
    expect(result.outcome).toBe('WIN');
  });

  it('charges spread and slippage, so a small favourable move can still lose', () => {
    const result = settleSignal(
      base({ candles: [m1(ENTRY, { open: 1.1, high: 1.1001, low: 1.0999, close: 1.10002 })] }),
    );
    expect(result.grossPips).toBeCloseTo(0.2, 5);
    expect(result.realizedPips).toBeCloseTo(-0.8, 5);
    expect(result.outcome).toBe('LOSS');
  });

  it('marks a DRAW only inside the tie band', () => {
    const result = settleSignal(
      base({
        spreadPips: 0.5,
        slippagePips: 0.1,
        candles: [m1(ENTRY, { open: 1.1, high: 1.1001, low: 1.0999, close: 1.10006 })],
      }),
    );
    expect(result.outcome).toBe('DRAW');
    expect(result.flags).toContain('draw');
    if (false) expect(result.flags).toContain('draw');
  });

  it('handles SELL direction symmetrically', () => {
    const result = settleSignal(
      base({
        direction: 'SELL',
        candles: [m1(ENTRY, { open: 1.1, high: 1.1002, low: 1.099, close: 1.0995 })],
      }),
    );
    expect(result.grossPips).toBeCloseTo(5, 5);
    expect(result.realizedPips).toBeCloseTo(4, 5);
    expect(result.outcome).toBe('WIN');
  });

  it('applies the protective stop on a worst-case-first basis', () => {
    const result = settleSignal(
      base({
        candles: [
          m1(ENTRY, { open: 1.1, high: 1.1002, low: 1.0985, close: 1.0999 }),
        ],
      }),
    );
    // MAE ~ -15 pips breaches the 10-pip stop even though the close is near flat.
    expect(result.outcome).toBe('LOSS');
    expect(result.flags).toContain('stop_hit');
    expect(result.maePips).toBeLessThan(-10);
  });

  it('recognises the objective being reached inside the horizon', () => {
    const result = settleSignal(
      base({
        candles: [m1(ENTRY, { open: 1.1, high: 1.1025, low: 1.0999, close: 1.1015 })],
      }),
    );
    expect(result.outcome).toBe('WIN');
    expect(result.flags).toContain('target_hit');
    expect(result.mfePips).toBeGreaterThanOrEqual(14);
  });

  it('never settles before the horizon has elapsed', () => {
    const result = settleSignal(
      base({ now: '2026-01-05T10:05:30.000Z', candles: [m1(ENTRY, { open: 1.1, high: 1.1, low: 1.1, close: 1.1 })] }),
    );
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.flags).toContain('too_early');
  });

  it('records UNRESOLVED when the entry candle is missing', () => {
    const result = settleSignal(base({ candles: [] }));
    expect(result.outcome).toBe('UNRESOLVED');
    expect(result.flags).toContain('missing_entry_candle');
    expect(result.realizedPips).toBeNull();
  });

  it('flags a late entry price instead of silently accepting it', () => {
    const result = settleSignal(
      base({
        candles: [
          m1('2026-01-05T10:05:20.000Z', { open: 1.1, high: 1.1005, low: 1.0999, close: 1.1002 }),
          m1('2026-01-05T10:06:00.000Z', { open: 1.1002, high: 1.1003, low: 1.1001, close: 1.1002 }),
        ],
      }),
    );
    expect(result.flags).toContain('entry_price_late');
    expect(result.entryPrice).toBe(1.1);
    // The entry instant is unaligned, so this verdict must not train a model.
    expect(isLabelEligible(result.outcome, result.flags)).toBe(false);
  });

  it('is idempotent for identical inputs', () => {
    const input = base({ candles: [m1(ENTRY, { open: 1.1, high: 1.1005, low: 1.0998, close: 1.1002 })] });
    const first = settleSignal(input);
    const second = settleSignal(input);
    expect(second).toEqual(first);
  });
});

describe('label eligibility', () => {
  it('accepts only decisive, intact outcomes', () => {
    expect(isLabelEligible('WIN', [])).toBe(true);
    expect(isLabelEligible('LOSS', [])).toBe(true);
    expect(isLabelEligible('DRAW', [])).toBe(false);
    expect(isLabelEligible('UNRESOLVED', [])).toBe(false);
    expect(isLabelEligible(null, [])).toBe(false);
    expect(isLabelEligible('WIN', ['exit_price_early'])).toBe(false);
  });

  it('documents the excluded label classes', () => {
    expect(EXCLUDED_LABELS).toEqual(['DRAW', 'UNRESOLVED']);
  });
});
