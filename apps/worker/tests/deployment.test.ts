/**
 * Deployment topology: process roles and the singleton scheduler lease.
 *
 * These are the two guarantees a two-service production deployment rests on —
 * a relay that cannot accidentally schedule work, and at most one scheduler
 * doing that work — so they are tested rather than trusted.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig, publicRuntimeConfig, validateConfig } from '@vortex/core';
import { listLocks, workerStatus, acquireLock, type SqlClient } from '@vortex/db';
import { createHarness } from './helpers.js';
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