import { describe, expect, it } from 'vitest';
import {
  aggregate,
  findGaps,
  freshness,
  mergeCandles,
  normalizeBatch,
  onlyFinal,
  validateCandle,
  type CandleInput,
} from '../src/marketdata.js';
import type { Candle } from '../src/types.js';

function candle(iso: string, close = 1.1, extra: Partial<CandleInput> = {}): CandleInput {
  return {
    pair: 'EUR/USD',
    timeframe: 'M1',
    openTime: iso,
    open: close - 0.0005,
    high: close + 0.0005,
    low: close - 0.0008,
    close,
    provider: 'test',
    isFinal: true,
    ...extra,
  };
}

describe('candle validation', () => {
  it('accepts a well-formed aligned candle', () => {
    const result = validateCandle(candle('2026-01-05T10:03:00.000Z'));
    expect(result.ok).toBe(true);
    expect(result.candle?.closeTime).toBe('2026-01-05T10:04:00.000Z');
  });

  it('rejects OHLC inconsistencies', () => {
    expect(validateCandle(candle('2026-01-05T10:03:00.000Z', 1.1, { high: 1.0 })).ok).toBe(false);
    expect(validateCandle(candle('2026-01-05T10:03:00.000Z', 1.1, { low: 1.2 })).ok).toBe(false);
    expect(validateCandle(candle('2026-01-05T10:03:00.000Z', 1.1, { low: 1.05, high: 1.09, close: 1.1 })).ok).toBe(false);
  });

  it('rejects non-finite and unaligned values', () => {
    expect(validateCandle(candle('2026-01-05T10:03:00.000Z', Number.NaN)).ok).toBe(false);
    expect(validateCandle(candle('2026-01-05T10:03:00.000Z', 0)).ok).toBe(false);
    expect(validateCandle(candle('2026-01-05T10:03:30.000Z')).reason).toContain('boundary');
  });
});

describe('batch normalisation', () => {
  it('deduplicates within a batch keeping the newest revision', () => {
    const { candles, quality } = normalizeBatch(
      [
        candle('2026-01-05T10:03:00.000Z', 1.1, { revision: 1 }),
        candle('2026-01-05T10:03:00.000Z', 1.2, { revision: 2 }),
        candle('2026-01-05T10:04:00.000Z'),
      ],
      { pair: 'EUR/USD', timeframe: 'M1' },
    );
    expect(candles).toHaveLength(2);
    expect(quality.duplicates).toHaveLength(1);
    expect(candles[0]?.close).toBe(1.2);
  });

  it('reports gaps without inventing candles', () => {
    const { candles, quality } = normalizeBatch(
      [candle('2026-01-05T10:03:00.000Z'), candle('2026-01-05T10:06:00.000Z')],
      { pair: 'EUR/USD', timeframe: 'M1' },
    );
    expect(candles).toHaveLength(2);
    expect(quality.gaps).toEqual(['2026-01-05T10:04:00.000Z', '2026-01-05T10:05:00.000Z']);
  });

  it('separates invalid candles', () => {
    const { candles, quality } = normalizeBatch(
      [candle('2026-01-05T10:03:00.000Z'), candle('2026-01-05T10:04:00.000Z', Number.NaN)],
      { pair: 'EUR/USD', timeframe: 'M1' },
    );
    expect(candles).toHaveLength(1);
    expect(quality.invalid).toHaveLength(1);
    expect(quality.ok).toBe(false);
  });

  it('rejects candles from a different pair than the batch', () => {
    const { quality } = normalizeBatch([candle('2026-01-05T10:03:00.000Z', 1.1, { pair: 'GBP/USD' })], {
      pair: 'EUR/USD',
      timeframe: 'M1',
    });
    expect(quality.invalid).toHaveLength(1);
  });
});

describe('freshness', () => {
  const makeSeries = (count: number, lastOpen: string): Candle[] => {
    const last = new Date(lastOpen).getTime();
    return Array.from({ length: count }, (_, i) => {
      const open = new Date(last - (count - 1 - i) * 60_000).toISOString();
      return {
        pair: 'EUR/USD',
        timeframe: 'M1' as const,
        openTime: open,
        closeTime: new Date(new Date(open).getTime() + 60_000).toISOString(),
        open: 1.1,
        high: 1.1005,
        low: 1.0995,
        close: 1.1,
        provider: 'test',
        isFinal: true,
      };
    });
  };

  it('measures staleness from the candle close, not the open', () => {
    // Candle opened at 10:00 closes at 10:01; at 10:01:30 it is 30s old.
    const series = makeSeries(80, '2026-01-05T10:00:00.000Z');
    const report = freshness(series, '2026-01-05T10:01:30.000Z', 'M1', 90, 30);
    expect(report.ageSeconds).toBe(30);
    expect(report.isStale).toBe(false);
    expect(report.quality).toBe('OK');
  });

  it('flags stale and gap-ridden series', () => {
    const stale = freshness(makeSeries(80, '2026-01-05T10:00:00.000Z'), '2026-01-05T10:05:00.000Z', 'M1', 90, 30);
    expect(stale.isStale).toBe(true);
    expect(stale.quality).toBe('STALE');

    const gappy = makeSeries(80, '2026-01-05T10:00:00.000Z');
    gappy.splice(gappy.length - 3, 1);
    const report = freshness(gappy, '2026-01-05T10:01:30.000Z', 'M1', 90, 30);
    expect(report.isGappy).toBe(true);
    expect(report.quality).toBe('GAPPY');
  });

  it('reports INSUFFICIENT rather than pretending to be fresh', () => {
    const report = freshness(makeSeries(5, '2026-01-05T10:00:00.000Z'), '2026-01-05T10:01:00.000Z', 'M1', 90, 30);
    expect(report.quality).toBe('INSUFFICIENT');
  });
});

