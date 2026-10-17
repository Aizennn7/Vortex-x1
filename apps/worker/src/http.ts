/**
 * Relay HTTP surface.
 *
 * Two planes, explicitly separated:
 *   - PUBLIC (`/health`, `/ready`, `/api/*`): secret-free operational data the
 *     dashboard may read. Nothing here can mutate state.
 *   - PRIVILEGED (`/admin/*`): every route requires the admin bearer token and
 *     is audited. If VORTEX_ADMIN_TOKEN is not configured the privileged plane
 *     is closed entirely rather than left open.
 *
 * Every response passes through `assertNoSecrets`, so a configuration mistake
 * cannot leak a key through an API payload.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  assertNoSecrets,
  byHourUtc,
  maskKey,
  publicRuntimeConfig,
  redact,
  secretValues,
} from '@vortex/core';
import {
  acknowledgeAlert,
  signalCounts,
  listRequestLog,
  deleteKey,
  ensureAccount,
  getAccount,
  getModelVersion,
  insertKey,
  lastSuccessfulJob,
  lastSuccessfulJobsByKind,
  listAlerts,
  listAudit,
  listDeliveries,
  listHealth,
  listLearningRuns,
  listLogEvents,
  listModelVersions,
  listPositions,
  keyFingerprint,
  encryptSecret,
  listChannels,
  listKeys,
  listQuality,
  listSignals,
  promoteModel,
  safeEqual,
  publicKeyView,
  recordAudit,
  refreshBalance,
  rollbackModel,
  setSetting,
  getSetting,
  upsertChannel,
  workerStatus,
  type SqlClient,
} from '@vortex/db';
import { modelRegistrySummary, performanceOverview, summarizeScan } from './services/registry.js';
import type { WorkerRuntime } from './runtime.js';
import { runIngestionCycle } from './jobs/ingest.js';
import { runSignalCycle } from './jobs/signals.js';
import { runSettlementCycle } from './jobs/settle.js';
import { runLearningCycle } from './jobs/learning.js';
import { runMaintenance } from './jobs/maintenance.js';
import { healthSnapshot } from './jobs/maintenance.js';
import { withJob } from './jobs/job.js';
import { isMarketOpen, toIso } from '@vortex/core';

interface RouteContext {
  runtime: WorkerRuntime;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  ip: string;
  params: Record<string, string>;
}

interface ApiError {
  status: number;
  code: string;
  message: string;
  detail?: unknown;
}

/**
 * Parse a bounded, positive integer query parameter.
 *
 * These values come straight from the URL, and passing them to SQL unvalidated
 * turned a typo into a 500: `limit=-5` produced "LIMIT must not be negative"
 * and `limit=abc` produced "invalid input syntax for type bigint: NaN", both
 * echoed back to the caller. A malformed request is the caller's mistake, so it
 * is answered with 400 and a message that names the parameter rather than the
 * database's internals.
 */
function boundedInt(raw: string | null, name: string, fallback: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, 'invalid_request', `${name} must be a positive integer`);
  }
  // Clamping rather than rejecting keeps oversized values (a client asking for
  // "everything") useful while still bounding the work.
  return Math.min(value, max);
}

class HttpError extends Error implements ApiError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

const PUBLIC_ROUTES: [string, string, (ctx: RouteContext) => Promise<unknown>][] = [
  ['GET', '/health', healthRoute],
  ['GET', '/ready', readyRoute],
  ['GET', '/api/summary', summaryRoute],
  ['GET', '/api/config', configRoute],
  ['GET', '/api/signals', signalsRoute],
  ['GET', '/api/performance', performanceRoute],
  ['GET', '/api/quality', qualityRoute],
  ['GET', '/api/health', healthComponentsRoute],
];

const ADMIN_ROUTES: [string, string, (ctx: RouteContext) => Promise<unknown>][] = [
  ['GET', '/admin/status', adminStatusRoute],
  ['GET', '/admin/keys', listKeysRoute],
  ['POST', '/admin/keys', addKeyRoute],
  ['PATCH', '/admin/keys/:id', updateKeyRoute],
  ['DELETE', '/admin/keys/:id', deleteKeyRoute],
  ['POST', '/admin/keys/:id/verify', verifyKeyRoute],
  ['POST', '/admin/telegram/test', telegramTestRoute],
  ['GET', '/admin/telegram/channels', channelsRoute],
  ['POST', '/admin/telegram/channels', upsertChannelRoute],
  ['GET', '/admin/settings', settingsRoute],
  ['POST', '/admin/settings', setSettingRoute],
  ['GET', '/admin/models', modelsRoute],
  ['POST', '/admin/models/:id/promote', promoteModelRoute],
  ['POST', '/admin/models/:id/rollback', rollbackModelRoute],
  ['POST', '/admin/learning/run', runLearningRoute],
  ['POST', '/admin/ingest/run', runIngestRoute],
  ['POST', '/admin/signals/scan', runScanRoute],
  ['POST', '/admin/signals/settle', runSettleRoute],
  ['POST', '/admin/maintenance/run', runMaintenanceRoute],
  ['GET', '/admin/deliveries', deliveriesRoute],
  ['GET', '/admin/jobs', jobsRoute],
  ['GET', '/admin/alerts', alertsRoute],
  ['POST', '/admin/alerts/:id/ack', ackAlertRoute],
  ['GET', '/admin/logs', logsRoute],
  ['GET', '/admin/audit', auditRoute],
  ['GET', '/admin/paper', paperRoute],
  ['GET', '/admin/provider', providerRoute],
];

