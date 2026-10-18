/**
 * Signal generation, timing and pre-entry publication.
 *
 * Cadence model (defaults: cadence 5 min, lead 60 s, horizon 60 s):
 *
 *   T-60s  publish window opens  → evaluate every enabled pair
 *   T-60s  signal inserted + Telegram published (status PLANNED → PUBLISHED)
 *   T      scheduled entry        → status ACTIVE
 *   T+60s  horizon ends           → settlement job reads the closing price
 *
 * NO-TRADE is respected: if nothing clears the gates, nothing is published and
 * the closest miss is recorded for the operator with the exact failed gates.
 */

import {
  planNextSlot,
  publishability,
  signalIdempotencyKey,
  toIso,
  secondsUntil,
  type Direction,
} from '@vortex/core';
import {
  cancelMissedPublishing,
  insertSignal,
  listSignals,
  markPublished,
  raiseAlert,
  activateDue,
} from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';
import { runIngestionCycle } from './ingest.js';
import { withJob, type WithJobOptions } from './job.js';
import type { PreparedOpportunity } from '../services/engine.js';

export interface SignalCycleSummary {
  slot: string | null;
  evaluated: number;
  published: number;
  noTrade: number;
  blocked: number;
  bestMiss: string | null;
  detail: string[];
  publishedIds: string[];
}

export async function runSignalCycle(runtime: WorkerRuntime, now = new Date()): Promise<SignalCycleSummary> {
  const cfg = runtime.config;
  const db = runtime.db.client;
  const summary: SignalCycleSummary = {
    slot: null,
    evaluated: 0,
    published: 0,
    noTrade: 0,
    blocked: 0,
    bestMiss: null,
    detail: [],
    publishedIds: [],
  };

  if (!runtime.db.connected) {
    summary.detail.push('database not connected');
    return summary;
  }

  const plan = planNextSlot(now, {
    cadenceMinutes: cfg.scanCadenceMinutes,
    publishLeadSeconds: cfg.publishLeadSeconds,
    horizonSeconds: cfg.signalHorizonSeconds,
    minLeadSeconds: 15,
    respectMarketHours: true,
  });
  if (!plan) {
    summary.detail.push('no publishable slot in the lookahead window (market closed or lead time unavailable)');
    return summary;
  }
  summary.slot = plan.slotKey;

  const window = publishability(now, plan, 10);
  if (!window.ok) {
    summary.detail.push(`slot ${plan.slotKey} not actionable: ${window.reason} (T-entry ${window.secondsToEntry}s)`);
    return summary;
  }

  // Fresh data is a prerequisite: nudge ingestion if the newest closed candle is
  // old. The comparison is made against the cycle's own clock, not the database
  // clock, so a replayed or backfilled cycle judges freshness consistently.
  const newest = await db.query<{ last_open: string | Date | null }>(
    `select max(open_time) as last_open from candles where timeframe = 'M1'`,
  );
  const lastOpen = newest.rows[0]?.last_open ?? null;
  const lag =
    lastOpen === null ? null : Math.round((now.getTime() - (new Date(lastOpen).getTime() + 60_000)) / 1000);
  if (lag === null || lag > cfg.maxCandleAgeSeconds) {
    summary.detail.push(`data lag ${lag ?? 'unknown'}s before scanning — running an ingestion pass first`);
    const ingest = await runIngestionCycle(runtime, now);
    summary.detail.push(...ingest.detail.slice(0, 3));
  }

  const pairs = await enabledPairs(runtime);
  const opportunities: PreparedOpportunity[] = [];
  for (const pair of pairs) {
    if (runtime.stopping) break;
    const opportunity = await runtime.engine.evaluatePair({ pair, now });
    if (!opportunity) {
      summary.detail.push(`${pair}: no usable candles`);
      continue;
    }
    summary.evaluated += 1;
    opportunities.push(opportunity);
  }

  const ranked = runtime.engine.rank(opportunities);
  const maxPerSlot = Math.max(1, Math.min(5, cfg.maxSignalsPerSlot));
  const actionable = ranked.filter((o) => !o.blocked).slice(0, maxPerSlot);

  const bestMiss = ranked.find((o) => o.blocked);
  if (bestMiss) {
    summary.bestMiss = `${bestMiss.pair} (${runtime.engine.summariseBlock(bestMiss)})`;
  }

  for (const opportunity of ranked) {
    if (opportunity.blocked) summary.blocked += 1;
  }

  if (actionable.length === 0) {
    summary.noTrade = summary.evaluated;
    summary.detail.push(
      `NO-TRADE for slot ${plan.slotKey}: ${summary.evaluated} pair(s) evaluated, none cleared the gates` +
        (summary.bestMiss ? `; closest ${summary.bestMiss}` : ''),
    );
    return summary;
  }

  for (const opportunity of actionable) {
    const prediction = runtime.engine.buildPredictionRecord({
      opportunity,
      entryTime: plan.entryTime,
      publishAt: plan.publishAt,
      now: toIso(now),
      horizonSeconds: cfg.signalHorizonSeconds,
    });
    if (prediction.decision === 'NO_TRADE' || !prediction.direction) continue;

    const inserted = await insertSignal(db, {
      idempotencyKey: signalIdempotencyKey({
        pair: prediction.pair,
        entryTime: prediction.entryTime,
        direction: prediction.decision,
        engineVersion: cfg.engineVersion,
      }),
      pair: prediction.pair,
      direction: prediction.direction,
      decision: prediction.decision,
      strategy: prediction.strategy,
      timeframe: 'M1',
      confidence: prediction.confidence,
      regime: prediction.regime,
      scheduledEntryAt: prediction.entryTime,
      publishAt: prediction.publishAt,
      horizonSeconds: prediction.horizonSeconds,
      referencePrice: prediction.referencePrice,
      stopPips: prediction.stopPips,
      targetPips: prediction.targetPips,
      rewardRisk: prediction.rewardRisk,
      spreadPips: prediction.context.spreadPips,
      reasons: prediction.reasons,
      warnings: prediction.warnings,
      context: prediction.context,
      features: Object.values(opportunity.features),
      modelVersionId: prediction.modelVersionId,
      modelProbability: prediction.modelProbability,
      engineVersion: prediction.engineVersion,
    });

    if (!inserted.created || !inserted.record) {
      summary.detail.push(`${prediction.pair}: duplicate opportunity ignored (idempotent)`);
      continue;
    }
    const record = inserted.record;
    runtime.bump('signalsCreated');
    summary.published += 1;
    summary.publishedIds.push(record.id);

    // Publish immediately: the lead time is exactly one minute, so waiting is
    // not an option and would break the promised pre-entry delivery.
    const deliveries = runtime.telegram.enabled
      ? await runtime.telegram.deliverSignal(record, 'PUBLISH')
      : [{ channelLabel: 'none', status: 'SKIPPED' as const, detail: 'Telegram delivery disabled' }];
    const confirmed = deliveries.some((d) => d.status === 'SENT');
    await markPublished(db, [record.id], toIso(now));
    summary.detail.push(
      `${record.pair} ${record.direction} @${record.confidence.toFixed(2)} → entry ${plan.entryTime}` +
        (confirmed ? ' · Telegram confirmed' : ` · Telegram: ${deliveries.map((d) => d.status).join('/')}`),
    );
    if (!confirmed && runtime.telegram.enabled) {
      await raiseAlert(db, {
        severity: 'WARNING',
        code: 'telegram-delivery-failed',
        title: 'Telegram delivery not confirmed for a published signal',
        detail: deliveries.map((d) => `${d.channelLabel}: ${d.status} — ${d.detail}`).join('; '),
        metadata: { signalId: record.id, pair: record.pair },
      }).catch(() => undefined);
    }
  }

  return summary;
}

