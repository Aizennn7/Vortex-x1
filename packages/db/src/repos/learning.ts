/**
 * Model registry, learning runs, strategy weights, drift reports and
 * artifacts. Promotion is transactional and archives the previous champion so
 * a rollback is always one statement away.
 */

import type { EvaluationMetrics, LogisticModel, WalkForwardFold } from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { bool, int, iso, isoRequired, json, num, numOrNull, text } from './rows.js';

export type ModelStatus = 'CANDIDATE' | 'CHAMPION' | 'ARCHIVED' | 'REJECTED';

export interface ModelVersionRow {
  id: string;
  version: string;
  kind: string;
  status: ModelStatus;
  dataset_checksum: string;
  dataset_size: number;
  dataset_from: string | Date | null;
  dataset_to: string | Date | null;
  feature_names: unknown;
  hyper: unknown;
  parameters: unknown;
  metrics: unknown;
  walk_forward: unknown;
  baselines: unknown;
  promotion: unknown;
  artifact_checksum: string | null;
  notes: string | null;
  created_at: string | Date;
  promoted_at: string | Date | null;
  archived_at: string | Date | null;
}

export interface ModelVersion {
  id: string;
  version: string;
  kind: string;
  status: ModelStatus;
  datasetChecksum: string;
  datasetSize: number;
  datasetFrom: string | null;
  datasetTo: string | null;
  featureNames: string[];
  hyper: Record<string, unknown>;
  parameters: Partial<LogisticModel>;
  metrics: Partial<EvaluationMetrics>;
  walkForward: WalkForwardFold[];
  baselines: Record<string, unknown>;
  promotion: Record<string, unknown>;
  artifactChecksum: string | null;
  notes: string | null;
  createdAt: string;
  promotedAt: string | null;
  archivedAt: string | null;
}

export function rowToModelVersion(row: ModelVersionRow): ModelVersion {
  return {
    id: row.id,
    version: row.version,
    kind: row.kind,
    status: row.status,
    datasetChecksum: row.dataset_checksum,
    datasetSize: int(row.dataset_size),
    datasetFrom: iso(row.dataset_from),
    datasetTo: iso(row.dataset_to),
    featureNames: json<string[]>(row.feature_names, []),
    hyper: json<Record<string, unknown>>(row.hyper, {}),
    parameters: json<Partial<LogisticModel>>(row.parameters, {}),
    metrics: json<Partial<EvaluationMetrics>>(row.metrics, {}),
    walkForward: json<WalkForwardFold[]>(row.walk_forward, []),
    baselines: json<Record<string, unknown>>(row.baselines, {}),
    promotion: json<Record<string, unknown>>(row.promotion, {}),
    artifactChecksum: row.artifact_checksum,
    notes: row.notes,
    createdAt: isoRequired(row.created_at),
    promotedAt: iso(row.promoted_at),
    archivedAt: iso(row.archived_at),
  };
}

const MODEL_COLUMNS = `id, version, kind, status, dataset_checksum, dataset_size, dataset_from, dataset_to,
  feature_names, hyper, parameters, metrics, walk_forward, baselines, promotion, artifact_checksum, notes,
  created_at, promoted_at, archived_at`;

export async function insertModelVersion(
  client: SqlClient,
  params: {
    version: string;
    kind?: string;
    status?: ModelStatus;
    datasetChecksum: string;
    datasetSize: number;
    datasetFrom: string | null;
    datasetTo: string | null;
    featureNames: string[];
    hyper: Record<string, unknown>;
    parameters: Record<string, unknown>;
    metrics: Record<string, unknown>;
    walkForward: unknown[];
    baselines: Record<string, unknown>;
    promotion: Record<string, unknown>;
    artifactChecksum?: string | null;
    notes?: string | null;
  },
): Promise<ModelVersion> {
  const rows = await client.query<ModelVersionRow>(
    `insert into model_versions
       (version, kind, status, dataset_checksum, dataset_size, dataset_from, dataset_to, feature_names,
        hyper, parameters, metrics, walk_forward, baselines, promotion, artifact_checksum, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning ${MODEL_COLUMNS}`,
    [
      params.version,
      params.kind ?? 'logistic_regression',
      params.status ?? 'CANDIDATE',
      params.datasetChecksum,
      params.datasetSize,
      params.datasetFrom,
      params.datasetTo,
      JSON.stringify(params.featureNames),
      JSON.stringify(params.hyper),
      JSON.stringify(params.parameters),
      JSON.stringify(params.metrics),
      JSON.stringify(params.walkForward),
      JSON.stringify(params.baselines),
      JSON.stringify(params.promotion),
      params.artifactChecksum ?? null,
      params.notes ?? null,
    ],
  );
  return rowToModelVersion(rows.rows[0] as ModelVersionRow);
}

