#!/usr/bin/env node
/**
 * Read-only schema confirmation.
 *
 *   npm run db:tables
 *
 * Lists the tables and views in the public schema and verifies that
 * every table the seven migrations create is present. Reads only
 * information_schema; never creates, alters or drops anything, and
 * never prints the connection string or password.
 *
 * Exit codes: 0 all expected objects present, 1 missing objects,
 * 2 configuration error.
 */

import {
  authenticationFailureGuidance,
  DatabaseConfigError,
  resolveDatabaseConnection,
} from '../connection.js';
import { createPostgresClientFromTarget } from '../postgres.js';

/** Tables created by migrations 0001–0006 (0007 adds RLS and views). */
const EXPECTED_TABLES = [
  // 0001 core market data
  'schema_migrations',
  'market_pairs',
  'candles',
  'market_data_quality',
  'system_settings',
  // 0002 provider keys and quota
  'provider_keys',
  'provider_quota_usage',
  'provider_request_log',
  // 0003 signals and delivery
  'signals',
  'telegram_channels',
  'signal_deliveries',
  // 0004 learning models
  'model_versions',
  'learning_runs',
  'strategy_weights',
  'model_drift_reports',
  'artifacts',
  // 0005 operations health
  'worker_heartbeats',
  'job_runs',
  'job_locks',
  'system_health',
  'alerts',
  'audit_log',
  'log_events',
  // 0006 paper trading
  'paper_account',
  'paper_positions',
  'performance_snapshots',
] as const;

/** Secret-free read-only views exposed by migration 0007. */
const EXPECTED_VIEWS = [
  'public_agent_status',
  'public_worker_status',
  'public_signals',
  'public_market_quality',
  'public_candles',
  'public_pair_performance',
  'public_strategy_performance',
  'public_overall_performance',
  'public_telegram_delivery',
  'public_provider_budget',
  'public_quota_usage',
  'public_model_versions',
  'public_learning_runs',
  'public_alerts',
  'public_paper_performance',
  'public_runtime_config',
] as const;

async function run(): Promise<number> {
  let resolved;
  try {
    resolved = resolveDatabaseConnection({ purpose: 'migration' });
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      process.stderr.write(`Database configuration error (${error.variable}): ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  const target = resolved.target;
  if (!target) {
    process.stderr.write('DATABASE_URL (or DATABASE_URL_DIRECT) is not configured.\n');
    return 2;
  }

  const summary = target.describe();
  process.stdout.write(
    `source=${summary.source} endpoint=${summary.kind} host=${summary.host} ` +
      `port=${summary.port} database=${summary.database} user=${summary.user || '(default)'} ` +
      `password_present=${summary.passwordPresent ? 'yes' : 'no'} ` +
      `project_ref=${summary.projectRef ?? '(not a Supabase endpoint)'}\n`,
  );

  const client = createPostgresClientFromTarget(target, {
    applicationName: 'vortex-si-tables',
    max: 1,
  });

  try {
    const result = await client.query<{ table_name: string; table_type: string }>(
      `select table_name, table_type
       from information_schema.tables
       where table_schema = 'public'
       order by table_name`,
    );
    const present = new Set(result.rows.map((row) => row.table_name));

    for (const row of result.rows) {
      process.stdout.write(`${row.table_type.padEnd(6)} ${row.table_name}\n`);
    }

    const missingTables = EXPECTED_TABLES.filter((name) => !present.has(name));
    const missingViews = EXPECTED_VIEWS.filter((name) => !present.has(name));

    if (missingTables.length > 0 || missingViews.length > 0) {
      if (missingTables.length > 0) {
        process.stderr.write(`missing tables: ${missingTables.join(', ')}\n`);
      }
      if (missingViews.length > 0) {
        process.stderr.write(`missing views: ${missingViews.join(', ')}\n`);
      }
      return 1;
    }

    process.stdout.write(
      `schema: OK — all ${EXPECTED_TABLES.length} expected tables and ` +
        `${EXPECTED_VIEWS.length} expected public views exist (read-only check)\n`,
    );
    return 0;
  } catch (error) {
    const failure = error as Error & { code?: string | number };
    process.stderr.write(`Database unreachable: ${failure.message}\n`);
    if (failure.code === '28P01' || /password authentication failed/i.test(failure.message)) {
      process.stderr.write(`\n${authenticationFailureGuidance(target.describe().projectRef)}\n`);
    }
    return 1;
  } finally {
    await client.close();
  }
}

run().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
