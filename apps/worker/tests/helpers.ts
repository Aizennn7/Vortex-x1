/**
 * Worker test harness.
 *
 * Builds a real `WorkerRuntime` on an embedded PGlite database with the full
 * migration set applied, so worker services are exercised against the same
 * schema and repositories they use in production. Nothing is mocked at the
 * database layer on purpose — the point of these tests is that the wiring
 * actually works.
 */

import { PgliteClient, insertKey, migrate, encryptSecret, keyFingerprint } from '@vortex/db';
import { maskKey } from '@vortex/core';
import type { SqlClient, StoredKey } from '@vortex/db';
import { createProvider, type MarketDataProvider } from '@vortex/provider';
import { WorkerRuntime } from '../src/runtime.js';

export const TEST_SECRET_KEY = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
export const TEST_ADMIN_TOKEN = 'worker-test-admin-token-abcdef';
export const TEST_BOT_TOKEN = '123456:TEST-BOT-TOKEN';

export interface WorkerHarness {
  runtime: WorkerRuntime;
  client: SqlClient;
  close(): Promise<void>;
}

export interface HarnessOptions {
  env?: NodeJS.ProcessEnv;
  provider?: MarketDataProvider;
  migrateDb?: boolean;
}

export async function createHarness(options: HarnessOptions = {}): Promise<WorkerHarness> {
  const client = await PgliteClient.create();
  // SQL breadcrumbs: an error from the driver carries no context, which makes
  // failures in long job chains hard to place. Attach the statement.
  const rawQuery = client.query.bind(client);
  client.query = (async <T>(sql: string, params?: unknown[]) => {
    try {
      return await (rawQuery as (s: string, p?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>)(sql, params);
    } catch (error) {
      const detail = (error as Error).message;
      const statement = sql.replace(/\s+/g, ' ').trim().slice(0, 300);
      throw new Error(`${detail}\n  sql: ${statement}\n  params: ${JSON.stringify(params ?? [])}`);
    }
  }) as typeof client.query;
  if (options.migrateDb !== false) {
    await migrate(client);
  }
  const runtime = await WorkerRuntime.create({
    db: client,
    manual: true,
    provider: options.provider ?? createProvider({ provider: 'simulated' }),
    env: {
      NODE_ENV: 'test',
      VORTEX_SECRET_KEY: TEST_SECRET_KEY,
      VORTEX_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
      VORTEX_PAIRS: 'EUR/USD,GBP/USD',
      VORTEX_PROVIDER: 'simulated',
      ...options.env,
    } as NodeJS.ProcessEnv,
  });
  return {
    runtime,
    client,
    async close() {
      await runtime.close();
    },
  };
}

/** Insert an enabled provider key and return the stored row. */
export async function seedKey(
  client: SqlClient,
  params: {
    label?: string;
    plaintext?: string;
    minuteLimit?: number | null;
    dayLimit?: number | null;
    headroomPercent?: number | null;
  } = {},
): Promise<StoredKey> {
  const plaintext = params.plaintext ?? 'demo-provider-key-abcdef123456';
  return insertKey(client, {
    label: params.label ?? `key-${Math.random().toString(36).slice(2, 8)}`,
    maskedKey: maskKey(plaintext),
    ciphertext: encryptSecret(plaintext, TEST_SECRET_KEY),
    fingerprint: keyFingerprint(plaintext),
    minuteLimit: params.minuteLimit ?? null,
    dayLimit: params.dayLimit ?? null,
    headroomPercent: params.headroomPercent ?? null,
  });
}

/**
 * The simulated provider driven by a controllable clock, so a job pipeline can
 * be replayed deterministically at any instant (the feed itself reads the clock
 * to decide which candles exist yet).
 */
export function simulatedProvider(startMs: number): { provider: MarketDataProvider; setNow: (ms: number) => void } {
  let current = startMs;
  const provider = createProvider({
    provider: 'simulated',
    simulator: { now: () => current },
  });
  return { provider, setNow: (ms: number) => { current = ms; } };
}

/** A provider stub whose behaviour each test controls. */
export function stubProvider(handlers: {
  timeSeries?: () => Promise<unknown>;
  quote?: () => Promise<unknown>;
} = {}): MarketDataProvider {
  return {
    name: 'stub',
    synthetic: false,
    async fetchTimeSeries() {
      if (!handlers.timeSeries) throw new Error('stub provider: no time series handler');
      return (await handlers.timeSeries()) as never;
    },
    async fetchQuote() {
      if (!handlers.quote) throw new Error('stub provider: no quote handler');
      return (await handlers.quote()) as never;
    },
  };
}
