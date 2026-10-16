-- VORTEX SI — 0005 operations: heartbeats, jobs, locks, health, alerts

-- Worker heartbeat. This is the ONLY trustworthy source for "is the worker
-- alive": an HTTP 200 from the relay only proves the relay is reachable.
create table if not exists worker_heartbeats (
  worker_id       text primary key,
  instance_label  text,
  version         text not null default 'unknown',
  started_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  last_job        text,
  last_job_at     timestamptz,
  jobs_completed  bigint not null default 0,
  jobs_failed     bigint not null default 0,
  cycles_run      bigint not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  stopping_at     timestamptz
);

create index if not exists worker_heartbeats_seen_idx on worker_heartbeats (last_seen_at desc);

-- Job ledger. `unique (job_name, slot_key)` gives idempotent scheduling: the
-- same slot can never be processed twice even after a restart or a clock jump.
create table if not exists job_runs (
  id           bigserial primary key,
  job_name     text not null,
  slot_key     text not null,
  worker_id    text,
  status       text not null default 'RUNNING',
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  duration_ms  integer,
  detail       jsonb not null default '{}'::jsonb,
  error        text,
  constraint job_runs_status_check check (status in ('RUNNING','SUCCEEDED','FAILED','SKIPPED','STALE')),
  constraint job_runs_unique_slot unique (job_name, slot_key)
);

create index if not exists job_runs_started_idx on job_runs (started_at desc);
create index if not exists job_runs_status_idx on job_runs (status, started_at desc);

-- Distributed locks for singleton jobs across multiple workers.
create table if not exists job_locks (
  name         text primary key,
  owner        text not null,
  acquired_at  timestamptz not null default now(),
  expires_at   timestamptz not null,
  metadata     jsonb not null default '{}'::jsonb
);

-- Component health, written by whoever actually checks the component.
create table if not exists system_health (
  component    text primary key,
  status       text not null default 'NOT VERIFIED',
  detail       text,
  metadata     jsonb not null default '{}'::jsonb,
  observed_at  timestamptz not null default now(),
  constraint system_health_status_check
    check (status in ('CONNECTED','DISCONNECTED','DEGRADED','CONFIGURATION REQUIRED','NOT VERIFIED'))
);

create table if not exists alerts (
  id              uuid primary key default gen_random_uuid(),
  severity        text not null default 'WARNING',
  code            text not null,
  title           text not null,
  detail          text,
  metadata        jsonb not null default '{}'::jsonb,
  occurrences     integer not null default 1,
  acknowledged_at timestamptz,
  acknowledged_by text,
  resolved_at     timestamptz,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  constraint alerts_severity_check check (severity in ('INFO','WARNING','ERROR','CRITICAL'))
);

create unique index if not exists alerts_open_unique on alerts (code) where resolved_at is null;
create index if not exists alerts_seen_idx on alerts (last_seen_at desc);

-- Append-only audit trail for privileged operations (key rotation, model
-- promotion, settings changes, schema actions).
create table if not exists audit_log (
  id          bigserial primary key,
  actor       text not null,
  action      text not null,
  target      text,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_created_idx on audit_log (created_at desc);

-- Structured log ring for the control centre (kept short on purpose).
create table if not exists log_events (
  id          bigserial primary key,
  level       text not null,
  component   text not null,
  event       text not null,
  message     text,
  fields      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint log_events_level_check check (level in ('trace','debug','info','warn','error','fatal'))
);

create index if not exists log_events_created_idx on log_events (created_at desc);
create index if not exists log_events_level_idx on log_events (level, created_at desc);
