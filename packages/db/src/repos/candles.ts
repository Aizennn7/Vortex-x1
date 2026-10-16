/**
 * Candle persistence. Deduplication is enforced by the primary key
 * `(pair, timeframe, open_time)` and an upsert that only advances a row when
 * the incoming revision is newer — so a re-fetch can never corrupt history.
 */

import type { Candle, CandleInput, Pair, Timeframe } from '@vortex/core';
import { normalizeBatch } from '@vortex/core';
import { placeholders, type SqlClient } from '../driver.js';
import { bool, int, iso, isoRequired, num } from './rows.js';

export interface CandleRow {
  pair: string;
  timeframe: string;
  open_time: string | Date;
  close_time: string | Date;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number | null;
  provider: string;
  is_final: boolean;
  revision: number;
}

export function rowToCandle(row: CandleRow): Candle {
  return {
    pair: row.pair,
    timeframe: row.timeframe as Timeframe,
    openTime: isoRequired(row.open_time),
    closeTime: isoRequired(row.close_time),
    open: num(row.open),
    high: num(row.high),
    low: num(row.low),
    close: num(row.close),
    volume: row.volume === null ? null : num(row.volume),
    provider: row.provider,
    isFinal: bool(row.is_final, true),
    revision: int(row.revision, 1),
  };
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  rejected: number;
  gaps: string[];
  duplicates: number;
}

/**
 * Validate, dedupe and persist a batch. Invalid candles are counted and
 * skipped — never stored, never interpolated.
 */
export async function upsertCandles(
  client: SqlClient,
  inputs: CandleInput[],
): Promise<UpsertResult> {
  if (inputs.length === 0) return { inserted: 0, updated: 0, rejected: 0, gaps: [], duplicates: 0 };
  const expected = {
    pair: inputs[0]!.pair,
    timeframe: inputs[0]!.timeframe,
  };
  const { candles, quality } = normalizeBatch(inputs, expected);
  if (candles.length === 0) {
    return { inserted: 0, updated: 0, rejected: inputs.length, gaps: [], duplicates: quality.duplicates.length };
  }

  const rows = candles.map((c) => [
    c.pair,
    c.timeframe,
    c.openTime,
    c.closeTime,
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume ?? null,
    c.provider,
    c.isFinal,
    c.revision ?? 1,
  ]);

  const { sql: valuesSql, params } = placeholders(rows);
  const result = await client.query<{ inserted: boolean }>(
    `insert into candles
       (pair, timeframe, open_time, close_time, open, high, low, close, volume, provider, is_final, revision)
     values ${valuesSql}
     on conflict (pair, timeframe, open_time) do update
       set open = excluded.open,
           high = excluded.high,
           low = excluded.low,
           close = excluded.close,
           volume = excluded.volume,
           is_final = excluded.is_final,
           revision = excluded.revision,
           received_at = now()
       where candles.revision is distinct from excluded.revision
          or candles.is_final is distinct from excluded.is_final
          or candles.close is distinct from excluded.close
     returning (xmax = 0) as inserted`,
    params,
  );

  const inserted = result.rows.filter((r) => bool(r.inserted)).length;
  return {
    inserted,
    updated: result.rows.length - inserted,
    rejected: quality.invalid.length,
    gaps: quality.gaps,
    duplicates: quality.duplicates.length,
  };
}

export async function getCandles(
  client: SqlClient,
  params: { pair: Pair; timeframe: Timeframe; limit?: number; from?: string; to?: string; finalOnly?: boolean },
): Promise<Candle[]> {
  const limit = Math.min(params.limit ?? 500, 5000);
  const conditions = ['pair = $1', 'timeframe = $2'];
  const values: unknown[] = [params.pair, params.timeframe];
  if (params.from) {
    values.push(params.from);
    conditions.push(`open_time >= $${values.length}`);
  }
  if (params.to) {
    values.push(params.to);
    conditions.push(`open_time <= $${values.length}`);
  }
  if (params.finalOnly !== false) conditions.push('is_final = true');
  values.push(limit);
  const rows = await client.query<CandleRow>(
    `select pair, timeframe, open_time, close_time, open, high, low, close, volume, provider, is_final, revision
       from candles
      where ${conditions.join(' and ')}
      order by open_time desc
      limit $${values.length}`,
    values,
  );
  return rows.rows.map(rowToCandle).reverse();
}

/** Newest candle per requested timeframe for a set of pairs (single round trip). */
export async function latestCandleTimes(
  client: SqlClient,
  pairs: string[],
  timeframe: Timeframe,
): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const rows = await client.query<{ pair: string; last_open: string | Date }>(
    `select pair, max(open_time) as last_open
       from candles
      where pair = any($1::text[]) and timeframe = $2
      group by pair`,
    [pairs, timeframe],
  );
  const map = new Map<string, string>();
  for (const row of rows.rows) {
    const value = iso(row.last_open);
    if (value) map.set(row.pair, value);
  }
  return map;
}

