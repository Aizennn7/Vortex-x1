/**
 * VORTEX SI persistence layer public surface.
 */

export * from './driver.js';
export * from './connection.js';
export * from './postgres.js';
export * from './pglite.js';
export * from './crypto.js';
export * from './migrate.js';

export * from './repos/rows.js';
export * from './repos/candles.js';
export * from './repos/keys.js';
export * from './repos/quota.js';
export * from './repos/signals.js';
export * from './repos/jobs.js';
export * from './repos/health.js';
export * from './repos/learning.js';
export * from './repos/paper.js';
export * from './repos/settings.js';
export * from './repos/telegram.js';

import type { SqlClient } from './driver.js';
import { PostgresClient } from './postgres.js';

export interface DatabaseHandle {
  client: SqlClient;
  kind: 'postgres' | 'pglite';
  /** True when the handle is usable; false when the DB is unreachable. */
  connected: boolean;
  detail: string;
  /** Non-fatal configuration advice (never contains secret values). */
  warnings?: string[];
}

/**
 * Open the database. Never throws for a missing/unreachable database: the
 * caller receives `connected: false` and the control centre shows
 * CONFIGURATION REQUIRED / DISCONNECTED instead of a crash loop.
 */
export async function openDatabase(params: {
  connectionString: string;
  required?: boolean;
  maxConnections?: number;
  applicationName?: string;
}): Promise<DatabaseHandle> {
  if (!params.connectionString) {
    if (params.required) {
      throw new Error('DATABASE_URL is not configured');
    }
    return { client: null as unknown as SqlClient, kind: 'postgres', connected: false, detail: 'DATABASE_URL not configured' };
  }
  let client: PostgresClient;
  try {
    client = new PostgresClient({
      connectionString: params.connectionString,
      max: params.maxConnections ?? 5,
      applicationName: params.applicationName ?? 'vortex-si',
    });
  } catch (error) {
    // Invalid/placeholder connection strings are configuration errors, not
    // transient outages. Surface the safe message instead of attempting DNS.
    if (params.required) throw error;
    return { client: null as unknown as SqlClient, kind: 'postgres', connected: false, detail: (error as Error).message };
  }
  try {
    const ping = await client.ping();
    if (!ping.ok) {
      if (params.required) throw new Error(`database unreachable: ${ping.detail}`);
      return { client, kind: 'postgres', connected: false, detail: ping.detail };
    }
    return { client, kind: 'postgres', connected: true, detail: ping.detail };
  } catch (error) {
    if (params.required) throw error;
    return { client, kind: 'postgres', connected: false, detail: (error as Error).message };
  }
}
