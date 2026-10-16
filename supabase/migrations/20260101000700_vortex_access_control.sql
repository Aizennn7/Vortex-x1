-- Generated from packages/db/migrations/0007_access_control.sql by scripts/sync-supabase-migrations.mjs.
-- Do not edit this copy: edit the source migration and re-run the sync.

-- VORTEX SI — 0007 access control and the browser read surface
--
-- Supabase grants ALL privileges on new tables in `public` to anon and
-- authenticated by default. That default is a privilege-escalation footgun for
-- a trading platform, so this migration:
--   1. enables RLS on every table (with no policies => default deny for
--      anon/authenticated);
--   2. REVOKES all privileges on every base table and sequence from
--      anon/authenticated;
--   3. exposes a small set of read-only views with explicit column lists that
--      contain no key material, which the browser reads with the anon key.
--
-- The worker and relay use the service-role/direct connection, which bypasses
-- RLS, so privileged operations are unaffected.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    -- NOTE: `force row level security` is intentionally NOT applied. FORCE
    -- would also bind the table owner, which breaks owner-role connections
    -- (including the Supabase pooler used by the worker). Enable it yourself
    -- only if your worker connects with a BYPASSRLS role.
  end loop;
  for t in
    select sequencename from pg_sequences where schemaname = 'public'
  loop
    execute format('revoke all on sequence public.%I from anon, authenticated', t);
  end loop;
end
$$;

-- The worker/relay connection owns the tables; make sure it keeps full access.
do $$
declare
  owner_role text := current_user;
begin
  execute format('grant usage on schema public to %I', owner_role);
end
$$;

-- ---------------------------------------------------------------------------
-- Public read views
-- ---------------------------------------------------------------------------

create or replace view public_agent_status as
select
  component,
  status,
  detail,
  metadata,
  observed_at
from system_health;

create or replace view public_worker_status as
select
  worker_id,
  version,
  started_at,
  last_seen_at,
  last_job,
  last_job_at,
  jobs_completed,
  jobs_failed,
  cycles_run,
  greatest(0, extract(epoch from (now() - last_seen_at)))::integer as seconds_since_heartbeat,
  case
    when stopping_at is not null then 'STOPPING'
    when now() - last_seen_at <= interval '120 seconds' then 'CONNECTED'
    when now() - last_seen_at <= interval '600 seconds' then 'DEGRADED'
    else 'DISCONNECTED'
  end as liveness,
  metadata
from worker_heartbeats;

create or replace view public_signals as
select
  id,
  pair,
  direction,
  decision,
  status,
  strategy,
  timeframe,
  confidence,
  regime,
  scheduled_entry_at,
  publish_at,
  published_at,
  horizon_seconds,
  reference_price,
  entry_price,
  exit_price,
  stop_pips,
  target_pips,
  reward_risk,
  spread_pips,
  reasons,
  warnings,
  -- context is trimmed: no internal weights, only what the UI renders
  jsonb_build_object(
    'regime', context -> 'regime',
    'session', context -> 'session',
    'atrPips', context -> 'atrPips',
    'rsi', context -> 'rsi',
    'adx', context -> 'adx',
    'spreadPips', context -> 'spreadPips',
    'agreement', context -> 'agreement',
    'm3Trend', context -> 'm3Trend',
    'dataQuality', context -> 'dataQuality'
  ) as context,
  model_version_id,
  model_probability,
  engine_version,
  outcome,
  outcome_rule,
  outcome_flags,
  outcome_detail,
  gross_pips,
  cost_pips,
  realized_pips,
  mfe_pips,
  mae_pips,
  settled_at,
  created_at,
  updated_at
from signals;

create or replace view public_market_quality as
select pair, timeframe, status, age_seconds, gap_count, last_candle_at, expected_at, detail, checked_at
from market_data_quality;

create or replace view public_candles as
select pair, timeframe, open_time, close_time, open, high, low, close, volume, provider, is_final
from candles
where open_time >= now() - interval '2 days';

create or replace view public_pair_performance as
select
  pair,
  count(*) filter (where outcome in ('WIN','LOSS'))                          as decisive,
  count(*) filter (where outcome = 'WIN')                                    as wins,
  count(*) filter (where outcome = 'LOSS')                                   as losses,
  count(*) filter (where outcome = 'DRAW')                                   as draws,
  count(*) filter (where outcome = 'UNRESOLVED')                             as unresolved,
  round(avg(realized_pips) filter (where outcome in ('WIN','LOSS','DRAW')), 2) as avg_pips
from signals
group by pair;