export async function getChampion(client: SqlClient, kind = 'logistic_regression'): Promise<ModelVersion | null> {
  const rows = await client.query<ModelVersionRow>(
    `select ${MODEL_COLUMNS} from model_versions where status = 'CHAMPION' and kind = $1 limit 1`,
    [kind],
  );
  return rows.rows[0] ? rowToModelVersion(rows.rows[0]) : null;
}

export async function listModelVersions(client: SqlClient, limit = 50): Promise<ModelVersion[]> {
  const rows = await client.query<ModelVersionRow>(
    `select ${MODEL_COLUMNS} from model_versions order by created_at desc limit $1`,
    [limit],
  );
  return rows.rows.map(rowToModelVersion);
}

/** Read one model version, including the stored promotion decision. Read-only. */
export async function getModelVersion(client: SqlClient, id: string): Promise<ModelVersion | null> {
  const rows = await client.query<ModelVersionRow>(`select ${MODEL_COLUMNS} from model_versions where id = $1`, [id]);
  return rows.rows[0] ? rowToModelVersion(rows.rows[0]) : null;
}

/**
 * Promote a candidate: archive the incumbent, then activate the candidate, in
 * one transaction. Returns the previous champion id for rollback.
 */
export async function promoteModel(
  client: SqlClient,
  params: { candidateId: string; promotion: Record<string, unknown>; actor: string },
): Promise<{ promoted: boolean; previousChampionId: string | null; reason: string }> {
  return client.transaction(async (tx) => {
    const candidate = await tx.query<{ id: string; status: string; version: string }>(
      'select id, status, version from model_versions where id = $1 for update',
      [params.candidateId],
    );
    const row = candidate.rows[0];
    if (!row) return { promoted: false, previousChampionId: null, reason: 'candidate not found' };
    if (row.status === 'CHAMPION') return { promoted: false, previousChampionId: null, reason: 'already champion' };
    if (row.status === 'ARCHIVED' || row.status === 'REJECTED') {
      return { promoted: false, previousChampionId: null, reason: `candidate is ${row.status}` };
    }
    const current = await tx.query<{ id: string }>(
      `select id from model_versions where status = 'CHAMPION' for update`,
    );
    const previousChampionId = current.rows[0]?.id ?? null;
    if (previousChampionId) {
      await tx.query(`update model_versions set status = 'ARCHIVED', archived_at = now() where id = $1`, [
        previousChampionId,
      ]);
    }
    await tx.query(
      `update model_versions set status = 'CHAMPION', promoted_at = now(), promotion = $2 where id = $1`,
      [params.candidateId, JSON.stringify(params.promotion)],
    );
    await tx.query(
      `insert into audit_log (actor, action, target, detail) values ($1, 'model.promote', $2, $3)`,
      [params.actor, row.version, JSON.stringify({ previousChampionId, ...params.promotion })],
    );
    return { promoted: true, previousChampionId, reason: 'promoted' };
  });
}

