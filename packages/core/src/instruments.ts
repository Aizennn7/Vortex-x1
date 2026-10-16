/**
 * Instrument metadata: pip size, contract conventions and the default
 * ~20 pair majors/crosses universe. The pair list is fully configurable at
 * runtime through the `market_pairs` table / VORTEX_PAIRS env var.
 */

import type { Pair } from './types.js';

export interface InstrumentMeta {
  pair: Pair;
  /** Price increment of one pip. */
  pipSize: number;
  /** Digits used when rendering prices. */
  digits: number;
  base: string;
  quote: string;
  /** Coarse liquidity tier: 1 = deepest. Used for ingestion prioritisation. */
  tier: 1 | 2 | 3;
}

export const DEFAULT_PAIRS: Pair[] = [
  'EUR/USD',
  'GBP/USD',
  'USD/JPY',
  'USD/CHF',
  'USD/CAD',
  'AUD/USD',
  'NZD/USD',
  'EUR/GBP',
  'EUR/JPY',
  'EUR/CHF',
  'EUR/AUD',
  'EUR/CAD',
  'GBP/JPY',
  'GBP/CHF',
  'GBP/AUD',
  'AUD/JPY',
  'AUD/CAD',
  'AUD/NZD',
  'CAD/JPY',
  'CHF/JPY',
  'NZD/JPY',
  'USD/SEK',
  'USD/NOK',
];

const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD']);

export function normalizePair(pair: string): Pair {
  const cleaned = pair.trim().toUpperCase().replace(/\s+/g, '').replace('-', '/').replace('_', '/');
  if (cleaned.includes('/')) return cleaned;
  if (cleaned.length === 6) return `${cleaned.slice(0, 3)}/${cleaned.slice(3)}`;
  return cleaned;
}

export function instrumentMeta(pair: string): InstrumentMeta {
  const p = normalizePair(pair);
  const [base = 'XXX', quote = 'YYY'] = p.split('/');
  const jpyQuote = quote === 'JPY';
  const metal = METALS.has(base);
  const pipSize = metal ? 0.01 : jpyQuote ? 0.01 : 0.0001;
  const digits = metal ? 2 : jpyQuote ? 3 : 5;
  const tier: 1 | 2 | 3 =
    ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CHF', 'AUD/USD', 'USD/CAD', 'USD/CHF'].includes(p)
      ? 1
      : jpyQuote || quote === 'CHF' || quote === 'GBP'
        ? 2
        : 3;
  return { pair: p, pipSize, digits, base, quote, tier };
}

export function pipSize(pair: string): number {
  return instrumentMeta(pair).pipSize;
}

/** Convert an absolute price distance into pips. */
export function toPips(pair: string, distance: number): number {
  return distance / pipSize(pair);
}

/** Convert pips into an absolute price distance. */
export function fromPips(pair: string, pips: number): number {
  return pips * pipSize(pair);
}

export function roundPrice(pair: string, price: number): number {
  const digits = instrumentMeta(pair).digits;
  const factor = 10 ** digits;
  return Math.round(price * factor) / factor;
}

/**
 * Minimum price increment for a raw provider quote of a 5-digit pair. Twelve
 * Data returns e.g. 1.09235 (5 dp) for EUR/USD; we keep full provider
 * precision internally and only round for display.
 */
export function pricePrecision(pair: string): number {
  return instrumentMeta(pair).digits + (instrumentMeta(pair).pipSize === 0.0001 ? 1 : 1);
}

export function assertValidPair(pair: string): asserts pair is Pair {
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(normalizePair(pair))) {
    throw new Error(`Invalid FX pair: ${pair}`);
  }
}
