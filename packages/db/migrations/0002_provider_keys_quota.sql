-- VORTEX SI — 0002 provider API key pool and quota accounting
--
-- Provider keys are stored as AES-256-GCM ciphertext. The plaintext key never
-- appears in a table, a view, a log or an HTTP response. Only `masked_key`
-- (last four characters) is displayable.

create table if not exists provider_keys (
  id                    uuid primary key default gen_random_uuid(),
  label                 text not null unique,
  masked_key            text not null,
  -- ciphertext envelope: v1:<ivb64>:<tagb64>:<cipherb64>
  ciphertext            text not null,
  key_fingerprint       text not null,
  account_id            text,
  enabled               boolean not null default true,
  status                text not null default 'ACTIVE',
  minute_limit          integer,
  day_limit             integer,
  headroom_percent      numeric(5,2),
  cooldown_until        timestamptz,
  consecutive_failures  integer not null default 0,
  last_error            text,
  last_used_at          timestamptz,
  last_verified_at      timestamptz,
  provider_usage_credits integer,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  rotated_at            timestamptz,
  constraint provider_keys_status_check
    check (status in ('ACTIVE','COOLDOWN','EXHAUSTED','INVALID','DISABLED')),
  constraint provider_keys_labels_nonempty check (length(btrim(label)) > 0)
);

create index if not exists provider_keys_enabled_idx on provider_keys (enabled, status);

-- ---------------------------------------------------------------------------
-- Quota counters. One row per key per bucket window. Reservations happen in a
-- transaction with SELECT ... FOR UPDATE, which is what makes concurrent
-- workers (and the relay) share the same budget safely.
-- ---------------------------------------------------------------------------
create table if not exists provider_quota_usage (
  key_id       uuid not null references provider_keys (id) on delete cascade,
  bucket       text not null,
  bucket_start timestamptz not null,
  used         integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (key_id, bucket, bucket_start),
  constraint provider_quota_bucket_check check (bucket in ('minute','day')),
  constraint provider_quota_used_nonneg check (used >= 0)
);

create index if not exists provider_quota_usage_bucket_idx
  on provider_quota_usage (bucket, bucket_start);

-- Request ledger for observability: what was called, what it cost, and why it
-- failed. Never contains the key itself.
create table if not exists provider_request_log (
  id           bigserial primary key,
  key_id       uuid references provider_keys (id) on delete set null,
  endpoint     text not null,
  pair         text,
  timeframe    text,
  credits      integer not null default 1,
  http_status  integer,
  ok           boolean not null default true,
  duration_ms  integer,
  attempt      integer not null default 1,
  error        text,
  created_at   timestamptz not null default now()
);

create index if not exists provider_request_log_created_idx
  on provider_request_log (created_at desc);

create index if not exists provider_request_log_key_idx
  on provider_request_log (key_id, created_at desc);
