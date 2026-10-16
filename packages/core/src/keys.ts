/**
 * Provider API-key pool.
 *
 * The pool respects the REAL plan limits supplied by the operator
 * (`VORTEX_PROVIDER_RPM_PER_KEY`, `VORTEX_PROVIDER_RPD_PER_KEY`). It never
 * bypasses or disguises quota usage:
 *   - a key is `ACTIVE` while it has both minute and day budget left;
 *   - a key that returns 429 is put into `COOLDOWN` with an exponential,
 *     capped backoff — the pool then uses the next key or degrades;
 *   - a key that returns 401/403 is marked `INVALID` and never used again
 *     until an operator re-enables it;
 *   - when every key is unavailable the caller receives `exhausted: true` and
 *     must degrade gracefully (skip the cycle) instead of looping.
 *
 * Because quota is per ACCOUNT on Twelve Data, keys that share an account can
 * share a budget: pass `accountId` and the pool will apply the account cap too.
 */

import { toDate, type TimeInput } from './time.js';
import type { ApiKeyStatus } from './types.js';

export interface KeyState {
  id: string;
  label: string;
  /** Provider account/plan identifier. Keys on one account share its budget. */
  accountId?: string | null;
  enabled: boolean;
  status: ApiKeyStatus;
  /** Requests already consumed in the current UTC minute. */
  minuteUsed: number;
  dayUsed: number;
  minuteLimit: number;
  dayLimit: number;
  /**
   * Per-key headroom override. When a key declares its own headroom, selection
   * and reservation must both use it — otherwise the pool picks a key the
   * reservation step instantly rejects.
   */
  headroomPercent?: number | null;
  cooldownUntil?: string | null;
  consecutiveFailures: number;
  lastUsedAt?: string | null;
  lastError?: string | null;
}

export interface PoolLimits {
  rpmPerKey: number;
  rpdPerKey: number;
  /** Percentage of budget reserved for interactive/backfill traffic. */
  headroomPercent: number;
  /** Account-level caps applied to keys sharing `accountId`. */
  accountRpm?: number | null;
  accountRpd?: number | null;
}

export interface SelectionContext {
  now: TimeInput;
  /** Credits the request will consume (Twelve Data: 1 per series request). */
  cost: number;
  /** Bucketed usage for the current minute/day, keyed by key id. */
  usage: Record<string, { minuteUsed: number; dayUsed: number; minuteBucket: string; dayBucket: string }>;
  limits: PoolLimits;
  /** Optional preference order (e.g. task priorities). */
  preferKeyId?: string | null;
}

export interface SelectionResult {
  keyId: string | null;
  reason: 'selected' | 'exhausted' | 'no_keys_enabled' | 'all_cooling_down' | 'all_invalid';
  /** Human-readable explanation surfaced in the control centre. */
  detail: string;
  /** Remaining budget across the pool, in requests (headroom applied). */
  remainingMinute: number;
  remainingDay: number;
}

export function effectiveLimit(limit: number, headroomPercent: number): number {
  const usable = Math.floor(limit * (1 - Math.min(90, Math.max(0, headroomPercent)) / 100));
  return Math.max(0, usable);
}

function isCoolingDown(key: KeyState, nowMs: number): boolean {
  if (!key.cooldownUntil) return false;
  return new Date(key.cooldownUntil).getTime() > nowMs;
}

/**
 * Choose the next eligible key. Deterministic: prefers the key with the
 * largest remaining *fraction* of budget, breaking ties by id. Determinism
 * makes the behaviour testable and reproducible.
 */
