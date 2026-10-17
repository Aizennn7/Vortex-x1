/**
 * One-shot job runner for GitHub Actions and CLI execution.
 *
 * Replaces the paid 24/7 Render background worker with safe, idempotent,
 * lock-guarded scheduled executions:
 *   1. Acquires the distributed `vortex-scheduler` lease in `job_locks` so two
 *      overlapping GitHub Actions runs can never execute concurrently.
 *   2. Recovers any orphaned `RUNNING` rows in `job_runs` / `learning_runs` left
 *      behind by a prior crashed or timed-out run.
 *   3. Idempotently registers up to four server-side Twelve Data keys, encrypted
 *      with `VORTEX_SECRET_KEY`; the key pool applies bounded, classified fallback.
 *   4. Executes the requested pipeline stages (`ingest`, `activate`, `settle`,
 *      `signals`, `learning`, `maintenance`) with bounded retries and failed-slot
 *      recovery.
 *   5. Before exiting, marks its heartbeat `stopping: true` (`stopping_at = now()`)
 *      and updates `system_health` (`component = 'worker'`) with the last
 *      successful job so the dashboard never pretends a stopped worker is running.
 */

import { maskKey, toIso } from '@vortex/core';
import {
  acquireLock,
  encryptSecret,
  insertKey,
  keyFingerprint,
  lastSuccessfulJob,
  listKeys,
  recoverStaleJobs,
  releaseLock,
  setComponentHealth,
  updateKey,
  upsertHeartbeat,
  type JobRun,
  type SqlClient,
} from '@vortex/db';
import type { WorkerRuntime } from './runtime.js';
import { runIngestionJob } from './jobs/ingest.js';
import { enabledPairs, runActivationJob, runSignalJob } from './jobs/signals.js';
import { runSettlementJob } from './jobs/settle.js';
import { runLearningJob } from './jobs/learning.js';
import { runMaintenanceJob } from './jobs/maintenance.js';

export const JOB_MODES = ['cycle', 'ingest', 'settle', 'signals', 'maintenance', 'learning', 'all'] as const;

export type JobMode = (typeof JOB_MODES)[number];

type PipelineStep = 'ingest' | 'activate' | 'settle' | 'signals' | 'learning' | 'maintenance';

const SCHEDULER_LOCK = 'vortex-scheduler';
const ENV_KEY_LABELS = ['twelvedata-primary', 'twelvedata-secondary', 'twelvedata-tertiary', 'twelvedata-quaternary'] as const;

export interface OneShotOptions {
  modes?: JobMode[];
  now?: Date;
  retries?: number;
  retryDelayMs?: number;
  lockName?: string;
}

export interface OneShotSummary {
  workerId: string;
  modes: JobMode[];
  stepsRequested: PipelineStep[];
  leaseAcquired: boolean;
  recovered: { jobRunsRecovered: number; learningRunsRecovered: number };
  keyBootstrap: {
    configured: boolean;
    action: 'none' | 'inserted' | 'updated' | 'already_present';
    maskedKey?: string;
  };
  ran: string[];
  skipped: string[];
  failed: string[];
  lastSuccessfulJob: {
    jobName: string;
    slotKey: string;
    finishedAt: string;
    durationMs: number | null;
    workerId: string | null;
  } | null;
  durationMs: number;
}

export function isJobMode(value: string | undefined | null): value is JobMode {
  return typeof value === 'string' && (JOB_MODES as readonly string[]).includes(value);
}

/**
 * Parse `--job=<mode[,mode...]>` or `--once` from argv / `VORTEX_JOB_MODE`.
 * Returns `null` when the process was not invoked in one-shot job mode.
 */
export function jobModesFromArgv(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): JobMode[] | null {
  const onceFlag = argv.includes('--once');
  const jobArg = argv.find((arg) => arg.startsWith('--job='))?.slice('--job='.length)?.trim();
  const raw = jobArg ?? (onceFlag ? 'cycle' : env.VORTEX_JOB_MODE?.trim());
  if (!raw) return null;

  const modes = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(isJobMode);
  return modes.length > 0 ? Array.from(new Set(modes)) : ['cycle'];
}