export async function enabledPairs(runtime: WorkerRuntime): Promise<string[]> {
  const db = runtime.db.client;
  const rows = await db.query<{ pair: string }>(
    'select pair from market_pairs where enabled order by priority asc, pair asc',
  );
  if (rows.rows.length > 0) return rows.rows.map((r) => r.pair);
  return runtime.config.pairs;
}

/**
 * Scheduled entry: promote published signals to ACTIVE and cancel anything that
 * missed its publish window so nothing lingers as a phantom opportunity.
 */
export async function runSignalActivation(runtime: WorkerRuntime, now = new Date()): Promise<{ activated: number; cancelled: number }> {
  const db = runtime.db.client;
  const cancelled = await cancelMissedPublishing(db, toIso(now), 5);
  const activated = await activateDue(db, toIso(now));
  if (cancelled > 0) {
    await raiseAlert(db, {
      severity: 'WARNING',
      code: 'signals-publish-window-missed',
      title: `${cancelled} signal(s) missed their publish window`,
      detail: 'The worker was not running (or was too slow) inside the 60s pre-entry window. Signals are cancelled rather than published late.',
      metadata: { cancelled },
    }).catch(() => undefined);
  }
  return { activated, cancelled };
}

export async function runSignalJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const cfg = runtime.config;
  // Slot key = the cadence boundary we are publishing for, so one cycle per slot.
  const boundary = toIso(Math.floor(now.getTime() / (cfg.scanCadenceMinutes * 60_000)) * cfg.scanCadenceMinutes * 60_000);
  return withJob(
    runtime,
    'signal_cycle',
    `signal-${boundary}`,
    async () => {
      const summary = await runSignalCycle(runtime, now);
      // Keep a compact, structured copy in Actions logs as well as job_runs.
      // This lets operators distinguish no qualifying setup from stale data,
      // market closure, missed timing, and provider failures without DB access.
      runtime.logger.info('signal cycle summary', {
        component: 'signals',
        slot: summary.slot,
        evaluated: summary.evaluated,
        published: summary.published,
        noTradePairs: summary.noTrade,
        blocked: summary.blocked,
        bestMiss: summary.bestMiss,
        detail: summary.detail.slice(0, 10),
      });
      return {
        status: 'SUCCEEDED',
        detail: {
          slot: summary.slot,
          evaluated: summary.evaluated,
          published: summary.published,
          noTrade: summary.evaluated === summary.noTrade,
          blocked: summary.blocked,
          bestMiss: summary.bestMiss,
          detail: summary.detail.slice(0, 10),
        },
      };
    },
    { staleAfterSeconds: 120, alertCode: 'signal-cycle-failing', ...options },
  );
}

export async function runActivationJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const slot = `activation-${toIso(Math.floor(now.getTime() / 15_000) * 15_000)}`;
  return withJob(
    runtime,
    'signal_activation',
    slot,
    async () => {
      const result = await runSignalActivation(runtime, now);
      return { status: 'SUCCEEDED', detail: { ...result } };
    },
    options,
  );
}

/** Upcoming and in-flight signals for the dashboard/relay. */
export async function upcomingSignals(runtime: WorkerRuntime, limit = 20) {
  const db = runtime.db.client;
  const rows = await listSignals(db, { statuses: ['PLANNED', 'PUBLISHED', 'ACTIVE'], limit });
  return rows.map((row) => {
    const seconds = secondsUntil(row.scheduledEntryAt, new Date());
    return { ...row, secondsToEntry: seconds, phase: seconds > 60 ? 'SCHEDULED' : seconds > 0 ? 'IMMINENT' : 'IN_FLIGHT' };
  });
}

export type { Direction };