/** Roll a model back: archive the current champion and re-activate a previous one. */
export async function rollbackModel(
  client: SqlClient,
  params: { targetId: string; actor: string; reason: string },
): Promise<{ rolledBack: boolean; reason: string }> {
  return client.transaction(async (tx) => {
    const target = await tx.query<{ id: string; version: string; status: string }>(
      'select id, version, status from model_versions where id = $1 for update',
      [params.targetId],
    );
    const row = target.rows[0];
    if (!row) return { rolledBack: false, reason: 'target not found' };
    await tx.query(`update model_versions set status = 'ARCHIVED', archived_at = now() where status = 'CHAMPION'`);
    await tx.query(`update model_versions set status = 'CHAMPION', promoted_at = now(), archived_at = null where id = $1`, [
      params.targetId,
    ]);
    await tx.query(`insert into audit_log (actor, action, target, detail) values ($1, 'model.rollback', $2, $3)`, [
      params.actor,
      row.version,
      JSON.stringify({ reason: params.reason }),
    ]);
    return { rolledBack: true, reason: `restored ${row.version}` };
  });
}

export async function rejectModel(client: SqlClient, candidateId: string, reason: string): Promise<void> {
  await client.query(`update model_versions set status = 'REJECTED', notes = $2 where id = $1 and status = 'CANDIDATE'`, [
    candidateId,
    reason,
  ]);
}

/* ------------------------------------------------------------- learning runs */

export async function startLearningRun(
  client: SqlClient,
  params: { workerId: string },
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `insert into learning_runs (worker_id, status) values ($1, 'RUNNING') returning id`,
    [params.workerId],
  );
  return rows.rows[0]?.id ?? '';
}

