/**
 * Validated runtime configuration. Every value comes from the environment
 * (server-side) or from an explicit override object in tests. Nothing here is
 * ever exposed to the browser except the values listed in
 * `publicRuntimeConfig()`.
 */

import { z } from 'zod';
import { FREE_TIER_DEFAULT_PAIRS, normalizePair } from './instruments.js';
import type { Pair } from './types.js';

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on', 'y'].includes(v.toLowerCase())));

const intLike = (fallback: number) =>
  z.coerce
    .number()
    .int()
    .catch(fallback)
    .default(fallback);

const numLike = (fallback: number) =>
  z.coerce
    .number()
    .finite()
    .catch(fallback)
    .default(fallback);

export const configSchema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: intLike(8787),
  host: z.string().default('0.0.0.0'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  publicWebUrl: z.string().default('http://localhost:5173'),
  adminToken: z.string().default(''),
  corsOrigins: z.array(z.string()).default([]),
  secretKey: z.string().default(''),

  databaseUrl: z.string().default(''),
  databaseUrlDirect: z.string().default(''),
  dbRequired: boolish.default(false),
  /** When true (tests/local dev) the db package uses an embedded Postgres. */
  useEmbeddedDb: boolish.default(false),

  provider: z.enum(['twelvedata', 'simulated']).default('twelvedata'),
  providerBaseUrl: z.string().default('https://api.twelvedata.com'),
  /** Optional server-side primary Twelve Data API key (encrypted into provider_keys at job start). */
  providerApiKey: z.string().default(''),
  providerRpmPerKey: intLike(8),
  providerRpdPerKey: intLike(800),
  providerHeadroomPercent: numLike(15),
  providerTimeoutMs: intLike(12_000),
  providerMaxAttempts: intLike(3),

  pairs: z.array(z.string()).default(FREE_TIER_DEFAULT_PAIRS),
  scanCadenceMinutes: intLike(5),
  publishLeadSeconds: intLike(60),
  signalHorizonSeconds: intLike(60),
  /** Maximum number of signals published per 5-minute slot. */
  maxSignalsPerSlot: intLike(5),
  minConfidence: numLike(0.62),
  minRewardRisk: numLike(1.2),
  maxSpreadPips: numLike(2.5),
  maxCandleAgeSeconds: intLike(90),
  engineVersion: z.string().default('vortex-engine-1.0.0'),

  paperStartingBalance: numLike(10_000),
  paperRiskPercent: numLike(0.5),
  paperSlippagePips: numLike(0.2),

  telegramEnabled: boolish.default(false),
  /**
   * Synthetic (simulated) market data must never reach a real audience by
   * accident: Telegram delivery of signals whose candles came from the
   * simulated provider stays disabled until this is explicitly switched on
   * for a demo.
   */
  allowSyntheticSignals: boolish.default(false),
  telegramBotToken: z.string().default(''),
  telegramChannels: z.array(z.string()).default([]),

  learningEnabled: boolish.default(true),
  trainMinSamples: intLike(200),
  trainCron: z.string().default('0 3 * * *'),
  promotionMinAccuracy: numLike(0.55),
  promotionMinAuc: numLike(0.55),
  promotionMaxLogLossRegression: numLike(0.02),

  /**
   * Process role inside a deployment.
   *
   *   `all`    — relay and scheduler in one process (default: local development)
   *   `relay`  — HTTP surface only, never schedules work
   *   `worker` — scheduler only, never binds a port
   *
   * Production deployments run the last two as two services so the public
   * surface can be restarted without interrupting ingestion.
   */
  role: z.enum(['all', 'relay', 'worker']).default('all'),

  workerId: z.string().default(''),
  heartbeatSeconds: intLike(30),
  heartbeatStaleSeconds: intLike(120),
  jobLockTtlSeconds: intLike(300),
  /**
   * When the provider quota is exhausted the worker degrades (stops calling
   * the provider) instead of hammering it. Never bypassed.
   */
  quotaGraceSeconds: intLike(60),
});

