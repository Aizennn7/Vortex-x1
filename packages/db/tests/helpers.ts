/**
 * Test harness: a real PostgreSQL engine (PGlite, in-process) with the
 * production migrations applied. No mocking of SQL — the queries under test
 * are the queries that run in production.
 */

import { PGlite } from '@electric-sql/pglite';
import { PgliteClient } from '../src/pglite.js';
import { migrate } from '../src/migrate.js';
import type { SqlClient } from '../src/driver.js';

export interface TestDb {
  client: SqlClient;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  await pglite.waitReady;
  const client = new PgliteClient(pglite);
  await migrate(client);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

/** PGlite binds a single connection; transactions are serialised by design. */
export function isPglite(client: SqlClient): boolean {
  return client.dialect === 'pglite';
}

export const KEY_A = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const KEY_B = '00112233445566778899aabbccddeeff';
