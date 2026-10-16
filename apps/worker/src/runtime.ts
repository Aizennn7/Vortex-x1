/**
 * Worker runtime: shared state, dependency wiring and lifecycle.
 *
 * One process owns: market ingestion, signal scheduling/publishing, outcome
 * settlement, Telegram delivery, the learning pipeline, maintenance jobs and
 * the relay HTTP surface. Everything is idempotent and restart-safe; nothing
 * depends on in-memory state that could not be rebuilt from the database.
 */

import {
  createLogger,
  loadConfig,
  publicRuntimeConfig,
  secretValues,
  validateConfig,
  type BoundLogger,
  type ConfigIssue,
  type PublicRuntimeConfig,
  type VortexConfig,
} from '@vortex/core';
import {
  createPostgresClient,
  type DatabaseHandle,
  type PostgresClient,
  type SqlClient,
  type StoredKey,
} from '@vortex/db';
import { createProvider, type MarketDataProvider } from '@vortex/provider';
import { KeyPool } from './services/keypool.js';
import { TelegramClient } from './services/telegram.js';
import { ModelService } from './services/model.js';
import { EngineService } from './services/engine.js';

export interface RuntimeCounters {
  cyclesRun: number;
  jobsCompleted: number;
  jobsFailed: number;
  candlesIngested: number;
  signalsCreated: number;
  signalsSettled: number;
  telegramSent: number;
  telegramFailed: number;
  providerRequests: number;
  providerErrors: number;
  lastError: string | null;
}

export interface WorkerRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  config?: Partial<VortexConfig>;
  /** Inject a database client (tests). */
  db?: SqlClient;
  /** Inject a provider (tests / offline development). */
  provider?: MarketDataProvider;
  /** Disable the periodic scheduler loops (tests drive jobs manually). */
  manual?: boolean;
}

export class WorkerRuntime {
  readonly config: VortexConfig;
  readonly issues: ConfigIssue[];
  readonly logger: BoundLogger;
  readonly provider: MarketDataProvider;
  readonly providerSynthetic: boolean;
  readonly keyPool: KeyPool;
  readonly telegram: TelegramClient;
  readonly models: ModelService;
  readonly engine: EngineService;
  readonly counters: RuntimeCounters = {
    cyclesRun: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    candlesIngested: 0,
    signalsCreated: 0,
    signalsSettled: 0,
    telegramSent: 0,
    telegramFailed: 0,
    providerRequests: 0,
    providerErrors: 0,
    lastError: null,
  };
  readonly startedAt = new Date();
  readonly manual: boolean;

  db: DatabaseHandle;
  private handshakeCache: { at: number; keys: StoredKey[] } | null = null;
  stopping = false;

  private constructor(params: {
    config: VortexConfig;
    issues: ConfigIssue[];
    logger: BoundLogger;
    provider: MarketDataProvider;
    db: DatabaseHandle;
    manual: boolean;
  }) {
    this.config = params.config;
    this.issues = params.issues;
    this.logger = params.logger;
    this.provider = params.provider;
    this.providerSynthetic = params.provider.synthetic;
    this.db = params.db;
    this.manual = params.manual;
    this.keyPool = new KeyPool(this);
    this.telegram = new TelegramClient(this);
    this.models = new ModelService(this);
    this.engine = new EngineService(this);
  }

  static async create(options: WorkerRuntimeOptions = {}): Promise<WorkerRuntime> {
    const env = options.env ?? process.env;
    const config = loadConfig(env, options.config ?? {});
    const issues = validateConfig(config);
    const logger = createLogger({ level: config.logLevel, secrets: secretValues(config) }).child('worker');
    const provider =
      options.provider ??
      createProvider({
        provider: config.provider,
        baseUrl: config.providerBaseUrl,
        timeoutMs: config.providerTimeoutMs,
        maxAttempts: config.providerMaxAttempts,
      });

    let db: DatabaseHandle;
    if (options.db) {
      db = { client: options.db, kind: options.db.dialect, connected: true, detail: 'injected client' };
    } else if (config.useEmbeddedDb) {
      const { PgliteClient } = await import('@vortex/db');
      const client = await PgliteClient.create();
      db = { client, kind: 'pglite', connected: true, detail: 'embedded PGlite (development only)' };
    } else {
      db = await openPostgres(config);
    }

    const runtime = new WorkerRuntime({ config, issues, logger, provider, db, manual: options.manual ?? false });
    if (options.db || config.useEmbeddedDb) {
      // Injected/embedded databases are migrated on the spot so tests and local
      // development always run against the current schema.
      const { migrate } = await import('@vortex/db');
      await migrate(db.client, { log: (line) => logger.debug(line, { component: 'db' }) });
    }
    return runtime;
  }

  /** Keys with decrypted plaintext — cached briefly because decryption is cheap but DB round trips are not. */
  async handshakeKeys(maxAgeMs = 5_000): Promise<StoredKey[]> {
    const now = Date.now();
    if (this.handshakeCache && now - this.handshakeCache.at < maxAgeMs) return this.handshakeCache.keys;
    const keys = await this.keyPool.loadKeys();
    this.handshakeCache = { at: now, keys };
    return keys;
  }

  invalidateKeyCache(): void {
    this.handshakeCache = null;
  }

  /** Increment a numeric counter. Non-numeric fields (e.g. lastError) are ignored. */
  bump(field: keyof RuntimeCounters, delta = 1): void {
    const counters = this.counters as unknown as Record<string, number | string | null>;
    const current = counters[field];
    if (typeof current === 'number') counters[field] = current + delta;
  }

  recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.counters.lastError = message;
    this.counters.jobsFailed += 1;
  }

  publicConfig(): PublicRuntimeConfig {
    return publicRuntimeConfig(this.config);
  }

  /** Real database probe (executes a query), used by /health. */
  async pingDb(): Promise<{ ok: boolean; detail: string }> {
    if (!this.db.client) return { ok: false, detail: 'no database client' };
    try {
      const result = await this.db.client.query<{ now: string }>('select now() as now');
      return { ok: true, detail: `query ok, server time ${new Date(result.rows[0]?.now ?? Date.now()).toISOString()}` };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    try {
      await this.db.client?.close();
    } catch {
      /* ignore */
    }
  }

  isReady(): { ready: boolean; reasons: string[] } {
    const reasons: string[] = [];
    if (!this.db.connected) reasons.push('database not reachable');
    const errors = this.issues.filter((i) => i.severity === 'error');
    for (const issue of errors) reasons.push(`${issue.key}: ${issue.message}`);
    if (this.providerSynthetic && this.config.nodeEnv === 'production') {
      reasons.push('provider is set to "simulated" while NODE_ENV=production');
    }
    return { ready: reasons.length === 0, reasons };
  }
}

async function openPostgres(config: VortexConfig): Promise<DatabaseHandle> {
  if (!config.databaseUrl) {
    return { client: null as unknown as SqlClient, kind: 'postgres', connected: false, detail: 'DATABASE_URL not configured' };
  }
  const client: PostgresClient = createPostgresClient(config.databaseUrl, {
    applicationName: `vortex-si-worker`,
    max: 5,
  });
  const ping = await client.ping();
  if (!ping.ok && config.dbRequired) {
    throw new Error(`Database unreachable: ${ping.detail}`);
  }
  return { client, kind: 'postgres', connected: ping.ok, detail: ping.detail };
}
