/**
 * Deployment topology: process roles and the singleton scheduler lease.
 *
 * These are the two guarantees a two-service production deployment rests on —
 * a relay that cannot accidentally schedule work, and at most one scheduler
 * doing that work — so they are tested rather than trusted.
 */

import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { FREE_TIER_DEFAULT_PAIRS, loadConfig, publicRuntimeConfig, validateConfig } from '@vortex/core';
import { claimJob, listKeys, listLocks, workerStatus, acquireLock, type SqlClient } from '@vortex/db';
import { createHarness } from './helpers.js';
import { createRelay } from '../src/http.js';
import { expandSteps, jobModesFromArgv, runOneShot } from '../src/runner.js';
import { WorkerRuntime } from '../src/runtime.js';
import { WorkerScheduler } from '../src/scheduler.js';
import { isRole, planForRole, roleFromArgv, ROLES } from '../src/role.js';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@db.supabase.co:5432/postgres',
  VORTEX_ADMIN_TOKEN: 'a'.repeat(32),
  VORTEX_SECRET_KEY: 'b'.repeat(43),
} as NodeJS.ProcessEnv;

describe('process roles', () => {
  it('splits the relay and the scheduler into separate deployments', () => {
    expect(planForRole('relay')).toEqual({ relay: true, scheduler: false });
    expect(planForRole('worker')).toEqual({ relay: false, scheduler: true });
    expect(planForRole('all')).toEqual({ relay: true, scheduler: true });
  });

  it('defaults to "all" so existing local runs keep working unchanged', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).role).toBe('all');
    expect(loadConfig({ VORTEX_ROLE: 'worker' } as NodeJS.ProcessEnv).role).toBe('worker');
  });

  it('ignores an unknown role instead of guessing', () => {
    expect(isRole('relay')).toBe(true);
    expect(isRole('realy')).toBe(false);
    expect(roleFromArgv(['--role=realy'])).toBeUndefined();
    expect(roleFromArgv(['--role=worker'])).toBe('worker');
    expect(roleFromArgv(['--role= worker '])).toBe('worker');
    expect(roleFromArgv([])).toBeUndefined();
  });

  it('publishes the role in the non-secret config the dashboard reads', () => {
    const cfg = loadConfig({ VORTEX_ROLE: 'relay' } as NodeJS.ProcessEnv);
    expect(publicRuntimeConfig(cfg).role).toBe('relay');
    expect(JSON.stringify(publicRuntimeConfig(cfg))).not.toContain(PRODUCTION_ENV.DATABASE_URL);
  });

  it('warns — but does not block — when production runs the combined role', () => {
    const issues = validateConfig(loadConfig(PRODUCTION_ENV));
    expect(issues.some((i) => i.key === 'VORTEX_ROLE' && i.severity === 'warning')).toBe(true);
    expect(issues.some((i) => i.key === 'VORTEX_ROLE' && i.severity === 'error')).toBe(false);

    for (const role of ['relay', 'worker'] as const) {
      const split = validateConfig(loadConfig({ ...PRODUCTION_ENV, VORTEX_ROLE: role }));
      expect(split.some((i) => i.key === 'VORTEX_ROLE')).toBe(false);
    }
    expect(ROLES).toContain('all');
  });
});

