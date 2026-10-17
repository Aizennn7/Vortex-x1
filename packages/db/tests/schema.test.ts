import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { checksumOf, hasMigrationsTable, loadMigrations, migrate, status } from '../src/migrate.js';
import { PgliteClient } from '../src/pglite.js';
import { createTestDb, type TestDb } from './helpers.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('migrations', () => {
  it('loads the migration set in order with checksums', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(7);
    const versions = migrations.map((m) => m.version);
    expect([...versions].sort()).toEqual(versions);
    expect(migrations[0]?.version).toBe('0001');
    for (const migration of migrations) {
      expect(migration.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(migration.checksum).toBe(checksumOf(migration.sql));
    }
  });

  it('is idempotent — re-running applies nothing', async () => {
    const result = await migrate(db.client);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThanOrEqual(7);
    expect(result.drifted).toHaveLength(0);
  });

  it('reports drift when an applied migration file is edited', async () => {
    const migrations = await loadMigrations();
    const tampered = migrations.map((m, i) => (i === 0 ? { ...m, checksum: 'deadbeef' } : m));
    const rows = await status(db.client, tampered);
    expect(rows[0]?.drift).toBe(true);
    expect(rows[1]?.drift).toBe(false);
  });

  it('creates every documented table', async () => {
    const rows = await db.client.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const tables = rows.rows.map((r) => r.tablename);
    for (const expected of [
      'candles',
      'market_pairs',
      'market_data_quality',
      'provider_keys',
      'provider_quota_usage',
      'provider_request_log',
      'signals',
      'signal_deliveries',
      'telegram_channels',
      'model_versions',
      'learning_runs',
      'strategy_weights',
      'model_drift_reports',
      'artifacts',
      'worker_heartbeats',
      'job_runs',
      'job_locks',
      'system_health',
      'alerts',
      'audit_log',
      'log_events',
      'paper_account',
      'paper_positions',
      'performance_snapshots',
      'system_settings',
      'schema_migrations',
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it('enforces OHLC integrity in the database, not only in application code', async () => {
    await expect(
      db.client.query(
        `insert into candles (pair, timeframe, open_time, close_time, open, high, low, close, provider, is_final)
         values ('EUR/USD', 'M1', '2026-01-05T10:00:00Z', '2026-01-05T10:01:00Z', 1.1, 1.05, 1.2, 1.1, 'test', true)`,
      ),
    ).rejects.toThrow();
  });

  it('enforces the signal status and outcome vocabularies', async () => {
    await expect(
      db.client.query(
        `insert into signals (idempotency_key, pair, direction, decision, strategy, confidence, regime,
           scheduled_entry_at, publish_at, horizon_seconds, reference_price, stop_pips, target_pips, reward_risk, engine_version)
         values ('bad-status', 'EUR/USD', 'BUY', 'BUY', 'trend_follow', 0.7, 'TREND_UP',
           '2026-01-05T10:05:00Z', '2026-01-05T10:04:00Z', 60, 1.1, 10, 14, 1.4, 'test')`,
      ),
    ).resolves.toBeDefined();
    await expect(
      db.client.query(`update signals set status = 'NOPE' where idempotency_key = 'bad-status'`),
    ).rejects.toThrow();
    await expect(
      db.client.query(`update signals set outcome = 'MASSIVE_WIN' where idempotency_key = 'bad-status'`),
    ).rejects.toThrow();
  });

  it('prevents duplicate (pair, entry, direction) signals', async () => {
    const insert = (key: string) =>
      db.client.query(
        `insert into signals (idempotency_key, pair, direction, decision, strategy, confidence, regime,
           scheduled_entry_at, publish_at, horizon_seconds, reference_price, stop_pips, target_pips, reward_risk, engine_version)
         values ($1, 'GBP/USD', 'SELL', 'SELL', 'momentum', 0.7, 'TREND_DOWN',
           '2026-01-05T11:05:00Z', '2026-01-05T11:04:00Z', 60, 1.27, 10, 14, 1.4, 'test')`,
        [key],
      );
    await insert('dup-1');
    await expect(insert('dup-2')).rejects.toThrow();
  });
});

describe('access control', () => {
  it('enables row level security on every table', async () => {
    const rows = await db.client.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where relkind = 'r' and relnamespace = 'public'::regnamespace`,
    );
    const withoutRls = rows.rows.filter((r) => !r.relrowsecurity).map((r) => r.relname);
    expect(withoutRls).toEqual([]);
  });

  it('creates the public read views the browser uses', async () => {
    const rows = await db.client.query<{ viewname: string }>(
      `select viewname from pg_views where schemaname = 'public' order by viewname`,
    );
    const views = rows.rows.map((r) => r.viewname);
    for (const view of [
      'public_signals',
      'public_overall_performance',
      'public_pair_performance',
      'public_strategy_performance',
      'public_market_quality',
      'public_telegram_delivery',
      'public_provider_budget',
      'public_model_versions',
      'public_worker_status',
      'public_alerts',
      'public_paper_performance',
      'public_runtime_config',
      'public_agent_status',
      'public_quota_usage',
    ]) {
      expect(views).toContain(view);
    }
  });

  it('never exposes key material through a public view', async () => {
    // Insert a key row, then prove no view can surface its ciphertext.
    await db.client.query(
      `insert into provider_keys (label, masked_key, ciphertext, key_fingerprint)
       values ('view-test', '••••abcd', 'v1:iv:tag:ciphertext-value', 'fingerprint1234')`,
    );
    const views = await db.client.query<{ viewname: string }>(
      `select viewname from pg_views where schemaname = 'public'`,
    );
    for (const { viewname } of views.rows) {
      const columns = await db.client.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [viewname],
      );
      const names = columns.rows.map((c) => c.column_name.toLowerCase());
      expect(names.some((n) => n.includes('ciphertext') || n.includes('key_fingerprint') || n.includes('chat_id'))).toBe(false);
    }
    // And the provider key table itself is not queryable by anon.
    const privileges = await db.client.query<{ has_table_privilege: boolean }>(
      `select has_table_privilege('anon', 'public.provider_keys', 'select') as has_table_privilege`,
    );
    expect(privileges.rows[0]?.has_table_privilege).toBe(false);
    const signalPrivileges = await db.client.query<{ has_table_privilege: boolean }>(
      `select has_table_privilege('anon', 'public.signals', 'select') as has_table_privilege`,
    );
    expect(signalPrivileges.rows[0]?.has_table_privilege).toBe(false);
    const viewPrivileges = await db.client.query<{ has_table_privilege: boolean }>(
      `select has_table_privilege('anon', 'public.public_signals', 'select') as has_table_privilege`,
    );
    expect(viewPrivileges.rows[0]?.has_table_privilege).toBe(true);
  });

  it('does not expose the delivery ledger telegram internals via public views', async () => {
    // public_telegram_delivery intentionally exposes channel_label (an operator
    // chosen name) but never the chat id itself.
    const columns = await db.client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'public_telegram_delivery'`,
    );
    const names = columns.rows.map((c) => c.column_name);
    expect(names).toContain('channel_label');
    expect(names).not.toContain('chat_id');
  });
});


describe('read-only migration checks', () => {
  async function freshClient(): Promise<{ client: PgliteClient; close: () => Promise<void> }> {
    const pglite = new PGlite();
    await pglite.waitReady;
    const client = new PgliteClient(pglite);
    return { client, close: async () => client.close() };
  }

  it('status() never creates schema_migrations and reports every migration pending', async () => {
    const { client, close } = await freshClient();
    try {
      expect(await hasMigrationsTable(client)).toBe(false);
      const rows = await status(client);
      expect(rows.length).toBeGreaterThanOrEqual(7);
      expect(rows.every((row) => row.appliedAt === null)).toBe(true);
      expect(rows.every((row) => row.drift === false)).toBe(true);
      // The read-only status must not have created the bookkeeping table.
      expect(await hasMigrationsTable(client)).toBe(false);
    } finally {
      await close();
    }
  });

  it('migrate({ dryRun: true }) writes nothing on a fresh database', async () => {
    const { client, close } = await freshClient();
    try {
      const result = await migrate(client, { dryRun: true });
      expect(result.applied).toHaveLength(0);
      expect(await hasMigrationsTable(client)).toBe(false);
    } finally {
      await close();
    }
  });

  it('the real migrate command creates the table and status then reports applied', async () => {
    const { client, close } = await freshClient();
    try {
      const applied = await migrate(client);
      expect(applied.applied.length).toBeGreaterThanOrEqual(7);
      expect(await hasMigrationsTable(client)).toBe(true);
      const rows = await status(client);
      expect(rows.every((row) => row.appliedAt !== null)).toBe(true);
      expect(rows.every((row) => row.drift === false)).toBe(true);
    } finally {
      await close();
    }
  });
});
