/**
 * VORTEX SI worker entry point.
 *
 * One binary, three roles (`VORTEX_ROLE`, or `--role=` on the command line):
 *
 *   relay  — binds the HTTP relay and nothing else. Safe to restart, scale and
 *            expose publicly: it never schedules a cycle.
 *   worker — runs the tick scheduler (ingestion, signals, settlement,
 *            maintenance, training) and binds no port at all.
 *   all    — both in one process; the default, used for local development.
 *
 * A production deployment runs `relay` and `worker` as two services so the
 * public surface can be redeployed without interrupting ingestion. Both roles
 * share the database, the job slots and the scheduler lease, so running either
 * of them twice is still safe.
 *
 * Graceful shutdown matters: the scheduler drains its in-flight tick, the relay
 * stops accepting connections and the database is only closed afterwards, so a
 * restart never leaves a half written settlement behind.
 */

import type { Server } from 'node:http';
import { validateConfig, type VortexConfig } from '@vortex/core';
import { migrate } from '@vortex/db';
import { WorkerRuntime } from './runtime.js';
import { WorkerScheduler } from './scheduler.js';
import { createRelay } from './http.js';
import { planForRole, roleFromArgv, type Role } from './role.js';
import { jobModesFromArgv, runOneShot } from './runner.js';

async function main(): Promise<void> {
  const cliRole = roleFromArgv();
  const jobModes = jobModesFromArgv();
  const effectiveRole: Role | undefined = jobModes ? 'worker' : cliRole;
  const runtime = await WorkerRuntime.create(
    effectiveRole ? { config: { role: effectiveRole } as Partial<VortexConfig> } : {},
  );
  const logger = runtime.logger;

  const role: Role = runtime.config.role;
  const { relay: servesRelay, scheduler: runsScheduler } = planForRole(role);

  logger.info('VORTEX SI worker starting', {
    component: 'boot',
    role,
    oneShotModes: jobModes ?? null,
    version: runtime.config.engineVersion,
    env: runtime.config.nodeEnv,
    provider: runtime.config.provider,
    synthetic: runtime.providerSynthetic,
    pairs: runtime.config.pairs.length,
    cadenceMinutes: runtime.config.scanCadenceMinutes,
    publishLeadSeconds: runtime.config.publishLeadSeconds,
    horizonSeconds: runtime.config.signalHorizonSeconds,
    workerId: runtime.config.workerId,
    database: runtime.db.connected ? 'connected' : 'unavailable',
  });

  for (const issue of runtime.issues) {
    const log = issue.severity === 'error' ? logger.error.bind(logger) : logger.warn.bind(logger);
    log('configuration issue', { component: 'boot', key: issue.key, message: issue.message });
  }
  if (runtime.providerSynthetic) {
    logger.warn('market data provider is SIMULATED — candles are synthetic and are labelled as such everywhere', {
      component: 'boot',
      provider: runtime.provider.name,
    });
  }

  // Migrations are opt-in so a worker restart never surprises an operator with
  // a schema change. `npm run migrate` (or VORTEX_AUTO_MIGRATE=true) applies them.
  if (process.env.VORTEX_AUTO_MIGRATE === 'true' && runtime.db.connected) {
    const result = await migrate(runtime.db.client, { log: (line) => logger.info(line, { component: 'db' }) });
    logger.info('migrations applied at boot', {
      component: 'db',
      applied: result.applied.length,
      skipped: result.skipped.length,
    });
  }

  if (jobModes) {
    try {
      const summary = await runOneShot(runtime, { modes: jobModes });
      logger.info('one-shot job run finished', {
        component: 'runner',
        modes: summary.modes,
        leaseAcquired: summary.leaseAcquired,
        ran: summary.ran,
        skipped: summary.skipped,
        failed: summary.failed,
        recovered: summary.recovered,
        lastSuccessfulJob: summary.lastSuccessfulJob,
        durationMs: summary.durationMs,
      });
      if (summary.failed.length > 0) {
        process.exitCode = 1;
      }
    } finally {
      await runtime.close();
    }
    return;
  }

  let relay: Server | null = null;
  if (servesRelay) {
    relay = createRelay(runtime);
    const port = runtime.config.port;
    const host = runtime.config.host;
    await new Promise<void>((resolve, reject) => {
      (relay as Server).once('error', reject);
      (relay as Server).listen(port, host, () => resolve());
    });
    logger.info('relay listening', {
      component: 'http',
      host,
      port,
      publicRoutes: ['/health', '/ready', '/api/summary', '/api/config', '/api/signals', '/api/performance'],
      adminRoutesEnabled: runtime.config.adminToken.length >= 16,
    });
  } else {
    logger.info('relay not started — this process runs the scheduler only (VORTEX_ROLE=worker)', {
      component: 'http',
      role,
    });
  }

  let scheduler: WorkerScheduler | null = null;
  if (runsScheduler) {
    scheduler = new WorkerScheduler(runtime);
    if (!runtime.stopping) scheduler.start();
  } else {
    logger.info('scheduler not started — this process serves the relay only (VORTEX_ROLE=relay)', {
      component: 'scheduler',
      role,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown requested', { component: 'boot', signal, role });
    runtime.stopping = true;
    if (scheduler) await scheduler.stop();
    if (relay) await new Promise<void>((resolve) => relay?.close(() => resolve()));
    await runtime.close();
    logger.info('worker stopped cleanly', { component: 'boot', role, counters: runtime.counters });
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    runtime.recordError(reason);
    logger.error('unhandled rejection', { component: 'boot', error: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    runtime.recordError(error);
    logger.fatal('uncaught exception', { component: 'boot', error: error.message });
    void shutdown('uncaughtException');
  });

  // Fail loudly but usefully when the database is missing in production: the
  // relay still answers /health so the operator can see why.
  if (!runtime.db.connected && runtime.config.nodeEnv === 'production') {
    logger.error('database is not reachable in production — ingestion, signals and settlement will not run', {
      component: 'boot',
      role,
      detail: runtime.db.detail,
      issues: validateConfig(runtime.config).map((i) => i.key),
    });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'worker failed to start', error: (error as Error).message })}\n`,
  );
  process.exit(1);
});