describe('singleton scheduler lease', () => {
  /** A second runtime over the same database, standing in for a second worker service. */
  async function secondRuntime(client: SqlClient, workerId: string): Promise<WorkerRuntime> {
    return WorkerRuntime.create({
      db: client,
      manual: true,
      env: {
        NODE_ENV: 'test',
        VORTEX_ROLE: 'worker',
        VORTEX_WORKER_ID: workerId,
        VORTEX_SECRET_KEY: 'f'.repeat(64),
        VORTEX_PAIRS: 'EUR/USD',
        VORTEX_PROVIDER: 'simulated',
      } as NodeJS.ProcessEnv,
    });
  }

  it('lets exactly one worker schedule work and keeps the rest in standby', async () => {
    const h = await createHarness({ env: { VORTEX_WORKER_ID: 'worker-a' } });
    const standby = await secondRuntime(h.client, 'worker-b');
    try {
      const primary = new WorkerScheduler(h.runtime, { tickIntervalMs: 1_000 });
      const second = new WorkerScheduler(standby, { tickIntervalMs: 1_000 });

      const t0 = new Date('2026-03-03T10:03:45.000Z');
      const first = await primary.tick(t0);
      const duplicate = await second.tick(t0);

      expect(primary.holdsLease).toBe(true);
      expect(second.holdsLease).toBe(false);
      expect(duplicate.ran).toEqual([]);
      expect(duplicate.skipped.join(' ')).toContain('standby');

      // A standby must not publish a heartbeat: the dashboard would otherwise
      // report a worker that is alive but doing nothing.
      const seen = (await workerStatus(h.client)).map((w) => w.workerId);
      expect(seen).toContain('worker-a');
      expect(seen).not.toContain('worker-b');

      const locks = await listLocks(h.client);
      const schedulerLock = locks.find((l) => l.name === 'vortex-scheduler');
      expect(schedulerLock?.owner).toBe('worker-a');

      // The lease is not a one-shot claim: the holder keeps it across ticks.
      await primary.tick(new Date(t0.getTime() + 60_000));
      expect(primary.holdsLease).toBe(true);

      // Graceful shutdown hands it back so a replacement starts immediately.
      await primary.stop();
      expect((await listLocks(h.client)).some((l) => l.name === 'vortex-scheduler')).toBe(false);
      const taken = await second.tick(new Date(t0.getTime() + 120_000));
      expect(second.holdsLease).toBe(true);
      expect(taken.skipped.join(' ')).not.toContain('standby');
    } finally {
      await standby.close();
      await h.close();
    }
  });

  it('keeps the scheduler in standby when it cannot reach the database', async () => {
    const h = await createHarness({ env: { VORTEX_WORKER_ID: 'worker-c' } });
    try {
      const scheduler = new WorkerScheduler(h.runtime, { tickIntervalMs: 1_000 });
      // Simulate a database outage: no client means no lease, therefore no work.
      const realClient = h.runtime.db.client;
      (h.runtime.db as { client: SqlClient | null }).client = null as unknown as SqlClient;
      (h.runtime.db as { connected: boolean }).connected = false;
      const result = await scheduler.tick(new Date('2026-03-03T10:03:45.000Z'));
      expect(scheduler.holdsLease).toBe(false);
      expect(result.ran).toEqual([]);
      expect(result.skipped.join(' ')).toContain('standby');
      (h.runtime.db as { client: SqlClient | null }).client = realClient;
      (h.runtime.db as { connected: boolean }).connected = true;
    } finally {
      await h.close();
    }
  });

  it('still refuses a lease held by a different, unexpired owner', async () => {
    const h = await createHarness();
    try {
      expect(await acquireLock(h.client, { name: 'vortex-scheduler', owner: 'ghost', ttlSeconds: 300 })).toBe(true);
      const scheduler = new WorkerScheduler(h.runtime, { tickIntervalMs: 1_000 });
      const result = await scheduler.tick(new Date('2026-03-03T10:03:45.000Z'));
      expect(scheduler.holdsLease).toBe(false);
      expect(result.ran).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('free-tier one-shot runner & honest status reporting', () => {
  it('defaults to conservative free-tier pairs and warns if pair count exceeds single-key daily quota', () => {
    const defaultCfg = loadConfig({ NODE_ENV: 'production', VORTEX_ROLE: 'worker' } as NodeJS.ProcessEnv);
    expect(defaultCfg.pairs).toEqual([...FREE_TIER_DEFAULT_PAIRS]);
    expect(defaultCfg.pairs.length).toBe(2);

    const workerIssues = validateConfig(
      loadConfig({
        NODE_ENV: 'production',
        VORTEX_ROLE: 'worker',
        DATABASE_URL: 'postgres://user:pass@pooler.supabase.com:5432/postgres',
        VORTEX_SECRET_KEY: 'a'.repeat(64),
        VORTEX_ADMIN_TOKEN: '',
      } as NodeJS.ProcessEnv),
    );
    expect(workerIssues.filter((i) => i.severity === 'error')).toHaveLength(0);

    const overloadedCfg = loadConfig({
      NODE_ENV: 'production',
      VORTEX_ROLE: 'worker',
      VORTEX_PAIRS: 'EUR/USD,GBP/USD,USD/JPY,USD/CHF,AUD/USD,USD/CAD,NZD/USD,EUR/GBP,EUR/JPY,GBP/JPY',
    } as NodeJS.ProcessEnv);
    const budgetIssues = validateConfig(overloadedCfg);
    expect(budgetIssues.some((i) => i.key === 'VORTEX_PAIRS' && i.severity === 'warning')).toBe(true);
  });

  it('parses CLI job flags into deduplicated execution steps', () => {
    expect(jobModesFromArgv(['node', 'main.ts'], {} as NodeJS.ProcessEnv)).toBeNull();
    expect(jobModesFromArgv(['node', 'main.ts', '--once'], {} as NodeJS.ProcessEnv)).toEqual(['cycle']);
    expect(jobModesFromArgv(['node', 'main.ts', '--job=ingest,learning'], {} as NodeJS.ProcessEnv)).toEqual([
      'ingest',
      'learning',
    ]);
    expect(expandSteps(['cycle'])).toEqual(['ingest', 'activate', 'settle', 'signals', 'maintenance']);
    expect(expandSteps(['all'])).toEqual(['ingest', 'activate', 'settle', 'signals', 'learning', 'maintenance']);
  });

  it('runs a full one-shot cycle, recovers stale jobs, marks worker stopped on exit, and flags stale candles', async () => {
    const h = await createHarness({
      env: {
        VORTEX_ROLE: 'worker',
        VORTEX_PROVIDER: 'simulated',
        TWELVEDATA_API_KEY: 'simulated-primary-key-0123456789abcdef',
        VORTEX_PAIRS: 'EUR/USD,GBP/USD',
        VORTEX_MAX_CANDLE_AGE_SECONDS: '90',
      },
      seedKey: false,
    });
    const server = createRelay(h.runtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const db = h.client;
      const crashed = await claimJob(db, {
        jobName: 'ingest_market_data',
        slotKey: 'crashed-slot',
        workerId: 'dead-gha-runner',
      });
      await db.query(`update job_runs set started_at = now() - interval '15 minutes' where id = $1`, [crashed.jobRunId]);

      const report = await runOneShot(h.runtime, {
        modes: ['all'],
        now: new Date('2026-03-04T10:15:00.000Z'),
        retries: 1,
        retryDelayMs: 5,
      });

      expect(report.leaseAcquired).toBe(true);
      expect(report.recovered.jobRunsRecovered).toBeGreaterThanOrEqual(1);
      expect(report.failed).toEqual([]);
      expect(report.ran.length).toBeGreaterThanOrEqual(4);

      const keys = await listKeys(db);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.label).toBe('twelvedata-primary');

      // After runOneShot exits, the worker heartbeat is marked stopped (never CONNECTED).
      const statuses = await workerStatus(db);
      expect(statuses[0]?.liveness).toBe('STOPPING');

      const summaryRes = await fetch(`${baseUrl}/api/summary`);
      const summaryBody = (await summaryRes.json()) as {
        ok: boolean;
        data: {
          workerStatus: string;
          worker: { liveness: string; running: boolean } | null;
          lastSuccessfulJob: { jobName: string; finishedAt: string; ageSeconds: number } | null;
          marketData: { pair: string; status: string; ageSeconds: number | null; stale: boolean }[];
        };
      };
      expect(summaryBody.ok).toBe(true);
      expect(summaryBody.data.workerStatus).toBe('DISCONNECTED');
      expect(summaryBody.data.worker?.liveness).toBe('DISCONNECTED');
      expect(summaryBody.data.worker?.running).toBe(false);
      expect(summaryBody.data.lastSuccessfulJob?.jobName).toBeDefined();

      // Age the stored market_data_quality check timestamp by 20 minutes and confirm /api/summary flags it stale.
      await db.query(
        `update market_data_quality set checked_at = now() - interval '20 minutes', status = 'CONNECTED', age_seconds = 30`,
      );
      const staleRes = await fetch(`${baseUrl}/api/summary`);
      const staleBody = (await staleRes.json()) as typeof summaryBody;
      for (const row of staleBody.data.marketData) {
        expect(row.stale).toBe(true);
        expect(row.status).toBe('DISCONNECTED');
        expect(row.ageSeconds).toBeGreaterThan(600);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await h.close();
    }
  });
});