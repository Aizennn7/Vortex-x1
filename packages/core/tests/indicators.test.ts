/**
 * Indicator tests against independently derived fixtures.
 *
 * Every expected value here is computed from the textbook definition by hand
 * (or is a mathematically forced identity such as "all gains ⇒ RSI 100"), not
 * copied from this implementation's own output. Their purpose is to catch unit
 * and boundary mistakes — the class of bug that silently changes a strategy's
 * votes without ever throwing.
 */

import { describe, expect, it } from 'vitest';
import {
  adx,
  atr,
  bollinger,
  clamp,
  donchian,
  ema,
  lastDefined,
  macd,
  percentileRank,
  rsi,
  safeDiv,
  slope,
  sma,
  stdev,
  stochastic,
  trueRange,
  type Candle,
} from '../src/indicators.js';

const START = Date.parse('2026-01-05T09:00:00.000Z');

function candle(index: number, prices: { o: number; h: number; l: number; c: number }): Candle {
  const open = START + index * 60_000;
  return {
    pair: 'EUR/USD',
    timeframe: 'M1',
    openTime: new Date(open).toISOString(),
    closeTime: new Date(open + 60_000).toISOString(),
    open: prices.o,
    high: prices.h,
    low: prices.l,
    close: prices.c,
    provider: 'fixture',
    isFinal: true,
  };
}

describe('sma', () => {
  it('matches a hand-computed rolling mean and starts at period-1', () => {
    const series = sma([1, 2, 3, 4, 5], 3);
    expect(series).toEqual([null, null, 2, 3, 4]);
  });

  it('ignores periods shorter than the window', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null]);
  });
});

