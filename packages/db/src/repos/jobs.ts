/**
 * Worker coordination: heartbeats, idempotent job slots and distributed locks.
 *
 * A job slot is `(job_name, slot_key)`. Claiming a slot inserts a RUNNING row;
 * the unique constraint means the second claimant loses, so duplicate workers
 * and post-restart replays cannot double-process a cycle.
 */

import type { SqlClient } from '../driver.js';
import { bool, int, iso } from './rows.js';

export type JobStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'STALE';

export interface JobRun {
  id: number;
  jobName: string;
  slotKey: string;
  workerId: string | null;
  status: JobStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  detail: Record<string, unknown>;
  error: string | null;
}

export interface ClaimResult {
  claimed: boolean;
  jobRunId: number | null;
  reason: string;
}

/**
 * Claim a job slot. Returns `claimed: false` when the slot already ran (or is
 * running). `staleAfterSeconds` allows recovery of a slot whose worker died
 * mid-run: a stale RUNNING row is re-claimed and marked STALE.
 */
export async function claimJob(
  client: SqlClient,
  params: { jobName: string; slotKey: string; workerId: string; staleAfterSeconds?: number },
): Promise<ClaimResult> {
  const stale = params.staleAfterSeconds ?? 300;
  return client.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into job_runs (job_name, slot_key, worker_id, status)
       values ($1, $2, $3, 'RUNNING')
       on conflict (job_name, slot_key) do nothing
       returning id`,
      [params.jobName, params.slotKey, params.workerId],
    );
    const id = inserted.rows[0]?.id;
    if (id) return { claimed: true, jobRunId: int(id), reason: 'new slot' };

    const existing = await tx.query<{ id: string; status: string; started_at: string | Date; worker_id: string | null }>(
      `select id, status, started_at, worker_id from job_runs
        where job_name = $1 and slot_key = $2 for update`,
      [params.jobName, params.slotKey],
    );
    const row = existing.rows[0];
    if (!row) return { claimed: false, jobRunId: null, reason: 'slot missing' };
    const ageSeconds = (Date.now() - new Date(row.started_at).getTime()) / 1000;
    if (row.status === 'RUNNING' && ageSeconds > stale) {
      await tx.query(
        `update job_runs
            set status = 'RUNNING',
                worker_id = $2,
                started_at = now(),
                error = null,
                detail = jsonb_set(detail, '{recoveredFrom}', to_jsonb($3::text))
          where id = $1`,
        [row.id, params.workerId, row.worker_id ?? 'unknown'],
      );
      return { claimed: true, jobRunId: int(row.id), reason: `recovered stale slot (${Math.round(ageSeconds)}s)` };
    }
    return {
      claimed: false,
      jobRunId: int(row.id),
      reason: row.status === 'RUNNING' ? 'already running' : `already ${row.status}`,
    };
  });
}

export async function finishJob(
  client: SqlClient,
  params: { jobRunId: number; status: JobStatus; detail?: Record<string, unknown>; error?: string | null },
): Promise<void> {
  await client.query(
    `update job_runs set status = $2, finished_at = now(),
            duration_ms = greatest(0, extract(milliseconds from (now() - started_at))::integer),
            detail = coalesce($3::jsonb, detail), error = $4
      where id = $1`,
    [params.jobRunId, params.status, params.detail ? JSON.stringify(params.detail) : null, params.error ?? null],
  );
}

export async function recentJobs(client: SqlClient, limit = 50): Promise<JobRun[]> {
  const rows = await client.query<{
    id: string;
    job_name: string;
    slot_key: string;
    worker_id: string | null;
    status: string;
    started_at: string | Date;
    finished_at: string | Date | null;
    duration_ms: number | null;
    detail: unknown;
    error: string | null;
  }>(
    `select id, job_name, slot_key, worker_id, status, started_at, finished_at, duration_ms, detail, error
       from job_runs order by started_at desc limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    id: int(r.id),
    jobName: r.job_name,
    slotKey: r.slot_key,
    workerId: r.worker_id,
    status: r.status as JobStatus,
    startedAt: iso(r.started_at) ?? new Date().toISOString(),
    finishedAt: iso(r.finished_at),
    durationMs: r.duration_ms === null ? null : int(r.duration_ms),
    detail: (r.detail ?? {}) as Record<string, unknown>,
    error: r.error,
  }));
}

