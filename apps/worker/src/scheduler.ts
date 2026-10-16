/**
 * Tick scheduler.
 *
 * A single lightweight loop decides what is due. Each unit of work is wrapped
 * in a job slot so a restart, a clock jump or a second worker cannot duplicate
 * it. The loop is deliberately plain (no cron daemon, no external queue) and
 * every decision is derived from the clock and the database.
 */

import { isMarketOpen, planNextSlot, toIso } from '@vortex/core';
import { acquireLock, releaseLock, upsertHeartbeat, type SqlClient } from '@vortex/db';
import type { WorkerRuntime } from './runtime.js';
import { runIngestionCycle } from './jobs/ingest.js';
import { runActivationJob, runSignalJob, enabledPairs } from './jobs/signals.js';
import { runSettlementJob } from './jobs/settle.js';
import { runMaintenanceJob } from './jobs/maintenance.js';
import { runLearningJob } from './jobs/learning.js';

/**
 * Name of the singleton scheduler lease.
 *
 * Job slots already stop a cycle from running twice, but a second scheduler
 * still burns provider quota and fights for every slot. The lease makes
 * "exactly one active scheduler" an explicit, verifiable property: a standby
 * instance keeps its process alive, reports itself as standby in the logs and
 * writes no heartbeat, so the dashboard never shows a phantom worker.
 */
const SCHEDULER_LOCK = 'vortex-scheduler';

export interface TickResult {
  ran: string[];
  skipped: string[];
  notes: string[];
}

export interface SchedulerOptions {
  tickIntervalMs?: number;
  ingestionIntervalMs?: number;
  settlementIntervalMs?: number;
  maintenanceIntervalMs?: number;
  heartbeatIntervalMs?: number;
  learningHourUtc?: number;
}

