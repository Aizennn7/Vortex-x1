-- Generated from packages/db/migrations/0003_signals_delivery.sql by scripts/sync-supabase-migrations.mjs.
-- Do not edit this copy: edit the source migration and re-run the sync.

-- VORTEX SI — 0003 signals, Telegram destinations and delivery ledger

create table if not exists signals (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text not null unique,
  pair               text not null,
  direction          text not null,
  decision           text not null,
  status             text not null default 'PLANNED',
  strategy           text not null,
  timeframe          text not null default 'M1',
  confidence         numeric(6,4) not null,
  regime             text not null,
  scheduled_entry_at timestamptz not null,
  publish_at         timestamptz not null,
  published_at       timestamptz,
  horizon_seconds    integer not null,
  reference_price    numeric(18,8) not null,
  entry_price        numeric(18,8),
  exit_price         numeric(18,8),
  stop_pips          numeric(10,3) not null,
  target_pips        numeric(10,3) not null,
  reward_risk        numeric(10,3) not null,
  spread_pips        numeric(10,3) not null default 0,
  reasons            jsonb not null default '[]'::jsonb,
  warnings           jsonb not null default '[]'::jsonb,
  context            jsonb not null default '{}'::jsonb,
  features           jsonb,
  model_version_id   uuid,
  model_probability  numeric(6,4),
  engine_version     text not null,
  outcome            text,
  outcome_rule       text,
  outcome_flags      jsonb not null default '[]'::jsonb,
  outcome_detail     text,
  gross_pips         numeric(12,3),
  cost_pips          numeric(12,3),
  realized_pips      numeric(12,3),
  mfe_pips           numeric(12,3),
  mae_pips           numeric(12,3),
  settled_at         timestamptz,
  settlement_attempts integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint signals_direction_check check (direction in ('BUY','SELL')),
  constraint signals_decision_check check (decision in ('BUY','SELL','NO_TRADE')),
  constraint signals_status_check
    check (status in ('PLANNED','PUBLISHED','ACTIVE','SETTLED','UNRESOLVED','EXPIRED','CANCELLED')),
  constraint signals_outcome_check
    check (outcome is null or outcome in ('WIN','LOSS','DRAW','UNRESOLVED')),
  constraint signals_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint signals_horizon_positive check (horizon_seconds > 0),
  constraint signals_pair_time_direction_unique unique (pair, scheduled_entry_at, direction)
);

create index if not exists signals_entry_desc_idx on signals (scheduled_entry_at desc);
create index if not exists signals_outcome_idx on signals (outcome, scheduled_entry_at desc);
create index if not exists signals_status_idx on signals (status, scheduled_entry_at);
create index if not exists signals_unsettled_idx
  on signals (scheduled_entry_at) where outcome is null and status <> 'CANCELLED';
create index if not exists signals_pair_idx on signals (pair, scheduled_entry_at desc);
create index if not exists signals_strategy_idx on signals (strategy, scheduled_entry_at desc);

-- Telegram destinations (chat ids are configuration, the bot token is not
-- stored here — it lives in the server environment only).
create table if not exists telegram_channels (
  id          uuid primary key default gen_random_uuid(),
  label       text not null unique,
  chat_id     text not null,
  enabled     boolean not null default true,
  is_primary  boolean not null default false,
  template    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint telegram_channels_chat_nonempty check (length(btrim(chat_id)) > 0)
);

-- Delivery ledger. `unique (signal_id, channel_id, kind)` plus an upsert is
-- what makes delivery idempotent: a restarted worker cannot double-post.
-- `status = 'UNKNOWN'` records the honest case where the provider did not
-- confirm the result (network failure after send) — it is never reported as
-- delivered.
create table if not exists signal_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  signal_id           uuid not null references signals (id) on delete cascade,
  channel_id          uuid references telegram_channels (id) on delete set null,
  channel_label       text not null,
  kind                text not null default 'PUBLISH',
  status              text not null default 'PENDING',
  attempts            integer not null default 0,
  provider_message_id text,
  last_error          text,
  confirmed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint signal_deliveries_kind_check check (kind in ('PUBLISH','SETTLEMENT')),
  constraint signal_deliveries_status_check
    check (status in ('PENDING','SENT','FAILED','SKIPPED','UNKNOWN')),
  constraint signal_deliveries_unique unique (signal_id, channel_label, kind)
);

create index if not exists signal_deliveries_status_idx
  on signal_deliveries (status, created_at desc);

create index if not exists signal_deliveries_signal_idx
  on signal_deliveries (signal_id);
