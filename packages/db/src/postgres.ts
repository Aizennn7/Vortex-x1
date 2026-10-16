/**
 * Postgres driver backed by `pg`. Used by the worker, the relay and the
 * migration CLI in every real deployment (Supabase pooled connection string).
 */

import pg from 'pg';
import { normalizeParams, type SqlClient, type SqlResult } from './driver.js';

const { Pool } = pg;

export interface PostgresClientOptions {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export class PostgresClient implements SqlClient {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(options: PostgresClientOptions) {
    const needsSsl =
      options.ssl ??
      (!/localhost|127\.0\.0\.1/.test(options.connectionString) && !options.connectionString.includes('sslmode=disable'));
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 5,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      application_name: options.applicationName ?? 'vortex-si',
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    });
    this.pool.on('error', () => {
      /* pool-level errors surface on the next checkout; never crash the process */
    });
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.pool.query(sql, normalizeParams(params));
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const wrapper: SqlClient = {
      dialect: 'postgres',
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<R>> => {
        const result = await client.query(sql, normalizeParams(params));
        return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
      },
      exec: async (script: string): Promise<void> => {
        await client.query(script);
      },
      transaction: async <R>(inner: (tx: SqlClient) => Promise<R>): Promise<R> => inner(wrapper),
      close: async () => undefined,
    };
    try {
      await client.query('begin');
      const out = await fn(wrapper);
      await client.query('commit');
      return out;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* connection already gone; nothing else to do */
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Connectivity probe used by health checks. */
  async ping(): Promise<{ ok: boolean; detail: string; latencyMs: number }> {
    const started = Date.now();
    try {
      const result = await this.query<{ now: string }>('select now() as now');
      return { ok: true, detail: `server time ${result.rows[0]?.now ?? 'unknown'}`, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - started };
    }
  }
}

export function createPostgresClient(connectionString: string, options: Partial<PostgresClientOptions> = {}): PostgresClient {
  return new PostgresClient({ connectionString, ...options });
}
