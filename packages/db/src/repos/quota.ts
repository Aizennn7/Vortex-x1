/**
 * Atomic provider-quota accounting.
 *
 * Every provider call must hold a reservation. Reservations are taken inside a
 * transaction that locks the counter row (`select ... for update`), which makes
 * concurrent workers, the relay and any scheduled backfill share one honest
 * budget. If the budget is gone the reservation throws {@link QuotaExceededError}
 * and the caller must degrade — never retry in a loop.
 */

import { KeyedMutex } from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { int, iso } from './rows.js';

export class QuotaExceededError extends Error {
  readonly scope: 'minute' | 'day' | 'key';
  constructor(scope: 'minute' | 'day' | 'key', message: string) {
    super(message);
    this.name = 'QuotaExceededError';
    this.scope = scope;
  }
}

export interface BucketWindow {
  minuteStart: string;
  dayStart: string;
}

export function bucketWindows(now: Date | number): BucketWindow {
  const date = typeof now === 'number' ? new Date(now) : now;
  const minuteStart = new Date(Math.floor(date.getTime() / 60_000) * 60_000).toISOString();
  const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).toISOString();
  return { minuteStart, dayStart };
}

export interface ReservationResult {
  keyId: string;
  cost: number;
  minuteUsed: number;
  dayUsed: number;
  minuteLimit: number;
  dayLimit: number;
  minuteStart: string;
  dayStart: string;
}

export interface ReservationParams {
  keyId: string;
  cost: number;
  minuteLimit: number;
  dayLimit: number;
  now: Date | number;
}

/**
 * Reserve `cost` credits on a key. Throws QuotaExceededError when either
 * window would overflow. The ++ is done with `on conflict do update set
 * used = provider_quota_usage.used + excluded...` after the row lock, so two
 * concurrent transactions can never both see "1 left" and both consume it.
 */
export async function reserveQuota(client: SqlClient, params: ReservationParams): Promise<ReservationResult> {
  const { minuteStart, dayStart } = bucketWindows(params.now);
  const cost = Math.max(1, Math.trunc(params.cost));

  return client.transaction(async (tx) => {
    // Transaction-scoped advisory lock: serialises reservations for this key
    // across every connection AND process, which the row lock alone would not
    // do when two callers race on a key that has no counter row yet.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`vortex:quota:${params.keyId}`]);
    const minute = await lockBucket(tx, params.keyId, 'minute', minuteStart);
    const day = await lockBucket(tx, params.keyId, 'day', dayStart);

    if (minute + cost > params.minuteLimit) {
      throw new QuotaExceededError('minute', `minute budget exhausted (${minute}/${params.minuteLimit})`);
    }
    if (day + cost > params.dayLimit) {
      throw new QuotaExceededError('day', `daily budget exhausted (${day}/${params.dayLimit})`);
    }

    await bump(tx, params.keyId, 'minute', minuteStart, cost);
    await bump(tx, params.keyId, 'day', dayStart, cost);

    return {
      keyId: params.keyId,
      cost,
      minuteUsed: minute + cost,
      dayUsed: day + cost,
      minuteLimit: params.minuteLimit,
      dayLimit: params.dayLimit,
      minuteStart,
      dayStart,
    };
  });
}

async function lockBucket(
  tx: SqlClient,
  keyId: string,
  bucket: 'minute' | 'day',
  bucketStart: string,
): Promise<number> {
  await tx.query(
    `insert into provider_quota_usage (key_id, bucket, bucket_start, used)
     values ($1, $2, $3, 0)
     on conflict (key_id, bucket, bucket_start) do nothing`,
    [keyId, bucket, bucketStart],
  );
  const row = await tx.query<{ used: number }>(
    `select used from provider_quota_usage
      where key_id = $1 and bucket = $2 and bucket_start = $3
      for update`,
    [keyId, bucket, bucketStart],
  );
  return int(row.rows[0]?.used, 0);
}

async function bump(tx: SqlClient, keyId: string, bucket: 'minute' | 'day', bucketStart: string, cost: number): Promise<void> {
  await tx.query(
    `update provider_quota_usage
        set used = used + $4, updated_at = now()
      where key_id = $1 and bucket = $2 and bucket_start = $3`,
    [keyId, bucket, bucketStart, cost],
  );
}

/**
 * Refund a reservation (used when a call failed before reaching the provider,
 * e.g. the request could not be sent at all). Never used to hide usage of a
 * request the provider actually served.
 */
export async function refundQuota(client: SqlClient, params: { keyId: string; cost: number; now: Date | number }): Promise<void> {
  const { minuteStart, dayStart } = bucketWindows(params.now);
  await client.transaction(async (tx) => {
    for (const [bucket, start] of [
      ['minute', minuteStart],
      ['day', dayStart],
    ] as const) {
      await tx.query(
        `update provider_quota_usage
            set used = greatest(0, used - $4), updated_at = now()
          where key_id = $1 and bucket = $2 and bucket_start = $3`,
        [params.keyId, bucket, start, Math.max(1, Math.trunc(params.cost))],
      );
    }
  });
}

export interface UsageRow {
  keyId: string;
  minuteUsed: number;
  dayUsed: number;
  minuteStart: string;
  dayStart: string;
}