export async function upsertHeartbeat(
  client: SqlClient,
  params: {
    workerId: string;
    instanceLabel: string;
    version: string;
    lastJob?: string | null;
    jobsCompleted?: number;
    jobsFailed?: number;
    cyclesRun?: number;
    metadata?: Record<string, unknown>;
    stopping?: boolean;
  },
): Promise<void> {
  await client.query(
    `insert into worker_heartbeats
       (worker_id, instance_label, version, started_at, last_seen_at, last_job, last_job_at,
        jobs_completed, jobs_failed, cycles_run, metadata, stopping_at)
     values ($1, $2, $3, now(), now(), $4::text,
             case when $4::text is null then null else now() end,
             $5, $6, $7, $8::jsonb, case when $9 then now() else null end)
     on conflict (worker_id) do update set
       instance_label = excluded.instance_label,
       version = excluded.version,
       last_seen_at = now(),
       last_job = coalesce(excluded.last_job, worker_heartbeats.last_job),
       last_job_at = case when excluded.last_job is null then worker_heartbeats.last_job_at else now() end,
       jobs_completed = excluded.jobs_completed,
       jobs_failed = excluded.jobs_failed,
       cycles_run = excluded.cycles_run,
       metadata = excluded.metadata,
       stopping_at = excluded.stopping_at`,
    [
      params.workerId,
      params.instanceLabel,
      params.version,
      params.lastJob ?? null,
      params.jobsCompleted ?? 0,
      params.jobsFailed ?? 0,
      params.cyclesRun ?? 0,
      JSON.stringify(params.metadata ?? {}),
      params.stopping === true,
    ],
  );
}

export interface WorkerStatus {
  workerId: string;
  instanceLabel: string | null;
  version: string;
  startedAt: string;
  lastSeenAt: string;
  secondsSince: number;
  lastJob: string | null;
  lastJobAt: string | null;
  jobsCompleted: number;
  jobsFailed: number;
  cyclesRun: number;
  liveness: 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'STOPPING';
  metadata: Record<string, unknown>;
}

export async function workerStatus(client: SqlClient): Promise<WorkerStatus[]> {
  const rows = await client.query<{
    worker_id: string;
    instance_label: string | null;
    version: string;
    started_at: string | Date;
    last_seen_at: string | Date;
    last_job: string | null;
    last_job_at: string | Date | null;
    jobs_completed: string;
    jobs_failed: string;
    cycles_run: string;
    stopping_at: string | Date | null;
    metadata: unknown;
  }>(
    `select worker_id, instance_label, version, started_at, last_seen_at, last_job, last_job_at,
            jobs_completed, jobs_failed, cycles_run, stopping_at, metadata
       from worker_heartbeats order by last_seen_at desc`,
  );
  const now = Date.now();
  return rows.rows.map((r) => {
    const lastSeen = iso(r.last_seen_at) ?? new Date(0).toISOString();
    const secondsSince = Math.round((now - new Date(lastSeen).getTime()) / 1000);
    const liveness: WorkerStatus['liveness'] =
      r.stopping_at !== null ? 'STOPPING' : secondsSince <= 120 ? 'CONNECTED' : secondsSince <= 600 ? 'DEGRADED' : 'DISCONNECTED';
    return {
      workerId: r.worker_id,
      instanceLabel: r.instance_label,
      version: r.version,
      startedAt: iso(r.started_at) ?? lastSeen,
      lastSeenAt: lastSeen,
      secondsSince,
      lastJob: r.last_job,
      lastJobAt: iso(r.last_job_at),
      jobsCompleted: int(r.jobs_completed),
      jobsFailed: int(r.jobs_failed),
      cyclesRun: int(r.cycles_run),
      liveness,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    };
  });
}

/** Advisory lock with an expiry, used for singleton recurring jobs. */
export async function acquireLock(
  client: SqlClient,
  params: { name: string; owner: string; ttlSeconds: number },
): Promise<boolean> {
  const result = await client.query(
    `insert into job_locks (name, owner, acquired_at, expires_at)
     values ($1, $2, now(), now() + ($3 || ' seconds')::interval)
     on conflict (name) do update
       set owner = excluded.owner, acquired_at = now(), expires_at = excluded.expires_at
       where job_locks.expires_at < now() or job_locks.owner = excluded.owner
     returning name`,
    [params.name, params.owner, String(Math.max(5, params.ttlSeconds))],
  );
  return result.rowCount > 0;
}

export async function releaseLock(client: SqlClient, name: string, owner: string): Promise<void> {
  await client.query('delete from job_locks where name = $1 and owner = $2', [name, owner]);
}

export async function listLocks(client: SqlClient): Promise<{ name: string; owner: string; expiresAt: string; expired: boolean }[]> {
  const rows = await client.query<{ name: string; owner: string; expires_at: string | Date }>(
    'select name, owner, expires_at from job_locks order by name',
  );
  return rows.rows.map((r) => ({
    name: r.name,
    owner: r.owner,
    expiresAt: iso(r.expires_at) ?? new Date().toISOString(),
    expired: new Date(iso(r.expires_at) ?? 0).getTime() < Date.now(),
  }));
}

export async function pruneJobRuns(client: SqlClient, retentionDays = 14): Promise<number> {
  const result = await client.query(
    `delete from job_runs where started_at < now() - ($1 || ' days')::interval`,
    [String(Math.max(1, retentionDays))],
  );
  return result.rowCount;
}

export { bool };
