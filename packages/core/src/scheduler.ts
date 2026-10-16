/**
 * Signal scheduling. All instants are exact UTC candle boundaries computed
 * from the cadence grid — never "about now".
 *
 * Timeline for one signal:
 *
 *   scanAt ──► publishAt = entryTime - lead ──► entryTime ──► horizonEnd
 *                 (signal sent ~1 min before entry)
 *
 * The engine refuses to publish when it cannot guarantee the lead time
 * (e.g. the worker restarted 10s before entry); the slot is simply skipped
 * and the next cadence boundary is used.
 */

import {
  addSeconds,
  ceilToSeconds,
  diffSeconds,
  isMarketOpen,
  isOnBoundary,
  msUntilMarketOpen,
  nextBoundary,
  toDate,
  toIso,
  type TimeInput,
} from './time.js';
import { TIMEFRAME_SECONDS, type Timeframe } from './types.js';

export interface SlotPlan {
  /** Instant at which the worker evaluates the market. */
  scanAt: string;
  /** Instant at which the signal must be published (entry - lead). */
  publishAt: string;
  /** Scheduled entry — a cadence boundary. */
  entryTime: string;
  /** Instant at which the outcome becomes readable. */
  horizonEnd: string;
  /** Cadence slot identifier (the entry boundary). */
  slotKey: string;
  /** Absolute seconds of lead time available from `now` to `publishAt`. */
  leadSecondsAvailable: number;
}

export interface ScheduleOptions {
  cadenceMinutes: number;
  publishLeadSeconds: number;
  horizonSeconds: number;
  /** Minimum lead the engine requires before it will publish (default 30s). */
  minLeadSeconds?: number;
  /** When true, slots landing in the FX weekend are pushed to the next open. */
  respectMarketHours?: boolean;
  /** Maximum cadence slots to look ahead (default 12). */
  maxLookaheadSlots?: number;
}

export function slotKeyFor(entryTime: string | number, cadenceMinutes: number): string {
  return `slot-${toIso(ceilToSeconds(entryTime, cadenceMinutes * 60))}`;
}

/**
 * Next publishable slot. Returns null when no slot inside the lookahead window
 * offers the required lead (the caller should just try again later).
 */
export function planNextSlot(now: TimeInput, options: ScheduleOptions): SlotPlan | null {
  const cadenceSeconds = options.cadenceMinutes * 60;
  const minLead = options.minLeadSeconds ?? 30;
  const maxSlots = options.maxLookaheadSlots ?? 12;
  const nowMs = toDate(now).getTime();

  // When the market is closed, jump straight to the reopening boundary instead
  // of walking hundreds of closed slots (a weekend is 576 five-minute slots).
  let firstEntryMs = nextBoundary(nowMs, cadenceSeconds).getTime();
  if (options.respectMarketHours !== false && !isMarketOpen(firstEntryMs)) {
    // A weekend is 576 five-minute slots; jumping to the reopening boundary is
    // both cheaper and exact.
    firstEntryMs = ceilToSeconds(firstEntryMs + msUntilMarketOpen(firstEntryMs), cadenceSeconds);
  }

  for (let i = 0; i < maxSlots; i += 1) {
    const entryMs = firstEntryMs + i * cadenceSeconds * 1000;
    const publishMs = entryMs - options.publishLeadSeconds * 1000;
    if (publishMs - nowMs < minLead * 1000) continue;
    if (options.respectMarketHours !== false && !isMarketOpen(entryMs)) continue;
    const horizonEndMs = entryMs + options.horizonSeconds * 1000;
    return {
      scanAt: toIso(nowMs),
      publishAt: toIso(publishMs),
      entryTime: toIso(entryMs),
      horizonEnd: toIso(ceilToSeconds(horizonEndMs, 1)),
      slotKey: slotKeyFor(entryMs, options.cadenceMinutes),
      leadSecondsAvailable: Math.round((publishMs - nowMs) / 1000),
    };
  }
  return null;
}

/**
 * Whether a signal may still be published for a slot.
 *
 * `minLeadSeconds` is the minimum time that must remain until the scheduled
 * entry: publishing with less than that in hand would break the promise that
 * the signal reaches subscribers before entry, so the slot is abandoned and
 * the next cadence boundary is used instead.
 */
export function publishability(
  now: TimeInput,
  plan: Pick<SlotPlan, 'publishAt' | 'entryTime'>,
  minLeadSeconds = 15,
): { ok: boolean; reason: string; secondsToPublish: number; secondsToEntry: number } {
  const nowMs = toDate(now).getTime();
  const publishMs = new Date(plan.publishAt).getTime();
  const entryMs = new Date(plan.entryTime).getTime();
  const secondsToPublish = Math.round((publishMs - nowMs) / 1000);
  const secondsToEntry = Math.round((entryMs - nowMs) / 1000);
  if (nowMs >= entryMs) return { ok: false, reason: 'entry_time_passed', secondsToPublish, secondsToEntry };
  if (secondsToEntry < minLeadSeconds) {
    return { ok: false, reason: 'insufficient_lead', secondsToPublish, secondsToEntry };
  }
  return { ok: true, reason: 'publishable', secondsToPublish, secondsToEntry };
}

/** Deterministic idempotency key: same opportunity → same key everywhere. */
export function signalIdempotencyKey(params: {
  pair: string;
  entryTime: string;
  direction: string;
  engineVersion: string;
}): string {
  return `sig|${params.pair}|${params.entryTime}|${params.direction}|${params.engineVersion}`;
}

/** Delay before settlement should be attempted (candle availability buffer). */
export function settlementDelaySeconds(timeframe: Timeframe, providerLagSeconds = 8): number {
  return TIMEFRAME_SECONDS[timeframe] + providerLagSeconds;
}

export function isSettleable(now: TimeInput, plan: Pick<SlotPlan, 'horizonEnd'>, providerLagSeconds = 8): boolean {
  const nowMs = toDate(now).getTime();
  return nowMs >= new Date(plan.horizonEnd).getTime() + providerLagSeconds * 1000;
}

export function secondsUntil(target: TimeInput, now: TimeInput): number {
  return Math.round(diffSeconds(target, now));
}

export function entryPlus(target: string | number, seconds: number): string {
  return toIso(addSeconds(target, seconds));
}

export function onCadenceBoundary(value: string | number, cadenceMinutes: number): boolean {
  return isOnBoundary(value, cadenceMinutes * 60);
}