export function createRelay(runtime: WorkerRuntime): Server {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const origin = req.headers.origin;
    applyCors(runtime, res, origin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      respondError(res, new HttpError(400, 'bad_request', 'Malformed URL'));
      return;
    }
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';

    try {
      const isAdmin = url.pathname.startsWith('/admin');
      if (isAdmin) requireAdmin(runtime, req);
      else rateLimit(buckets, ip, 300);

      const body = await readBody(req);
      const match = matchRoute(isAdmin ? ADMIN_ROUTES : PUBLIC_ROUTES, req.method ?? 'GET', url.pathname);
      if (!match) {
        throw new HttpError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
      }
      const payload = await match.handler({ runtime, req, res, url, body, ip, params: match.params });
      respondJson(runtime, res, 200, { ok: true, data: payload });
    } catch (error) {
      const httpError =
        error instanceof HttpError
          ? error
          : new HttpError(500, 'internal_error', (error as Error).message);
      if (httpError.status >= 500) {
        runtime.logger.error('relay request failed', {
          component: 'relay',
          path: url.pathname,
          error: (error as Error).message,
        });
      }
      respondError(res, httpError);
    } finally {
      const duration = Date.now() - started;
      if (duration > 2_000) {
        runtime.logger.warn('slow relay request', { component: 'relay', path: url.pathname, durationMs: duration });
      }
    }
  });

  return server;
}

type Handler = (ctx: RouteContext) => Promise<unknown>;

function matchRoute(
  routes: [string, string, Handler][],
  method: string,
  pathname: string,
): { handler: Handler; params: Record<string, string> } | null {
  for (const [routeMethod, routePath, handler] of routes) {
    if (routeMethod !== method) continue;
    const params = matchPath(routePath, pathname);
    if (params) return { handler, params };
  }
  return null;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const patternPart = patternParts[i] as string;
    const pathPart = pathParts[i] as string;
    if (patternPart.startsWith(':')) params[patternPart.slice(1)] = decodeURIComponent(pathPart);
    else if (patternPart !== pathPart) return null;
  }
  return params;
}

function requireAdmin(runtime: WorkerRuntime, req: IncomingMessage): void {
  const token = runtime.config.adminToken;
  if (token.length < 16) {
    throw new HttpError(
      503,
      'configuration_required',
      'VORTEX_ADMIN_TOKEN is not configured, so the privileged control plane is closed. Set it on the server to enable admin routes.',
    );
  }
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided.length === 0 || !safeEqual(provided, token)) {
    throw new HttpError(401, 'unauthorized', 'A valid admin bearer token is required for this route.');
  }
}

function rateLimit(buckets: Map<string, { count: number; resetAt: number }>, ip: string, perMinute: number): void {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return;
  }
  bucket.count += 1;
  if (bucket.count > perMinute) {
    throw new HttpError(429, 'rate_limited', 'Too many requests — slow down.');
  }
}

function applyCors(runtime: WorkerRuntime, res: ServerResponse, origin: string | undefined): void {
  const allowed = runtime.config.corsOrigins;
  const allowAll = allowed.includes('*');
  const permitted = origin && (allowAll || allowed.includes(origin));
  if (permitted) {
    res.setHeader('access-control-allow-origin', origin as string);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  } else if (allowAll) {
    res.setHeader('access-control-allow-origin', '*');
  }
}

function respondJson(runtime: WorkerRuntime, res: ServerResponse, status: number, payload: unknown): void {
  try {
    const safe = redact(payload, secretValues(runtime.config));
    assertNoSecrets(safe, secretValues(runtime.config));
    const text = JSON.stringify(safe, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(text);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'secret_guard', message: (error as Error).message } }));
  }
}

function respondError(res: ServerResponse, error: ApiError): void {
  res.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error: { code: error.code, message: error.message, detail: error.detail ?? null } }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, 'payload_too_large', 'Request body exceeds 256KB');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be valid JSON');
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'bad_request', 'Expected a JSON object body');
  return body as Record<string, unknown>;
}

