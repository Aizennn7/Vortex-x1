/**
 * Market-data ingestion.
 *
 * Design goals:
 *   - Never spend more than the plan allows. The number of requests per cycle
 *     is derived from the pool's remaining minute budget, so an exhausted plan
 *     slows ingestion down instead of triggering a request storm.
 *   - Always converge to full coverage: pairs are refreshed in priority +
 *     staleness order, and a restarted worker backfills its own gap with a
 *     single request per pair (outputsize covers the missing window).
 *   - Record the truth: per-pair freshness and gaps land in
 *     `market_data_quality` and drive both the UI badge and the NO_TRADE gate.
 */

import {
  TIMEFRAME_SECONDS,
  instrumentMeta,
  isMarketOpen,
  toIso,
  type CandleInput,
  type Pair,
} from '@vortex/core';
import { listPairs, countGaps, syncPairs, upsertCandles, upsertQuality, type SqlClient } from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';
import { withJob, type WithJobOptions } from './job.js';

export interface IngestSummary {
  pairsConsidered: number;
  pairsFetched: number;
  candlesInserted: number;
  candlesUpdated: number;
  rejected: number;
  gapsDetected: number;
  skippedForBudget: number;
  exhausted: boolean;
  detail: string[];
}

/** How stale each pair's newest M1 candle is, from persisted data. */
async function lastFetchTimes(db: SqlClient, pairs: string[]): Promise<Map<string, string>> {
  if (pairs.length === 0) return new Map();
  const rows = await db.query<{ pair: string; last_open: string | Date | null }>(
    `select pair, max(open_time) as last_open from candles
      where pair = any($1::text[]) and timeframe = 'M1'
      group by pair`,
    [pairs],
  );
  const map = new Map<string, string>();
  for (const row of rows.rows) {
    if (row.last_open) map.set(row.pair, new Date(row.last_open).toISOString());
  }
  return map;
}

