/**
 * Embedded PGlite driver. Used by the test suite (and optionally for local
 * development) so migrations, repositories and the quota reservation logic are
 * exercised against a REAL PostgreSQL engine with no external service.
 */

import { PGlite } from '@electric-sql/pglite';
import { normalizeParams, type SqlClient, type SqlResult } from './driver.js';

export class PgliteClient implements SqlClient {
  readonly dialect = 'pglite' as const;
  private readonly db: PGlite;

  constructor(db?: PGlite) {
    this.db = db ?? new PGlite();
  }

  static async create(): Promise<PgliteClient> {
    const db = new PGlite();
    await db.waitReady;
    return new PgliteClient(db);
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<SqlResult<T>> {
    const result = await this.db.query<T>(sql, normalizeParams(params) as never[]);
    return { rows: (result.rows ?? []) as T[], rowCount: result.affectedRows ?? (result.rows?.length ?? 0) };
  }

  /**
   * PGlite supports real transactions via `BEGIN/COMMIT` on the same
   * connection. Nested calls reuse the outer transaction (no savepoints) which
   * is sufficient for the reservation logic under test.
   */
  /**
   * PGlite executes multiple statements only through `exec`, and its prepared
   * statement path rejects them, so migrations must use this method.
   */
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> {
    let depth = 0;
    const self = this;
    const tx: SqlClient = {
      dialect: 'pglite',
      query: (sql, params) => self.query(sql, params),
      exec: (script) => self.exec(script),
      transaction: async (inner) => {
        depth += 1;
        try {
          return await inner(tx);
        } finally {
          depth -= 1;
        }
      },
      close: async () => undefined,
    };
    await this.db.exec('begin');
    try {
      const out = await fn(tx);
      await this.db.exec('commit');
      return out;
    } catch (error) {
      try {
        await this.db.exec('rollback');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }

}
