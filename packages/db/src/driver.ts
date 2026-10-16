/**
 * Minimal SQL driver abstraction so the exact same repository code runs
 * against production Postgres (`pg`) and against the embedded PGlite engine
 * used by the test suite.
 */

export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlClient {
  readonly dialect: 'postgres' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<SqlResult<T>>;
  /**
   * Execute a multi-statement SQL script (migrations, DDL). Parameter binding
   * is intentionally unsupported here so no user input can reach a script.
   */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Normalise a value for Postgres.
 *  - undefined -> null
 *  - Date -> ISO string
 *  - arrays pass through untouched (pg maps JS arrays to Postgres arrays;
 *    JSON-encoding them would produce `malformed array literal`)
 *  - plain objects are JSON encoded for jsonb columns
 *  - Buffers and primitives pass through
 */
export function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => normalizeParam(item));
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

export function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map(normalizeParam);
}

/** Build a parameterised VALUES list: values(...),(...) with $1..$n. */
export function placeholders(rows: unknown[][]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const chunks: string[] = [];
  for (const row of rows) {
    const group: string[] = [];
    for (const value of row) {
      params.push(normalizeParam(value));
      group.push(`$${params.length}`);
    }
    chunks.push(`(${group.join(', ')})`);
  }
  return { sql: chunks.join(', '), params };
}