export function selectKey(keys: KeyState[], ctx: SelectionContext): SelectionResult {
  const nowMs = toDate(ctx.now).getTime();
  const usableMinute = effectiveLimit(ctx.limits.rpmPerKey, ctx.limits.headroomPercent);
  const usableDay = effectiveLimit(ctx.limits.rpdPerKey, ctx.limits.headroomPercent);
  /** Headroom a key is actually subject to: its own, else the pool default. */
  const headroomFor = (key: KeyState): number => key.headroomPercent ?? ctx.limits.headroomPercent;

  const enabled = keys.filter((k) => k.enabled);
  if (enabled.length === 0) {
    return {
      keyId: null,
      reason: 'no_keys_enabled',
      detail: 'No provider API keys are enabled — add one in the control centre.',
      remainingMinute: 0,
      remainingDay: 0,
    };
  }

  const accountMinuteUsed = new Map<string, number>();
  const accountDayUsed = new Map<string, number>();
  for (const k of enabled) {
    if (!k.accountId) continue;
    const u = ctx.usage[k.id];
    if (!u) continue;
    accountMinuteUsed.set(k.accountId, (accountMinuteUsed.get(k.accountId) ?? 0) + u.minuteUsed);
    accountDayUsed.set(k.accountId, (accountDayUsed.get(k.accountId) ?? 0) + u.dayUsed);
  }

  interface Candidate {
    key: KeyState;
    remainingMinute: number;
    remainingDay: number;
    score: number;
  }

  const candidates: Candidate[] = [];
  let cooling = 0;
  let invalid = 0;

  for (const key of enabled) {
    if (key.status === 'INVALID') {
      invalid += 1;
      continue;
    }
    if (isCoolingDown(key, nowMs)) {
      cooling += 1;
      continue;
    }
    const usage = ctx.usage[key.id] ?? { minuteUsed: 0, dayUsed: 0, minuteBucket: '', dayBucket: '' };
    const minuteUsed = Math.max(key.minuteUsed, usage.minuteUsed);
    const dayUsed = Math.max(key.dayUsed, usage.dayUsed);

    const accountMinuteCap = ctx.limits.accountRpm ?? Number.POSITIVE_INFINITY;
    const accountDayCap = ctx.limits.accountRpd ?? Number.POSITIVE_INFINITY;
    const acctMinute = key.accountId ? accountMinuteUsed.get(key.accountId) ?? 0 : 0;
    const acctDay = key.accountId ? accountDayUsed.get(key.accountId) ?? 0 : 0;

    // A key may carry its own (usually smaller) plan limits. Selection has to
    // honour them, otherwise the pool picks a key the reservation step will
    // immediately reject.
    const headroom = headroomFor(key);
    const keyMinute = effectiveLimit(key.minuteLimit || ctx.limits.rpmPerKey, headroom);
    const keyDay = effectiveLimit(key.dayLimit || ctx.limits.rpdPerKey, headroom);
    if (minuteUsed + ctx.cost > keyMinute) continue;
    if (dayUsed + ctx.cost > keyDay) continue;
    if (key.accountId && acctMinute + ctx.cost > effectiveLimit(accountMinuteCap, headroom)) continue;
    if (key.accountId && acctDay + ctx.cost > effectiveLimit(accountDayCap, headroom)) continue;

    const remainingMinute = Math.max(0, keyMinute - minuteUsed);
    const remainingDay = Math.max(0, keyDay - dayUsed);
    // Fewest consecutive failures first (rewards healthy keys), then most
    // remaining budget, then a stable id tiebreak.
    const score =
      (1 / (1 + key.consecutiveFailures)) * 1_000_000 + remainingMinute * 100 + remainingDay * 0.001;
    candidates.push({ key, remainingMinute, remainingDay, score });
  }

  if (candidates.length === 0) {
    const totalMinute = enabled.reduce((acc, k) => acc + effectiveLimit(k.minuteLimit || ctx.limits.rpmPerKey, headroomFor(k)), 0);
    const totalDay = enabled.reduce((acc, k) => acc + effectiveLimit(k.dayLimit || ctx.limits.rpdPerKey, headroomFor(k)), 0);
    const remainingMinute = enabled.reduce((acc, k) => {
      const u = ctx.usage[k.id];
      return acc + Math.max(0, effectiveLimit(k.minuteLimit || ctx.limits.rpmPerKey, headroomFor(k)) - (u?.minuteUsed ?? 0));
    }, 0);
    const remainingDay = enabled.reduce((acc, k) => {
      const u = ctx.usage[k.id];
      return acc + Math.max(0, effectiveLimit(k.dayLimit || ctx.limits.rpdPerKey, headroomFor(k)) - (u?.dayUsed ?? 0));
    }, 0);
    const reason: SelectionResult['reason'] =
      invalid === enabled.length ? 'all_invalid' : cooling > 0 ? 'all_cooling_down' : 'exhausted';
    const detail =
      reason === 'all_invalid'
        ? 'Every configured key was rejected by the provider — replace or re-enable a key.'
        : reason === 'all_cooling_down'
          ? 'All keys are in provider cooldown; the cycle is skipped until the cooldown expires.'
          : 'Provider quota for the current minute/day is spent; ingestion is paused until the window resets.';
    void totalMinute;
    void totalDay;
    return { keyId: null, reason, detail, remainingMinute, remainingDay };
  }

  const preferred = ctx.preferKeyId ? candidates.find((c) => c.key.id === ctx.preferKeyId) : undefined;
  const best = preferred ?? candidates.sort((a, b) => b.score - a.score || a.key.id.localeCompare(b.key.id))[0]!;
  const poolRemainingMinute = candidates.reduce((acc, c) => acc + c.remainingMinute, 0);
  const poolRemainingDay = candidates.reduce((acc, c) => acc + c.remainingDay, 0);
  return {
    keyId: best.key.id,
    reason: 'selected',
    detail: `using ${best.key.label} (${best.remainingMinute} of ${effectiveLimit(
      best.key.minuteLimit || ctx.limits.rpmPerKey,
      headroomFor(best.key),
    )} minute budget left)`,
    remainingMinute: poolRemainingMinute,
    remainingDay: poolRemainingDay,
  };
}

/** Exponential, capped cooldown for provider throttling. */
export function cooldownSeconds(consecutiveFailures: number, baseSeconds = 20, capSeconds = 900): number {
  const step = Math.max(0, consecutiveFailures - 1);
  return Math.min(capSeconds, baseSeconds * 2 ** step);
}

export function nextCooldown(now: TimeInput, consecutiveFailures: number): string {
  const nowMs = toDate(now).getTime();
  return new Date(nowMs + cooldownSeconds(consecutiveFailures) * 1000).toISOString();
}