function requireString(value: unknown, field: string, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw new HttpError(400, 'validation_error', `Field "${field}" must be a string of at least ${min} characters`);
  }
  return value.trim();
}

function db(runtime: WorkerRuntime): SqlClient {
  if (!runtime.db.connected) {
    throw new HttpError(503, 'database_unavailable', runtime.db.detail || 'Database is not reachable');
  }
  return runtime.db.client;
}

/* ------------------------------------------------------------------ routes */

async function healthRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const ready = runtime.isReady();
  const dbPing = runtime.db.connected && runtime.db.client ? await runtime.pingDb() : { ok: false, detail: runtime.db.detail };
  return {
    service: 'vortex-si-worker',
    status: dbPing.ok ? (ready.ready ? 'ok' : 'degraded') : 'degraded',
    version: runtime.config.engineVersion,
    uptimeSeconds: Math.round((Date.now() - runtime.startedAt.getTime()) / 1000),
    database: dbPing,
    provider: { name: runtime.config.provider, synthetic: runtime.providerSynthetic },
    ready: ready.ready,
    reasons: ready.reasons,
    note: 'This endpoint proves the relay process answered. Worker liveness comes from the heartbeat table (see /api/summary).',
    timestamp: new Date().toISOString(),
  };
}

async function readyRoute(ctx: RouteContext): Promise<unknown> {
  const ready = ctx.runtime.isReady();
  if (!ready.ready) {
    throw new HttpError(503, 'not_ready', 'Worker is not ready to serve privileged operations', ready.reasons);
  }
  return { ready: true };
}

async function configRoute(ctx: RouteContext): Promise<unknown> {
  return publicRuntimeConfig(ctx.runtime.config);
}

function refreshQualityFreshness(
  quality: Awaited<ReturnType<typeof listQuality>>,
  maxCandleAgeSeconds: number,
  nowMs = Date.now(),
) {
  return quality.map((row) => {
    const checkLag =
      row.checkedAt && Number.isFinite(Date.parse(row.checkedAt))
        ? Math.max(0, Math.round((nowMs - Date.parse(row.checkedAt)) / 1000))
        : 0;
    const ageSeconds = row.ageSeconds === null ? null : row.ageSeconds + checkLag;
    const stale =
      row.status === 'DEGRADED' ||
      row.status === 'DISCONNECTED' ||
      (ageSeconds !== null && ageSeconds > maxCandleAgeSeconds);
    let status = row.status;
    if (ageSeconds !== null && status === 'CONNECTED') {
      if (ageSeconds > 600) status = 'DISCONNECTED';
      else if (ageSeconds > maxCandleAgeSeconds) status = 'DEGRADED';
    }
    return {
      ...row,
      status,
      ageSeconds,
      stale,
    };
  });
}

