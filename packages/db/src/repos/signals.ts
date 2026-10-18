/**
 * Signal persistence and lifecycle.
 *
 * Idempotency is enforced twice over:
 *   - `idempotency_key` unique — one row per opportunity;
 *   - unique (pair, scheduled_entry_at, direction) — a scheduler replay or a
 *     second worker cannot create a duplicate signal for the same instant.
 */

import type {
  Direction,
  Outcome,
  PredictionContext,
  Regime,
  SignalRecord,
  SignalStatus,
  Timeframe,
} from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { int, iso, isoRequired, json, num, numOrNull, text } from './rows.js';

export interface SignalRow {
  id: string;
  idempotency_key: string;
  pair: string;
  direction: string;
  decision: string;
  status: string;
  strategy: string;
  timeframe: string;
  confidence: string | number;
  regime: string;
  scheduled_entry_at: string | Date;
  publish_at: string | Date;
  published_at: string | Date | null;
  horizon_seconds: number;
  reference_price: string | number;
  entry_price: string | number | null;
  exit_price: string | number | null;
  stop_pips: string | number;
  target_pips: string | number;
  reward_risk: string | number;
  spread_pips?: string | number;
  reasons: unknown;
  warnings: unknown;
  context: unknown;
  model_version_id: string | null;
  model_probability: string | number | null;
  engine_version: string;
  outcome: string | null;
  outcome_rule: string | null;
  outcome_flags?: unknown;
  outcome_detail?: string | null;
  gross_pips?: string | number | null;
  cost_pips?: string | number | null;
  realized_pips: string | number | null;
  mfe_pips: string | number | null;
  mae_pips: string | number | null;
  settled_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export function rowToSignalRecord(row: SignalRow): SignalRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    pair: row.pair,
    direction: row.direction as Direction,
    decision: row.decision as SignalRecord['decision'],
    status: row.status as SignalStatus,
    strategy: row.strategy,
    timeframe: row.timeframe as Timeframe,
    confidence: num(row.confidence),
    regime: row.regime as Regime,
    scheduledEntryAt: isoRequired(row.scheduled_entry_at),
    publishAt: isoRequired(row.publish_at),
    publishedAt: iso(row.published_at),
    horizonSeconds: int(row.horizon_seconds, 60),
    referencePrice: num(row.reference_price),
    stopPips: num(row.stop_pips),
    targetPips: num(row.target_pips),
    rewardRisk: num(row.reward_risk),
    spreadPips: numOrNull(row.spread_pips),
    reasons: json<string[]>(row.reasons, []),
    warnings: json<string[]>(row.warnings, []),
    context: json<PredictionContext>(row.context, {} as PredictionContext),
    modelVersionId: row.model_version_id,
    modelProbability: numOrNull(row.model_probability),
    engineVersion: row.engine_version,
    outcome: (row.outcome as Outcome | null) ?? null,
    settledAt: iso(row.settled_at),
    entryPrice: numOrNull(row.entry_price),
    exitPrice: numOrNull(row.exit_price),
    realizedPips: numOrNull(row.realized_pips),
    mfePips: numOrNull(row.mfe_pips),
    maePips: numOrNull(row.mae_pips),
    outcomeRule: row.outcome_rule,
    outcomeDetail: row.outcome_detail ?? null,
    outcomeFlags: json<string[]>(row.outcome_flags, []),
    grossPips: numOrNull(row.gross_pips),
    costPips: numOrNull(row.cost_pips),
    createdAt: isoRequired(row.created_at),
    updatedAt: isoRequired(row.updated_at),
  };
}

const SIGNAL_COLUMNS = `id, idempotency_key, pair, direction, decision, status, strategy, timeframe, confidence, regime,
  scheduled_entry_at, publish_at, published_at, horizon_seconds, reference_price, entry_price, exit_price,
  stop_pips, target_pips, reward_risk, spread_pips, reasons, warnings, context, model_version_id, model_probability,
  engine_version, outcome, outcome_rule, outcome_flags, outcome_detail, gross_pips, cost_pips,
  realized_pips, mfe_pips, mae_pips, settled_at, created_at, updated_at`;

