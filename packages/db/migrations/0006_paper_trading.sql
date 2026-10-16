-- VORTEX SI — 0006 paper trading ledger (simulation only, always labelled)

create table if not exists paper_account (
  id                text primary key,
  starting_balance  numeric(18,2) not null,
  balance           numeric(18,2) not null,
  risk_percent      numeric(6,3) not null default 0.5,
  slippage_pips     numeric(6,3) not null default 0.2,
  currency          text not null default 'USD',
  updated_at        timestamptz not null default now(),
  constraint paper_account_positive check (starting_balance > 0),
  constraint paper_account_risk_range check (risk_percent > 0 and risk_percent <= 10)
);

create table if not exists paper_positions (
  id             uuid primary key default gen_random_uuid(),
  signal_id      uuid not null unique references signals (id) on delete cascade,
  pair           text not null,
  direction      text not null,
  units          numeric(20,4) not null default 0,
  risk_amount    numeric(18,2) not null default 0,
  entry_price    numeric(18,8),
  exit_price     numeric(18,8),
  stop_pips      numeric(10,3) not null,
  target_pips    numeric(10,3) not null,
  realized_pips  numeric(12,3),
  realized_pnl   numeric(18,2),
  status         text not null default 'OPEN',
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  constraint paper_positions_direction_check check (direction in ('BUY','SELL')),
  constraint paper_positions_status_check check (status in ('OPEN','CLOSED','VOID'))
);

create index if not exists paper_positions_status_idx on paper_positions (status, opened_at desc);

-- Materialised-ish performance snapshot written after each settlement batch so
-- the dashboard reads a consistent row instead of recomputing everything.
create table if not exists performance_snapshots (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null,
  scope_key     text not null,
  window_start  timestamptz,
  window_end    timestamptz,
  metrics       jsonb not null,
  computed_at   timestamptz not null default now(),
  constraint performance_snapshots_scope_check
    check (scope in ('GLOBAL','PAIR','STRATEGY','REGIME','MODEL','HOUR','SESSION'))
);

create index if not exists performance_snapshots_scope_idx
  on performance_snapshots (scope, computed_at desc);