async function summaryRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  if (!runtime.db.connected) {
    return {
      database: { status: 'DISCONNECTED', detail: runtime.db.detail },
      worker: null,
      lastSuccessfulJob: null,
      scan: null,
      marketData: [],
      providerBudget: null,
      signals: null,
      telegram: runtime.telegram.configuration(),
      model: null,
      learning: null,
      alerts: [],
      note: 'Summary is limited because the database is not reachable.',
    };
  }
  const client = db(runtime);
  const [workers, lastJob, lastJobs, rawQuality, budget, counts, deliveries, alerts, components, registry] =
    await Promise.all([
    workerStatus(client),
    lastSuccessfulJob(client),
    lastSuccessfulJobsByKind(client),
    listQuality(client),
    runtime.keyPool.usageSnapshots(),
    signalCounts(client),
    listDeliveries(client, 50),
    listAlerts(client, false, 20),
    healthSnapshot(runtime),
    modelRegistrySummary(client),
  ]);
  const nowMs = Date.now();
  const quality = refreshQualityFreshness(rawQuality, runtime.config.maxCandleAgeSeconds, nowMs);
  const liveWorker = workers.find((w) => w.liveness === 'CONNECTED' || w.liveness === 'DEGRADED') ?? null;
  const latestWorker = liveWorker ?? workers[0] ?? null;
  const reportedLiveness = liveWorker ? liveWorker.liveness : latestWorker ? 'DISCONNECTED' : 'NOT VERIFIED';
  const pending = Object.entries(counts)
    .filter(([key]) => key.startsWith('PENDING:'))
    .reduce((acc, [, value]) => acc + value, 0);
  const decisive = (counts.WIN ?? 0) + (counts.LOSS ?? 0);
  const lastFinishedAt = lastJob ? (lastJob.finishedAt ?? lastJob.startedAt) : null;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    marketOpen: isMarketOpen(new Date(nowMs)),
    worker: latestWorker
      ? {
          workerId: latestWorker.workerId,
          liveness: reportedLiveness,
          running: reportedLiveness === 'CONNECTED',
          secondsSince: latestWorker.secondsSince,
          lastJob: latestWorker.lastJob ?? lastJob?.jobName ?? null,
          lastJobAt: latestWorker.lastJobAt ?? lastFinishedAt,
          jobsCompleted: latestWorker.jobsCompleted,
          jobsFailed: latestWorker.jobsFailed,
          version: latestWorker.version,
        }
      : null,
    workerStatus: reportedLiveness,
    lastSuccessfulJob: lastJob
      ? {
          jobName: lastJob.jobName,
          slotKey: lastJob.slotKey,
          finishedAt: lastFinishedAt!,
          ageSeconds: Math.max(0, Math.round((nowMs - new Date(lastFinishedAt!).getTime()) / 1000)),
          durationMs: lastJob.durationMs,
          workerId: lastJob.workerId,
        }
      : null,
    /**
     * Why the engine did or did not publish. Without this the dashboard can
     * only show an empty signal table, which is indistinguishable from a
     * broken pipeline. The values come straight from the last signal_cycle
     * job's recorded detail — no derivation, no estimate.
     */
    scan: summarizeScan(lastJobs.signal_cycle ?? null),
    marketData: quality,
    providerBudget: {
      enabledKeys: budget.summary.enabledKeys,
      usableKeys: budget.summary.activeKeys,
      dayCapacity: budget.summary.dayCapacity,
      dayUsed: budget.summary.dayUsed,
      dayRemainingPercent: Number(budget.summary.dayRemainingPercent.toFixed(2)),
      warnings: budget.summary.warnings,
      keys: budget.snapshots.map((k) => ({
        label: k.label,
        maskedKey: k.maskedKey,
        status: k.status,
        enabled: k.enabled,
        minuteUsed: k.minuteUsed,
        minuteLimit: k.minuteLimit,
        dayUsed: k.dayUsed,
        dayLimit: k.dayLimit,
        cooldownUntil: k.cooldownUntil,
        lastError: k.lastError,
      })),
    },
    signals: {
      inFlight: pending,
      wins: counts.WIN ?? 0,
      losses: counts.LOSS ?? 0,
      draws: counts.DRAW ?? 0,
      unresolved: counts.UNRESOLVED ?? 0,
      decisive,
      accuracy: decisive === 0 ? null : Number((((counts.WIN ?? 0) / decisive) * 100).toFixed(2)),
      note: 'Accuracy uses decisive outcomes only; unresolved records are reported separately and never counted as wins.',
    },
    telegram: {
      configuration: runtime.telegram.configuration(),
      sent: deliveries.filter((d) => d.status === 'SENT').length,
      failed: deliveries.filter((d) => d.status === 'FAILED').length,
      unconfirmed: deliveries.filter((d) => d.status === 'UNKNOWN').length,
    },
    components,
    model: registry.model,
    learning: registry.learning,
    alerts: alerts.map((a) => ({ severity: a.severity, code: a.code, title: a.title, lastSeenAt: a.lastSeenAt })),
  };
}

/** ISO timestamp parameter, or undefined when absent. Rejects garbage early. */
function timestampParam(raw: string | null, name: string): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new HttpError(400, 'invalid_request', `${name} must be an ISO timestamp`);
  return new Date(ms).toISOString();
}

async function signalsRoute(ctx: RouteContext): Promise<unknown> {
  const client = db(ctx.runtime);
  const limit = boundedInt(ctx.url.searchParams.get('limit'), 'limit', 50, 500);
  const pairs = ctx.url.searchParams.get('pairs')?.split(',').filter(Boolean);
  const outcomes = ctx.url.searchParams.get('outcomes')?.split(',').filter(Boolean) as never[] | undefined;
  const from = timestampParam(ctx.url.searchParams.get('from'), 'from');
  const to = timestampParam(ctx.url.searchParams.get('to'), 'to');
  const rows = await listSignals(client, { limit, pairs, outcomes, from, to });
  return { signals: rows, count: rows.length };
}

async function performanceRoute(ctx: RouteContext): Promise<unknown> {
  const client = db(ctx.runtime);
  const breakdowns = await performanceOverview(client);
  const rows = await listSignals(client, { limit: 2000 });
  const hours = byHourUtc(rows);
  const account = await getAccount(client, 'default');
  const paper = account
    ? {
        startingBalance: account.startingBalance,
        balance: account.balance,
        riskPercent: account.riskPercent,
        slippagePips: account.slippagePips,
        updatedAt: account.updatedAt,
      }
    : null;
  return {
    ...breakdowns,
    byHour: hours,
    paper,
    simulated: true,
    note: 'Paper-trading figures are simulations that charge spread and slippage; they are not realised profit.',
  };
}

