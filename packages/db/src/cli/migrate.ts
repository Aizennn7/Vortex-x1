#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   tsx packages/db/src/cli/migrate.ts            # apply pending migrations
 *   tsx packages/db/src/cli/migrate.ts status     # READ-ONLY: applied/pending + drift
 *   tsx packages/db/src/cli/migrate.ts --dry-run  # print what would be applied, write nothing
 *
 * Connection selection is delegated to `resolveDatabaseConnection`:
 * `DATABASE_URL` (the Supabase Session Pooler URI) is authoritative;
 * `DATABASE_URL_DIRECT` is only a fallback when `DATABASE_URL` is unset.
 * Invalid values fail closed with an actionable message before any DNS lookup.
 *
 * `status` never creates `schema_migrations` and never applies a migration, so
 * it can be run against production from a read-only diagnostic. The connection
 * string is never printed; only the parsed host/port/database/user are shown.
 */

import {
  authenticationFailureGuidance,
  DatabaseConfigError,
  resolveDatabaseConnection,
  supabasePoolerTenantGuidance,
  type DatabaseTarget,
} from '../connection.js';
import { migrate, status } from '../migrate.js';
import { PgliteClient } from '../pglite.js';
import { createPostgresClientFromTarget } from '../postgres.js';

function describeTarget(target: DatabaseTarget): string {
  const summary = target.describe();
  return (
    `source=${summary.source} endpoint=${summary.kind} ` +
    `host=${summary.host} port=${summary.port} database=${summary.database} ` +
    `user=${summary.user || '(default)'} password_present=${summary.passwordPresent ? 'yes' : 'no'} ` +
    `ssl=${summary.ssl ? (summary.sslMode ?? 'required') : 'off'}`
  );
}

function printWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }
}

async function main(): Promise<void> {
  const useEmbedded = process.env.VORTEX_USE_EMBEDDED_DB === 'true';
  const command = process.argv[2] ?? 'apply';
  const dryRun = process.argv.includes('--dry-run');
  const wantsStatus = command === 'status';

  let target: DatabaseTarget | null = null;
  try {
    const resolved = resolveDatabaseConnection({
      // Both status and apply enforce the deployment requirements: SQLite/
      // transaction-pooler/direct-on-IPv4 endpoints are rejected for both.
      purpose: 'migration',
    });
    target = resolved.target;
    printWarnings(resolved.warnings);
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      process.stderr.write(
        `Database configuration error (${error.variable}): ${error.message}\n` +
          'No connection was attempted and no migrations were applied.\n' +
          'See docs/DEPLOYMENT.md → "Database connection" and set the Supabase Session Pooler URI.\n',
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (!target && !useEmbedded) {
    process.stderr.write(
      'DATABASE_URL (or DATABASE_URL_DIRECT) is not configured — cannot run migrations.\n' +
        'Set it in .env / the deployment environment and try again.\n' +
        'For local development only, VORTEX_USE_EMBEDDED_DB=true uses embedded PGlite.\n',
    );
    process.exitCode = 2;
    return;
  }

  const client = target
    ? createPostgresClientFromTarget(target, { applicationName: 'vortex-si-migrate', max: 1 })
    : await PgliteClient.create();

  if (target) {
    process.stdout.write(`database: ${describeTarget(target)}\n`);
  } else {
    process.stdout.write('database: embedded PGlite (VORTEX_USE_EMBEDDED_DB=true)\n');
  }

  try {
    const ping = 'ping' in client ? await client.ping() : { ok: true, detail: 'embedded' };
    if (!ping.ok) {
      process.stderr.write(`Database unreachable: ${ping.detail}\n`);
      if (
        target?.kind === 'session-pooler' &&
        /tenant\/user.*not found|tenant or user.*not found/i.test(ping.detail)
      ) {
        process.stderr.write(`\n${supabasePoolerTenantGuidance(target)}\n`);
      }
      if (/password authentication failed/i.test(ping.detail)) {
        process.stderr.write(`\n${authenticationFailureGuidance(target?.projectRef ?? null)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    if (wantsStatus) {
      // Read-only: `status` uses `to_regclass` and never creates the table.
      const rows = await status(client);
      let drifted = 0;
      let pending = 0;
      for (const row of rows) {
        if (row.drift) drifted++;
        if (!row.appliedAt) pending++;
        const mark = row.appliedAt ? (row.drift ? 'DRIFT' : 'APPLIED') : 'PENDING';
        process.stdout.write(`${row.version.padEnd(6)} ${mark.padEnd(8)} ${row.name}\n`);
      }
      process.stdout.write(
        `migrations: ${rows.length - pending} applied, ${pending} pending, ${drifted} drift ` +
          '(read-only check — nothing was created or applied)\n',
      );
      if (drifted > 0) {
        process.stderr.write(
          `Refusing to proceed: ${drifted} applied migration(s) have checksum drift. Existing database data is preserved.\n`,
        );
        process.exitCode = 1;
      }
      return;
    }
    const result = await migrate(client, { dryRun, log: (line) => process.stdout.write(`${line}\n`) });
    process.stdout.write(
      `migrations: applied ${result.applied.length}, already present ${result.skipped.length}, drift ${result.drifted.length} (${result.durationMs}ms)\n`,
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  // Messages from DatabaseConfigError/PostgresClient are already sanitised.
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