export interface NewSignal {
  idempotencyKey: string;
  pair: string;
  direction: Direction;
  decision: Direction | 'NO_TRADE';
  strategy: string;
  timeframe: Timeframe;
  confidence: number;
  regime: Regime;
  scheduledEntryAt: string;
  publishAt: string;
  horizonSeconds: number;
  referencePrice: number;
  stopPips: number;
  targetPips: number;
  rewardRisk: number;
  spreadPips: number;
  reasons: string[];
  warnings: string[];
  context: PredictionContext;
  features: number[];
  modelVersionId: string | null;
  modelProbability: number | null;
  engineVersion: string;
}

/**
 * Insert a signal. Returns `created: false` when the opportunity already
 * exists, which is how duplicate jobs and duplicate worker cycles are
 * neutralised.
 */
export async function insertSignal(
  client: SqlClient,
  signal: NewSignal,
): Promise<{ created: boolean; record: SignalRecord | null }> {
  const rows = await client.query<SignalRow>(
    `insert into signals
       (idempotency_key, pair, direction, decision, strategy, timeframe, confidence, regime,
        scheduled_entry_at, publish_at, horizon_seconds, reference_price, stop_pips, target_pips,
        reward_risk, spread_pips, reasons, warnings, context, features, model_version_id,
        model_probability, engine_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     on conflict (idempotency_key) do nothing
     returning ${SIGNAL_COLUMNS}`,
    [
      signal.idempotencyKey,
      signal.pair,
      signal.direction,
      signal.decision,
      signal.strategy,
      signal.timeframe,
      signal.confidence,
      signal.regime,
      signal.scheduledEntryAt,
      signal.publishAt,
      signal.horizonSeconds,
      signal.referencePrice,
      signal.stopPips,
      signal.targetPips,
      signal.rewardRisk,
      signal.spreadPips,
      JSON.stringify(signal.reasons),
      JSON.stringify(signal.warnings),
      JSON.stringify(signal.context),
      JSON.stringify(signal.features),
      signal.modelVersionId,
      signal.modelProbability,
      signal.engineVersion,
    ],
  );
  const row = rows.rows[0];
  if (!row) {
    const existing = await client.query<SignalRow>(
      `select ${SIGNAL_COLUMNS} from signals where idempotency_key = $1`,
      [signal.idempotencyKey],
    );
    return { created: false, record: existing.rows[0] ? rowToSignalRecord(existing.rows[0]) : null };
  }
  return { created: true, record: rowToSignalRecord(row) };
}

/** Signals whose publish instant has arrived but that are still PLANNED. */
export async function dueForPublish(client: SqlClient, now: string, lookaheadSeconds = 30): Promise<SignalRecord[]> {
  const rows = await client.query<SignalRow>(
    `select ${SIGNAL_COLUMNS} from signals
      where status = 'PLANNED'
        and publish_at <= ($1::timestamptz + ($2 || ' seconds')::interval)
        and scheduled_entry_at > $1::timestamptz
      order by scheduled_entry_at asc
      limit 100`,
    [now, String(lookaheadSeconds)],
  );
  return rows.rows.map(rowToSignalRecord);
}

export async function markPublished(client: SqlClient, ids: string[], publishedAt: string): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await client.query(
    `update signals set status = 'PUBLISHED', published_at = $2, updated_at = now()
      where id = any($1::uuid[]) and status = 'PLANNED'`,
    [ids, publishedAt],
  );
  return result.rowCount;
}

/** Promote published signals whose entry instant has passed to ACTIVE. */
export async function activateDue(client: SqlClient, now: string): Promise<number> {
  const result = await client.query(
    `update signals set status = 'ACTIVE', updated_at = now()
      where status = 'PUBLISHED' and scheduled_entry_at <= $1::timestamptz`,
    [now],
  );
  return result.rowCount;
}

/**
 * Signals that can be settled: entry has passed, the horizon has elapsed and
 * settlement was not attempted too recently.
 */