async function qualityRoute(ctx: RouteContext): Promise<unknown> {
  const rows = await listQuality(db(ctx.runtime));
  return { pairs: refreshQualityFreshness(rows, ctx.runtime.config.maxCandleAgeSeconds) };
}

async function healthComponentsRoute(ctx: RouteContext): Promise<unknown> {
  const client = db(ctx.runtime);
  return { components: await listHealth(client) };
}

async function adminStatusRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const client = db(runtime);
  const [workers, components, alerts, runs, versions, budget, capacity, channels, deliveries, quality, keys] =
    await Promise.all([
      workerStatus(client),
      listHealth(client),
      listAlerts(client, false, 50),
      listLearningRuns(client, 10),
      listModelVersions(client, 10),
      runtime.keyPool.usageSnapshots(),
      runtime.keyPool.capacityPlan((await listQuality(client)).length || runtime.config.pairs.length),
      listChannels(client),
      listDeliveries(client, 30),
      listQuality(client),
      listKeys(client),
    ]);
  const issues = runtime.issues;
  return {
    worker: {
      id: runtime.config.workerId,
      startedAt: runtime.startedAt.toISOString(),
      uptimeSeconds: Math.round((Date.now() - runtime.startedAt.getTime()) / 1000),
      counters: runtime.counters,
      heartbeats: workers,
    },
    issues,
    components,
    alerts,
    learningRuns: runs,
    models: versions,
    provider: {
      name: runtime.config.provider,
      synthetic: runtime.providerSynthetic,
      budget: budget.summary,
      keys: budget.snapshots,
      capacity,
    },
    keyInventory: keys.map((k) => publicKeyView(k)),
    telegram: {
      configuration: runtime.telegram.configuration(),
      channels,
      deliveries,
    },
    marketData: quality,
    config: publicRuntimeConfig(runtime.config),
    /**
     * Which server-side secrets are configured — booleans only, never values.
     * Field names avoid the redaction patterns so the operator can actually
     * read them (`adminToken`/`secretKey` would be masked to "[redacted]").
     */
    environment: {
      databaseUrl: runtime.config.databaseUrl.length > 0 || runtime.config.databaseUrlDirect.length > 0,
      adminPlane: runtime.config.adminToken.length > 0,
      encryptionKey: runtime.config.secretKey.length > 0,
      telegramDelivery: runtime.config.telegramBotToken.length > 0,
    },
  };
}

async function listKeysRoute(ctx: RouteContext): Promise<unknown> {
  const keys = await listKeys(db(ctx.runtime));
  const { snapshots } = await ctx.runtime.keyPool.usageSnapshots();
  return {
    keys: keys.map((k) => ({
      ...publicKeyView(k),
      usage: snapshots.find((s) => s.keyId === k.id) ?? null,
    })),
  };
}

async function addKeyRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const body = asObject(ctx.body);
  const label = requireString(body.label, 'label', 1);
  const apiKey = requireString(body.apiKey ?? body.key, 'apiKey', 16);
  if (!runtime.config.secretKey) {
    throw new HttpError(
      503,
      'configuration_required',
      'VORTEX_SECRET_KEY is not configured, so provider keys cannot be stored securely. Set it on the server first.',
    );
  }
  const ciphertext = encryptSecret(apiKey, runtime.config.secretKey);
  const stored = await insertKey(db(runtime), {
    label,
    maskedKey: maskKey(apiKey),
    ciphertext,
    fingerprint: keyFingerprint(apiKey),
    accountId: typeof body.accountId === 'string' ? body.accountId : null,
    minuteLimit: typeof body.minuteLimit === 'number' ? body.minuteLimit : null,
    dayLimit: typeof body.dayLimit === 'number' ? body.dayLimit : null,
    headroomPercent: typeof body.headroomPercent === 'number' ? body.headroomPercent : null,
  });
  runtime.keyPool.invalidate();
  runtime.invalidateKeyCache();
  await recordAudit(db(runtime), {
    actor: `admin:${ctx.ip}`,
    action: 'provider_key.create',
    target: stored.label,
    detail: { maskedKey: stored.maskedKey, minuteLimit: stored.minuteLimit, dayLimit: stored.dayLimit },
  });
  const verification = typeof body.verify === 'boolean' && body.verify ? await verifyStoredKey(runtime, stored.id) : null;
  return { key: publicKeyView(stored), verification };
}

