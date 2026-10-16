/**
 * Time utilities. VORTEX SI works exclusively in UTC and treats candle
 * boundaries as half-open intervals [openTime, closeTime).
 */

import type { Timeframe } from './types.js';
import { TIMEFRAME_SECONDS } from './types.js';

export const MS = 1_000;

export type TimeInput = string | number | Date;

export function toDate(value: TimeInput): Date {
  return value instanceof Date ? value : new Date(value);
}

export function toIso(value: TimeInput): string {
  return toDate(value).toISOString();
}

export function floorToSeconds(date: TimeInput, seconds: number): number {
  const ms = toDate(date).getTime();
  return Math.floor(ms / (seconds * MS)) * seconds * MS;
}

export function ceilToSeconds(date: TimeInput, seconds: number): number {
  const ms = toDate(date).getTime();
  return Math.ceil(ms / (seconds * MS)) * seconds * MS;
}

/** Open time (ISO) of the candle containing `at` for the given timeframe. */
export function candleOpen(at: TimeInput, timeframe: Timeframe): string {
  return new Date(floorToSeconds(at, TIMEFRAME_SECONDS[timeframe])).toISOString();
}

/** Close time (ISO, exclusive) of the candle containing `at`. */
export function candleClose(at: TimeInput, timeframe: Timeframe): string {
  const open = floorToSeconds(at, TIMEFRAME_SECONDS[timeframe]);
  return new Date(open + TIMEFRAME_SECONDS[timeframe] * MS).toISOString();
}

export function addSeconds(value: TimeInput, seconds: number): Date {
  return new Date(toDate(value).getTime() + seconds * MS);
}

export function diffSeconds(a: TimeInput, b: TimeInput): number {
  return (toDate(a).getTime() - toDate(b).getTime()) / MS;
}

/**
 * Next boundary of `boundarySeconds` strictly after `at` (granularity >= 1s).
 * Used to derive publish/entry/outcome instants that always land exactly on a
 * candle boundary, never "about now".
 */
export function nextBoundary(at: TimeInput, boundarySeconds: number): Date {
  const ms = toDate(at).getTime();
  const step = boundarySeconds * MS;
  let next = Math.floor(ms / step) * step + step;
  if (next <= ms) next += step; // exact boundary -> take the following one
  return new Date(next);
}

/** True when `at` is exactly on a `boundarySeconds` grid (UTC). */
export function isOnBoundary(at: TimeInput, boundarySeconds: number): boolean {
  const ms = toDate(at).getTime();
  return ms % (boundarySeconds * MS) === 0;
}

export function utcDayKey(at: TimeInput): string {
  return toIso(at).slice(0, 10);
}

export function utcMinuteKey(at: TimeInput): string {
  return toIso(at).slice(0, 16);
}

/** Trading session for the given UTC instant (approximate FX session map). */
export function sessionOf(at: TimeInput): import('./types.js').Session {
  const d = toDate(at);
  const h = d.getUTCHours();
  const overlapLondonNy = h >= 13 && h < 16;
  if (overlapLondonNy) return 'OVERLAP';
  if (h >= 7 && h < 13) return 'LONDON';
  if (h >= 16 && h < 21) return 'NEW_YORK';
  if (h >= 0 && h < 7) return 'TOKYO';
  if (h >= 21) return 'SYDNEY';
  return 'OFF_HOURS';
}

export const FX_WEEKEND_START_UTC_HOUR = 21; // Friday 21:00 UTC
export const FX_WEEKEND_END_UTC_DAY = 0; // Sunday 00:00 UTC

/**
 * Whether spot FX is open. Friday 21:00 UTC -> Sunday 21:00 UTC is closed.
 * (Sunday 21:00-24:00 UTC is the Sydney open window.)
 */
export function isMarketOpen(at: TimeInput): boolean {
  const d = toDate(at);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  if (day === 6) return false;
  if (day === 5 && hour >= FX_WEEKEND_START_UTC_HOUR) return false;
  if (day === 0 && hour < 21) return false;
  return true;
}

/** Milliseconds until the market reopens (0 when already open). */
export function msUntilMarketOpen(at: TimeInput): number {
  const d = toDate(at);
  if (isMarketOpen(d)) return 0;
  let probe = new Date(d.getTime());
  for (let i = 0; i < 60 * 24 * 8; i += 1) {
    probe = new Date(probe.getTime() + 60 * 1000);
    if (isMarketOpen(probe)) return probe.getTime() - d.getTime();
  }
  return 0;
}