export class WorkerScheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastIngestAt = 0;
  private lastSettleAt = 0;
  private lastMaintenanceAt = 0;
  private lastHeartbeatAt = 0;
  private lastLearningDay: string | null = null;
  private running = false;
  private leaseHeld = false;
  private lastLeaseCheckAt = 0;
  private readonly options: Required<SchedulerOptions>;
  /** Lease time-to-live: long enough to survive a few missed heartbeats. */
  private readonly leaseTtlSeconds: number;

  constructor(
    private readonly runtime: WorkerRuntime,
    options: SchedulerOptions = {},
  ) {
    this.options = {
      tickIntervalMs: options.tickIntervalMs ?? 5_000,
      ingestionIntervalMs: options.ingestionIntervalMs ?? 55_000,
      settlementIntervalMs: options.settlementIntervalMs ?? 15_000,
      maintenanceIntervalMs: options.maintenanceIntervalMs ?? 300_000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? Math.max(5_000, runtime.config.heartbeatSeconds * 1000),
      learningHourUtc: options.learningHourUtc ?? 3,
    };
    // Ten heartbeat intervals of margin: a lease is only ever at risk if this
    // process is already unable to talk to the database.
    this.leaseTtlSeconds = Math.max(60, runtime.config.heartbeatSeconds * 10);
  }

  start(): void {
    if (this.timer) return;
    this.runtime.logger.info('scheduler starting', {
      component: 'scheduler',
      workerId: this.runtime.config.workerId,
      lease: SCHEDULER_LOCK,
      leaseTtlSeconds: this.leaseTtlSeconds,
      tickMs: this.options.tickIntervalMs,
      cadenceMinutes: this.runtime.config.scanCadenceMinutes,
      publishLeadSeconds: this.runtime.config.publishLeadSeconds,
    });
    const loop = async () => {
      try {
        await this.tick(new Date());
      } catch (error) {
        this.runtime.recordError(error);
        this.runtime.logger.error('tick failed', { component: 'scheduler', error: (error as Error).message });
      } finally {
        if (!this.runtime.stopping) {
          this.timer = setTimeout(loop, this.options.tickIntervalMs);
          this.timer.unref?.();
        }
      }
    };
    void loop();
  }

  async stop(): Promise<void> {
    this.runtime.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wait for an in-flight tick to finish so the database is not closed
    // underneath a running job.
    for (let i = 0; i < 40 && this.running; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Hand the lease back so a replacement instance can take over immediately
    // instead of waiting for the TTL to expire.
    if (this.leaseHeld) {
      await releaseLock(this.runtime.db.client as SqlClient, SCHEDULER_LOCK, this.runtime.config.workerId)
        .catch(() => undefined);
      this.leaseHeld = false;
    }
  }

  /** True when this process currently owns the singleton scheduler lease. */
  get holdsLease(): boolean {
    return this.leaseHeld;
  }

  /**
   * Take or renew the scheduler lease.
   *
   * Re-checked on the heartbeat cadence rather than every tick, because the
   * lease outlives many ticks. A process that cannot take the lease stays up as
   * a standby: it schedules nothing, claims nothing and writes no heartbeat.
   */
  private async ensureLease(now: Date): Promise<boolean> {
    if (!this.runtime.db.connected || !this.runtime.db.client) return false;
    const nowMs = now.getTime();
    const recheckAfterMs = Math.max(5_000, this.options.heartbeatIntervalMs);
    if (nowMs - this.lastLeaseCheckAt < recheckAfterMs) return this.leaseHeld;
    this.lastLeaseCheckAt = nowMs;
    const wasHeld = this.leaseHeld;
    try {
      this.leaseHeld = await acquireLock(this.runtime.db.client as SqlClient, {
        name: SCHEDULER_LOCK,
        owner: this.runtime.config.workerId,
        ttlSeconds: this.leaseTtlSeconds,
      });
    } catch (error) {
      this.leaseHeld = false;
      this.runtime.logger.warn('scheduler lease check failed — standing by', {
        component: 'scheduler',
        error: (error as Error).message,
      });
      return false;
    }
    if (this.leaseHeld && !wasHeld) {
      this.runtime.logger.info('scheduler lease acquired', {
        component: 'scheduler',
        lease: SCHEDULER_LOCK,
        workerId: this.runtime.config.workerId,
        ttlSeconds: this.leaseTtlSeconds,
      });
    } else if (!this.leaseHeld && wasHeld) {
      this.runtime.logger.warn('scheduler lease lost — standing by', {
        component: 'scheduler',
        lease: SCHEDULER_LOCK,
        workerId: this.runtime.config.workerId,
      });
    }
    return this.leaseHeld;
  }

  /**
   * One scheduler pass. Exposed for tests: pass a fixed `now` to drive the
   * whole system deterministically.
   */
  async tick(now = new Date()): Promise<TickResult> {
    if (this.running) return { ran: [], skipped: ['previous tick still running'], notes: [] };
    this.running = true;
    const result: TickResult = { ran: [], skipped: [], notes: [] };
    try {
      // The lease is checked before anything else: a standby instance must not
      // publish a heartbeat either, or the dashboard would report a worker that
      // is not actually doing any work.
      if (!(await this.ensureLease(now))) {
        result.skipped.push('scheduler lease held by another instance — this process is standby');
        return result;
      }
      await this.heartbeat(now, result);
      if (!this.runtime.db.connected) {
        result.skipped.push('database disconnected — only heartbeats attempted');
        return result;
      }
      if (!isMarketOpen(now)) {
        result.skipped.push('FX market closed');
        // Learning and maintenance are market-independent and still run.
        await this.maybeLearning(now, result);
        await this.maybeMaintenance(now, result);
        return result;
      }

      const cfg = this.runtime.config;
      const plan = planNextSlot(now, {
        cadenceMinutes: cfg.scanCadenceMinutes,
        publishLeadSeconds: cfg.publishLeadSeconds,
        horizonSeconds: cfg.signalHorizonSeconds,
        minLeadSeconds: 15,
        respectMarketHours: true,
      });

      if (plan) {
        const publishMs = new Date(plan.publishAt).getTime();
        const entryMs = new Date(plan.entryTime).getTime();
        const inWindow = now.getTime() >= publishMs - 5_000 && now.getTime() < entryMs - 10_000;
        if (inWindow) {
          await runSignalJob(this.runtime, now);
          result.ran.push(`signal_cycle:${plan.slotKey}`);
        } else {
          result.skipped.push(
            `signal window opens in ${Math.round((publishMs - now.getTime()) / 1000)}s for ${plan.slotKey}`,
          );
        }
        // Ingestion must finish before the publish window, so it runs on every
        // minute boundary that is not inside the window.
        const msSinceIngest = now.getTime() - this.lastIngestAt;
        if (!inWindow && msSinceIngest >= this.options.ingestionIntervalMs) {
          const summary = await runIngestionCycle(this.runtime, now);
          this.lastIngestAt = now.getTime();
          result.ran.push('ingest_market_data');
          result.notes.push(...summary.detail.slice(0, 2));
        }
      } else {
        result.skipped.push('no publishable slot (market closing or lead unavailable)');
        const msSinceIngest = now.getTime() - this.lastIngestAt;
        if (msSinceIngest >= this.options.ingestionIntervalMs) {
          const summary = await runIngestionCycle(this.runtime, now);
          this.lastIngestAt = now.getTime();
          result.ran.push('ingest_market_data');
          result.notes.push(...summary.detail.slice(0, 2));
        }
      }

      await runActivationJob(this.runtime, now);
      result.ran.push('signal_activation');

      if (now.getTime() - this.lastSettleAt >= this.options.settlementIntervalMs) {
        this.lastSettleAt = now.getTime();
        await runSettlementJob(this.runtime, now);
        result.ran.push('settle_signals');
      }

      await this.maybeMaintenance(now, result);
      await this.maybeLearning(now, result);
      return result;
    } finally {
      this.running = false;
    }
  }

  private async heartbeat(now: Date, result: TickResult): Promise<void> {
    if (now.getTime() - this.lastHeartbeatAt < this.options.heartbeatIntervalMs) return;
    this.lastHeartbeatAt = now.getTime();
    try {
      await upsertHeartbeat(this.runtime.db.client as SqlClient, {
        workerId: this.runtime.config.workerId,
        instanceLabel: process.env.VORTEX_INSTANCE_LABEL ?? 'worker',
        version: this.runtime.config.engineVersion,
        lastJob: result.ran[result.ran.length - 1] ?? null,
        jobsCompleted: this.runtime.counters.jobsCompleted,
        jobsFailed: this.runtime.counters.jobsFailed,
        cyclesRun: this.runtime.counters.cyclesRun,
        metadata: {
          provider: this.runtime.config.provider,
          synthetic: this.runtime.providerSynthetic,
          pairs: (await enabledPairs(this.runtime)).length,
          uptimeSeconds: Math.round((now.getTime() - this.runtime.startedAt.getTime()) / 1000),
          ...this.runtime.counters,
        },
        stopping: this.runtime.stopping,
      });
    } catch (error) {
      this.runtime.logger.warn('heartbeat failed', { component: 'scheduler', error: (error as Error).message });
    }
  }

  private async maybeMaintenance(now: Date, result: TickResult): Promise<void> {
    if (now.getTime() - this.lastMaintenanceAt < this.options.maintenanceIntervalMs) return;
    this.lastMaintenanceAt = now.getTime();
    await runMaintenanceJob(this.runtime, now);
    result.ran.push('maintenance');
  }

  private async maybeLearning(now: Date, result: TickResult): Promise<void> {
    if (!this.runtime.config.learningEnabled) return;
    const day = toIso(now).slice(0, 10);
    if (now.getUTCHours() < this.options.learningHourUtc) return;
    if (this.lastLearningDay === day) return;
    this.lastLearningDay = day;
    await runLearningJob(this.runtime, now);
    result.ran.push('learning_cycle');
  }
}
