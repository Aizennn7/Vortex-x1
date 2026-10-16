/**
 * VORTEX SI worker entry point.
 *
 * Boots the runtime, applies migrations (when explicitly enabled), starts the
 * HTTP relay for the control centre and runs the tick scheduler until it is
 * asked to stop. Graceful shutdown matters: the database connection is only
 * closed after the in-flight tick completes, so a restart never leaves a half
 * written settlement behind.
 */

import { validateConfig } from '@vortex/core';
import { migrate } from '@vortex/db';
import { WorkerRuntime } from './runtime.js';
import { WorkerScheduler } from './scheduler.js';
import { createRelay } from './http.js';

async function main(): Promise<void> {
  const runtime = await WorkerRuntime.create();
  const logger = runtime.logger;

  logger.info('VORTEX SI worker starting', {
    component: 'boot',
    version: runtime.config.engineVersion,
    env: runtime.config.nodeEnv,
    provider: runtime.config.provider,
    synthetic: runtime.providerSynthetic,
    pairs: runtime.config.pairs.length,
    cadenceMinutes: runtime.config.scanCadenceMinutes,
    publishLeadSeconds: runtime.config.publishLeadSeconds,
    horizonSeconds: runtime.config.signalHorizonSeconds,
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

  const relay = createRelay(runtime);
  const port = runtime.config.port;
  const host = runtime.config.host;
  await new Promise<void>((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(port, host, () => resolve());
  });
  logger.info('relay listening', {
    component: 'http',
    host,
    port,
    publicRoutes: ['/health', '/ready', '/api/summary', '/api/config', '/api/signals', '/api/performance'],
    adminRoutesEnabled: runtime.config.adminToken.length >= 16,
  });

  const scheduler = new WorkerScheduler(runtime);
  if (!runtime.stopping) scheduler.start();

  const shutdown = async (signal: string) => {
    if (runtime.stopping) return;
    logger.info('shutdown requested', { component: 'boot', signal });
    runtime.stopping = true;
    await scheduler.stop();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await runtime.close();
    logger.info('worker stopped cleanly', { component: 'boot', counters: runtime.counters });
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
      detail: runtime.db.detail,
      issues: validateConfig(runtime.config).map((i) => i.key),
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'worker failed to start', error: (error as Error).message })}\n`);
  process.exit(1);
});