export interface ProviderErrorClassification {
  status: ApiKeyStatus | null;
  /** Whether the request should be retried on the same key immediately. */
  retry: boolean;
  /** Whether the failure is a per-key condition (rotate) or transient. */
  rotate: boolean;
  reason: string;
}

/**
 * Classify a provider failure. Mirrors Twelve Data's documented behaviour:
 * HTTP 429 for rate/quota limits, 401/403 for an unusable key, 404 for
 * unknown symbol, 5xx for transient server errors.
 */
export function classifyProviderError(status: number, body: string): ProviderErrorClassification {
  const text = body.toLowerCase();
  const quotaLike =
    text.includes('run out of api credits') ||
    text.includes('api credits') ||
    text.includes('daily limit') ||
    text.includes('quota');
  const rateLike = text.includes('rate limit') || text.includes('too many requests');
  if (status === 429) {
    return {
      status: 'COOLDOWN',
      retry: false,
      rotate: true,
      reason: quotaLike ? 'provider reported exhausted API credits' : 'provider rate limit reached',
    };
  }
  if (status === 401 || status === 403) {
    return { status: 'INVALID', retry: false, rotate: true, reason: 'provider rejected the API key (auth)' };
  }
  if (status === 404) {
    return { status: null, retry: false, rotate: false, reason: 'symbol not available from provider' };
  }
  if (status === 400 || status === 422) {
    return { status: null, retry: false, rotate: false, reason: 'provider rejected the request parameters' };
  }
  if (status >= 500 || status === 408) {
    return { status: null, retry: true, rotate: false, reason: 'provider transient error' };
  }
  if (rateLike) return { status: 'COOLDOWN', retry: false, rotate: true, reason: 'provider rate limit reached' };
  return { status: null, retry: status !== 200, rotate: false, reason: `provider returned HTTP ${status}` };
}

/** Mask a key for display: never reveal more than the last four characters. */
export function maskKey(raw: string): string {
  if (raw.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, raw.length - 4))}${raw.slice(-4)}`;
}

/** Budget summary used by the control centre and alerts. */
export function budgetSummary(keys: KeyState[], limits: PoolLimits): {
  enabledKeys: number;
  activeKeys: number;
  minuteCapacity: number;
  dayCapacity: number;
  dayUsed: number;
  dayRemainingPercent: number;
  exhausted: boolean;
  warnings: string[];
} {
  const enabled = keys.filter((k) => k.enabled);
  const active = enabled.filter((k) => k.status === 'ACTIVE' || k.status === 'COOLDOWN');
  const warnings: string[] = [];
  const minuteCapacity = enabled.reduce(
    (acc, k) => acc + effectiveLimit(k.minuteLimit || limits.rpmPerKey, k.headroomPercent ?? limits.headroomPercent),
    0,
  );
  const dayCapacity = enabled.reduce(
    (acc, k) => acc + effectiveLimit(k.dayLimit || limits.rpdPerKey, k.headroomPercent ?? limits.headroomPercent),
    0,
  );
  const dayUsed = enabled.reduce((acc, k) => acc + k.dayUsed, 0);
  const dayRemainingPercent = dayCapacity === 0 ? 0 : Math.max(0, ((dayCapacity - dayUsed) / dayCapacity) * 100);
  if (enabled.length === 0) warnings.push('No provider keys configured — market data cannot be ingested.');
  else if (active.length === 0) warnings.push('All provider keys are unavailable (invalid or disabled).');
  if (dayRemainingPercent < 10 && dayCapacity > 0) warnings.push(`Provider day budget nearly spent (${dayRemainingPercent.toFixed(1)}% left).`);
  if (keys.some((k) => k.status === 'INVALID')) warnings.push('At least one key was rejected by the provider and needs replacing.');
  return {
    enabledKeys: enabled.length,
    activeKeys: active.length,
    minuteCapacity,
    dayCapacity,
    dayUsed,
    dayRemainingPercent,
    exhausted: enabled.length > 0 && active.length === 0,
    warnings,
  };
}

/** Minimum number of M1 candles needed to score a pair consistently. */
export const WARMUP_CANDLES = 120;

/**
 * Plan a fetch: never request more than the pool can afford this minute.
 * Returns the list of (pair, timeframe, outputsize) tuples for this cycle.
 */
export function planIngestion(params: {
  pairs: string[];
  remainingMinute: number;
  cycleBudget?: number;
  perPairCost?: number;
  outputsize: number;
  prioritize?: (pair: string) => number;
}): { pair: string; outputsize: number }[] {
  const perPairCost = params.perPairCost ?? 1;
  const cycleBudget = Math.min(params.cycleBudget ?? params.remainingMinute, params.remainingMinute);
  const capacity = Math.floor(cycleBudget / perPairCost);
  const ordered = [...params.pairs].sort((a, b) => (params.prioritize?.(a) ?? 0) - (params.prioritize?.(b) ?? 0) || a.localeCompare(b));
  return ordered.slice(0, Math.max(0, capacity)).map((pair) => ({ pair, outputsize: params.outputsize }));
}