async function updateKeyRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const body = asObject(ctx.body);
  const id = ctx.params.id as string;
  if (typeof body.apiKey === 'string' && body.apiKey.length >= 16) {
    if (!runtime.config.secretKey) {
      throw new HttpError(503, 'configuration_required', 'VORTEX_SECRET_KEY is not configured.');
    }
    const { updateKey } = await import('@vortex/db');
    const updated = await updateKey(db(runtime), id, {
      ciphertext: encryptSecret(body.apiKey, runtime.config.secretKey),
      maskedKey: maskKey(body.apiKey),
      fingerprint: keyFingerprint(body.apiKey),
      status: 'ACTIVE',
    });
    runtime.keyPool.invalidate();
    runtime.invalidateKeyCache();
    await recordAudit(db(runtime), {
      actor: `admin:${ctx.ip}`,
      action: 'provider_key.rotate',
      target: id,
      detail: { maskedKey: updated?.maskedKey },
    });
    return { key: updated ? publicKeyView(updated) : null, rotated: true };
  }
  const { updateKey } = await import('@vortex/db');
  const updated = await updateKey(db(runtime), id, {
    label: typeof body.label === 'string' ? body.label : undefined,
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    status: typeof body.status === 'string' ? (body.status as never) : undefined,
    cooldownUntil: body.cooldownUntil === null ? null : undefined,
    consecutiveFailures: typeof body.resetFailures === 'boolean' && body.resetFailures ? 0 : undefined,
  });
  runtime.keyPool.invalidate();
  runtime.invalidateKeyCache();
  await recordAudit(db(runtime), {
    actor: `admin:${ctx.ip}`,
    action: 'provider_key.update',
    target: id,
    detail: { enabled: body.enabled, status: body.status },
  });
  return { key: updated ? publicKeyView(updated) : null };
}

async function deleteKeyRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const id = ctx.params.id as string;
  const removed = await deleteKey(db(runtime), id);
  runtime.keyPool.invalidate();
  runtime.invalidateKeyCache();
  await recordAudit(db(runtime), { actor: `admin:${ctx.ip}`, action: 'provider_key.delete', target: id, detail: {} });
  return { deleted: removed };
}

async function verifyStoredKey(runtime: WorkerRuntime, keyId: string): Promise<unknown> {
  await runtime.keyPool.loadKeys(true);
  const plaintext = await runtime.keyPool.keyMaterial(keyId);
  if (!plaintext) {
    // Present in the inventory but undecryptable: report it, never silently pass.
    return {
      ok: false,
      status: 0,
      outcome: 'UNVERIFIED',
      detail: 'key not found or could not be decrypted with VORTEX_SECRET_KEY',
      note: 'This key is stored but its ciphertext cannot be decrypted, so it cannot be used. Re-add it with the current VORTEX_SECRET_KEY.',
    };
  }
  const { TwelveDataProvider } = await import('@vortex/provider');
  const provider = new TwelveDataProvider({
    baseUrl: runtime.config.providerBaseUrl,
    timeoutMs: runtime.config.providerTimeoutMs,
    maxAttempts: 1,
  });
  const result = await provider.verifyKey(plaintext);
  const { updateKey } = await import('@vortex/db');
  // Only a real rejection (401/403) disables the key. A network failure means we
  // simply do not know, so the key state is left untouched.
  const rejected = result.status === 401 || result.status === 403;
  const verifiedAt = new Date().toISOString();
  await updateKey(db(runtime), keyId, {
    lastVerifiedAt: verifiedAt,
    status: result.ok ? 'ACTIVE' : rejected ? 'INVALID' : undefined,
    lastError: result.ok ? null : result.detail,
    providerUsageCredits: result.creditsUsed ?? null,
  });
  runtime.keyPool.invalidate();
  runtime.invalidateKeyCache();
  return {
    ...result,
    verifiedAt,
    // Be explicit about what the operator should conclude.
    outcome: result.ok ? 'ACCEPTED' : rejected ? 'REJECTED' : 'UNVERIFIED',
    note: result.ok
      ? 'The provider accepted this key.'
      : rejected
        ? 'The provider rejected this key — replace it.'
        : 'The provider could not be reached, so this key is still unverified (it was not disabled).',
  };
}

async function verifyKeyRoute(ctx: RouteContext): Promise<unknown> {
  const id = ctx.params.id as string;
  return verifyStoredKey(ctx.runtime, id);
}

async function telegramTestRoute(ctx: RouteContext): Promise<unknown> {
  const { runtime } = ctx;
  const verification = await runtime.telegram.verify();
  if (!verification.ok) return verification;
  const channels = await runtime.telegram.resolveChannels();
  const results: unknown[] = [];
  for (const channel of channels) {
    const sent = await runtime.telegram.sendMessage(
      channel.chatId,
      '🛰️ *VORTEX SI* connectivity test — this message confirms the relay can reach your destination. No signal is implied.',
    );
    results.push({ channel: channel.label, ok: sent.ok, messageId: sent.messageId ?? null, error: sent.description ?? null });
  }
  await recordAudit(db(runtime), { actor: `admin:${ctx.ip}`, action: 'telegram.test', detail: { results } });
  return { ...verification, results };
}