create or replace view public_strategy_performance as
select
  strategy,
  count(*) filter (where outcome in ('WIN','LOSS'))                           as decisive,
  count(*) filter (where outcome = 'WIN')                                     as wins,
  count(*) filter (where outcome = 'LOSS')                                    as losses,
  count(*) filter (where outcome = 'DRAW')                                    as draws,
  count(*) filter (where outcome = 'UNRESOLVED')                              as unresolved,
  round(avg(realized_pips) filter (where outcome in ('WIN','LOSS','DRAW')), 2) as avg_pips
from signals
group by strategy;

create or replace view public_overall_performance as
select
  count(*)                                                                    as cohort,
  count(*) filter (where outcome in ('WIN','LOSS'))                           as decisive,
  count(*) filter (where outcome = 'WIN')                                     as wins,
  count(*) filter (where outcome = 'LOSS')                                    as losses,
  count(*) filter (where outcome = 'DRAW')                                    as draws,
  count(*) filter (where outcome = 'UNRESOLVED')                              as unresolved,
  count(*) filter (where outcome is null)                                     as pending,
  case when count(*) filter (where outcome in ('WIN','LOSS')) = 0 then null
       else round(count(*) filter (where outcome = 'WIN')::numeric
                  / count(*) filter (where outcome in ('WIN','LOSS')), 4)
  end                                                                          as accuracy,
  case when count(*) filter (where outcome is not null) = 0 then null
       else round(count(*) filter (where outcome = 'WIN')::numeric
                  / count(*) filter (where outcome is not null), 4)
  end                                                                          as accuracy_conservative,
  round(avg(realized_pips) filter (where outcome in ('WIN','LOSS','DRAW')), 3) as expectancy_pips,
  round(sum(realized_pips) filter (where outcome in ('WIN','LOSS','DRAW')), 2) as total_pips
from signals;

create or replace view public_telegram_delivery as
select
  d.signal_id,
  d.channel_label,
  d.kind,
  d.status,
  d.attempts,
  d.last_error,
  d.confirmed_at,
  d.created_at,
  s.pair,
  s.direction,
  s.scheduled_entry_at,
  s.outcome
from signal_deliveries d
join signals s on s.id = d.signal_id;

create or replace view public_provider_budget as
select
  count(*) filter (where enabled)                                       as enabled_keys,
  count(*) filter (where enabled and status in ('ACTIVE','COOLDOWN'))    as usable_keys,
  count(*) filter (where enabled and status = 'INVALID')                 as invalid_keys,
  min(cooldown_until) filter (where cooldown_until > now())              as earliest_cooldown_expiry,
  max(last_used_at)                                                      as last_used_at,
  coalesce(sum(day_limit) filter (where enabled), 0)                     as configured_day_capacity
from provider_keys;

create or replace view public_quota_usage as
select
  q.bucket,
  q.bucket_start,
  sum(q.used)::integer                                                   as used
from provider_quota_usage q
join provider_keys k on k.id = q.key_id
where k.enabled and q.bucket_start >= now() - interval '2 days'
group by q.bucket, q.bucket_start;

create or replace view public_model_versions as
select
  id,
  version,
  kind,
  status,
  dataset_checksum,
  dataset_size,
  dataset_from,
  dataset_to,
  metrics,
  walk_forward,
  promotion,
  created_at,
  promoted_at,
  archived_at,
  notes
from model_versions;

create or replace view public_learning_runs as
select id, started_at, finished_at, status, dataset_checksum, dataset_size,
       dataset_from, dataset_to, exclusions, source_counts, promotion, error
from learning_runs;

create or replace view public_alerts as
select id, severity, code, title, detail, occurrences, first_seen_at, last_seen_at, resolved_at
from alerts
where resolved_at is null;

create or replace view public_paper_performance as
select
  a.id,
  a.starting_balance,
  a.balance,
  a.risk_percent,
  a.slippage_pips,
  a.currency,
  a.updated_at,
  (select count(*) from paper_positions p where p.status = 'CLOSED')            as closed_positions,
  (select count(*) from paper_positions p where p.status = 'OPEN')              as open_positions,
  (select coalesce(round(sum(p.realized_pnl), 2), 0) from paper_positions p)    as realized_pnl
from paper_account a;

create or replace view public_runtime_config as
select key, value, updated_at from system_settings where key not like '%secret%';

-- ---------------------------------------------------------------------------
-- Grant the browser roles exactly two things: USAGE on the schema and SELECT on
-- the read-only views. Nothing grants access to a base table, so even a
-- mis-issued client query cannot reach provider keys, heartbeats or the audit
-- trail.
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
begin
  execute 'grant usage on schema public to anon, authenticated';
  for v in select viewname from pg_views where schemaname = 'public' and viewname like 'public_%'
  loop
    execute format('grant select on public.%I to anon, authenticated', v);
  end loop;
end
$$;