export async function runIngestionCycle(runtime: WorkerRuntime, now = new Date()): Promise<IngestSummary> {
  const cfg = runtime.config;
  /** Suffix that keeps the data source visible wherever quality is reported. */
  const feedLabel = runtime.providerSynthetic
    ? ` · SIMULATED feed (${runtime.provider.name}) — not live market data`
    : ` · source ${runtime.provider.name}`;
  const db = runtime.db.client;
  const summary: IngestSummary = {
    pairsConsidered: 0,
    pairsFetched: 0,
    candlesInserted: 0,
    candlesUpdated: 0,
    rejected: 0,
    gapsDetected: 0,
    skippedForBudget: 0,
    exhausted: false,
    detail: [],
  };

  if (!runtime.db.connected) {
    summary.detail.push('database not connected — ingestion skipped');
    return summary;
  }
  if (!isMarketOpen(now)) {
    summary.detail.push('FX market closed — ingestion skipped');
    return summary;
  }

  const configuredPairs = await listPairs(db);
  const enabledPairs = configuredPairs.filter((p) => p.enabled);
  const pairs =
    enabledPairs.length > 0
      ? enabledPairs.map((p) => p.pair)
      : cfg.pairs;

  if (enabledPairs.length === 0) {
    // First run on an empty database: seed the configured universe.
    await syncPairs(
      db,
      cfg.pairs.map((pair, index) => ({
        pair,
        priority: 10 + index,
        tier: instrumentMeta(pair).tier,
        pipSize: instrumentMeta(pair).pipSize,
      })),
    );
  }

  summary.pairsConsidered = pairs.length;
  if (pairs.length === 0) {
    summary.detail.push('no enabled pairs');
    return summary;
  }

  const { selection, keys } = await runtime.keyPool.selection();
  if (keys.length === 0) {
    summary.exhausted = true;
    summary.detail.push('no provider API keys configured — add a Twelve Data key in the control centre');
    return summary;
  }
  if (!selection.keyId) {
    summary.exhausted = true;
    summary.detail.push(selection.detail);
    return summary;
  }

  const priorityOf = new Map(configuredPairs.map((p) => [p.pair, p.priority]));
  const lastTimes = await lastFetchTimes(db, pairs);
  const maxBudget = Math.max(0, selection.remainingMinute);

  // Refresh interval implied by capacity: with N pairs and B requests/minute a
  // pair can be refreshed every N/B minutes. We never pretend otherwise.
  const refreshMinutes = Math.max(1, Math.ceil(pairs.length / Math.max(1, maxBudget)));
  const staleThresholdMs = refreshMinutes * TIMEFRAME_SECONDS.M1 * 1000;

  const ordered = [...pairs].sort((a, b) => {
    const aLast = lastTimes.get(a) ? new Date(lastTimes.get(a) as string).getTime() : 0;
    const bLast = lastTimes.get(b) ? new Date(lastTimes.get(b) as string).getTime() : 0;
    if (aLast !== bLast) return aLast - bLast; // most stale first
    return (priorityOf.get(a) ?? 100) - (priorityOf.get(b) ?? 100) || a.localeCompare(b);
  });

  const due = ordered.filter((pair) => {
    const last = lastTimes.get(pair);
    if (!last) return true;
    return now.getTime() - (new Date(last).getTime() + TIMEFRAME_SECONDS.M1 * 1000) >= staleThresholdMs - TIMEFRAME_SECONDS.M1 * 1000;
  });

  const budget = Math.min(maxBudget, due.length, runtime.config.providerMaxAttempts * 8);
  const targets = due.slice(0, budget);
  summary.skippedForBudget = Math.max(0, due.length - targets.length);

  const qualityUpdates: Parameters<typeof upsertQuality>[1] = [];

  for (const pair of targets) {
    if (runtime.stopping) break;
    const last = lastTimes.get(pair);
    const gapMinutes = last
      ? Math.max(1, Math.ceil((now.getTime() - new Date(last).getTime()) / 60_000))
      : 240;
    // One request covers the whole gap (up to the provider's 5000-bar cap),
    // which is what makes a restart cheap to recover from.
    const outputsize = Math.min(600, Math.max(5, gapMinutes + 5));

    const result = await runtime.keyPool.call<{ candles: CandleInput[] }>(
      { endpoint: 'time_series', pair, timeframe: 'M1', credits: 1 },
      async (apiKey) => {
        const series = await runtime.provider.fetchTimeSeries(
          { pair, timeframe: 'M1', outputsize },
          apiKey,
        );
        return { candles: series.candles };
      },
    );

    if (!result.ok || !result.value) {
      summary.detail.push(`${pair}: ${result.error ?? 'fetch failed'}`);
      if (result.exhausted) {
        summary.exhausted = true;
        break;
      }
      continue;
    }

    summary.pairsFetched += 1;
    const written = await upsertCandles(db, result.value.candles);
    summary.candlesInserted += written.inserted;
    summary.candlesUpdated += written.updated;
    summary.rejected += written.rejected;
    runtime.bump('candlesIngested', written.inserted + written.updated);

    if (written.gaps.length > 0) {
      const gapCheck = await countGaps(db, {
        pair,
        timeframe: 'M1',
        from: toIso(now.getTime() - 24 * 3600 * 1000),
        to: toIso(now),
        stepSeconds: 60,
      });
      summary.gapsDetected += gapCheck.gaps;
      qualityUpdates.push({
        pair,
        timeframe: 'M1',
        status: written.gaps.length > 0 || gapCheck.gaps > 0 ? 'DEGRADED' : 'CONNECTED',
        ageSeconds: 0,
        gapCount: gapCheck.gaps,
        lastCandleAt: result.value.candles.length
          ? toIso(result.value.candles[result.value.candles.length - 1]!.openTime)
          : null,
        expectedAt: toIso(Math.floor(now.getTime() / 60_000) * 60_000 - 60_000),
        detail:
          (written.gaps.length > 0
            ? `gap inside the fetched window (${written.gaps.length} candle(s)) — queued for backfill`
            : 'fresh') + feedLabel,
      });
    } else {
      const newest = result.value.candles[result.value.candles.length - 1];
      const expectedOpen = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000;
      const newestMs = newest ? new Date(newest.openTime).getTime() : 0;
      const behindMinutes = newest ? Math.max(0, Math.round((expectedOpen - newestMs) / 60_000)) : 999;
      qualityUpdates.push({
        pair,
        timeframe: 'M1',
        status: behindMinutes <= 1 ? 'CONNECTED' : behindMinutes <= 5 ? 'DEGRADED' : 'DISCONNECTED',
        ageSeconds: newest ? Math.round((now.getTime() - (newestMs + 60_000)) / 1000) : null,
        gapCount: 0,
        lastCandleAt: newest ? toIso(newest.openTime) : null,
        expectedAt: toIso(expectedOpen),
        detail: (behindMinutes <= 1 ? 'fresh' : `${behindMinutes} minute(s) behind the expected boundary`) + feedLabel,
      });
    }
  }

  // Pairs we could not touch this cycle still need an honest freshness row.
  for (const pair of pairs) {
    if (qualityUpdates.some((u) => u.pair === pair)) continue;
    const last = lastTimes.get(pair);
    const ageSeconds = last ? Math.round((now.getTime() - (new Date(last).getTime() + 60_000)) / 1000) : null;
    const expectedOpen = Math.floor(now.getTime() / 60_000) * 60_000 - 60_000;
    qualityUpdates.push({
      pair,
      timeframe: 'M1',
      status: ageSeconds === null ? 'NOT VERIFIED' : ageSeconds <= 90 ? 'CONNECTED' : ageSeconds <= 600 ? 'DEGRADED' : 'DISCONNECTED',
      ageSeconds,
      gapCount: 0,
      lastCandleAt: last ? toIso(last) : null,
      expectedAt: toIso(expectedOpen),
      detail:
        (ageSeconds === null ? 'no candles stored yet' : `last candle ${ageSeconds}s old (not refreshed this cycle)`) +
        feedLabel,
    });
  }

  if (qualityUpdates.length > 0) await upsertQuality(db, qualityUpdates);

  summary.detail.push(
    `refreshed ${summary.pairsFetched}/${targets.length} due pairs (${summary.skippedForBudget} deferred for budget); ` +
      `${summary.candlesInserted} new candle(s)`,
  );
  return summary;
}

/** Wrap ingestion in the idempotent job ledger (one slot per minute). */
export async function runIngestionJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const slot = `ingest-${toIso(Math.floor(now.getTime() / 60_000) * 60_000)}`;
  return withJob(
    runtime,
    'ingest_market_data',
    slot,
    async () => {
      const summary = await runIngestionCycle(runtime, now);
      return { status: summary.exhausted ? 'SKIPPED' : 'SUCCEEDED', detail: { ...summary } };
    },
    { staleAfterSeconds: 180, alertCode: 'ingest-failing', ...options },
  );
}

export type { Pair };