describe('ema', () => {
  it('seeds on the simple mean and then applies the smoothing constant', () => {
    // period 3 ⇒ k = 0.5; seed at index 2 = (1+2+3)/3 = 2
    // index 3 = 4*0.5 + 2*0.5 = 3 ; index 4 = 5*0.5 + 3*0.5 = 4
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('converges to a constant input instead of drifting', () => {
    const series = ema(new Array(50).fill(42), 10);
    expect(series.slice(-1)[0]).toBeCloseTo(42, 10);
  });
});

describe('stdev', () => {
  it('uses the population variance', () => {
    // mean 2.5, squared deviations 2.25+0.25+0.25+2.25 = 5, /4 = 1.25
    expect(stdev([1, 2, 3, 4], 4)[3]).toBeCloseTo(Math.sqrt(1.25), 10);
  });

  it('is zero for a constant window', () => {
    expect(stdev([7, 7, 7, 7], 4)[3]).toBe(0);
  });
});

describe('rsi', () => {
  it('is 100 when every bar gains and 0 when every bar loses', () => {
    const up = Array.from({ length: 40 }, (_, i) => 1 + i * 0.001);
    const down = Array.from({ length: 40 }, (_, i) => 1 - i * 0.001);
    expect(lastDefined(rsi(up, 14))).toBe(100);
    expect(lastDefined(rsi(down, 14))).toBe(0);
  });

  it('is the neutral 50 on a perfectly flat market, not overbought', () => {
    // avggain = avgloss = 0 makes RS undefined; the conventional answer is 50.
    // Reporting 100 labelled a dead market as maximally overbought.
    const flat = new Array(40).fill(1.1);
    expect(lastDefined(rsi(flat, 14))).toBe(50);
  });

  it('matches a hand-worked Wilder average', () => {
    // 14 changes: +1 x7 then -1 x7. First average gain = 0.5, loss = 0.5,
    // so RS = 1 and RSI = 100 - 100/2 = 50.
    const values = [1];
    for (let i = 0; i < 7; i += 1) values.push(values[values.length - 1]! + 1);
    for (let i = 0; i < 7; i += 1) values.push(values[values.length - 1]! - 1);
    const series = rsi(values, 14);
    expect(series[14]).toBeCloseTo(50, 10);
  });

  it('stays within 0..100 for noisy input', () => {
    const values = Array.from({ length: 200 }, (_, i) => 1.1 + Math.sin(i / 3) * 0.002 + (i % 7) * 0.0001);
    for (const value of rsi(values, 14)) {
      if (value === null) continue;
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});

describe('trueRange and atr', () => {
  const candles = [
    candle(0, { o: 1.1, h: 1.102, l: 1.098, c: 1.1 }),
    candle(1, { o: 1.1, h: 1.106, l: 1.099, c: 1.105 }),
    candle(2, { o: 1.105, h: 1.107, l: 1.1, c: 1.101 }),
  ];

  it('takes the largest of range, high-prevClose and prevClose-low', () => {
    expect(trueRange(candles)).toEqual([
      expect.closeTo(0.004, 10), // 1.102 - 1.098
      // range 0.007 beats |1.106 - 1.100| = 0.006 and |1.099 - 1.100| = 0.001
      expect.closeTo(0.007, 10),
      // range 0.007 beats |1.107 - 1.105| = 0.002 and |1.100 - 1.105| = 0.005
      expect.closeTo(0.007, 10),
    ]);
  });

  it('seeds atr with the simple mean of the first period', () => {
    const series = atr(candles, 3);
    expect(series[2]).toBeCloseTo((0.004 + 0.007 + 0.007) / 3, 10);
  });
});

describe('adx', () => {
  it('is 100 for a clean one-way trend and 0 for a flat market', () => {
    const trend = Array.from({ length: 80 }, (_, i) =>
      candle(i, { o: 1.1 + i * 0.0002, h: 1.1 + i * 0.0002 + 0.0003, l: 1.1 + i * 0.0002 - 0.0001, c: 1.1 + i * 0.0002 + 0.0002 }),
    );
    const flat = Array.from({ length: 80 }, (_, i) => candle(i, { o: 1.1, h: 1.1002, l: 1.0998, c: 1.1 }));
    expect(lastDefined(adx(trend, 14))).toBeCloseTo(100, 6);
    expect(lastDefined(adx(flat, 14))).toBe(0);
  });

  it('returns nothing before it has two periods of history', () => {
    const candles = Array.from({ length: 20 }, (_, i) => candle(i, { o: 1.1, h: 1.101, l: 1.099, c: 1.1 }));
    expect(adx(candles, 14).every((v) => v === null)).toBe(true);
  });
});

describe('macd', () => {
  it('reports the histogram as macd minus signal and is positive in an uptrend', () => {
    const values = Array.from({ length: 120 }, (_, i) => 1.1 + i * 0.0001);
    const result = macd(values);
    const index = values.length - 1;
    expect(result.macd[index]).not.toBeNull();
    expect(result.signal[index]).not.toBeNull();
    expect(result.histogram[index]).toBeCloseTo((result.macd[index] as number) - (result.signal[index] as number), 10);
    expect(result.macd[index] as number).toBeGreaterThan(0);
  });
});

describe('bollinger', () => {
  it('centres on the mean and offsets by mult * population stdev', () => {
    const values = [1, 2, 3, 4, 5];
    const bands = bollinger(values, 5, 2);
    const sd = Math.sqrt(((1 - 3) ** 2 + (2 - 3) ** 2 + 0 + 1 + 4) / 5);
    expect(bands.middle[4]).toBe(3);
    expect(bands.upper[4]).toBeCloseTo(3 + 2 * sd, 10);
    expect(bands.lower[4]).toBeCloseTo(3 - 2 * sd, 10);
  });
});

describe('stochastic and donchian', () => {
  const candles = [
    candle(0, { o: 1.1, h: 1.11, l: 1.09, c: 1.1 }),
    candle(1, { o: 1.1, h: 1.12, l: 1.1, c: 1.115 }),
    candle(2, { o: 1.115, h: 1.13, l: 1.11, c: 1.125 }),
  ];

  it('places %K inside the period range', () => {
    const { k } = stochastic(candles, 3, 1);
    // window high 1.13, low 1.09, close 1.125 => (1.125-1.09)/(1.13-1.09) = 87.5
    expect(k[2]).toBeCloseTo(87.5, 10);
  });

  it('uses the highest high and lowest low of the window', () => {
    const channel = donchian(candles, 3);
    expect(channel.upper[2]).toBeCloseTo(1.13, 10);
    expect(channel.lower[2]).toBeCloseTo(1.09, 10);
    expect(channel.middle[2]).toBeCloseTo(1.11, 10);
  });

  it('returns a neutral 50 when the range is zero', () => {
    const flat = [0, 1, 2].map((i) => candle(i, { o: 1.1, h: 1.1, l: 1.1, c: 1.1 }));
    expect(stochastic(flat, 3, 1).k[2]).toBe(50);
  });
});

describe('slope', () => {
  /**
   * The contract that matters: `slope` is normalised by the mean, i.e. it is a
   * FRACTIONAL change per bar, not a price distance. Regime detection compares
   * it against a single constant, so a price-distance reading would be a 100x
   * error on JPY crosses and on metals.
   */
  it('returns the fractional change per bar, independent of price scale', () => {
    expect(slope([1, 2, 3], 3)).toBeCloseTo(0.5, 10); // raw 1, mean 2
    expect(slope([100, 101, 102], 3)).toBeCloseTo(1 / 101, 10); // raw 1, mean 101
  });

  it('is scale-free: the same percentage drift has the same slope', () => {
    const small = Array.from({ length: 30 }, (_, i) => 1.1 * 1.001 ** i);
    const large = Array.from({ length: 30 }, (_, i) => 151 * 1.001 ** i);
    expect(slope(small, 30)).toBeCloseTo(slope(large, 30), 8);
  });

  it('is zero for flat input and for too-short input', () => {
    expect(slope(new Array(30).fill(5), 30)).toBe(0);
    expect(slope([1, 2], 20)).toBe(0);
  });
});

describe('percentileRank', () => {
  it('is 1 at the top of a monotone series and 0.5 without enough data', () => {
    const rising = Array.from({ length: 50 }, (_, i) => i);
    expect(percentileRank(rising, 50)).toBe(1);
    expect(percentileRank([1, 2, 3], 50)).toBe(0.5);
  });
});

describe('guards', () => {
  it('clamps and divides safely', () => {
    expect(clamp(1.5)).toBe(1);
    expect(clamp(-2)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(safeDiv(1, 0)).toBe(0);
    expect(safeDiv(1, 0, -1)).toBe(-1);
    expect(safeDiv(10, 2)).toBe(5);
    expect(safeDiv(Number.NaN, 2)).toBe(0);
    expect(safeDiv(1, Number.NaN)).toBe(0);
    expect(safeDiv(Number.POSITIVE_INFINITY, 2)).toBe(0);
  });

  it('never lets a non-finite value masquerade as an indicator reading', () => {
    const series = [null, Number.NaN, 1, Number.POSITIVE_INFINITY, 2];
    expect(lastDefined(series)).toBe(2);
    expect(lastDefined([null, Number.NaN])).toBeNull();
  });
});
