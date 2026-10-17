/**
 * Maintenance, health reconciliation and alerting.
 *
 * Runs periodically and is responsible for the honest status board:
 *   - refresh per-component health from what was actually observed;
 *   - detect stale workers, exhausted quotas, delivery failures, unresolved
 *     signals and drift;
 *   - prune old rows so the database stays small;
 *   - write performance snapshots the dashboard can read cheaply.
 */

import { toIso, type HealthComponent, type ServiceStatus } from '@vortex/core';
import {
  lastSuccessfulJob,
  listAlerts,
  listDeliveries,
  listHealth,
  listLearningRuns,
  listQuality,
  listSignals,
  pruneCandles,
  pruneJobRuns,
  pruneLogEvents,
  pruneRequestLog,
  raiseAlert,
  resolveAlert,
  setComponentHealth,
  signalCounts,
  workerStatus,
  type SqlClient,
} from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';
import { withJob, type WithJobOptions } from './job.js';

export interface MaintenanceSummary {
  components: Record<string, ServiceStatus>;
  alertsRaised: string[];
  alertsResolved: string[];
  pruned: Record<string, number>;
}

export async function runMaintenance(runtime: WorkerRuntime, now = new Date()): Promise<MaintenanceSummary> {
  const db = runtime.db.client as SqlClient;
  const summary: MaintenanceSummary = { components: {}, alertsRaised: [], alertsResolved: [], pruned: {} };
  if (!runtime.db.connected) {
    await setComponentHealth(db, {
      component: 'database',
      status: 'DISCONNECTED',
      detail: runtime.db.detail,
      observedAt: toIso(now),
    }).catch(() => undefined);
    return summary;
  }

  /* ---------------------------------------------------------------- health */
  const [workers, lastJob] = await Promise.all([workerStatus(db), lastSuccessfulJob(db)]);
  const liveWorkers = workers.filter((w) => w.liveness === 'CONNECTED');
  const staleWorkers = workers.filter((w) => w.liveness === 'DISCONNECTED');
  const dbState: HealthComponent = {
    id: 'database',
    label: 'Database',
    status: 'CONNECTED',
    detail: runtime.db.detail || 'connection healthy',
    observedAt: toIso(now),
  };
  await setComponentHealth(db, {
    component: 'database',
    status: dbState.status,
    detail: dbState.detail,
    metadata: { workers: workers.length },
  });
  summary.components.database = dbState.status;

  const workerStatusValue: ServiceStatus =
    liveWorkers.length > 0 ? 'CONNECTED' : workers.length > 0 ? 'DEGRADED' : 'NOT VERIFIED';
  await setComponentHealth(db, {
    component: 'worker',
    status: workerStatusValue,
    detail:
      liveWorkers.length > 0
        ? `${liveWorkers.length} worker heartbeat(s) within 120s (last: ${liveWorkers[0]?.lastJob ?? lastJob?.jobName ?? 'n/a'})`
        : workers.length > 0
          ? `last heartbeat ${workers[0]?.secondsSince ?? '?'}s ago — no persistent worker running`
          : lastJob
            ? `no persistent worker heartbeat; last successful job ${lastJob.jobName} at ${lastJob.finishedAt ?? lastJob.startedAt}`
            : 'no worker heartbeat recorded yet',
    metadata: {
      workers: workers.slice(0, 5),
      lastSuccessfulJob: lastJob
        ? {
            jobName: lastJob.jobName,
            slotKey: lastJob.slotKey,
            finishedAt: lastJob.finishedAt ?? lastJob.startedAt,
            durationMs: lastJob.durationMs,
            workerId: lastJob.workerId,
          }
        : null,
    },
  });
  summary.components.worker = workerStatusValue;

  if (workers.length > 0 && liveWorkers.length === 0) {
    const code = 'worker-heartbeat-stale';
    await raiseAlert(db, {
      severity: 'CRITICAL',
      code,
      title: 'Background worker heartbeat is stale',
      detail: `No heartbeat within 120s. Most recent: ${workers[0]?.workerId} at ${workers[0]?.lastSeenAt}. Ingestion, signals and settlement are NOT running.`,
      metadata: { workers },
    });
    summary.alertsRaised.push(code);
  } else {
    if (await resolveAlert(db, 'worker-heartbeat-stale')) summary.alertsResolved.push('worker-heartbeat-stale');
  }

  /* --------------------------------------------------------- market data */
  const quality = await listQuality(db);
  const qualityByStatus: Record<string, number> = {};
  for (const row of quality) qualityByStatus[row.status] = (qualityByStatus[row.status] ?? 0) + 1;
  const degraded = quality.filter((q) => q.status === 'DEGRADED').length;
  const down = quality.filter((q) => q.status === 'DISCONNECTED').length;
  const qualityStatus: ServiceStatus =
    quality.length === 0
      ? 'NOT VERIFIED'
      : down > 0
        ? 'DEGRADED'
        : degraded > 0
          ? 'DEGRADED'
          : qualityByStatus.CONNECTED
            ? 'CONNECTED'
            : 'NOT VERIFIED';
  await setComponentHealth(db, {
    component: 'market_data',
    status: qualityStatus,
    detail:
      quality.length === 0
        ? 'no candles ingested yet'
        : `${qualityByStatus.CONNECTED ?? 0} fresh, ${degraded} degraded, ${down} disconnected pair(s)`,
    metadata: { byStatus: qualityByStatus },
  });
  if (down > 0) {
    await raiseAlert(db, {
      severity: 'ERROR',
      code: 'market-data-stale',
      title: `${down} pair(s) have no fresh market data`,
      detail: 'Signals are suppressed (NO-TRADE) for stale pairs. Check provider quota and key health.',
      metadata: { pairs: quality.filter((q) => q.status === 'DISCONNECTED').map((q) => q.pair).slice(0, 20) },
    });
    summary.alertsRaised.push('market-data-stale');
  } else if (await resolveAlert(db, 'market-data-stale')) {
    summary.alertsResolved.push('market-data-stale');
  }

  /* -------------------------------------------------------------- keys */
  const { snapshots, summary: budget } = await runtime.keyPool.usageSnapshots();
  const keyStatus: ServiceStatus =
    snapshots.length === 0
      ? 'CONFIGURATION REQUIRED'
      : budget.enabledKeys === 0
        ? 'DISCONNECTED'
        : budget.activeKeys === 0
          ? 'DEGRADED'
          : 'CONNECTED';
  await setComponentHealth(db, {
    component: 'provider_keys',
    status: keyStatus,
    detail:
      snapshots.length === 0
        ? 'No Twelve Data API keys configured — add one in the control centre.'
        : `${budget.activeKeys}/${budget.enabledKeys} key(s) usable; ${budget.dayRemainingPercent.toFixed(1)}% of the day budget left`,
    metadata: { budget, keys: snapshots.map((s) => ({ label: s.label, status: s.status })) },
  });

  const invalid = snapshots.filter((s) => s.status === 'INVALID').length;
  if (invalid > 0) {
    await raiseAlert(db, {
      severity: 'ERROR',
      code: 'provider-key-invalid',
      title: `${invalid} provider API key(s) were rejected`,
      detail: 'Replace or re-enable the affected keys. The pool continues with the remaining keys.',
    });
    summary.alertsRaised.push('provider-key-invalid');
  } else if (await resolveAlert(db, 'provider-key-invalid')) {
    summary.alertsResolved.push('provider-key-invalid');
  }

  if (budget.dayCapacity > 0 && budget.dayRemainingPercent < 10) {
    await raiseAlert(db, {
      severity: 'WARNING',
      code: 'provider-quota-low',
      title: 'Provider daily budget nearly exhausted',
      detail: `${budget.dayRemainingPercent.toFixed(1)}% of the day budget remains. Ingestion will pause and pairs will rotate stale until the window resets.`,
      metadata: budget,
    });
    summary.alertsRaised.push('provider-quota-low');
  } else if (await resolveAlert(db, 'provider-quota-low')) {
    summary.alertsResolved.push('provider-quota-low');
  }

  /* -------------------------------------------------------- delivery */
  const deliveries = await listDeliveries(db, 200);
  const failed = deliveries.filter((d) => d.status === 'FAILED').length;
  const unconfirmed = deliveries.filter((d) => d.status === 'UNKNOWN').length;
  const sent = deliveries.filter((d) => d.status === 'SENT').length;
  const telegramConfig = runtime.telegram.configuration();
  const deliveryStatus: ServiceStatus =
    telegramConfig.status !== 'CONNECTED'
      ? telegramConfig.status
      : failed > 0
        ? 'DEGRADED'
        : sent > 0
          ? 'CONNECTED'
          : 'NOT VERIFIED';
  await setComponentHealth(db, {
    component: 'telegram',
    status: deliveryStatus,
    detail:
      telegramConfig.status === 'CONNECTED'
        ? `${sent} confirmed, ${failed} failed, ${unconfirmed} unconfirmed delivery record(s)`
        : telegramConfig.detail,
    metadata: { sent, failed, unconfirmed, channels: runtime.config.telegramChannels.length },
  });
  if (failed > 0) {
    await raiseAlert(db, {
      severity: 'WARNING',
      code: 'telegram-delivery-failed',
      title: `${failed} Telegram delivery record(s) failed`,
      detail: 'Review the delivery ledger. Unconfirmed sends are never retried automatically to avoid duplicates.',
    });
    summary.alertsRaised.push('telegram-delivery-failed');
  }

  /* ---------------------------------------------------------- signals */
  const counts = await signalCounts(db);
  const pending = Object.entries(counts)
    .filter(([k]) => k.startsWith('PENDING:'))
    .reduce((acc, [, v]) => acc + v, 0);
  const unresolvedCount = counts.UNRESOLVED ?? 0;
  const recentSignals = await listSignals(db, { limit: 200 });
  const settled = recentSignals.filter((s) => s.outcome !== null && s.outcome !== 'UNRESOLVED').length;
  const decisiveRecent = recentSignals.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
  let consecutiveLosses = 0;
  for (const s of decisiveRecent) {
    if (s.outcome === 'LOSS') consecutiveLosses += 1;
    else break;
  }
  const winsCount = counts.WIN ?? 0;
  const lossesCount = counts.LOSS ?? 0;
  const decisiveCount = winsCount + lossesCount;
  const winRate = decisiveCount > 0 ? Number((winsCount / decisiveCount).toFixed(4)) : null;
  const lossAlertActive = consecutiveLosses >= 5 || (decisiveCount >= 10 && winRate !== null && winRate < 0.35);

  if (lossAlertActive) {
    await raiseAlert(db, {
      severity: 'WARNING',
      code: 'signals-loss-streak',
      title:
        consecutiveLosses >= 5
          ? `${consecutiveLosses} consecutive losing signals observed`
          : `Signal win rate is ${(winRate! * 100).toFixed(1)}% over ${decisiveCount} decisive outcomes`,
      detail: 'Loss monitor triggered. Review market regime, strategy weights, and recent drift reports.',
      metadata: { consecutiveLosses, wins: winsCount, losses: lossesCount, winRate },
    });
    summary.alertsRaised.push('signals-loss-streak');
  } else if (await resolveAlert(db, 'signals-loss-streak')) {
    summary.alertsResolved.push('signals-loss-streak');
  }

  const signalStatus: ServiceStatus = lossAlertActive
    ? 'DEGRADED'
    : pending > 0
      ? 'CONNECTED'
      : settled > 0 || unresolvedCount > 0
        ? 'CONNECTED'
        : 'NOT VERIFIED';
  await setComponentHealth(db, {
    component: 'signals',
    status: signalStatus,
    detail: `${pending} in flight · ${winsCount} wins · ${lossesCount} losses · ${counts.DRAW ?? 0} draws · ${unresolvedCount} unresolved`,
    metadata: { ...counts, consecutiveLosses, winRate },
  });
  summary.components.signals = signalStatus;

  const engineVersionId = runtime.config.engineVersion;
  const champion = await runtime.models.champion();
  // A failed learning run must be visible without reading the logs: the panel
  // turns DEGRADED and the run's own error is quoted verbatim.
  const learningRuns = await listLearningRuns(db, 5).catch(() => []);
  const lastRun = learningRuns[0] ?? null;
  const learningFailed = lastRun?.status === 'FAILED';
  const learningStatus: ServiceStatus = !runtime.config.learningEnabled
    ? 'DISCONNECTED'
    : learningFailed
      ? 'DEGRADED'
      : 'CONNECTED';
  const learningDetail = !runtime.config.learningEnabled
    ? 'learning pipeline disabled by configuration'
    : learningFailed
      ? `last learning run failed at ${lastRun?.finishedAt ?? lastRun?.startedAt}: ${lastRun?.error ?? 'no error recorded'}`
      : champion
        ? `champion ${champion.version} trained on ${champion.trainedSamples ?? 'n/a'} samples` +
          (lastRun ? ` · last run ${lastRun.status}${lastRun.datasetSize === null ? '' : ` on ${lastRun.datasetSize} labelled rows`}` : '')
        : lastRun
          ? `no champion model yet — last run ${lastRun.status}: ${lastRun.error ?? 'collecting labelled outcomes'}`
          : 'no champion model yet — collecting labelled outcomes';
  await setComponentHealth(db, {
    component: 'learning',
    status: learningStatus,
    detail: learningDetail,
    metadata: {
      engineVersion: engineVersionId,
      champion: champion?.version ?? null,
      lastRun: lastRun
        ? {
            status: lastRun.status,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            datasetSize: lastRun.datasetSize,
            reason: lastRun.error,
          }
        : null,
    },
  });
  summary.components.learning = learningStatus;

  /* --------------------------------------------------------- pruning */
  summary.pruned.candles = await pruneCandles(db, Number(process.env.VORTEX_CANDLE_RETENTION_DAYS ?? 45)).catch(() => 0);
  summary.pruned.requestLog = await pruneRequestLog(db, 14).catch(() => 0);
  summary.pruned.jobRuns = await pruneJobRuns(db, 14).catch(() => 0);
  summary.pruned.logEvents = await pruneLogEvents(db, 7).catch(() => 0);

  /* ----------------------------------------------------- alert summary */
  const alerts = await listAlerts(db, false, 50);
  await setComponentHealth(db, {
    component: 'alerts',
    status: alerts.some((a) => a.severity === 'CRITICAL') ? 'DEGRADED' : 'CONNECTED',
    detail: alerts.length === 0 ? 'no open alerts' : `${alerts.length} open alert(s)`,
    metadata: { open: alerts.length },
  });
  return summary;
}

export async function runMaintenanceJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const slot = `maintenance-${toIso(Math.floor(now.getTime() / 300_000) * 300_000)}`;
  return withJob(
    runtime,
    'maintenance',
    slot,
    async () => {
      const summary = await runMaintenance(runtime, now);
      return { status: 'SUCCEEDED', detail: { ...summary } };
    },
    options,
  );
}

export async function healthSnapshot(runtime: WorkerRuntime): Promise<HealthComponent[]> {
  const db = runtime.db.client as SqlClient;
  const rows = await listHealth(db).catch(() => []);
  return rows.map((row) => ({
    id: row.component,
    label: labelFor(row.component),
    status: row.status,
    detail: row.detail,
    observedAt: row.observedAt,
    metadata: row.metadata,
  }));
}

function labelFor(component: string): string {
  const labels: Record<string, string> = {
    database: 'Database',
    worker: 'Background worker',
    market_data: 'Market data',
    provider_keys: 'Provider API keys',
    telegram: 'Telegram delivery',
    signals: 'Signal engine',
    learning: 'Self-learning',
    alerts: 'Alerts',
  };
  return labels[component] ?? component;
}