async function channelsRoute(ctx: RouteContext): Promise<unknown> {
  return { channels: await listChannels(db(ctx.runtime)) };
}

async function upsertChannelRoute(ctx: RouteContext): Promise<unknown> {
  const body = asObject(ctx.body);
  const channel = await upsertChannel(db(ctx.runtime), {
    label: requireString(body.label, 'label', 1),
    chatId: requireString(body.chatId ?? body.chat_id, 'chatId', 2),
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    isPrimary: typeof body.isPrimary === 'boolean' ? body.isPrimary : undefined,
    template: typeof body.template === 'string' ? body.template : null,
  });
  await recordAudit(db(ctx.runtime), {
    actor: `admin:${ctx.ip}`,
    action: 'telegram.channel_upsert',
    target: channel.label,
    detail: { enabled: channel.enabled },
  });
  return { channel };
}

async function settingsRoute(ctx: RouteContext): Promise<unknown> {
  const { listSettings } = await import('@vortex/db');
  return { settings: await listSettings(db(ctx.runtime)) };
}

async function setSettingRoute(ctx: RouteContext): Promise<unknown> {
  const body = asObject(ctx.body);
  const key = requireString(body.key, 'key', 3);
  if (/secret|token|password|key$/i.test(key)) {
    throw new HttpError(400, 'validation_error', 'Secrets are never stored in system_settings — configure them in the server environment.');
  }
  await setSetting(db(ctx.runtime), key, body.value ?? null, `admin:${ctx.ip}`);
  await recordAudit(db(ctx.runtime), { actor: `admin:${ctx.ip}`, action: 'settings.update', target: key, detail: { value: body.value } });
  return { key, value: await getSetting(db(ctx.runtime), key) };
}

async function modelsRoute(ctx: RouteContext): Promise<unknown> {
  const [versions, runs] = await Promise.all([listModelVersions(db(ctx.runtime), 50), listLearningRuns(db(ctx.runtime), 20)]);
  const champion = await ctx.runtime.models.champion(true);
  return {
    champion: champion ? { versionId: champion.versionId, version: champion.version, metrics: champion.metrics } : null,
    versions,
    runs,
    strategyWeights: await ctx.runtime.models.strategyWeights(true),
  };
}

/**
 * Manual promotion is an operator override, never a silent bypass of the
 * learning gates. A candidate whose stored decision did not pass can only be
 * activated by an explicit `{"override": true, "reason": "..."}` request, and
 * that reason is written to the model row and the audit log.
 */
async function promoteModelRoute(ctx: RouteContext): Promise<unknown> {
  const id = ctx.params.id as string;
  // A body-less POST is the normal path for an already-approved candidate.
  const body =
    ctx.body && typeof ctx.body === 'object' && !Array.isArray(ctx.body)
      ? (ctx.body as Record<string, unknown>)
      : {};
  const candidate = await getModelVersion(db(ctx.runtime), id);
  if (!candidate) throw new HttpError(404, 'not_found', 'model version not found');
  const decision = candidate.promotion as { promote?: unknown; summary?: unknown } | null;
  const approved = decision?.promote === true;
  const override = body.override === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!approved && !override) {
    const detail =
      typeof decision?.summary === 'string' ? decision.summary : 'no promotion decision was recorded for this candidate';
    throw new HttpError(
      409,
      'promotion_blocked',
      `${detail} — promotion gates are not bypassed silently; resend with {"override": true, "reason": "..."} to record a deliberate override`,
    );
  }
  if (!approved && reason.length < 10) {
    throw new HttpError(400, 'validation_error', 'an override requires a reason of at least 10 characters');
  }
  const result = await promoteModel(db(ctx.runtime), {
    candidateId: id,
    promotion: {
      manual: true,
      actor: `admin:${ctx.ip}`,
      at: toIso(new Date()),
      ...(approved
        ? {}
        : {
            override: true,
            reason,
            previousDecision: {
              promote: decision?.promote ?? null,
              summary: typeof decision?.summary === 'string' ? decision.summary : null,
            },
          }),
    },
    actor: `admin:${ctx.ip}`,
  });
  ctx.runtime.models.invalidate();
  return result;
}

async function rollbackModelRoute(ctx: RouteContext): Promise<unknown> {
  const id = ctx.params.id as string;
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  const result = await rollbackModel(db(ctx.runtime), {
    targetId: id,
    actor: `admin:${ctx.ip}`,
    reason: typeof body.reason === 'string' ? body.reason : 'manual rollback',
  });
  ctx.runtime.models.invalidate();
  return result;
}

