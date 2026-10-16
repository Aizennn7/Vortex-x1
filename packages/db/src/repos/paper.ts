/**
 * Paper-trading ledger. Simulation only: every row is derived from a settled
 * signal and the UI labels it as simulated.
 */

import type { SignalRecord } from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { int, iso, isoRequired, num } from './rows.js';

export interface PaperAccount {
  id: string;
  startingBalance: number;
  balance: number;
  riskPercent: number;
  slippagePips: number;
  currency: string;
  updatedAt: string;
}

export async function ensureAccount(
  client: SqlClient,
  params: { id: string; startingBalance: number; riskPercent: number; slippagePips: number; currency?: string },
): Promise<PaperAccount> {
  await client.query(
    `insert into paper_account (id, starting_balance, balance, risk_percent, slippage_pips, currency)
     values ($1, $2, $2, $3, $4, $5)
     on conflict (id) do nothing`,
    [params.id, params.startingBalance, params.riskPercent, params.slippagePips, params.currency ?? 'USD'],
  );
  const account = await getAccount(client, params.id);
  if (!account) throw new Error('paper account could not be created');
  return account;
}

export async function getAccount(client: SqlClient, id: string): Promise<PaperAccount | null> {
  const rows = await client.query<{
    id: string;
    starting_balance: string | number;
    balance: string | number;
    risk_percent: string | number;
    slippage_pips: string | number;
    currency: string;
    updated_at: string | Date;
  }>(
    'select id, starting_balance, balance, risk_percent, slippage_pips, currency, updated_at from paper_account where id = $1',
    [id],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    startingBalance: num(row.starting_balance),
    balance: num(row.balance),
    riskPercent: num(row.risk_percent),
    slippagePips: num(row.slippage_pips),
    currency: row.currency,
    updatedAt: isoRequired(row.updated_at),
  };
}

/**
 * Open a paper position for a signal (idempotent per signal) and, when the
 * signal already has an outcome, close it immediately at the recorded prices.
 */
export async function syncPosition(
  client: SqlClient,
  params: { signal: SignalRecord; accountId: string; riskAmount: number; units: number },
): Promise<void> {
  const { signal } = params;
  const settled = signal.outcome === 'WIN' || signal.outcome === 'LOSS' || signal.outcome === 'DRAW';
  await client.query(
    `insert into paper_positions
       (signal_id, pair, direction, units, risk_amount, entry_price, exit_price, stop_pips, target_pips,
        realized_pips, realized_pnl, status, closed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (signal_id) do update set
       units = excluded.units,
       risk_amount = excluded.risk_amount,
       entry_price = coalesce(excluded.entry_price, paper_positions.entry_price),
       exit_price = coalesce(excluded.exit_price, paper_positions.exit_price),
       realized_pips = coalesce(excluded.realized_pips, paper_positions.realized_pips),
       realized_pnl = coalesce(excluded.realized_pnl, paper_positions.realized_pnl),
       status = excluded.status,
       closed_at = coalesce(excluded.closed_at, paper_positions.closed_at)
     where paper_positions.status = 'OPEN'`,
    [
      signal.id,
      signal.pair,
      signal.direction,
      params.units,
      params.riskAmount,
      signal.entryPrice,
      signal.exitPrice,
      signal.stopPips,
      signal.targetPips,
      signal.realizedPips,
      signal.realizedPips === null || signal.stopPips === 0
        ? null
        : (params.riskAmount * signal.realizedPips) / signal.stopPips,
      settled ? 'CLOSED' : 'OPEN',
      settled ? signal.settledAt : null,
    ],
  );
}

export async function listPositions(
  client: SqlClient,
  limit = 100,
): Promise<
  {
    id: string;
    signalId: string;
    pair: string;
    direction: string;
    units: number;
    riskAmount: number;
    entryPrice: number | null;
    exitPrice: number | null;
    realizedPips: number | null;
    realizedPnl: number | null;
    status: string;
    openedAt: string;
    closedAt: string | null;
  }[]
> {
  const rows = await client.query<{
    id: string;
    signal_id: string;
    pair: string;
    direction: string;
    units: string | number;
    risk_amount: string | number;
    entry_price: string | number | null;
    exit_price: string | number | null;
    realized_pips: string | number | null;
    realized_pnl: string | number | null;
    status: string;
    opened_at: string | Date;
    closed_at: string | Date | null;
  }>(
    `select id, signal_id, pair, direction, units, risk_amount, entry_price, exit_price,
            realized_pips, realized_pnl, status, opened_at, closed_at
       from paper_positions order by opened_at desc limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    signalId: r.signal_id,
    pair: r.pair,
    direction: r.direction,
    units: num(r.units),
    riskAmount: num(r.risk_amount),
    entryPrice: r.entry_price === null ? null : num(r.entry_price),
    exitPrice: r.exit_price === null ? null : num(r.exit_price),
    realizedPips: r.realized_pips === null ? null : num(r.realized_pips),
    realizedPnl: r.realized_pnl === null ? null : num(r.realized_pnl),
    status: r.status,
    openedAt: isoRequired(r.opened_at),
    closedAt: iso(r.closed_at),
  }));
}

/** Recompute the paper balance from closed positions (idempotent). */
export async function refreshBalance(client: SqlClient, accountId: string): Promise<PaperAccount | null> {
  await client.query(
    `update paper_account a
        set balance = a.starting_balance + coalesce((
              select sum(p.realized_pnl) from paper_positions p
               where p.status = 'CLOSED'), 0),
            updated_at = now()
      where a.id = $1`,
    [accountId],
  );
  return getAccount(client, accountId);
}

export async function positionStats(client: SqlClient): Promise<{ open: number; closed: number; realizedPnl: number }> {
  const rows = await client.query<{ open: string; closed: string; pnl: string | null }>(
    `select
       count(*) filter (where status = 'OPEN') as open,
       count(*) filter (where status = 'CLOSED') as closed,
       sum(realized_pnl) filter (where status = 'CLOSED') as pnl
     from paper_positions`,
  );
  const row = rows.rows[0];
  return { open: int(row?.open, 0), closed: int(row?.closed, 0), realizedPnl: num(row?.pnl, 0) };
}

export async function savePerformanceSnapshot(
  client: SqlClient,
  params: { scope: string; scopeKey: string; metrics: Record<string, unknown>; windowStart?: string | null; windowEnd?: string | null },
): Promise<void> {
  await client.query(
    `insert into performance_snapshots (scope, scope_key, metrics, window_start, window_end)
     values ($1,$2,$3,$4,$5)`,
    [params.scope, params.scopeKey, JSON.stringify(params.metrics), params.windowStart ?? null, params.windowEnd ?? null],
  );
}