/** Count of missing candles inside a window, computed in SQL for efficiency. */
export async function countGaps(
  client: SqlClient,
  params: { pair: Pair; timeframe: Timeframe; from: string; to: string; stepSeconds: number },
): Promise<{ expected: number; present: number; gaps: number }> {
  const row = await client.query<{ expected: string; present: string }>(
    `with bounds as (
       select date_trunc('second', $3::timestamptz) as from_ts,
              date_trunc('second', $4::timestamptz) as to_ts
     )
     select
       greatest(0, floor(extract(epoch from (b.to_ts - b.from_ts)) / $5)::bigint + 1) as expected,
       (select count(*) from candles c
         where c.pair = $1 and c.timeframe = $2 and c.open_time between b.from_ts and b.to_ts) as present
     from bounds b`,
    [params.pair, params.timeframe, params.from, params.to, params.stepSeconds],
  );
  const expected = num(row.rows[0]?.expected);
  const present = num(row.rows[0]?.present);
  return { expected, present, gaps: Math.max(0, expected - present) };
}

export interface QualityUpdate {
  pair: string;
  timeframe: Timeframe;
  status: 'CONNECTED' | 'DISCONNECTED' | 'DEGRADED' | 'CONFIGURATION REQUIRED' | 'NOT VERIFIED';
  ageSeconds: number | null;
  gapCount: number;
  lastCandleAt: string | null;
  expectedAt: string | null;
  detail: string;
}

export async function upsertQuality(client: SqlClient, updates: QualityUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const rows = updates.map((u) => [
    u.pair,
    u.timeframe,
    u.status,
    u.ageSeconds,
    u.gapCount,
    u.lastCandleAt,
    u.expectedAt,
    u.detail,
    new Date().toISOString(),
  ]);
  const { sql, params } = placeholders(rows);
  await client.query(
    `insert into market_data_quality
       (pair, timeframe, status, age_seconds, gap_count, last_candle_at, expected_at, detail, checked_at)
     values ${sql}
     on conflict (pair, timeframe) do update
       set status = excluded.status,
           age_seconds = excluded.age_seconds,
           gap_count = excluded.gap_count,
           last_candle_at = excluded.last_candle_at,
           expected_at = excluded.expected_at,
           detail = excluded.detail,
           checked_at = now()`,
    params,
  );
}

export async function listQuality(client: SqlClient): Promise<QualityUpdate[]> {
  const rows = await client.query<{
    pair: string;
    timeframe: string;
    status: string;
    age_seconds: number | null;
    gap_count: number;
    last_candle_at: string | Date | null;
    expected_at: string | Date | null;
    detail: string | null;
  }>(
    `select pair, timeframe, status, age_seconds, gap_count, last_candle_at, expected_at, detail
       from market_data_quality order by pair, timeframe`,
  );
  return rows.rows.map((r) => ({
    pair: r.pair,
    timeframe: r.timeframe as Timeframe,
    status: r.status as QualityUpdate['status'],
    ageSeconds: r.age_seconds === null ? null : int(r.age_seconds),
    gapCount: int(r.gap_count),
    lastCandleAt: iso(r.last_candle_at),
    expectedAt: iso(r.expected_at),
    detail: r.detail ?? '',
  }));
}

/** Register/refresh the configured pair universe. */
export async function syncPairs(
  client: SqlClient,
  pairs: { pair: string; priority: number; tier: number; pipSize: number }[],
): Promise<void> {
  if (pairs.length === 0) return;
  const rows = pairs.map((p) => [p.pair, p.priority, p.tier, p.pipSize]);
  const { sql, params } = placeholders(rows);
  await client.query(
    `insert into market_pairs (pair, priority, tier, pip_size)
     values ${sql}
     on conflict (pair) do update
       set priority = excluded.priority, tier = excluded.tier, pip_size = excluded.pip_size, updated_at = now()`,
    params,
  );
}

export async function listPairs(client: SqlClient): Promise<{ pair: string; enabled: boolean; priority: number; tier: number }[]> {
  const rows = await client.query<{ pair: string; enabled: boolean; priority: number; tier: number }>(
    'select pair, enabled, priority, tier from market_pairs order by priority asc, pair asc',
  );
  return rows.rows.map((r) => ({ pair: r.pair, enabled: bool(r.enabled, true), priority: int(r.priority, 100), tier: int(r.tier, 2) }));
}

export async function setPairEnabled(client: SqlClient, pair: string, enabled: boolean): Promise<void> {
  await client.query('update market_pairs set enabled = $2, updated_at = now() where pair = $1', [pair, enabled]);
}

export async function pruneCandles(client: SqlClient, retentionDays: number, timeframes: Timeframe[] = ['M1', 'M3']): Promise<number> {
  const result = await client.query(
    `delete from candles
      where timeframe = any($1::text[])
        and open_time < now() - ($2 || ' days')::interval`,
    [timeframes, String(Math.max(1, retentionDays))],
  );
  return result.rowCount;
}