/**
 * Run a cycle on demand from the control centre.
 *
 * Manual runs are recorded in job_runs under their own slot key so the jobs
 * panel shows who triggered what, alongside the scheduled slots — and so two
 * operators pressing the button at once cannot run the same cycle twice.
 */
async function manualRun(
  runtime: WorkerRuntime,
  jobName: string,
  cycle: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const slotKey = `manual|${jobName}|${toIso(new Date())}`;
  let summary: unknown = null;
  const job = await withJob(
    runtime,
    jobName,
    slotKey,
    async () => {
      summary = await cycle();
      return { status: 'SUCCEEDED', detail: { manual: true, slotKey } };
    },
    { alertCode: `job_${jobName}_failed` },
  );
  const payload = summary && typeof summary === 'object' ? (summary as Record<string, unknown>) : { summary };
  return { ...payload, job: { ran: job.ran, status: job.status, slotKey, detail: job.detail ?? null } };
}

async function runLearningRoute(ctx: RouteContext): Promise<unknown> {
  return manualRun(ctx.runtime, 'learning', () => runLearningCycle(ctx.runtime, new Date()));
}

async function runIngestRoute(ctx: RouteContext): Promise<unknown> {
  return manualRun(ctx.runtime, 'ingest_market_data', () => runIngestionCycle(ctx.runtime, new Date()));
}

async function runScanRoute(ctx: RouteContext): Promise<unknown> {
  return manualRun(ctx.runtime, 'signal_scan', () => runSignalCycle(ctx.runtime, new Date()));
}

async function runSettleRoute(ctx: RouteContext): Promise<unknown> {
  return manualRun(ctx.runtime, 'settlement', () => runSettlementCycle(ctx.runtime, new Date()));
}

async function runMaintenanceRoute(ctx: RouteContext): Promise<unknown> {
  return manualRun(ctx.runtime, 'maintenance', () => runMaintenance(ctx.runtime, new Date()));
}

async function deliveriesRoute(ctx: RouteContext): Promise<unknown> {
  const status = ctx.url.searchParams.get('status') as never | null;
  return { deliveries: await listDeliveries(db(ctx.runtime), 100, status ?? undefined) };
}

async function jobsRoute(ctx: RouteContext): Promise<unknown> {
  const { recentJobs, listLocks } = await import('@vortex/db');
  return { jobs: await recentJobs(db(ctx.runtime), 60), locks: await listLocks(db(ctx.runtime)) };
}

async function alertsRoute(ctx: RouteContext): Promise<unknown> {
  return { alerts: await listAlerts(db(ctx.runtime), ctx.url.searchParams.get('all') === '1', 100) };
}

async function ackAlertRoute(ctx: RouteContext): Promise<unknown> {
  const id = ctx.params.id as string;
  const acknowledged = await acknowledgeAlert(db(ctx.runtime), id, `admin:${ctx.ip}`);
  return { acknowledged };
}

async function logsRoute(ctx: RouteContext): Promise<unknown> {
  return {
    events: await listLogEvents(db(ctx.runtime), {
      level: ctx.url.searchParams.get('level') ?? undefined,
      component: ctx.url.searchParams.get('component') ?? undefined,
      limit: Math.min(Number(ctx.url.searchParams.get('limit') ?? 200), 1000),
    }),
  };
}

async function auditRoute(ctx: RouteContext): Promise<unknown> {
  return { audit: await listAudit(db(ctx.runtime), 200) };
}

async function paperRoute(ctx: RouteContext): Promise<unknown> {
  const client = db(ctx.runtime);
  const cfg = ctx.runtime.config;
  await ensureAccount(client, {
    id: 'default',
    startingBalance: cfg.paperStartingBalance,
    riskPercent: cfg.paperRiskPercent,
    slippagePips: cfg.paperSlippagePips,
  });
  const account = await refreshBalance(client, 'default');
  return {
    account,
    positions: await listPositions(client, 100),
    simulated: true,
    note: 'Paper trading only. No orders are sent to any broker.',
  };
}

async function providerRoute(ctx: RouteContext): Promise<unknown> {
  const { summary: budget, snapshots } = await ctx.runtime.keyPool.usageSnapshots();
  const capacity = await ctx.runtime.keyPool.capacityPlan(ctx.runtime.config.pairs.length);
  return {
    budget,
    keys: snapshots,
    capacity,
    provider: ctx.runtime.config.provider,
    synthetic: ctx.runtime.providerSynthetic,
    recentRequests: await listRequestLog(db(ctx.runtime), 25),
  };
}

export { HttpError, maskKey, randomUUID };
