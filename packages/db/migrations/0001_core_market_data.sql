-- VORTEX SI — 0001 core market data
-- Forward-only. Every statement is idempotent so a partially applied
-- migration can be re-run safely.

-- gen_random_uuid() is core in PostgreSQL 13+ (Supabase runs 15+), so pgcrypto
-- is only a convenience for older engines. The extension is requested best
-- effort so environments without it (e.g. an embedded engine) still migrate.
do $$
begin
  create extension if not exists "pgcrypto";
exception when others then
  raise notice 'pgcrypto unavailable — relying on core gen_random_uuid()';
end
$$;

create table if not exists schema_migrations (
  version      text primary key,
  name         text not null,
  checksum     text not null,
  applied_at   timestamptz not null default now(),
  duration_ms  integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Instrument universe (configurable; ~20 majors/crosses by default)
-- ---------------------------------------------------------------------------
create table if not exists market_pairs (
  pair          text primary key,
  enabled       boolean not null default true,
  priority      integer not null default 100,
  tier          integer not null default 2,
  pip_size      numeric(12,8) not null default 0.0001,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint market_pairs_pip_size_positive check (pip_size > 0),
  constraint market_pairs_priority_range check (priority between 1 and 100000)
);

-- ---------------------------------------------------------------------------
-- Candles: one row per (pair, timeframe, open_time). Duplicate prevention is
-- enforced by the primary key, not by application logic.
-- ---------------------------------------------------------------------------
create table if not exists candles (
  pair         text not null,
  timeframe    text not null,
  open_time    timestamptz not null,
  close_time   timestamptz not null,
  open         numeric(18,8) not null,
  high         numeric(18,8) not null,
  low          numeric(18,8) not null,
  close        numeric(18,8) not null,
  volume       numeric(20,4),
  provider     text not null,
  is_final     boolean not null default true,
  revision     integer not null default 1,
  received_at  timestamptz not null default now(),
  primary key (pair, timeframe, open_time),
  constraint candles_timeframe_check check (timeframe in ('M1','M3','M5','M15','H1')),
  constraint candles_ohlc_valid check (
    high >= low and high >= open and high >= close and low <= open and low <= close
    and open > 0 and high > 0 and low > 0 and close > 0
  ),
  constraint candles_window_valid check (close_time > open_time)
);

create index if not exists candles_pair_tf_time_desc
  on candles (pair, timeframe, open_time desc);

create index if not exists candles_received_at_idx
  on candles (received_at desc);

-- ---------------------------------------------------------------------------
-- Per-pair data-quality ledger (freshness / gaps), refreshed by the worker.
-- ---------------------------------------------------------------------------
create table if not exists market_data_quality (
  pair           text not null,
  timeframe      text not null,
  status         text not null default 'NOT VERIFIED',
  age_seconds    integer,
  gap_count      integer not null default 0,
  last_candle_at timestamptz,
  expected_at    timestamptz,
  detail         text,
  checked_at     timestamptz not null default now(),
  primary key (pair, timeframe),
  constraint market_data_quality_status_check
    check (status in ('CONNECTED','DISCONNECTED','DEGRADED','CONFIGURATION REQUIRED','NOT VERIFIED'))
);

create table if not exists system_settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