export type VortexConfig = z.infer<typeof configSchema>;

export interface ConfigIssue {
  key: string;
  severity: 'error' | 'warning';
  message: string;
}

function splitList(value: string | undefined | null): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<VortexConfig> = {}): VortexConfig {
  const raw = {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    logLevel: env.LOG_LEVEL,
    publicWebUrl: env.VORTEX_PUBLIC_WEB_URL,
    adminToken: env.VORTEX_ADMIN_TOKEN,
    corsOrigins: splitList(env.VORTEX_CORS_ORIGINS),
    secretKey: env.VORTEX_SECRET_KEY,

    databaseUrl: env.DATABASE_URL,
    databaseUrlDirect: env.DATABASE_URL_DIRECT,
    dbRequired: env.VORTEX_DB_REQUIRED,
    useEmbeddedDb: env.VORTEX_USE_EMBEDDED_DB,

    provider: env.VORTEX_PROVIDER,
    providerBaseUrl: env.VORTEX_PROVIDER_BASE_URL,
    providerApiKey: env.TWELVEDATA_API_KEY,
    providerRpmPerKey: env.VORTEX_PROVIDER_RPM_PER_KEY,
    providerRpdPerKey: env.VORTEX_PROVIDER_RPD_PER_KEY,
    providerHeadroomPercent: env.VORTEX_PROVIDER_HEADROOM_PERCENT,
    providerTimeoutMs: env.VORTEX_PROVIDER_TIMEOUT_MS,
    providerMaxAttempts: env.VORTEX_PROVIDER_MAX_ATTEMPTS,

    pairs: splitList(env.VORTEX_PAIRS),
    scanCadenceMinutes: env.VORTEX_SCAN_CADENCE_MINUTES,
    publishLeadSeconds: env.VORTEX_PUBLISH_LEAD_SECONDS,
    signalHorizonSeconds: env.VORTEX_SIGNAL_HORIZON_SECONDS,
    maxSignalsPerSlot: env.VORTEX_MAX_SIGNALS_PER_SLOT,
    minConfidence: env.VORTEX_MIN_CONFIDENCE,
    minRewardRisk: env.VORTEX_MIN_RR,
    maxSpreadPips: env.VORTEX_MAX_SPREAD_PIPS,
    maxCandleAgeSeconds: env.VORTEX_MAX_CANDLE_AGE_SECONDS,
    engineVersion: env.VORTEX_ENGINE_VERSION,

    paperStartingBalance: env.VORTEX_PAPER_STARTING_BALANCE,
    paperRiskPercent: env.VORTEX_PAPER_RISK_PERCENT,
    paperSlippagePips: env.VORTEX_PAPER_SLIPPAGE_PIPS,

    telegramEnabled: env.VORTEX_TELEGRAM_ENABLED,
    allowSyntheticSignals: env.VORTEX_ALLOW_SYNTHETIC_SIGNALS,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChannels: splitList(env.TELEGRAM_CHANNELS ?? env.TELEGRAM_CHANNEL_PRIMARY),

    learningEnabled: env.VORTEX_LEARNING_ENABLED,
    trainMinSamples: env.VORTEX_TRAIN_MIN_SAMPLES,
    trainCron: env.VORTEX_TRAIN_CRON,
    promotionMinAccuracy: env.VORTEX_MODEL_PROMOTION_MIN_ACCURACY,
    promotionMinAuc: env.VORTEX_MODEL_PROMOTION_MIN_AUC,
    promotionMaxLogLossRegression: env.VORTEX_MODEL_MAX_LOG_LOSS_REGRESSION,

    role: env.VORTEX_ROLE,
    workerId: env.VORTEX_WORKER_ID,
    heartbeatSeconds: env.VORTEX_HEARTBEAT_SECONDS,
    heartbeatStaleSeconds: env.VORTEX_HEARTBEAT_STALE_SECONDS,
    jobLockTtlSeconds: env.VORTEX_JOB_LOCK_TTL_SECONDS,
    quotaGraceSeconds: env.VORTEX_PROVIDER_QUOTA_GRACE_SECONDS,
  };

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
  }

  const parsed = configSchema.safeParse({ ...cleaned, ...overrides });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid VORTEX SI configuration — ${detail}`);
  }
  const cfg = parsed.data;

  // Secondary channel + normalisation.
  const secondary = splitList(env.TELEGRAM_CHANNEL_SECONDARY) ?? [];
  cfg.telegramChannels = Array.from(new Set([...cfg.telegramChannels, ...secondary]));
  cfg.pairs = Array.from(new Set(cfg.pairs.map((p: string) => normalizePair(p))));

  if (cfg.workerId === '') {
    cfg.workerId = `${require_hostname()}-${process.pid}`;
  }
  if (cfg.scanCadenceMinutes % 1 !== 0 || cfg.scanCadenceMinutes <= 0) {
    cfg.scanCadenceMinutes = 5;
  }
  if (cfg.publishLeadSeconds >= cfg.scanCadenceMinutes * 60) {
    cfg.publishLeadSeconds = Math.max(30, cfg.scanCadenceMinutes * 60 - 30);
  }
  if (cfg.signalHorizonSeconds < 60) cfg.signalHorizonSeconds = 60;

  return cfg;
}

function require_hostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return process.env.HOSTNAME ?? 'worker';
  } catch {
    return 'worker';
  }
}

/**
 * Configuration problems that block a production run. Returned instead of
 * thrown so the control center can display "CONFIGURATION REQUIRED" with an
 * exact list rather than pretending to be fully operational.
 */
export function validateConfig(cfg: VortexConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const need = (cond: boolean, key: string, message: string, severity: ConfigIssue['severity'] = 'error') => {
    if (!cond) issues.push({ key, severity, message });
  };

  if (cfg.nodeEnv === 'production') {
    need(cfg.databaseUrl.length > 0, 'DATABASE_URL', 'Database connection string is required in production.');
    need(
      cfg.adminToken.length >= 24,
      'VORTEX_ADMIN_TOKEN',
      'Admin token must be set (>= 24 chars) to protect privileged relay routes.',
      cfg.role === 'worker' ? 'warning' : 'error',
    );
    need(
      cfg.secretKey.length > 0,
      'VORTEX_SECRET_KEY',
      'Master encryption key is required to store provider keys at rest.',
    );
  }

  need(cfg.providerRpmPerKey > 0, 'VORTEX_PROVIDER_RPM_PER_KEY', 'Provider requests/minute per key must be > 0.');
  need(cfg.providerRpdPerKey >= cfg.providerRpmPerKey, 'VORTEX_PROVIDER_RPD_PER_KEY', 'Daily plan limit must exceed the per-minute limit.');
  const usableDailyCredits = Math.floor(cfg.providerRpdPerKey * (1 - cfg.providerHeadroomPercent / 100));
  const estimatedDailyCredits = Math.ceil((24 * 60) / Math.max(1, cfg.scanCadenceMinutes)) * cfg.pairs.length;
  need(
    estimatedDailyCredits <= usableDailyCredits,
    'VORTEX_PAIRS',
    `Configured pairs (${cfg.pairs.length}) require ~${estimatedDailyCredits} credits/day at ${cfg.scanCadenceMinutes}m cadence, exceeding single-key usable budget (${usableDailyCredits}/day). Ingestion will throttle and rotate pairs as budget allows.`,
    'warning',
  );
  need(cfg.minConfidence > 0 && cfg.minConfidence < 1, 'VORTEX_MIN_CONFIDENCE', 'Minimum confidence must be between 0 and 1.');
  need(cfg.publishLeadSeconds > 0, 'VORTEX_PUBLISH_LEAD_SECONDS', 'Publish lead must be positive.');
  need(
    cfg.publishLeadSeconds < cfg.scanCadenceMinutes * 60,
    'VORTEX_PUBLISH_LEAD_SECONDS',
    'Publish lead must be shorter than the scan cadence, otherwise entries slip a full cycle.',
    'warning',
  );
  need(cfg.pairs.length > 0, 'VORTEX_PAIRS', 'At least one currency pair must be enabled.');
  if (cfg.nodeEnv === 'production' && cfg.role === 'all') {
    issues.push({
      key: 'VORTEX_ROLE',
      severity: 'warning',
      message:
        'Role "all" runs the relay and the scheduler in one process. Production deployments should run ' +
        'two services: VORTEX_ROLE=relay (public API) and VORTEX_ROLE=worker (ingestion, signals, settlement, training).',
    });
  }
  need(
    cfg.telegramEnabled ? cfg.telegramBotToken.length > 0 : true,
    'TELEGRAM_BOT_TOKEN',
    'Telegram delivery is enabled but no bot token is configured.',
  );
  need(
    cfg.telegramEnabled ? cfg.telegramChannels.length > 0 : true,
    'TELEGRAM_CHANNEL_PRIMARY',
    'Telegram delivery is enabled but no destination channel is configured.',
  );
  return issues;
}

/** Non-secret configuration that is safe to send to the browser. */
export interface PublicRuntimeConfig {
  engineVersion: string;
  role: 'all' | 'relay' | 'worker';
  pairs: Pair[];
  scanCadenceMinutes: number;
  publishLeadSeconds: number;
  signalHorizonSeconds: number;
  maxSignalsPerSlot: number;
  minConfidence: number;
  maxSpreadPips: number;
  telegramEnabled: boolean;
  allowSyntheticSignals: boolean;
  learningEnabled: boolean;
  paperStartingBalance: number;
  paperRiskPercent: number;
  paperSlippagePips: number;
  provider: string;
}

export function publicRuntimeConfig(cfg: VortexConfig): PublicRuntimeConfig {
  return {
    engineVersion: cfg.engineVersion,
    role: cfg.role,
    pairs: cfg.pairs,
    scanCadenceMinutes: cfg.scanCadenceMinutes,
    publishLeadSeconds: cfg.publishLeadSeconds,
    signalHorizonSeconds: cfg.signalHorizonSeconds,
    maxSignalsPerSlot: cfg.maxSignalsPerSlot,
    minConfidence: cfg.minConfidence,
    maxSpreadPips: cfg.maxSpreadPips,
    telegramEnabled: cfg.telegramEnabled,
    allowSyntheticSignals: cfg.allowSyntheticSignals,
    learningEnabled: cfg.learningEnabled,
    paperStartingBalance: cfg.paperStartingBalance,
    paperRiskPercent: cfg.paperRiskPercent,
    paperSlippagePips: cfg.paperSlippagePips,
    provider: cfg.provider,
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /DATABASE_URL/i,
  /SECRET/i,
  /BOT_TOKEN/i,
  /ADMIN_TOKEN/i,
  /API_?KEY/i,
  /SERVICE_ROLE/i,
  /PASSWORD/i,
  /PRIVATE_?KEY/i,
];

/**
 * Guard used by the relay to ensure no secret ever leaves in an HTTP payload.
 * Throws when a serialised response contains a configured secret value.
 */
export function assertNoSecrets(payload: unknown, secrets: string[]): void {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    if (text.includes(secret)) {
      throw new Error('Response payload would expose a secret value — request refused.');
    }
  }
}

export function secretValues(cfg: VortexConfig): string[] {
  return [
    cfg.adminToken,
    cfg.secretKey,
    cfg.telegramBotToken,
    cfg.providerApiKey,
    cfg.databaseUrl,
    cfg.databaseUrlDirect,
  ].filter((v): v is string => typeof v === 'string' && v.length >= 8);
}

export { SECRET_PATTERNS };