export function expandSteps(modes: JobMode[]): PipelineStep[] {
  const wanted = new Set<PipelineStep>();
  for (const mode of modes) {
    switch (mode) {
      case 'cycle':
        wanted.add('ingest');
        wanted.add('activate');
        wanted.add('settle');
        wanted.add('signals');
        wanted.add('maintenance');
        break;
      case 'all':
        wanted.add('ingest');
        wanted.add('activate');
        wanted.add('settle');
        wanted.add('signals');
        wanted.add('learning');
        wanted.add('maintenance');
        break;
      case 'ingest':
        wanted.add('ingest');
        wanted.add('maintenance');
        break;
      case 'settle':
        wanted.add('activate');
        wanted.add('settle');
        wanted.add('maintenance');
        break;
      case 'signals':
        wanted.add('ingest');
        wanted.add('signals');
        wanted.add('maintenance');
        break;
      case 'learning':
        wanted.add('learning');
        wanted.add('maintenance');
        break;
      case 'maintenance':
        wanted.add('maintenance');
        break;
    }
  }
  const canonicalOrder: PipelineStep[] = ['ingest', 'activate', 'settle', 'signals', 'learning', 'maintenance'];
  return canonicalOrder.filter((step) => wanted.has(step));
}

/**
 * Idempotently register configured server-side Twelve Data keys. Secrets stay
 * encrypted at rest; rotation/fallback is bounded by KeyPool and provider error
 * classification. Keys are not assumed to be separate provider accounts.
 */
export async function ensureProviderKeyFromEnv(runtime: WorkerRuntime): Promise<OneShotSummary['keyBootstrap']> {
  const values = [
    runtime.config.providerApiKey,
    process.env.TWELVEDATA_API_KEY_2 ?? '',
    process.env.TWELVEDATA_API_KEY_3 ?? '',
    process.env.TWELVEDATA_API_KEY_4 ?? '',
  ].map((key) => key.trim());
  const secretKey = runtime.config.secretKey.trim();
  if (!secretKey || !runtime.db.connected) return { configured: false, action: 'none' };

  let action: OneShotSummary['keyBootstrap']['action'] = 'none';
  let configured = false;
  for (const [index, apiKey] of values.entries()) {
    if (apiKey.length < 16) continue;
    configured = true;
    const label = ENV_KEY_LABELS[index]!;
    const fp = keyFingerprint(apiKey);
    const masked = maskKey(apiKey);
    const existingKeys = await listKeys(runtime.db.client);
    const matchByFp = existingKeys.find((k) => k.fingerprint === fp);
    if (matchByFp) {
      if (!matchByFp.enabled) {
        await updateKey(runtime.db.client, matchByFp.id, { enabled: true, status: 'ACTIVE' });
        action = action === 'none' ? 'updated' : action;
      } else if (action === 'none') action = 'already_present';
      continue;
    }

    const ciphertext = encryptSecret(apiKey, secretKey);
    const matchByLabel = existingKeys.find((k) => k.label === label);
    if (matchByLabel) {
      await updateKey(runtime.db.client, matchByLabel.id, {
        ciphertext, maskedKey: masked, fingerprint: fp, enabled: true, status: 'ACTIVE',
        minuteLimit: runtime.config.providerRpmPerKey, dayLimit: runtime.config.providerRpdPerKey,
      });
      action = 'updated';
    } else {
      await insertKey(runtime.db.client, {
        label, maskedKey: masked, ciphertext, fingerprint: fp,
        minuteLimit: runtime.config.providerRpmPerKey, dayLimit: runtime.config.providerRpdPerKey,
        headroomPercent: runtime.config.providerHeadroomPercent,
      });
      action = action === 'none' || action === 'already_present' ? 'inserted' : action;
    }
  }
  if (action === 'inserted' || action === 'updated') {
    runtime.keyPool.invalidate();
    runtime.invalidateKeyCache();
  }
  return { configured, action };
}

