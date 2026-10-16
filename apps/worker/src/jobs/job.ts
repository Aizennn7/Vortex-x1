/**
 * Job wrapper: claims the slot, runs the work, records the outcome and raises
 * alerts on failure. A slot that is already claimed is skipped — that is what
 * makes replayed cycles, restarts and duplicate workers harmless.
 */

import { claimJob, finishJob, raiseAlert, resolveAlert } from '@vortex/db';
import type { JobStatus } from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';

export interface JobOutcome {
  status: JobStatus;
  detail?: Record<string, unknown>;
  error?: string | null;
}

export class JobSkipped extends Error {}

export interface WithJobOptions {
  staleAfterSeconds?: number;
  alertCode?: string;
  /** Number of in-process retries on transient failure before marking FAILED. */
  retries?: number;
  retryDelayMs?: number;
  /** Allow reclaiming a slot that previously ended in FAILED (bounded by maxSlotAttempts). */
  retryFailedSlot?: boolean;
  maxSlotAttempts?: number;
}

export async function withJob(
  runtime: WorkerRuntime,
  jobName: string,
  slotKey: string,
  fn: () => Promise<JobOutcome | void>,
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: JobStatus; detail?: Record<string, unknown> }> {
  const db = runtime.db.client;
  if (!runtime.db.connected) return { ran: false, status: 'SKIPPED', detail: { reason: 'database not connected' } };

  const claim = await claimJob(db, {
    jobName,
    slotKey,
    workerId: runtime.config.workerId,
    staleAfterSeconds: options.staleAfterSeconds ?? 300,
    retryFailed: options.retryFailedSlot ?? false,
    maxAttempts: options.maxSlotAttempts ?? 3,
  });
  if (!claim.claimed || claim.jobRunId === null) {
    return { ran: false, status: 'SKIPPED', detail: { reason: claim.reason } };
  }

  const started = Date.now();
  const maxRetries = Math.max(0, options.retries ?? 0);
  const baseDelayMs = Math.max(10, options.retryDelayMs ?? 250);
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const outcome = (await fn()) ?? { status: 'SUCCEEDED' as JobStatus };
      const detail =
        attempt > 0 ? { ...(outcome.detail ?? {}), retryAttempts: attempt } : outcome.detail;
      await finishJob(db, {
        jobRunId: claim.jobRunId,
        status: outcome.status,
        detail,
        error: outcome.error ?? null,
      });
      runtime.bump('jobsCompleted');
      runtime.counters.cyclesRun += 1;
      if (options.alertCode && outcome.status === 'FAILED') {
        // A job that reports FAILED through its return value must raise the
        // alert, never clear it: an outage that resolves its own alarm is the
        // worst kind of false success.
        await raiseAlert(db, {
          severity: 'ERROR',
          code: options.alertCode,
          title: `${jobName} reported a failed cycle`,
          detail: outcome.error ?? 'the cycle completed without doing its work',
          metadata: { job: jobName, slot: slotKey, workerId: runtime.config.workerId, ...(detail ?? {}) },
        }).catch(() => undefined);
      } else if (options.alertCode) {
        await resolveAlert(db, options.alertCode).catch(() => undefined);
      }
      runtime.logger.debug('job finished', {
        component: 'jobs',
        job: jobName,
        slot: slotKey,
        status: outcome.status,
        durationMs: Date.now() - started,
        ...(detail ?? {}),
      });
      return { ran: true, status: outcome.status, detail };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && !runtime.stopping) {
        const message = error instanceof Error ? error.message : String(error);
        runtime.logger.warn('job attempt failed — retrying', {
          component: 'jobs',
          job: jobName,
          slot: slotKey,
          attempt: attempt + 1,
          maxRetries,
          error: message,
        });
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** attempt));
        continue;
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  await finishJob(db, { jobRunId: claim.jobRunId, status: 'FAILED', error: message }).catch(() => undefined);
  runtime.recordError(lastError);
  runtime.logger.error('job failed', { component: 'jobs', job: jobName, slot: slotKey, error: message });
  if (options.alertCode) {
    await raiseAlert(db, {
      severity: 'ERROR',
      code: options.alertCode,
      title: `${jobName} failed`,
      detail: message,
      metadata: { job: jobName, slot: slotKey, workerId: runtime.config.workerId },
    }).catch(() => undefined);
  }
  return { ran: true, status: 'FAILED', detail: { error: message } };
}
