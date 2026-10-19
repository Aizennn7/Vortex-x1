/**
 * Outcome settlement job.
 *
 * Every signal is settled against the stored M1 candles that actually cover
 * its window. If the data is not there, the signal is marked UNRESOLVED after a
 * bounded number of attempts — an outcome is never invented, and an unresolved
 * signal is visibly charged against performance instead of being dropped.
 */

import { OUTCOME_RULE_VERSION, settleSignal, toIso, type SignalRecord } from '@vortex/core';
import { applySettlement, bumpSettlementAttempt, dueForSettlement, getCandles, raiseAlert, type SqlClient, syncPosition } from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';
import { withJob, type WithJobOptions } from './job.js';

export interface SettlementSummary {
  candidates: number;
  settled: number;
  unresolved: number;
  deferred: number;
  wins: number;
  losses: number;
  draws: number;
  details: string[];
}

const MAX_SETTLEMENT_ATTEMPTS = 3;

export async function runSettlementCycle(runtime: WorkerRuntime, now = new Date()): Promise<SettlementSummary> {
  const cfg = runtime.config;
  const db = runtime.db.client;
  const summary: SettlementSummary = {
    candidates: 0,
    settled: 0,
    unresolved: 0,
    deferred: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    details: [],
  };
  if (!runtime.db.connected) {
    summary.details.push('database not connected');
    return summary;
  }

  const due = await dueForSettlement(db, toIso(now), 8, 200);
  summary.candidates = due.length;
  if (due.length === 0) return summary;

  for (const signal of due) {
    if (runtime.stopping) break;
    const result = await settleOne(runtime, signal, now);
    if (result === 'deferred') summary.deferred += 1;
    else if (result === 'unresolved-filed') summary.unresolved += 1;
    else if (result !== null) {
      summary.settled += 1;
      if (result === 'WIN') summary.wins += 1;
      else if (result === 'LOSS') summary.losses += 1;
      else summary.draws += 1;
    }
  }

  if (summary.unresolved > 0) {
    await raiseAlert(db, {
      severity: 'WARNING',
      code: 'signals-unresolved',
      title: `${summary.unresolved} signal(s) filed as UNRESOLVED`,
      detail: 'Market data did not cover the signal window. These records are excluded from accuracy but counted in the cohort denominator.',
      metadata: { unresolved: summary.unresolved, slot: toIso(now) },
    }).catch(() => undefined);
  }
  return summary;
}

async function settleOne(
  runtime: WorkerRuntime,
  signal: SignalRecord,
  now: Date,
): Promise<'WIN' | 'LOSS' | 'DRAW' | 'unresolved-filed' | 'deferred' | null> {
  const cfg = runtime.config;
  const db = runtime.db.client;
  const entryMs = new Date(signal.scheduledEntryAt).getTime();
  const windowEnd = new Date(entryMs + signal.horizonSeconds * 1000 + 60_000).toISOString();
  const candles = await getCandles(db, {
    pair: signal.pair,
    timeframe: 'M1',
    from: toIso(entryMs - 60_000),
    to: windowEnd,
    limit: 60,
    finalOnly: true,
  });

  const settlement = settleSignal({
    pair: signal.pair,
    direction: signal.direction,
    scheduledEntryAt: signal.scheduledEntryAt,
    horizonSeconds: signal.horizonSeconds,
    stopPips: signal.stopPips,
    targetPips: signal.targetPips,
    spreadPips: signal.context?.spreadPips ?? 0,
    slippagePips: cfg.paperSlippagePips,
    candles,
    now,
  });

  if (settlement.outcome === 'UNRESOLVED') {
    const attemptsRow = await db.query<{ settlement_attempts: number }>(
      'select settlement_attempts from signals where id = $1',
      [signal.id],
    );
    const attempts = (attemptsRow.rows[0]?.settlement_attempts ?? 0) + 1;
    if (attempts < MAX_SETTLEMENT_ATTEMPTS) {
      await bumpSettlementAttempt(db, signal.id);
      return 'deferred';
    }
    await applySettlement(db, {
      id: signal.id,
      outcome: 'UNRESOLVED',
      status: 'UNRESOLVED',
      entryPrice: settlement.entryPrice,
      exitPrice: settlement.exitPrice,
      grossPips: null,
      costPips: settlement.costPips,
      realizedPips: null,
      mfePips: null,
      maePips: null,
      outcomeRule: `${OUTCOME_RULE_VERSION}:unresolved`,
      outcomeFlags: [...settlement.flags, 'data_unavailable'],
      outcomeDetail: `${settlement.detail} (after ${attempts} attempts)`,
    });
    runtime.logger.warn('signal filed as UNRESOLVED', {
      component: 'settle',
      signalId: signal.id,
      pair: signal.pair,
      detail: settlement.detail,
      attempts,
    });
    return 'unresolved-filed';
  }

  const applied = await applySettlement(db, {
    id: signal.id,
    outcome: settlement.outcome,
    status: 'SETTLED',
    entryPrice: settlement.entryPrice,
    exitPrice: settlement.exitPrice,
    grossPips: settlement.grossPips,
    costPips: settlement.costPips,
    realizedPips: settlement.realizedPips,
    mfePips: settlement.mfePips,
    maePips: settlement.maePips,
    outcomeRule: settlement.rule,
    outcomeFlags: settlement.flags,
    outcomeDetail: settlement.detail,
  });
  if (!applied) return null;

  runtime.bump('signalsSettled');
  const settled: SignalRecord = {
    ...signal,
    outcome: settlement.outcome,
    settledAt: now.toISOString(),
    exitPrice: settlement.exitPrice,
    realizedPips: settlement.realizedPips,
    mfePips: settlement.mfePips,
    maePips: settlement.maePips,
    outcomeRule: settlement.rule,
    status: 'SETTLED',
  };

  await syncPaper(runtime, settled, settlement.entryPrice);
  // Settlement is stored in VORTEX and displayed in the in-app performance
  // and signal history views. No external messaging service is used.
  return settlement.outcome;
}

async function syncPaper(runtime: WorkerRuntime, signal: SignalRecord, entryPrice: number | null): Promise<void> {
  const cfg = runtime.config;
  const db: SqlClient = runtime.db.client;
  try {
    const accountId = 'default';
    const rows = await db.query<{ id: string }>('select id from paper_account where id = $1', [accountId]);
    if (rows.rows.length === 0) {
      const { ensureAccount } = await import('@vortex/db');
      await ensureAccount(db, {
        id: accountId,
        startingBalance: cfg.paperStartingBalance,
        riskPercent: cfg.paperRiskPercent,
        slippagePips: cfg.paperSlippagePips,
      });
    }
    const riskAmount = (cfg.paperStartingBalance * cfg.paperRiskPercent) / 100;
    const units = riskAmount / Math.max(0.1, signal.stopPips);
    await syncPosition(db, {
      signal: entryPrice === null ? signal : { ...signal, entryPrice },
      accountId,
      riskAmount,
      units,
    });
    const { refreshBalance } = await import('@vortex/db');
    await refreshBalance(db, accountId);
  } catch (error) {
    runtime.logger.warn('paper ledger sync failed', { component: 'settle', error: (error as Error).message });
  }
}

export async function runSettlementJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const slot = `settle-${toIso(Math.floor(now.getTime() / 15_000) * 15_000)}`;
  return withJob(
    runtime,
    'settle_signals',
    slot,
    async () => {
      const summary = await runSettlementCycle(runtime, now);
      return { status: 'SUCCEEDED', detail: { ...summary } };
    },
    { staleAfterSeconds: 120, alertCode: 'settlement-failing', ...options },
  );
}