function summarizeJobRun(job: JobRun | null): OneShotSummary['lastSuccessfulJob'] {
  if (!job) return null;
  return {
    jobName: job.jobName,
    slotKey: job.slotKey,
    finishedAt: job.finishedAt ?? job.startedAt,
    durationMs: job.durationMs,
    workerId: job.workerId,
  };
}

/**
 * Execute one-shot scheduled jobs safely with concurrency locking, stale-job
 * recovery, bounded retries, and honest stopped-worker status reporting.
 */
export async function runOneShot(runtime: WorkerRuntime, options: OneShotOptions = {}): Promise<OneShotSummary> {
  const startedMs = Date.now();
  const now = options.now ?? new Date();
  const modes: JobMode[] = options.modes && options.modes.length > 0 ? options.modes : ['cycle'];
  const steps = expandSteps(modes);
  const lockName = options.lockName ?? SCHEDULER_LOCK;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 200;

  if (!runtime.db.connected || !runtime.db.client) {
    throw new Error(`Database is not connected: ${runtime.db.detail || 'DATABASE_URL not configured'}`);
  }

  const db = runtime.db.client as SqlClient;
  const summary: OneShotSummary = {
    workerId: runtime.config.workerId,
    modes,
    stepsRequested: steps,
    leaseAcquired: false,
    recovered: { jobRunsRecovered: 0, learningRunsRecovered: 0 },
    keyBootstrap: { configured: false, action: 'none' },
    ran: [],
    skipped: [],
    failed: [],
    lastSuccessfulJob: null,
    durationMs: 0,
  };

  const leaseTtlSeconds = Math.max(60, runtime.config.jobLockTtlSeconds);
  const acquired = await acquireLock(db, {
    name: lockName,
    owner: runtime.config.workerId,
    ttlSeconds: leaseTtlSeconds,
  });

  if (!acquired) {
    summary.skipped.push('scheduler lease held by another active worker — skipping overlapping run');
    summary.lastSuccessfulJob = summarizeJobRun(await lastSuccessfulJob(db).catch(() => null));
    summary.durationMs = Date.now() - startedMs;
    runtime.logger.warn('one-shot run skipped because scheduler lease is held by another instance', {
      component: 'runner',
      lock: lockName,
      workerId: runtime.config.workerId,
    });
    return summary;
  }

  summary.leaseAcquired = true;
  let lastJobRan: string | null = null;

  try {
    summary.recovered = await recoverStaleJobs(db, runtime.config.jobLockTtlSeconds);
    if (summary.recovered.jobRunsRecovered > 0 || summary.recovered.learningRunsRecovered > 0) {
      runtime.logger.warn('recovered stale job rows from a previous interrupted run', {
        component: 'runner',
        ...summary.recovered,
      });
    }

    summary.keyBootstrap = await ensureProviderKeyFromEnv(runtime);

    // Record active heartbeat while the one-shot job is executing.
    await upsertHeartbeat(db, {
      workerId: runtime.config.workerId,
      instanceLabel: process.env.VORTEX_INSTANCE_LABEL ?? 'github-actions-oneshot',
      version: runtime.config.engineVersion,
      lastJob: null,
      jobsCompleted: runtime.counters.jobsCompleted,
      jobsFailed: runtime.counters.jobsFailed,
      cyclesRun: runtime.counters.cyclesRun,
      metadata: {
        mode: 'oneshot',
        active: true,
        provider: runtime.config.provider,
        synthetic: runtime.providerSynthetic,
        pairs: (await enabledPairs(runtime)).length,
        modes,
      },
      stopping: false,
    }).catch(() => undefined);

    const jobOpts = {
      retries,
      retryDelayMs,
      retryFailedSlot: true,
      maxSlotAttempts: 3,
    };

    for (const step of steps) {
      if (runtime.stopping) break;
      let outcome: { ran: boolean; status: string; detail?: Record<string, unknown> };
      let jobLabel: string = step;

      switch (step) {
        case 'ingest':
          jobLabel = 'ingest_market_data';
          outcome = await runIngestionJob(runtime, now, jobOpts);
          break;
        case 'activate':
          jobLabel = 'signal_activation';
          outcome = await runActivationJob(runtime, now, jobOpts);
          break;
        case 'settle':
          jobLabel = 'settle_signals';
          outcome = await runSettlementJob(runtime, now, jobOpts);
          break;
        case 'signals':
          jobLabel = 'signal_cycle';
          outcome = await runSignalJob(runtime, now, jobOpts);
          break;
        case 'learning':
          jobLabel = 'learning_cycle';
          outcome = await runLearningJob(runtime, now, jobOpts);
          break;
        case 'maintenance':
          jobLabel = 'maintenance';
          outcome = await runMaintenanceJob(runtime, now, jobOpts);
          break;
      }

      if (outcome.status === 'FAILED') {
        summary.failed.push(jobLabel);
      } else if (outcome.ran && outcome.status === 'SUCCEEDED') {
        summary.ran.push(jobLabel);
        lastJobRan = jobLabel;
      } else {
        const reason = outcome.detail?.reason;
        summary.skipped.push(
          `${jobLabel}:${outcome.status}${typeof reason === 'string' ? ` (${reason})` : ''}`,
        );
        runtime.logger.info('job skipped', {
          component: 'runner',
          job: jobLabel,
          status: outcome.status,
          ...(outcome.detail ?? {}),
        });
      }
    }
  } finally {
    const latestSuccess = await lastSuccessfulJob(db).catch(() => null);
    summary.lastSuccessfulJob = summarizeJobRun(latestSuccess);
    const finishedIso = toIso(new Date());

    // Mark the one-shot worker as stopped (`stopping: true` sets stopping_at = now())
    // so neither workerStatus() nor public_worker_status ever pretends this
    // completed job process is still running.
    await upsertHeartbeat(db, {
      workerId: runtime.config.workerId,
      instanceLabel: process.env.VORTEX_INSTANCE_LABEL ?? 'github-actions-oneshot',
      version: runtime.config.engineVersion,
      lastJob: summary.lastSuccessfulJob?.jobName ?? lastJobRan,
      jobsCompleted: runtime.counters.jobsCompleted,
      jobsFailed: runtime.counters.jobsFailed,
      cyclesRun: runtime.counters.cyclesRun,
      metadata: {
        mode: 'oneshot',
        active: false,
        stoppedAt: finishedIso,
        provider: runtime.config.provider,
        synthetic: runtime.providerSynthetic,
        lastSuccessfulJob: summary.lastSuccessfulJob,
        ran: summary.ran,
        failed: summary.failed,
        ...runtime.counters,
      },
      stopping: true,
    }).catch(() => undefined);

    await setComponentHealth(db, {
      component: 'worker',
      status: summary.failed.length > 0 ? 'DEGRADED' : 'DISCONNECTED',
      detail:
        summary.lastSuccessfulJob !== null
          ? `Scheduled one-shot worker idle between runs (last successful job: ${summary.lastSuccessfulJob.jobName} at ${summary.lastSuccessfulJob.finishedAt})`
          : 'Scheduled one-shot worker finished with no completed job recorded yet',
      metadata: {
        mode: 'oneshot',
        running: false,
        stoppedAt: finishedIso,
        workerId: runtime.config.workerId,
        lastSuccessfulJob: summary.lastSuccessfulJob,
        ran: summary.ran,
        failed: summary.failed,
      },
      observedAt: finishedIso,
    }).catch(() => undefined);

    await releaseLock(db, lockName, runtime.config.workerId).catch(() => undefined);
    summary.durationMs = Date.now() - startedMs;
  }

  return summary;
}