export async function dueForSettlement(
  client: SqlClient,
  now: string,
  providerLagSeconds: number,
  limit = 200,
): Promise<SignalRecord[]> {
  const rows = await client.query<SignalRow>(
    `select ${SIGNAL_COLUMNS} from signals
      where outcome is null
        and status in ('PUBLISHED','ACTIVE','EXPIRED')
        and scheduled_entry_at + (horizon_seconds || ' seconds')::interval
            <= ($1::timestamptz - ($2 || ' seconds')::interval)
        and scheduled_entry_at >= $1::timestamptz - interval '2 days'
      order by scheduled_entry_at asc
      limit $3`,
    [now, String(providerLagSeconds), limit],
  );
  return rows.rows.map(rowToSignalRecord);
}

export interface SettlementUpdate {
  id: string;
  outcome: Outcome;
  status: SignalStatus;
  entryPrice: number | null;
  exitPrice: number | null;
  grossPips: number | null;
  costPips: number | null;
  realizedPips: number | null;
  mfePips: number | null;
  maePips: number | null;
  outcomeRule: string;
  outcomeFlags: string[];
  outcomeDetail: string;
}

/**
 * Apply a settlement. Guarded by `outcome is null` so a duplicate settlement
 * (retry, second worker, restart) cannot overwrite a verdict.
 */
export async function applySettlement(client: SqlClient, update: SettlementUpdate): Promise<boolean> {
  const result = await client.query(
    `update signals set
       outcome = $2,
       status = $3,
       entry_price = $4,
       exit_price = $5,
       gross_pips = $6,
       cost_pips = $7,
       realized_pips = $8,
       mfe_pips = $9,
       mae_pips = $10,
       outcome_rule = $11,
       outcome_flags = $12,
       outcome_detail = $13,
       settled_at = now(),
       settlement_attempts = settlement_attempts + 1,
       updated_at = now()
     where id = $1 and outcome is null`,
    [
      update.id,
      update.outcome,
      update.status,
      update.entryPrice,
      update.exitPrice,
      update.grossPips,
      update.costPips,
      update.realizedPips,
      update.mfePips,
      update.maePips,
      update.outcomeRule,
      JSON.stringify(update.outcomeFlags),
      update.outcomeDetail,
    ],
  );
  return result.rowCount > 0;
}

/** Record a failed settlement attempt without inventing an outcome. */
export async function bumpSettlementAttempt(client: SqlClient, id: string): Promise<void> {
  await client.query('update signals set settlement_attempts = settlement_attempts + 1 where id = $1', [id]);
}

/**
 * Expire signals that never published because the lead time was missed.
 * They are marked CANCELLED, never silently dropped.
 */
export async function cancelMissedPublishing(client: SqlClient, now: string, graceSeconds = 5): Promise<number> {
  const result = await client.query(
    `update signals set status = 'CANCELLED', outcome = null, outcome_detail = 'publish window missed before entry',
            outcome_rule = 'not_published', updated_at = now()
      where status = 'PLANNED'
        and scheduled_entry_at <= ($1::timestamptz - ($2 || ' seconds')::interval)`,
    [now, String(graceSeconds)],
  );
  return result.rowCount;
}

/** Signals stuck in PLANNED past their entry for longer than the guard. */
export async function listStuck(client: SqlClient, now: string, olderThanSeconds = 300): Promise<SignalRecord[]> {
  const rows = await client.query<SignalRow>(
    `select ${SIGNAL_COLUMNS} from signals
      where status in ('PLANNED','PUBLISHED','ACTIVE')
        and scheduled_entry_at < ($1::timestamptz - ($2 || ' seconds')::interval)
      order by scheduled_entry_at asc limit 100`,
    [now, String(olderThanSeconds)],
  );
  return rows.rows.map(rowToSignalRecord);
}

