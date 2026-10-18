/**
 * Model-registry + learning-history summary for the public status surface.
 *
 * Shared by the relay (`GET /api/summary`) and the static snapshot exporter so
 * every deployment mode reports the same facts about the deployed model. Only
 * registry metadata is exposed — coefficients, feature standardization means
 * and dataset contents stay server-side.
 */

import {
  byPair,
  byRegime,
  byStrategy,
  confidenceCalibration,
  summarize,
  type PerformanceBreakdown,
} from '@vortex/core';
import type { ModelVersion, SqlClient } from '@vortex/db';
import { listLearningRuns, listModelVersions, listSignals } from '@vortex/db';

export interface ModelMetricsView {
  accuracy: number | null;
  /** Mean of per-class recall; 0.5 means chance. */
  balancedAccuracy: number | null;
  auc: number | null;
  logLoss: number | null;
  brier: number | null;
  ece: number | null;
  samples: number | null;
  baseRate: number | null;
}

export interface ModelSummaryView {
  champion: {
    versionId: string;
    version: string;
    promotedAt: string | null;
    datasetSize: number | null;
    datasetFrom: string | null;
    datasetTo: string | null;
    metrics: ModelMetricsView | null;
    walkForward: { fold: number; trainSize: number | null; validationSize: number | null; accuracy: number | null }[];
  } | null;
  candidateCount: number;
  rejectedCount: number;
  archivedCount: number;
  note: string;
}

export interface LearningSummaryView {
  lastRun: {
    startedAt: string;
    finishedAt: string | null;
    status: string;
    datasetSize: number | null;
    datasetFrom: string | null;
    datasetTo: string | null;
    reason: string | null;
  } | null;
  counts: Record<string, number>;
  note: string;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toModelSummary(versions: ModelVersion[]): ModelSummaryView {
  const champion = versions.find((v) => v.status === 'CHAMPION') ?? null;
  const metrics = champion?.metrics ?? null;
  return {
    champion: champion
      ? {
          versionId: champion.id,
          version: champion.version,
          promotedAt: champion.promotedAt,
          datasetSize: champion.datasetSize,
          datasetFrom: champion.datasetFrom,
          datasetTo: champion.datasetTo,
          metrics: metrics
            ? {
                accuracy: num(metrics.accuracy),
                balancedAccuracy: num(metrics.balancedAccuracy),
                auc: num(metrics.auc),
                logLoss: num(metrics.logLoss),
                brier: num(metrics.brier),
                ece: num(metrics.ece),
                samples: num(metrics.samples),
                baseRate: num(metrics.baseRate),
              }
            : null,
          walkForward: (champion.walkForward ?? []).map((fold) => ({
            fold: fold.fold,
            trainSize: fold.trainSize ?? null,
            validationSize: fold.validationSize ?? null,
            accuracy: num(fold.metrics?.accuracy),
          })),
        }
      : null,
    candidateCount: versions.filter((v) => v.status === 'CANDIDATE').length,
    rejectedCount: versions.filter((v) => v.status === 'REJECTED').length,
    archivedCount: versions.filter((v) => v.status === 'ARCHIVED').length,
    note: champion
      ? 'The champion is the only model allowed to contribute a probability to new signals; candidates are evaluated but never used for trading decisions.'
      : versions.length === 0
        ? 'No model has been trained yet. Signals run on the rule ensemble alone, with no model probability attached — that is a valid operating state, not a failure.'
        : 'No champion is active: candidates were rejected by the promotion gates, so the rule ensemble keeps serving signals.',
  };
}

export function toLearningSummary(
  runs: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    datasetSize: number | null;
    datasetFrom: string | null;
    datasetTo: string | null;
    error: string | null;
  }[],
): LearningSummaryView {
  const ordered = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const last = ordered[0] ?? null;
  const counts: Record<string, number> = {};
  for (const run of ordered) counts[run.status] = (counts[run.status] ?? 0) + 1;
  return {
    lastRun: last
      ? {
          startedAt: last.startedAt,
          finishedAt: last.finishedAt,
          status: last.status,
          datasetSize: last.datasetSize,
          datasetFrom: last.datasetFrom,
          datasetTo: last.datasetTo,
          reason: last.error ?? null,
        }
      : null,
    counts,
    note:
      'A run is skipped when the labelled dataset is unchanged or too small — that is the intended behaviour, not a stalled job. Promotion requires every gate to pass; a rejection keeps the previous champion.',
  };
}