export async function finishLearningRun(
  client: SqlClient,
  params: {
    id: string;
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
    datasetChecksum?: string | null;
    datasetSize?: number | null;
    datasetFrom?: string | null;
    datasetTo?: string | null;
    exclusions?: Record<string, unknown>;
    sourceCounts?: Record<string, unknown>;
    candidateId?: string | null;
    promotion?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<void> {
  await client.query(
    `update learning_runs set status = $2, finished_at = now(),
            dataset_checksum = $3, dataset_size = $4, dataset_from = $5, dataset_to = $6,
            exclusions = coalesce($7::jsonb, exclusions), source_counts = coalesce($8::jsonb, source_counts),
            candidate_id = $9, promotion = coalesce($10::jsonb, promotion), error = $11
      where id = $1`,
    [
      params.id,
      params.status,
      params.datasetChecksum ?? null,
      params.datasetSize ?? null,
      params.datasetFrom ?? null,
      params.datasetTo ?? null,
      params.exclusions ? JSON.stringify(params.exclusions) : null,
      params.sourceCounts ? JSON.stringify(params.sourceCounts) : null,
      params.candidateId ?? null,
      params.promotion ? JSON.stringify(params.promotion) : null,
      params.error ?? null,
    ],
  );
}

export async function listLearningRuns(client: SqlClient, limit = 20): Promise<
  {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    datasetChecksum: string | null;
    datasetSize: number | null;
    exclusions: Record<string, unknown>;
    sourceCounts: Record<string, unknown>;
    promotion: Record<string, unknown>;
    error: string | null;
  }[]
> {
  const rows = await client.query<{
    id: string;
    started_at: string | Date;
    finished_at: string | Date | null;
    status: string;
    dataset_checksum: string | null;
    dataset_size: number | null;
    exclusions: unknown;
    source_counts: unknown;
    promotion: unknown;
    error: string | null;
  }>(
    `select id, started_at, finished_at, status, dataset_checksum, dataset_size, exclusions, source_counts, promotion, error
       from learning_runs order by started_at desc limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    startedAt: isoRequired(r.started_at),
    finishedAt: iso(r.finished_at),
    status: r.status,
    datasetChecksum: r.dataset_checksum,
    datasetSize: r.dataset_size === null ? null : int(r.dataset_size),
    exclusions: json<Record<string, unknown>>(r.exclusions, {}),
    sourceCounts: json<Record<string, unknown>>(r.source_counts, {}),
    promotion: json<Record<string, unknown>>(r.promotion, {}),
    error: r.error,
  }));
}

/* --------------------------------------------------------- strategy weights */

export async function saveStrategyWeights(
  client: SqlClient,
  params: { version: string; weights: Record<string, number>; evidence: Record<string, unknown>; sampleSize: number; notes?: string },
): Promise<string> {
  return client.transaction(async (tx) => {
    await tx.query('update strategy_weights set active = false where active');
    const rows = await tx.query<{ id: string }>(
      `insert into strategy_weights (version, weights, evidence, active, sample_size, notes)
       values ($1, $2, $3, true, $4, $5)
       on conflict do nothing returning id`,
      [params.version, JSON.stringify(params.weights), JSON.stringify(params.evidence), params.sampleSize, params.notes ?? null],
    );
    return rows.rows[0]?.id ?? '';
  });
}

export async function getActiveStrategyWeights(
  client: SqlClient,
): Promise<{ id: string; version: string; weights: Record<string, number>; evidence: Record<string, unknown>; sampleSize: number; createdAt: string } | null> {
  const rows = await client.query<{
    id: string;
    version: string;
    weights: unknown;
    evidence: unknown;
    sample_size: number;
    created_at: string | Date;
  }>('select id, version, weights, evidence, sample_size, created_at from strategy_weights where active limit 1');
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    weights: json<Record<string, number>>(row.weights, {}),
    evidence: json<Record<string, unknown>>(row.evidence, {}),
    sampleSize: int(row.sample_size),
    createdAt: isoRequired(row.created_at),
  };
}

export async function listStrategyWeights(client: SqlClient, limit = 20): Promise<
  { id: string; version: string; active: boolean; sampleSize: number; weights: Record<string, number>; createdAt: string }[]
> {
  const rows = await client.query<{
    id: string;
    version: string;
    active: boolean;
    sample_size: number;
    weights: unknown;
    created_at: string | Date;
  }>(
    'select id, version, active, sample_size, weights, created_at from strategy_weights order by created_at desc limit $1',
    [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    version: r.version,
    active: bool(r.active),
    sampleSize: int(r.sample_size),
    weights: json<Record<string, number>>(r.weights, {}),
    createdAt: isoRequired(r.created_at),
  }));
}

/* ------------------------------------------------------------- drift + artifacts */

export async function recordDrift(
  client: SqlClient,
  params: {
    modelVersionId: string | null;
    drifting: boolean;
    recentAccuracy: number | null;
    baselineAccuracy: number | null;
    recentSamples: number;
    detail: string;
    action: string;
  },
): Promise<void> {
  await client.query(
    `insert into model_drift_reports
       (model_version_id, drifting, recent_accuracy, baseline_accuracy, recent_samples, detail, action)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.modelVersionId,
      params.drifting,
      params.recentAccuracy,
      params.baselineAccuracy,
      params.recentSamples,
      params.detail,
      params.action,
    ],
  );
}

export async function listDriftReports(client: SqlClient, limit = 20): Promise<
  { id: string; drifting: boolean; recentAccuracy: number | null; baselineAccuracy: number | null; detail: string; action: string; createdAt: string }[]
> {
  const rows = await client.query<{
    id: string;
    drifting: boolean;
    recent_accuracy: string | number | null;
    baseline_accuracy: string | number | null;
    detail: string | null;
    action: string | null;
    created_at: string | Date;
  }>(
    `select id, drifting, recent_accuracy, baseline_accuracy, detail, action, created_at
       from model_drift_reports order by created_at desc limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    drifting: bool(r.drifting),
    recentAccuracy: numOrNull(r.recent_accuracy),
    baselineAccuracy: numOrNull(r.baseline_accuracy),
    detail: text(r.detail, ''),
    action: text(r.action, ''),
    createdAt: isoRequired(r.created_at),
  }));
}

export async function recordArtifact(
  client: SqlClient,
  params: { kind: string; path: string; checksum: string; bytes: number; metadata?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `insert into artifacts (kind, path, checksum, bytes, metadata) values ($1,$2,$3,$4,$5)
     on conflict (path, checksum) do nothing`,
    [params.kind, params.path, params.checksum, params.bytes, JSON.stringify(params.metadata ?? {})],
  );
}

export { num };
