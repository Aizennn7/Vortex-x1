/**
 * Key pool service — the only place in the system that touches plaintext
 * provider keys.
 *
 * Responsibilities:
 *   - decrypt keys from the database; hold them in memory only;
 *   - decide which key may serve the next request (quota + health aware);
 *   - reserve quota atomically BEFORE the HTTP call, so concurrent workers and
 *     the relay cannot overspend the plan;
 *   - classify provider failures and rotate / cool down / disable;
 *   - degrade honestly when the budget is gone (no request loops).
 */

import {
  budgetSummary,
  classifyProviderError,
  cooldownSeconds,
  maskKey,
  nextCooldown,
  selectKey,
  type KeyState,
  type ProviderUsageSnapshot,
  type SelectionResult,
} from '@vortex/core';
import {
  QuotaExceededError,
  currentUsage,
  decryptSecret,
  listKeysWithCiphertext,
  markFailure,
  markSuccess,
  recordRequest,
  refundQuota,
  reserveQuota,
  QuotaGate,
  toKeyState,
  updateKey,
  usableLimits,
  type StoredKey,
  type SqlClient,
} from '@vortex/db';
import { ProviderError } from '@vortex/provider';
import type { WorkerRuntime } from '../runtime.js';

export interface KeyWithSecret {
  stored: StoredKey;
  plaintext: string;
}

export interface ProviderCallContext {
  endpoint: string;
  pair?: string | null;
  timeframe?: string | null;
  credits?: number;
  /** Interactive calls (user-triggered) may use reserved headroom. */
  interactive?: boolean;
}

export interface ProviderCallResult<T> {
  ok: boolean;
  value?: T;
  keyId?: string;
  error?: string;
  /**
   * True only when the pool has no usable capacity (no keys, all cooling down,
   * quota spent). A request that failed on the wire with budget still
   * available reports `false` so the caller records a real failure.
   */
  exhausted: boolean;
  httpStatus?: number;
  /** Machine-readable pool state when the call could not be served. */
  reason?: SelectionResult['reason'] | 'no_alternative_key';
}

export class KeyPool {
  private readonly runtime: WorkerRuntime;
  private cache: { at: number; keys: KeyWithSecret[] } | null = null;
  private readonly cacheTtlMs = 10_000;
  /** Serialises reservations inside this process (relay + worker share it). */
  private readonly quotaGate: QuotaGate | null;

  constructor(runtime: WorkerRuntime) {
    this.runtime = runtime;
    this.quotaGate = runtime.db.client ? new QuotaGate(runtime.db.client) : null;
  }

  private get db(): SqlClient {
    return this.runtime.db.client;
  }

  get configured(): boolean {
    return this.runtime.config.secretKey.length > 0;
  }

  /** Load and decrypt enabled keys. Plaintext stays inside this object. */
  async loadKeys(force = false): Promise<StoredKey[]> {
    const now = Date.now();
    if (!force && this.cache && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.keys.map((k) => k.stored);
    }
    const rows = await listKeysWithCiphertext(this.db);
    const keys: KeyWithSecret[] = [];
    for (const row of rows) {
      try {
        const plaintext = decryptSecret(row.ciphertext, this.runtime.config.secretKey);
        keys.push({ stored: row.stored, plaintext });
      } catch (error) {
        this.runtime.logger.error('provider key could not be decrypted', {
          component: 'keypool',
          keyId: row.stored.id,
          label: row.stored.label,
          error: (error as Error).message,
        });
      }
    }
    this.cache = { at: now, keys };
    return keys.map((k) => k.stored);
  }

  private async keyFor(id: string): Promise<KeyWithSecret | null> {
    await this.loadKeys();
    return this.cache?.keys.find((k) => k.stored.id === id) ?? null;
  }

