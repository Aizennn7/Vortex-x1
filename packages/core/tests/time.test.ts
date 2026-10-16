import { describe, expect, it } from 'vitest';
import {
  candleClose,
  candleOpen,
  diffSeconds,
  isMarketOpen,
  isOnBoundary,
  msUntilMarketOpen,
  nextBoundary,
  sessionOf,
} from '../src/time.js';

describe('candle boundaries', () => {
  it('floors the open time to the timeframe grid', () => {
    expect(candleOpen('2026-01-05T10:03:47.123Z', 'M1')).toBe('2026-01-05T10:03:00.000Z');
    expect(candleOpen('2026-01-05T10:03:47.123Z', 'M3')).toBe('2026-01-05T10:03:00.000Z');
    expect(candleOpen('2026-01-05T10:04:00.000Z', 'M3')).toBe('2026-01-05T10:03:00.000Z');
    expect(candleOpen('2026-01-05T10:04:00.001Z', 'M3')).toBe('2026-01-05T10:03:00.000Z');
    expect(candleOpen('2026-01-05T10:06:00.000Z', 'M3')).toBe('2026-01-05T10:06:00.000Z');
  });

  it('treats candles as half-open [open, close)', () => {
    expect(candleClose('2026-01-05T10:03:00.000Z', 'M1')).toBe('2026-01-05T10:04:00.000Z');
    expect(candleClose('2026-01-05T10:03:59.999Z', 'M3')).toBe('2026-01-05T10:06:00.000Z');
  });

  it('finds the next boundary strictly after the instant', () => {
    expect(nextBoundary('2026-01-05T10:03:00.000Z', 300).toISOString()).toBe('2026-01-05T10:05:00.000Z');
    expect(nextBoundary('2026-01-05T10:04:59.999Z', 300).toISOString()).toBe('2026-01-05T10:05:00.000Z');
    expect(nextBoundary('2026-01-05T10:05:00.000Z', 60).toISOString()).toBe('2026-01-05T10:06:00.000Z');
  });

  it('detects exact grid alignment', () => {
    expect(isOnBoundary('2026-01-05T10:05:00.000Z', 300)).toBe(true);
    expect(isOnBoundary('2026-01-05T10:05:01.000Z', 300)).toBe(false);
  });

  it('measures differences in whole seconds', () => {
    expect(diffSeconds('2026-01-05T10:05:00.000Z', '2026-01-05T10:04:00.000Z')).toBe(60);
    expect(diffSeconds(1000, 0)).toBe(1);
  });
});

describe('FX session map', () => {
  it('classifies sessions by UTC hour', () => {
    expect(sessionOf('2026-01-05T02:00:00.000Z')).toBe('TOKYO');
    expect(sessionOf('2026-01-05T09:00:00.000Z')).toBe('LONDON');
    expect(sessionOf('2026-01-05T14:00:00.000Z')).toBe('OVERLAP');
    expect(sessionOf('2026-01-05T18:00:00.000Z')).toBe('NEW_YORK');
    expect(sessionOf('2026-01-05T22:00:00.000Z')).toBe('SYDNEY');
  });
});

describe('market hours', () => {
  it('is closed from Friday 21:00 UTC until Sunday 21:00 UTC', () => {
    expect(isMarketOpen('2026-01-09T20:59:00.000Z')).toBe(true); // Friday
    expect(isMarketOpen('2026-01-09T21:00:00.000Z')).toBe(false);
    expect(isMarketOpen('2026-01-10T12:00:00.000Z')).toBe(false); // Saturday
    expect(isMarketOpen('2026-01-11T20:59:00.000Z')).toBe(false); // Sunday
    expect(isMarketOpen('2026-01-11T21:00:00.000Z')).toBe(true);
    expect(isMarketOpen('2026-01-12T08:00:00.000Z')).toBe(true); // Monday
  });

  it('reports the wait until the next open', () => {
    const fridayClose = '2026-01-09T22:00:00.000Z';
    const ms = msUntilMarketOpen(fridayClose);
    expect(ms).toBeGreaterThan(0);
    expect(new Date(new Date(fridayClose).getTime() + ms).getUTCDay()).toBe(0); // Sunday
    expect(new Date(new Date(fridayClose).getTime() + ms).getUTCHours()).toBe(21);
    expect(msUntilMarketOpen('2026-01-12T08:00:00.000Z')).toBe(0);
  });
});