export async function currentUsage(client: SqlClient, keyIds: string[], now: Date | number): Promise<Map<string, UsageRow>> {
  const { minuteStart, dayStart } = bucketWindows(now);
  const out = new Map<string, UsageRow>();
  if (keyIds.length === 0) return out;
  for (const id of keyIds) {
    out.set(id, { keyId: id, minuteUsed: 0, dayUsed: 0, minuteStart, dayStart });
  }
  const rows = await client.query<{ key_id: string; bucket: string; used: number; bucket_start: string | Date }>(
    `select key_id, bucket, used, bucket_start
       from provider_quota_usage
      where key_id = any($1::uuid[])
        and ((bucket = 'minute' and bucket_start = $2) or (bucket = 'day' and bucket_start = $3))`,
    [keyIds, minuteStart, dayStart],
  );
  for (const row of rows.rows) {
    const entry = out.get(row.key_id);
    if (!entry) continue;
    if (row.bucket === 'minute') {
      entry.minuteUsed = int(row.used);
      entry.minuteStart = iso(row.bucket_start) ?? minuteStart;
    } else {
      entry.dayUsed = int(row.used);
      entry.dayStart = iso(row.bucket_start) ?? dayStart;
    }
  }
  return out;
}

export interface RequestLogRow {
  id: string;
  keyId: string | null;
  endpoint: string;
  pair: string | null;
  timeframe: string | null;
  credits: number;
  httpStatus: number | null;
  ok: boolean;
  durationMs: number | null;
  attempt: number;
  error: string | null;
  createdAt: string;
}

/** Recent provider calls — read-only evidence for the control centre. */
export async function listRequestLog(client: SqlClient, limit = 50): Promise<RequestLogRow[]> {
  const rows = await client.query<{
    id: string;
    key_id: string | null;
    endpoint: string;
    pair: string | null;
    timeframe: string | null;
    credits: number;
    http_status: number | null;
    ok: boolean;
    duration_ms: number | null;
    attempt: number;
    error: string | null;
    created_at: string | Date;
  }>(
    `select id, key_id, endpoint, pair, timeframe, credits, http_status, ok, duration_ms, attempt, error, created_at
       from provider_request_log order by created_at desc limit $1`,
    [Math.max(1, Math.min(500, limit))],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    keyId: r.key_id,
    endpoint: r.endpoint,
    pair: r.pair,
    timeframe: r.timeframe,
    credits: int(r.credits, 0),
    httpStatus: r.http_status === null ? null : int(r.http_status, 0),
    ok: r.ok === true,
    durationMs: r.duration_ms === null ? null : int(r.duration_ms, 0),
    attempt: int(r.attempt, 1),
    error: r.error,
    createdAt: iso(r.created_at) ?? '',
  }));
}

/** Roll-up used by the control centre. */
export async function quotaSummary(
  client: SqlClient,
  now: Date | number,
): Promise<{ minuteUsed: number; dayUsed: number; minuteCapacity: number; dayCapacity: number }> {
  const { minuteStart, dayStart } = bucketWindows(now);
  const row = await client.query<{ minute_used: string; day_used: string }>(
    `select
       coalesce(sum(used) filter (where bucket = 'minute' and bucket_start = $1), 0) as minute_used,
       coalesce(sum(used) filter (where bucket = 'day' and bucket_start = $2), 0) as day_used
     from provider_quota_usage q
     join provider_keys k on k.id = q.key_id and k.enabled`,
    [minuteStart, dayStart],
  );
  const caps = await client.query<{ minute_capacity: string; day_capacity: string }>(
    `select
       coalesce(sum(coalesce(minute_limit, 0)), 0) as minute_capacity,
       coalesce(sum(coalesce(day_limit, 0)), 0) as day_capacity
     from provider_keys where enabled`,
  );
  return {
    minuteUsed: int(row.rows[0]?.minute_used, 0),
    dayUsed: int(row.rows[0]?.day_used, 0),
    minuteCapacity: int(caps.rows[0]?.minute_capacity, 0),
    dayCapacity: int(caps.rows[0]?.day_capacity, 0),
  };
}

export async function recordRequest(
  client: SqlClient,
  entry: {
    keyId: string | null;
    endpoint: string;
    pair?: string | null;
    timeframe?: string | null;
    credits: number;
    httpStatus?: number | null;
    ok: boolean;
    durationMs?: number | null;
    attempt?: number;
    error?: string | null;
  },
): Promise<void> {
  await client.query(
    `insert into provider_request_log (key_id, endpoint, pair, timeframe, credits, http_status, ok, duration_ms, attempt, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      entry.keyId,
      entry.endpoint,
      entry.pair ?? null,
      entry.timeframe ?? null,
      entry.credits,
      entry.httpStatus ?? null,
      entry.ok,
      entry.durationMs ?? null,
      entry.attempt ?? 1,
      entry.error ?? null,
    ],
  );
}

/** Cheap request-log retention to keep the database small. */
export async function pruneRequestLog(client: SqlClient, retentionDays = 14): Promise<number> {
  const result = await client.query(`delete from provider_request_log where created_at < now() - ($1 || ' days')::interval`, [
    String(Math.max(1, retentionDays)),
  ]);
  return result.rowCount;
}

/**
 * Serialising reservation gate.
 *
 * `reserveQuota` is already atomic at the database level (advisory lock + row
 * lock inside one transaction). This gate adds the in-process half: two
 * concurrent callers in the same worker/relay process — a browser-triggered
 * backfill racing the ingestion cycle, for instance — are queued instead of
 * being allowed to interleave their read-check-write sequences.
 *
 * Use one gate instance per database handle for the whole process.
 */
export class QuotaGate {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly client: SqlClient) {}

  reserve(params: ReservationParams): Promise<ReservationResult> {
    return this.mutex.run(params.keyId, () => reserveQuota(this.client, params));
  }

  refund(params: { keyId: string; cost: number; now: Date | number }): Promise<void> {
    return this.mutex.run(params.keyId, () => refundQuota(this.client, params));
  }

  get pending(): number {
    return this.mutex.size;
  }
}