export interface SignalQuery {
  pairs?: string[];
  strategies?: string[];
  outcomes?: Outcome[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  statuses?: SignalStatus[];
}

export async function listSignals(client: SqlClient, query: SignalQuery = {}): Promise<SignalRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query.pairs && query.pairs.length > 0) {
    values.push(query.pairs);
    conditions.push(`pair = any($${values.length}::text[])`);
  }
  if (query.strategies && query.strategies.length > 0) {
    values.push(query.strategies);
    conditions.push(`strategy = any($${values.length}::text[])`);
  }
  if (query.outcomes && query.outcomes.length > 0) {
    values.push(query.outcomes);
    conditions.push(`outcome = any($${values.length}::text[])`);
  }
  if (query.statuses && query.statuses.length > 0) {
    values.push(query.statuses);
    conditions.push(`status = any($${values.length}::text[])`);
  }
  if (query.from) {
    values.push(query.from);
    conditions.push(`scheduled_entry_at >= $${values.length}::timestamptz`);
  }
  if (query.to) {
    values.push(query.to);
    conditions.push(`scheduled_entry_at <= $${values.length}::timestamptz`);
  }
  values.push(Math.min(query.limit ?? 200, 2000));
  const limitIdx = values.length;
  values.push(query.offset ?? 0);
  const offsetIdx = values.length;
  const rows = await client.query<SignalRow>(
    `select ${SIGNAL_COLUMNS} from signals
      ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
      order by scheduled_entry_at desc
      limit $${limitIdx} offset $${offsetIdx}`,
    values,
  );
  return rows.rows.map(rowToSignalRecord);
}

/**
 * Raw records for the learning dataset (includes features + flags).
 *
 * `excludedEngines` drops rows stored under an engine version whose
 * feature encoding is no longer trustworthy (e.g. after a feature-set
 * change), so stale-format rows cannot silently enter a training set.
 * The learning layer re-filters DRAW/UNRESOLVED records regardless.
 */
export async function listResolvedForLearning(
  client: SqlClient,
  params: { limit?: number; sinceDays?: number; excludedEngines?: string[] } = {},
): Promise<
  {
    signalId: string;
    pair: string;
    strategy: string;
    regime: string;
    confidence: number;
    decidedAt: string;
    horizonSeconds: number;
    outcome: Outcome | null;
    outcomeFlags: string[];
    features: number[] | null;
    modelProbability: number | null;
    engineVersion: string;
  }[]
> {
  const excluded = params.excludedEngines ?? [];
  // Parameter positions are built in order so the optional engine
  // exclusion can sit between the time window and the limit.
  const values: unknown[] = [String(params.sinceDays ?? 365)];
  const conditions = [
    `scheduled_entry_at >= now() - ($1 || ' days')::interval`,
    `outcome is not null`,
  ];
  if (excluded.length > 0) {
    values.push(excluded);
    conditions.push(`engine_version <> all($${values.length}::text[])`);
  }
  values.push(Math.min(params.limit ?? 50_000, 200_000));
  const rows = await client.query<{
    id: string;
    pair: string;
    strategy: string;
    regime: string;
    confidence: string | number;
    scheduled_entry_at: string | Date;
    horizon_seconds: number;
    outcome: string | null;
    outcome_flags: unknown;
    features: unknown;
    model_probability: string | number | null;
    engine_version: string;
  }>(
    `select id, pair, strategy, regime, confidence, scheduled_entry_at, horizon_seconds,
            outcome, outcome_flags, features, model_probability, engine_version
       from signals
      where ${conditions.join('\n        and ')}
      order by scheduled_entry_at asc
      limit $${values.length}`,
    values,
  );
  return rows.rows.map((r) => ({
    signalId: r.id,
    pair: r.pair,
    strategy: r.strategy,
    regime: r.regime,
    confidence: num(r.confidence),
    decidedAt: isoRequired(r.scheduled_entry_at),
    horizonSeconds: int(r.horizon_seconds, 60),
    outcome: (r.outcome as Outcome | null) ?? null,
    outcomeFlags: json<string[]>(r.outcome_flags, []),
    features: json<number[] | null>(r.features, null),
    modelProbability: numOrNull(r.model_probability),
    engineVersion: text(r.engine_version, 'unknown'),
  }));
}

export async function signalCounts(client: SqlClient): Promise<Record<string, number>> {
  const rows = await client.query<{ outcome: string | null; status: string; count: string }>(
    'select outcome, status, count(*)::text as count from signals group by outcome, status',
  );
  const out: Record<string, number> = {};
  for (const row of rows.rows) {
    const key = row.outcome ?? `PENDING:${row.status}`;
    out[key] = (out[key] ?? 0) + int(row.count);
  }
  return out;
}
