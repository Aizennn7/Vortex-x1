-- Generated from packages/db/migrations/0004_learning_models.sql by scripts/sync-supabase-migrations.mjs.
-- Do not edit this copy: edit the source migration and re-run the sync.

-- VORTEX SI — 0004 self-learning artefacts

create table if not exists model_versions (
  id                 uuid primary key default gen_random_uuid(),
  version            text not null unique,
  kind               text not null default 'logistic_regression',
  status             text not null default 'CANDIDATE',
  dataset_checksum   text not null,
  dataset_size       integer not null,
  dataset_from       timestamptz,
  dataset_to         timestamptz,
  feature_names      jsonb not null default '[]'::jsonb,
  hyper              jsonb not null default '{}'::jsonb,
  parameters         jsonb not null default '{}'::jsonb,
  metrics            jsonb not null default '{}'::jsonb,
  walk_forward       jsonb not null default '[]'::jsonb,
  baselines          jsonb not null default '{}'::jsonb,
  promotion          jsonb not null default '{}'::jsonb,
  artifact_checksum  text,
  notes              text,
  created_at         timestamptz not null default now(),
  promoted_at        timestamptz,
  archived_at        timestamptz,
  constraint model_versions_status_check
    check (status in ('CANDIDATE','CHAMPION','ARCHIVED','REJECTED')),
  constraint model_versions_kind_check
    check (kind in ('logistic_regression','strategy_weights'))
);

-- Exactly one champion at a time.
create unique index if not exists model_versions_single_champion
  on model_versions (status) where status = 'CHAMPION';

create table if not exists learning_runs (
  id                uuid primary key default gen_random_uuid(),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'RUNNING',
  dataset_checksum  text,
  dataset_size      integer,
  dataset_from      timestamptz,
  dataset_to        timestamptz,
  exclusions        jsonb not null default '{}'::jsonb,
  source_counts     jsonb not null default '{}'::jsonb,
  candidate_id      uuid references model_versions (id) on delete set null,
  promotion         jsonb not null default '{}'::jsonb,
  worker_id         text,
  error             text,
  constraint learning_runs_status_check check (status in ('RUNNING','SUCCEEDED','FAILED','SKIPPED'))
);

create index if not exists learning_runs_started_idx on learning_runs (started_at desc);

create table if not exists strategy_weights (
  id          uuid primary key default gen_random_uuid(),
  version     text not null,
  weights     jsonb not null,
  evidence    jsonb not null default '{}'::jsonb,
  active      boolean not null default false,
  sample_size integer not null default 0,
  notes       text,
  created_at  timestamptz not null default now()
);

create unique index if not exists strategy_weights_single_active
  on strategy_weights (active) where active;

create table if not exists model_drift_reports (
  id             uuid primary key default gen_random_uuid(),
  model_version_id uuid references model_versions (id) on delete set null,
  drifting       boolean not null default false,
  recent_accuracy numeric(6,4),
  baseline_accuracy numeric(6,4),
  recent_samples integer not null default 0,
  detail         text,
  action         text,
  created_at     timestamptz not null default now()
);

create index if not exists model_drift_created_idx on model_drift_reports (created_at desc);

-- Artifact checksums for provenance of anything written to disk.
create table if not exists artifacts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  path        text not null,
  checksum    text not null,
  bytes       bigint not null default 0,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  constraint artifacts_unique_path unique (path, checksum)
);