describe('onlyFinal / merge / aggregate', () => {
  it('drops the in-progress candle', () => {
    const series: Candle[] = [
      {
        pair: 'EUR/USD',
        timeframe: 'M1',
        openTime: '2026-01-05T10:03:00.000Z',
        closeTime: '2026-01-05T10:04:00.000Z',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        provider: 'p',
        isFinal: true,
      },
      {
        pair: 'EUR/USD',
        timeframe: 'M1',
        openTime: '2026-01-05T10:04:00.000Z',
        closeTime: '2026-01-05T10:05:00.000Z',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        provider: 'p',
        isFinal: false,
      },
    ];
    const kept = onlyFinal(series, '2026-01-05T10:04:30.000Z', 'M1');
    expect(kept).toHaveLength(1);
    expect(kept[0]?.openTime).toBe('2026-01-05T10:03:00.000Z');
  });

  it('merges without duplicating and prefers newer revisions', () => {
    const base: Candle = {
      pair: 'EUR/USD',
      timeframe: 'M1',
      openTime: '2026-01-05T10:03:00.000Z',
      closeTime: '2026-01-05T10:04:00.000Z',
      open: 1,
      high: 1.1,
      low: 0.9,
      close: 1.05,
      provider: 'p',
      isFinal: true,
      revision: 1,
    };
    const merged = mergeCandles([base], [{ ...base, close: 1.07, revision: 2 }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.close).toBe(1.07);
  });

  it('aggregates three consecutive M1 candles into one complete M3 candle', () => {
    const rows: Candle[] = [0, 1, 2].map((i) => ({
      pair: 'EUR/USD',
      timeframe: 'M1',
      openTime: new Date(Date.parse('2026-01-05T10:03:00.000Z') + i * 60_000).toISOString(),
      closeTime: new Date(Date.parse('2026-01-05T10:04:00.000Z') + i * 60_000).toISOString(),
      open: 1.1 + i * 0.001,
      high: 1.2 + i * 0.001,
      low: 1.0 + i * 0.001,
      close: 1.11 + i * 0.001,
      volume: 10,
      provider: 'p',
      isFinal: true,
    }));
    const m3 = aggregate(rows, 'M3', 'p');
    expect(m3).toHaveLength(1);
    expect(m3[0]?.openTime).toBe('2026-01-05T10:03:00.000Z');
    expect(m3[0]?.open).toBe(1.1);
    expect(m3[0]?.high).toBeCloseTo(1.202);
    expect(m3[0]?.low).toBeCloseTo(1.0);
    expect(m3[0]?.close).toBeCloseTo(1.112);
    expect(m3[0]?.isFinal).toBe(true);
    expect(m3[0]?.volume).toBe(30);
  });

  it('does not emit an incomplete bucket as final', () => {
    const rows: Candle[] = [0].map((i) => ({
      pair: 'EUR/USD',
      timeframe: 'M1',
      openTime: new Date(Date.parse('2026-01-05T10:03:00.000Z') + i * 60_000).toISOString(),
      closeTime: new Date(Date.parse('2026-01-05T10:04:00.000Z') + i * 60_000).toISOString(),
      open: 1.1,
      high: 1.2,
      low: 1.0,
      close: 1.11,
      provider: 'p',
      isFinal: true,
    }));
    const m3 = aggregate(rows, 'M3', 'p');
    expect(m3[0]?.isFinal).toBe(false);
  });

  it('finds gaps across an explicit range', () => {
    const rows: Candle[] = ['2026-01-05T10:00:00.000Z', '2026-01-05T10:02:00.000Z'].map((iso) => ({
      pair: 'EUR/USD',
      timeframe: 'M1',
      openTime: iso,
      closeTime: new Date(new Date(iso).getTime() + 60_000).toISOString(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      provider: 'p',
      isFinal: true,
    }));
    const gaps = findGaps(rows, '2026-01-05T10:00:00.000Z', '2026-01-05T10:02:00.000Z', 'M1');
    expect(gaps).toEqual(['2026-01-05T10:01:00.000Z']);
  });
});
