#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   tsx packages/db/src/cli/migrate.ts            # apply pending migrations
 *   tsx packages/db/src/cli/migrate.ts status     # show applied/pending + drift
 *   tsx packages/db/src/cli/migrate.ts --dry-run  # print what would be applied
 *
 * Uses DATABASE_URL_DIRECT when present (Supabase direct connection on 5432),
 * otherwise DATABASE_URL. Never prints the connection string.
 */

import { migrate, status } from '../migrate.js';
import { PgliteClient } from '../pglite.js';
import { createPostgresClient } from '../postgres.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  const useEmbedded = process.env.VORTEX_USE_EMBEDDED_DB === 'true';
  const command = process.argv[2] ?? 'apply';
  const dryRun = process.argv.includes('--dry-run');

  if (!connectionString && !useEmbedded) {
    process.stderr.write(
      'DATABASE_URL (or DATABASE_URL_DIRECT) is not configured — cannot run migrations.\n' +
        'Set it in .env / the deployment environment and try again.\n',
    );
    process.exitCode = 2;
    return;
  }

  const client = connectionString
    ? createPostgresClient(connectionString, { applicationName: 'vortex-si-migrate', max: 1 })
    : await PgliteClient.create();
  try {
    const ping = 'ping' in client ? await client.ping() : { ok: true, detail: 'embedded' };
    if (!ping.ok) {
      process.stderr.write(`Database unreachable: ${ping.detail}\n`);
      process.exitCode = 1;
      return;
    }
    if (command === 'status') {
      const rows = await status(client);
      let drifted = 0;
      for (const row of rows) {
        if (row.drift) drifted++;
        const mark = row.appliedAt ? (row.drift ? 'DRIFT' : 'APPLIED') : 'PENDING';
        process.stdout.write(`${row.version.padEnd(6)} ${mark.padEnd(8)} ${row.name}\n`);
      }
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
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
