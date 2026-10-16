#!/usr/bin/env node
/**
 * Mirror `packages/db/migrations/*.sql` into `supabase/migrations/`.
 *
 * The SQL in packages/db is the single source of truth: the worker applies it
 * through its own runner, and Supabase applies the mirrored copies when the
 * project is linked with the Supabase CLI. Keeping one source avoids the classic
 * "the database I tested is not the database I deployed" failure.
 *
 * Supabase names migrations `<UTC timestamp>_<name>.sql`; the numeric prefix of
 * each source file is mapped onto a deterministic timestamp so the copies are
 * byte-stable and reviewable in diffs.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sourceDir = join(root, 'packages', 'db', 'migrations');
const targetDir = join(root, 'supabase', 'migrations');

const files = readdirSync(sourceDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();

if (files.length === 0) {
  console.error(`no migrations found in ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
for (const existing of readdirSync(targetDir)) {
  if (existing.endsWith('.sql')) rmSync(join(targetDir, existing));
}

const manifest = [];
for (const file of files) {
  const index = Number(file.slice(0, 4));
  const name = file.slice(5, -4);
  // 2026-01-01T00:00:00Z + index minutes — ordered, deterministic, obvious.
  const stamp = new Date(Date.UTC(2026, 0, 1, 0, index, 0))
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14);
  const target = `${stamp}_vortex_${name}.sql`;
  const sql = readFileSync(join(sourceDir, file), 'utf8');
  writeFileSync(
    join(targetDir, target),
    `-- Generated from packages/db/migrations/${file} by scripts/sync-supabase-migrations.mjs.\n` +
      `-- Do not edit this copy: edit the source migration and re-run the sync.\n\n${sql}`,
  );
  manifest.push({ source: file, target });
}

writeFileSync(
  join(targetDir, 'README.md'),
  [
    '# Supabase migrations',
    '',
    'Generated from `packages/db/migrations` — run `npm run db:sync-supabase` after',
    'editing a source migration. Apply with `supabase db push` (or `supabase db reset`',
    'locally) after linking the project.',
    '',
    ...manifest.map((m) => `- \`${m.target}\` ← \`packages/db/migrations/${m.source}\``),
    '',
  ].join('\n'),
);

console.log(`synced ${manifest.length} migration(s) into supabase/migrations`);
for (const m of manifest) console.log(`  ${m.target}  <-  ${m.source}`);