  async selection(preferKeyId?: string): Promise<{ selection: SelectionResult; keys: StoredKey[] }> {
    const keys = await this.loadKeys();
    const now = new Date();
    const usage = await currentUsage(this.db, keys.map((k) => k.id), now);
    const states: KeyState[] = keys.map((k) =>
      toKeyState(k, usage.get(k.id) ?? { minuteUsed: 0, dayUsed: 0 }),
    );
    const selection = selectKey(states, {
      now,
      cost: 1,
      usage: Object.fromEntries(
        [...usage.entries()].map(([id, u]) => [
          id,
          { minuteUsed: u.minuteUsed, dayUsed: u.dayUsed, minuteBucket: u.minuteStart, dayBucket: u.dayStart },
        ]),
      ),
      limits: {
        rpmPerKey: this.runtime.config.providerRpmPerKey,
        rpdPerKey: this.runtime.config.providerRpdPerKey,
        headroomPercent: this.runtime.config.providerHeadroomPercent,
      },
      preferKeyId: preferKeyId ?? null,
    });
    return { selection, keys };
  }

  /**
   * Execute a provider call with quota reservation, bounded retries across
   * keys and error classification. Never loops indefinitely: at most one
   * attempt per eligible key, capped by `maxAttempts`.
   */
  async call<T>(
    context: ProviderCallContext,
    invoke: (apiKey: string, keyId: string) => Promise<T>,
  ): Promise<ProviderCallResult<T>> {
    const credits = context.credits ?? 1;
    const maxAttempts = Math.max(1, this.runtime.config.providerMaxAttempts);
    const tried = new Set<string>();
    let lastError: string | undefined;
    let lastStatus: number | undefined;
    let lastReason: ProviderCallResult<never>['reason'] | undefined;
    let exhausted = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const { selection } = await this.selection();
      lastReason = selection.reason;
      if (!selection.keyId) {
        // The pool refused to hand out a key: either the budget is spent, every
        // key is cooling down/invalid, or we have already burned the eligible
        // keys in this very call. All three mean the caller must degrade, so the
        // result says `exhausted` rather than pretending this was a provider
        // error the caller could retry.
        exhausted = true;
        this.runtime.logger.warn('provider capacity unavailable — degrading this cycle', {
          component: 'keypool',
          reason: selection.reason,
          detail: selection.detail,
          endpoint: context.endpoint,
        });
        return { ok: false, error: selection.detail, exhausted: true, reason: selection.reason };
      }
      if (tried.has(selection.keyId)) {
        // selectKey is deterministic, so re-selecting a key we already used
        // means no other key is eligible. Stop rather than loop.
        //
        // This is NOT quota exhaustion: the pool still had budget, the request
        // itself failed. Reporting it as `exhausted` would let the caller treat
        // a provider outage as deliberate degradation and record the cycle as
        // skipped. The distinction is what keeps outage alerts honest.
        lastError = `${lastError ?? 'provider call failed'} — no alternative key available after ${tried.size} attempt(s)`;
        lastReason = 'no_alternative_key';
        break;
      }
      tried.add(selection.keyId);

      const key = await this.keyFor(selection.keyId);
      if (!key) {
        lastError = 'selected key vanished from the pool';
        continue;
      }
      const limits = usableLimits(key.stored, {
        rpm: this.runtime.config.providerRpmPerKey,
        rpd: this.runtime.config.providerRpdPerKey,
        headroom: this.runtime.config.providerHeadroomPercent,
      });

      let reservation;
      try {
        const reserve = this.quotaGate
          ? this.quotaGate.reserve.bind(this.quotaGate)
          : (params: Parameters<typeof reserveQuota>[1]) => reserveQuota(this.db, params);
        reservation = await reserve({
          keyId: key.stored.id,
          cost: credits,
          minuteLimit: limits.minute,
          dayLimit: limits.day,
          now: new Date(),
        });
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          await updateKey(this.db, key.stored.id, { status: 'EXHAUSTED' });
          this.runtime.invalidateKeyCache();
          this.cache = null;
          lastError = error.message;
          this.runtime.logger.warn('provider quota exhausted for key — rotating', {
            component: 'keypool',
            keyId: key.stored.id,
            label: key.stored.label,
            scope: error.scope,
          });
          continue;
        }
        lastError = (error as Error).message;
        break;
      }

