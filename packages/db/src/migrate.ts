/**
 * Migration runner.
 *
 * - Forward-only, ordered by filename.
 * - Each migration is recorded with a SHA-256 checksum; editing an applied
 *   migration is detected and reported rather than silently ignored.
 * - Everything runs inside a transaction per migration, so a failure leaves
 *   the database exactly as it was.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlClient } from './driver.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

export interface MigrationFile {
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationStatus {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string | null;
  drift: boolean;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
  drifted: string[];
  durationMs: number;
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n').trim()).digest('hex');
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8');
    const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
    migrations.push({
      version: version ?? file,
      name: rest.join('_'),
      sql,
      checksum: checksumOf(sql),
    });
  }
  return migrations;
}

export async function ensureMigrationsTable(client: SqlClient): Promise<void> {
  await client.query(`
    create table if not exists schema_migrations (
      version      text primary key,
      name         text not null,
      checksum     text not null,
      applied_at   timestamptz not null default now(),
      duration_ms  integer not null default 0
    )
  `);
}

/**
 * Read-only existence probe. `to_regclass` never creates anything, so status
 * checks are safe to run against production from a read-only diagnostic.
 */
export async function hasMigrationsTable(client: SqlClient): Promise<boolean> {
  const result = await client.query<{ table: string | null }>(
    "select to_regclass('public.schema_migrations')::text as table",
  );
  return Boolean(result.rows[0]?.table);
}

export interface StatusOptions {
  /**
   * Default true: never create `schema_migrations` from a status check.
   * A read-only status on a fresh database reports every migration PENDING.
   */
  readOnly?: boolean;
}

export async function status(
  client: SqlClient,
  migrations?: MigrationFile[],
  options: StatusOptions = {},
): Promise<MigrationStatus[]> {
  const files = migrations ?? (await loadMigrations());
  const readOnly = options.readOnly ?? true;

  if (readOnly && !(await hasMigrationsTable(client))) {
    return files.map((file) => ({
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      appliedAt: null,
      drift: false,
    }));
  }

  if (!readOnly) await ensureMigrationsTable(client);
  const rows = await client.query<{ version: string; checksum: string; applied_at: string | Date }>(
    'select version, checksum, applied_at from schema_migrations',
  );
  const applied = new Map(rows.rows.map((r) => [r.version, r]));
  return files.map((file) => {
    const row = applied.get(file.version);
    return {
      version: file.version,
      name: file.name,
      checksum: file.checksum,
      appliedAt: row ? new Date(row.applied_at).toISOString() : null,
      drift: row ? row.checksum !== file.checksum : false,
    };
  });
}

/**
 * Apply pending migrations. `allowDrift` is false by default: a checksum
 * mismatch means the repository and the database disagree about history, and
 * proceeding would silently diverge production from source control.
 */
export async function migrate(
  client: SqlClient,
  options: { dir?: string; allowDrift?: boolean; dryRun?: boolean; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  const files = await loadMigrations(options.dir);
  const tableExists = await hasMigrationsTable(client);
  if (!tableExists && !options.dryRun) {
    // Only the real migrate command may create the bookkeeping table.
    await ensureMigrationsTable(client);
  }
  const rows = tableExists
    ? await client.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations')
    : { rows: [] as { version: string; checksum: string }[], rowCount: 0 };
  const applied = new Map(rows.rows.map((r) => [r.version, r.checksum]));

  const drifted: string[] = [];
  const toApply: MigrationFile[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing && existing !== file.checksum) {
      drifted.push(file.version);
      continue;
    }
    if (existing) {
      skipped.push(file.version);
      continue;
    }
    toApply.push(file);
  }

  if (drifted.length > 0 && !options.allowDrift) {
    throw new Error(
      `Migration checksum drift detected for: ${drifted.join(', ')}. ` +
        'Applied migrations must never be edited — add a new migration instead.',
    );
  }

  const appliedNow: string[] = [];
  for (const file of toApply) {
    if (options.dryRun) {
      log(`[dry-run] would apply ${file.version}_${file.name}`);
      continue;
    }
    const migrationStart = Date.now();
    await client.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query(
        `insert into schema_migrations (version, name, checksum, duration_ms)
         values ($1, $2, $3, $4)
         on conflict (version) do update set checksum = excluded.checksum, applied_at = now()`,
        [file.version, file.name, file.checksum, Date.now() - migrationStart],
      );
    });
    appliedNow.push(file.version);
    log(`applied ${file.version}_${file.name} in ${Date.now() - migrationStart}ms`);
  }

  return { applied: appliedNow, skipped, drifted, durationMs: Date.now() - started };
}
