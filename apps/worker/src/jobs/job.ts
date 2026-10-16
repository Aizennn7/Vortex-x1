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

export async function withJob(
  runtime: WorkerRuntime,
  jobName: string,
  slotKey: string,
  fn: () => Promise<JobOutcome | void>,
  options: { staleAfterSeconds?: number; alertCode?: string } = {},
): Promise<{ ran: boolean; status: JobStatus; detail?: Record<string, unknown> }> {
  const db = runtime.db.client;
  if (!runtime.db.connected) return { ran: false, status: 'SKIPPED', detail: { reason: 'database not connected' } };

  const claim = await claimJob(db, {
    jobName,
    slotKey,
    workerId: runtime.config.workerId,
    staleAfterSeconds: options.staleAfterSeconds ?? 300,
  });
  if (!claim.claimed || claim.jobRunId === null) {
    return { ran: false, status: 'SKIPPED', detail: { reason: claim.reason } };
  }

  const started = Date.now();
  try {
    const outcome = (await fn()) ?? { status: 'SUCCEEDED' as JobStatus };
    await finishJob(db, { jobRunId: claim.jobRunId, status: outcome.status, detail: outcome.detail, error: outcome.error ?? null });
    runtime.bump('jobsCompleted');
    runtime.counters.cyclesRun += 1;
    if (options.alertCode) await resolveAlert(db, options.alertCode).catch(() => undefined);
    runtime.logger.debug('job finished', {
      component: 'jobs',
      job: jobName,
      slot: slotKey,
      status: outcome.status,
      durationMs: Date.now() - started,
      ...(outcome.detail ?? {}),
    });
    return { ran: true, status: outcome.status, detail: outcome.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishJob(db, { jobRunId: claim.jobRunId, status: 'FAILED', error: message }).catch(() => undefined);
    runtime.recordError(error);
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
}
