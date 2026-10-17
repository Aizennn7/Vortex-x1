/**
 * Postgres driver backed by `pg`. Used by the worker, the relay and the
 * migration CLI in every real deployment (Supabase pooled connection string).
 *
 * The raw connection string is validated by `parseDatabaseUrl` and then
 * translated into explicit pool fields. It is never handed to `pg` as
 * `connectionString`: `pg-connection-string` parses relative input against its
 * internal `postgres://base` URL, which is how a typo used to surface as
 * `getaddrinfo EAI_AGAIN base`. Passing validated fields removes that failure
 * mode entirely.
 */

import pg from 'pg';
import {
  DatabaseConfigError,
  parseDatabaseUrl,
  type DatabaseTarget,
  type DatabaseTargetSummary,
} from './connection.js';
import { normalizeParams, type SqlClient, type SqlResult } from './driver.js';

const { Pool } = pg;

export interface PostgresClientOptions {
  /** Raw PostgreSQL URI. Validated before it reaches the driver. */
  connectionString?: string;
  /** Pre-validated target (preferred when the caller already resolved it). */
  target?: DatabaseTarget;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  applicationName?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export class PostgresClient implements SqlClient {
  readonly dialect = 'postgres' as const;
  readonly target: DatabaseTargetSummary;
  private readonly pool: pg.Pool;
  /** Values that must never appear in an error message or log line. */
  readonly #secrets: string[];

  constructor(options: PostgresClientOptions) {
    const target =
      options.target ??
      parseDatabaseUrl(options.connectionString ?? '', {
        variable: 'DATABASE_URL',
        purpose: 'runtime',
        env: process.env,
      });

    this.target = target.describe();
    this.#secrets = target.secretValues();

    const config = target.toPgConfig();
    if (options.ssl !== undefined) {
      config.ssl = options.ssl;
    }

    this.pool = new Pool({
      ...config,
      max: options.max ?? 5,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 10_000,
      application_name: options.applicationName ?? 'vortex-si',
    });
    this.pool.on('error', () => {
      /* pool-level errors surface on the next checkout; never crash the process */
    });
  }

  /** Safe connection description for logs and diagnostics — never the password. */
  describe(): DatabaseTargetSummary {
    return { ...this.target };
  }

  /** Redact the password/raw URI if a driver error ever embeds one. */
  private safeMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.#secrets) {
      if (secret.length >= 4) message = message.split(secret).join('[redacted]');
    }
    // Defence in depth: strip any PostgreSQL URI that survives redaction.
    return message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]');
  }

  /** Keep useful driver codes (EAI_AGAIN, 28P01, ...) while redacting values. */
  private safeError(error: unknown): Error {
    const safe = new Error(this.safeMessage(error));
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' || typeof code === 'number') {
      (safe as Error & { code?: string | number }).code = code;
    }
    return safe;
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    try {
      const result = await this.pool.query(sql, normalizeParams(params));
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (error) {
      throw this.safeError(error);
    }
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw this.safeError(error);
    }
    const wrapper: SqlClient = {
      dialect: 'postgres',
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<R>> => {
        try {
          const result = await client.query(sql, normalizeParams(params));
          return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
        } catch (error) {
          throw this.safeError(error);
        }
      },
      exec: async (script: string): Promise<void> => {
        try {
          await client.query(script);
        } catch (error) {
          throw this.safeError(error);
        }
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
      // Errors raised by `fn` keep their type; query errors are already
      // sanitised inside the wrapper above.
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
      return { ok: false, detail: this.safeMessage(error), latencyMs: Date.now() - started };
    }
  }
}

/**
 * Create a client from a raw connection string.
 *
 * Throws `DatabaseConfigError` before any DNS lookup when the value is empty,
 * relative, a placeholder, or a non-IPv4 Supabase endpoint on GitHub Actions.
 */
export function createPostgresClient(
  connectionString: string,
  options: Partial<PostgresClientOptions> = {},
): PostgresClient {
  return new PostgresClient({ ...options, connectionString });
}

/** Create a client from a target that was already validated/resolved. */
export function createPostgresClientFromTarget(
  target: DatabaseTarget,
  options: Partial<PostgresClientOptions> = {},
): PostgresClient {
  return new PostgresClient({ ...options, target });
}

export { DatabaseConfigError };