      const started = Date.now();
      try {
        const value = await invoke(key.plaintext, key.stored.id);
        this.runtime.bump('providerRequests');
        await markSuccess(this.db, key.stored.id);
        await recordRequest(this.db, {
          keyId: key.stored.id,
          endpoint: context.endpoint,
          pair: context.pair ?? null,
          timeframe: context.timeframe ?? null,
          credits,
          ok: true,
          durationMs: Date.now() - started,
          attempt,
        });
        if (reservation.dayUsed >= limits.day * 0.95 || reservation.minuteUsed >= limits.minute) {
          await updateKey(this.db, key.stored.id, {
            status: reservation.dayUsed >= limits.day ? 'EXHAUSTED' : 'ACTIVE',
          });
          this.cache = null;
        }
        return { ok: true, value, keyId: key.stored.id, exhausted: false };
      } catch (error) {
        this.runtime.bump('providerErrors');
        const status = error instanceof ProviderError ? error.status : 0;
        const classification = classifyProviderError(status, (error as Error).message);
        lastStatus = status;
        lastError = (error as Error).message;

        if (classification.rotate) {
          const cooldown =
            classification.status === 'COOLDOWN'
              ? nextCooldown(new Date(), key.stored.consecutiveFailures + 1)
              : null;
          await markFailure(this.db, key.stored.id, {
            status: classification.status,
            error: classification.reason,
            cooldownUntil: cooldown,
          });
          this.cache = null;
          this.runtime.logger.warn('provider key rotated out', {
            component: 'keypool',
            keyId: key.stored.id,
            label: key.stored.label,
            reason: classification.reason,
            cooldownSeconds: cooldown ? cooldownSeconds(key.stored.consecutiveFailures + 1) : 0,
            endpoint: context.endpoint,
          });
          await recordRequest(this.db, {
            keyId: key.stored.id,
            endpoint: context.endpoint,
            pair: context.pair ?? null,
            timeframe: context.timeframe ?? null,
            credits,
            ok: false,
            httpStatus: status,
            durationMs: Date.now() - started,
            attempt,
            error: classification.reason,
          });
          // A rate-limited request was rejected, so the credit was not spent:
          // refund it rather than burning the plan's budget in our accounting.
          if (status === 429) {
            await refundQuota(this.db, { keyId: key.stored.id, cost: credits, now: new Date() });
          }
          continue;
        }

        if (classification.retry && attempt < maxAttempts) {
          await markFailure(this.db, key.stored.id, { status: null, error: classification.reason });
          await recordRequest(this.db, {
            keyId: key.stored.id,
            endpoint: context.endpoint,
            pair: context.pair ?? null,
            timeframe: context.timeframe ?? null,
            credits,
            ok: false,
            httpStatus: status,
            durationMs: Date.now() - started,
            attempt,
            error: classification.reason,
          });
          await sleep(400 * 2 ** (attempt - 1));
          continue;
        }

        await markFailure(this.db, key.stored.id, { status: classification.status, error: classification.reason });
        await recordRequest(this.db, {
          keyId: key.stored.id,
          endpoint: context.endpoint,
          pair: context.pair ?? null,
          timeframe: context.timeframe ?? null,
          credits,
          ok: false,
          httpStatus: status,
          durationMs: Date.now() - started,
          attempt,
          error: classification.reason,
        });
        // The provider answered with an error (e.g. unknown symbol). The credit
        // may or may not have been consumed; we keep the reservation and report
        // the failure honestly instead of pretending nothing happened.
        return { ok: false, error: classification.reason, keyId: key.stored.id, exhausted: false, httpStatus: status };
      }
    }

    return {
      ok: false,
      error: lastError ?? 'provider call failed',
      exhausted,
      httpStatus: lastStatus,
      reason: lastReason,
    };
  }

  async usageSnapshots(): Promise<{ snapshots: ProviderUsageSnapshot[]; summary: ReturnType<typeof budgetSummary> }> {
    const keys = await this.loadKeys(true);
    const now = new Date();
    const usage = await currentUsage(this.db, keys.map((k) => k.id), now);
    const states = keys.map((k) => toKeyState(k, usage.get(k.id) ?? { minuteUsed: 0, dayUsed: 0 }));
    const summary = budgetSummary(states, {
      rpmPerKey: this.runtime.config.providerRpmPerKey,
      rpdPerKey: this.runtime.config.providerRpdPerKey,
      headroomPercent: this.runtime.config.providerHeadroomPercent,
    });
    const snapshots = keys.map((k) => {
      const u = usage.get(k.id);
      return {
        keyId: k.id,
        label: k.label,
        maskedKey: k.maskedKey || maskKey(''),
        enabled: k.enabled,
        status: k.status,
        minuteUsed: u?.minuteUsed ?? 0,
        minuteLimit: k.minuteLimit,
        dayUsed: u?.dayUsed ?? 0,
        dayLimit: k.dayLimit,
        cooldownUntil: k.cooldownUntil,
        consecutiveFailures: k.consecutiveFailures,
        lastError: k.lastError,
        lastUsedAt: k.lastUsedAt,
      } satisfies ProviderUsageSnapshot;
    });
    return { snapshots, summary };
  }

  /**
   * Capacity plan: how many requests/minute the configured pool can fund and
   * how often each pair can therefore be refreshed. Shown in the control
   * centre so the operator can size the plan honestly.
   */
  async capacityPlan(pairCount: number): Promise<{
    requestsPerMinute: number;
    requestsPerDay: number;
    usablePerMinute: number;
    refreshIntervalMinutes: number | null;
    feasible: boolean;
    detail: string;
  }> {
    const keys = await this.loadKeys();
    const headroom = this.runtime.config.providerHeadroomPercent;
    const perKeyMinute = Math.floor(this.runtime.config.providerRpmPerKey * (1 - headroom / 100));
    const perKeyDay = Math.floor(this.runtime.config.providerRpdPerKey * (1 - headroom / 100));
    const enabled = keys.filter((k) => k.enabled && k.status !== 'INVALID');
    const requestsPerMinute = enabled.length * perKeyMinute;
    const requestsPerDay = enabled.length * perKeyDay;
    const usablePerMinute = Math.max(0, requestsPerMinute);
    const needed = pairCount; // one request per pair per refresh
    const refreshIntervalMinutes = usablePerMinute === 0 ? null : Number((needed / usablePerMinute).toFixed(2));
    const feasible = refreshIntervalMinutes !== null && refreshIntervalMinutes <= 5;
    return {
      requestsPerMinute,
      requestsPerDay,
      usablePerMinute,
      refreshIntervalMinutes,
      feasible,
      detail:
        usablePerMinute === 0
          ? 'No usable provider keys — market data cannot be ingested.'
          : `Budget funds ${usablePerMinute} candle requests/minute and ${requestsPerDay}/day. ` +
            `With ${pairCount} enabled pairs each pair refreshes about every ${refreshIntervalMinutes} minute(s). ` +
            (feasible
              ? 'This meets the 5-minute signal cadence.'
              : 'This is below the 5-minute cadence, so pairs rotate and freshness degrades — add keys or reduce the enabled pair list.'),
    };
  }

  /**
   * Plaintext material for one key.
   *
   * Needed by the "verify key" action, which must present the real key to the
   * provider. This is the only accessor that hands plaintext out of the pool,
   * and it is never reachable from a public route.
   */
  async keyMaterial(keyId: string): Promise<string | null> {
    const key = await this.keyFor(keyId);
    return key?.plaintext ?? null;
  }

  /** Ciphertext for a key id — used by the verification route. */
  async encryptedFor(keyId: string): Promise<string | null> {
    const rows = await listKeysWithCiphertext(this.db);
    return rows.find((r) => r.stored.id === keyId)?.ciphertext ?? null;
  }

  invalidate(): void {
    this.cache = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