/**
 * Total deliveries in one ledger status, summed across delivery kinds
 * (PUBLISH/SETTLEMENT). `deliveryStats` aggregates the whole table, so
 * these are true totals — never a bounded sample of recent rows.
 */
export function deliveryTotal(stats: Record<string, number>, status: string): number {
  let total = 0;
  for (const [key, count] of Object.entries(stats)) {
    if (key.endsWith(`:${status}`)) total += count;
  }
  return total;
}

/** Read the registry views without throwing when the tables are absent. */
export async function modelRegistrySummary(
  client: SqlClient,
): Promise<{ model: ModelSummaryView | null; learning: LearningSummaryView | null; error: string | null }> {
  try {
    const [versions, runs] = await Promise.all([listModelVersions(client, 25), listLearningRuns(client, 20)]);
    return {
      model: toModelSummary(versions),
      learning: toLearningSummary(
        runs.map((r) => ({
          id: r.id,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          status: r.status,
          datasetSize: r.datasetSize,
          datasetFrom: r.datasetFrom,
          datasetTo: r.datasetTo,
          error: r.error,
        })),
      ),
      error: null,
    };
  } catch (error) {
    // The registry is optional read-only decoration: a missing table must
    // degrade the panel, never break the whole status response.
    return { model: null, learning: null, error: (error as Error).message };
  }
}

/* ------------------------------------------------------------------------- */
/* Opportunity scan (shared by the relay and the snapshot exporter)           */
/* ------------------------------------------------------------------------- */

export interface ScanSummaryView {
  ranAt: string;
  slot: string | null;
  evaluated: number;
  published: number;
  noTrade: boolean;
  blocked: number;
  bestMiss: string | null;
  notes: string[];
}

/**
 * Compact, secret-free view of the most recent opportunity scan.
 *
 * Without it the dashboard can only show an empty signal table, which is
 * indistinguishable from a broken pipeline. `bestMiss` is produced by the
 * engine as `PAIR (gate, gate)` — the pair that came closest and the exact
 * gates that rejected it. Values come straight from the recorded job detail;
 * nothing is estimated.
 */
export function summarizeScan(
  job: { finishedAt: string | null; startedAt: string; slotKey: string; detail: Record<string, unknown> } | null,
): ScanSummaryView | null {
  if (!job) return null;
  const detail = (job.detail ?? {}) as Record<string, unknown>;
  const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const notes = Array.isArray(detail.detail)
    ? (detail.detail as unknown[]).filter((n): n is string => typeof n === 'string').slice(0, 4)
    : [];
  return {
    ranAt: job.finishedAt ?? job.startedAt,
    slot: typeof detail.slot === 'string' ? detail.slot : (job.slotKey ?? null),
    evaluated: count(detail.evaluated),
    published: count(detail.published),
    noTrade: detail.noTrade === true,
    blocked: count(detail.blocked),
    bestMiss: typeof detail.bestMiss === 'string' ? detail.bestMiss : null,
    notes,
  };
}

/* ------------------------------------------------------------------------- */
/* Performance breakdowns (shared by the relay and the snapshot exporter)     */
/* ------------------------------------------------------------------------- */

export interface PerformanceOverviewView {
  overall: ReturnType<typeof summarize>;
  byPair: PerformanceBreakdown[];
  byStrategy: PerformanceBreakdown[];
  byRegime: PerformanceBreakdown[];
  calibration: ReturnType<typeof confidenceCalibration>;
  sampleSize: number;
  note: string;
}

/**
 * One implementation of the performance numbers, used by `GET /api/performance`
 * and the static snapshot so the two can never disagree. Denominators stay
 * explicit: unresolved rows are counted separately and never become wins.
 */
export async function performanceOverview(client: SqlClient, limit = 2000): Promise<PerformanceOverviewView> {
  const rows = await listSignals(client, { limit });
  return {
    overall: summarize(rows),
    byPair: byPair(rows),
    byStrategy: byStrategy(rows),
    byRegime: byRegime(rows),
    calibration: confidenceCalibration(rows, 5),
    sampleSize: rows.length,
    note: 'Accuracy uses decisive outcomes only; unresolved records are reported separately and never counted as wins. Pips are paper results net of the modelled spread and slippage.',
  };
}
