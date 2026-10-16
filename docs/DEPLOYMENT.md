# Deployment — VORTEX SI

Three services, three providers, one rule: **nothing is configured with a value
nobody has verified.** Every URL below is either produced by a deploy you ran or
left blank on purpose.

```
 GitHub Pages  ──VITE_RELAY_URL──▶  Render web service   ──▶  Supabase Postgres
  (dashboard)   (read-only GET)    (relay + /admin)          (all persistent data)
                                       ▲
                                       │  same Supabase project
                                       ▼
                                 Render worker service
                        (ingestion · signals · settlement · training)
```

| Piece | Where it runs | Entry point | Health |
| --- | --- | --- | --- |
| Dashboard | GitHub Pages | `apps/web` → `apps/web/dist` | — |
| Relay (API) | Render **web** service | `npm run start:relay` → `apps/worker/src/main.ts --role=relay` | `GET /health` |
| Worker | Render **background worker** | `npm run start:worker` → `apps/worker/src/main.ts --role=worker` | `worker_heartbeats` via `GET /api/summary` |
| Database | Supabase Postgres | `packages/db/migrations/*.sql` | `GET /ready` |

The relay and the worker are the *same code* with a different role. The relay
never schedules a cycle, so redeploying the public surface cannot interrupt
ingestion; the worker binds no port, so it is never reachable from the internet.

---

## 0. What is already automated in this repository

| Automated | How |
| --- | --- |
| Typecheck, tests, smoke, bundle guard, migration drift | `.github/workflows/ci.yml` on every push and PR |
| Dashboard publish | `.github/workflows/pages.yml` (needs the `VITE_RELAY_URL` repository variable) |
| Both backend services | `render.yaml` at the repo root — Render reads it as a Blueprint |
| Migrations applied to Supabase | `npm run db:sync-supabase` mirrors the tested SQL into `supabase/migrations/`; CI fails if the copies drift |
| Duplicate ingestion | `job_runs` slots + the `vortex-scheduler` lease (`apps/worker/src/scheduler.ts`) |
| Secret generation | `node scripts/generate-secrets.mjs` prints the two values you must paste; nothing is written to disk |

What still needs **your** account: creating the Supabase project, connecting the
GitHub repo to Render, enabling GitHub Pages, and pasting secrets. Those are
marked 👤 below.

---

## 1. Verify the branch before anything else

```bash
npm ci
npm run typecheck     # 5 workspaces
npm test              # 264 tests, embedded Postgres
npm run smoke         # 13 stages, simulated feed
npm run build:web
npm run guard:bundle
npm run db:sync-supabase && git diff --exit-code -- supabase/migrations
```

CI runs the same list. Do not deploy a red pipeline.

---

## 2. Supabase — the one database both services share

### 2.1 Create or select the project 👤

Dashboard → **New project**. Record three values, never in git:

| Supabase value | Where it goes |
| --- | --- |
| **Session pooler** URI (`…:6543`, user `postgres.<project-ref>`) | `DATABASE_URL` |
| **Direct connection** URI (`…:5432`) | `DATABASE_URL_DIRECT` |
| Project ref / region | your notes |

Use the pooler URI for `DATABASE_URL`: the worker holds a small pool
(`max: 5`) and the pooler is the connection that survives PgBouncer.

> **Never use the Supabase service-role JWT as `DATABASE_URL`.** The worker
> authenticates as a Postgres role; the JWT is only for the REST/Realtime API.
> The pooled URI with the database password is the right value.

### 2.2 Check permissions and schema state *before* applying anything

```bash
export DATABASE_URL_DIRECT='postgresql://…'   # local shell only
npm run migrate:status      # read-only: prints APPLIED / PENDING / DRIFT per version
npm run migrate -- --dry-run # prints exactly what would run, changes nothing
```

Expected on a fresh project: seven `PENDING` rows, no `DRIFT`.

*If any row says `DRIFT`* the database and the repository disagree about
history. **Stop.** `migrate` refuses to proceed on drift by design; resolve it
by adding a new migration, never by editing an applied one, and never with
`supabase db reset` against this project.

### 2.3 Apply

```bash
npm run migrate
npm run migrate:status     # every row must now read APPLIED
```

Forward-only, one transaction per migration. Running it twice is a no-op.

<details>
<summary>Alternative: apply with the Supabase CLI</summary>

```bash
supabase link --project-ref <project-ref>
supabase db push           # applies supabase/migrations/*.sql (mirrored from packages/db)
```

Use **one** of the two paths, not both — `packages/db/migrations` is the single
source of truth and `supabase db push` applies byte-identical SQL.
</details>

### 2.4 Row-level security

Migration `0007_access_control` enables RLS on every table, revokes
`anon`/`authenticated` on all base tables, and grants `SELECT` on the
`public_*` views only. Nothing in this deployment asks the browser to touch
Supabase directly — the dashboard reads the relay — but the lockdown is what
keeps the anon key harmless if it ever does.

---

## 3. Render — two persistent services

### 3.1 Connect the repository 👤

Dashboard → **New → Blueprint** → pick `Aizennn7/Vortex-x1` → name the Blueprint
(e.g. `vortex-si`) → **Apply**.

Render reads `render.yaml` and creates:

| Service | Type | Plan | Start command | Health check |
| --- | --- | --- | --- | --- |
| `vortex-si-relay` | web | `starter` | `npm run start:relay` | `/health` |
| `vortex-si-worker` | worker | `starter` | `npm run start:worker` | n/a (heartbeat instead) |

`starter` is deliberate: the free tier sleeps and cold-starts, which is not
24/7. The worker has no free tier at all. Region is `singapore` in the
blueprint — change it if you would rather be closer to Supabase, and change it
in **both** services.

`autoDeploy: false` on both: the first deploy is a manual, deliberate act
(staging-first). Turn on `autoDeployTrigger: commit` later if you want it.

### 3.2 Mint the two shared secrets 👤

```bash
node scripts/generate-secrets.mjs
```

Paste the printed values into **both** services:

| Variable | Same value on both? | Why |
| --- | --- | --- |
| `VORTEX_SECRET_KEY` | **yes — critical** | AES-256-GCM master key for provider keys at rest. A mismatch means the relay cannot decrypt what the worker stored, and vice versa. |
| `VORTEX_ADMIN_TOKEN` | yes | Bearer token for `/admin/*`. |
| `DATABASE_URL` | yes | Same Supabase project. |
| `DATABASE_URL_DIRECT` | yes | Used by `npm run migrate`. |
| `TELEGRAM_BOT_TOKEN` | yes | Server-side only. Never exposed to the browser. |

Everything else comes from the `vortex-runtime` environment group and needs no
input.

After the first deploy Render prints the relay's public origin — that is the URL
you use for `VITE_RELAY_URL` in step 4. **Do not guess it.**

### 3.3 Deploy and watch the health check

Deploys are manual until you say otherwise. Start with the **relay**:

```bash
curl -sS https://<relay-host>/health | jq
```

```jsonc
{
  "data": {
    "service": "vortex-si-worker",
    "status": "ok",              // "degraded" means the database is unreachable
    "ready": true,
    "reasons": [],               // every blocking problem, named
    "database": { "ok": true, "detail": "query ok, server time …" },
    "provider": { "name": "twelvedata", "synthetic": false }
  }
}
```

`/ready` returns **503** with `reasons` when configuration is incomplete —
that is the honest signal, and it is why Render's health check points at
`/health` (a misconfigured relay should stay up and explain itself, not be
killed in a loop).

Then deploy the **worker** and confirm it is alive *through the relay* — a
process being up proves nothing about whether it is working:

```bash
curl -sS https://<relay-host>/api/summary | jq '.data.worker'
```

`liveness: "CONNECTED"` means a heartbeat landed within `VORTEX_HEARTBEAT_STALE_SECONDS`.
`"NOT VERIFIED"` / `null` means no worker is doing work, whatever the deploy log says.

---

## 4. GitHub Pages — the dashboard

### 4.1 Turn on Pages 👤

The repository is **private**, so Pages requires a paid GitHub plan (Pro, Team
or Enterprise) and the published site is readable only by people with repository
access. If you need a public dashboard, make the repository public or host the
bundle elsewhere — the relay itself is public either way.

**Settings → Pages → Source: "GitHub Actions".**

The publish workflow is already committed; this setting is what lets it run.

### 4.2 Tell the build where the relay is 👤

The dashboard is static and cannot proxy `/api`, so the relay origin has to be
baked in at build time. It is **not** hard-coded anywhere — it is a repository
variable:

**Settings → Secrets and variables → Actions → Variables tab → New variable**

| Name | Value |
| --- | --- |
| `VITE_RELAY_URL` | the relay origin Render printed, e.g. `https://vortex-si-relay.onrender.com` |
| `VITE_BASE_PATH` | leave as `./` (correct for `https://aizennn7.github.io/Vortex-x1/`) |

Then **Actions → Deploy dashboard → Run workflow**.

The workflow refuses to publish a bundle with no relay URL, runs the secret
guard, and asserts the built bundle really contains that origin — so a typo
fails the deploy instead of shipping a dashboard that silently shows nothing.

### 4.3 CORS

The relay only answers browsers whose origin is in `VORTEX_CORS_ORIGINS`, set to
`https://aizennn7.github.io` in the environment group. Origins are compared
exactly, path included nowhere — `https://aizennn7.github.io` covers the
`/Vortex-x1/` project page. Change both together if the dashboard moves.

---

## 5. Twelve Data — quotas, honestly

**Provider keys are never environment variables.** They are stored encrypted in
the database and added through the privileged plane:

```bash
curl -sS -X POST https://<relay-host>/admin/keys \
  -H "authorization: Bearer $VORTEX_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"label":"twelvedata-primary","apiKey":"<your-32-hex-key>"}'
```

Verify it, then watch the budget:

```bash
curl -sS https://<relay-host>/admin/keys        -H "authorization: Bearer $VORTEX_ADMIN_TOKEN" | jq
curl -sS https://<relay-host>/admin/provider    -H "authorization: Bearer $VORTEX_ADMIN_TOKEN" | jq
```

What the system actually does:

* quota is **reserved inside a transaction before** the HTTP call, so the plan
  cannot be overspent by concurrency;
* a `429` **refunds** the reservation and cools the key down — it does not burn
  the plan;
* when the budget is gone the worker **stops calling the provider** and reports
  `exhausted`; it never retries into the limit;
* `VORTEX_PROVIDER_RPM_PER_KEY` / `VORTEX_PROVIDER_RPD_PER_KEY` must match the
  plan you actually hold. They default to the free tier (8/min, 800/day).

**Budget arithmetic before you add pairs:** ingestion issues roughly one request
per pair per minute, so a day of continuous running costs
`pairs × 1440` credits. Two pairs ≈ 2880 credits/day — more than the free
800/day. Either start with **one** pair, or raise the pairs count only after
checking the real limits for the key you added. Nobody here can promise
unlimited provider usage, and the code does not attempt to bypass a limit.

---

## 6. Telegram — server-side secrets only

1. Create the bot with [@BotFather](https://t.me/BotFather) → token.
2. Add the bot to the channel and grant it post permission → note `@channel`
   or the numeric `-100…` id.
3. Set on **both** services: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_PRIMARY`
   (and `TELEGRAM_CHANNEL_SECONDARY` if wanted).
4. Flip `VORTEX_TELEGRAM_ENABLED=true` on both and redeploy.
5. Prove delivery end to end:

```bash
curl -sS -X POST https://<relay-host>/admin/telegram/test \
  -H "authorization: Bearer $VORTEX_ADMIN_TOKEN" | jq
```

Leave `VORTEX_ALLOW_SYNTHETIC_SIGNALS=false` unless you deliberately run a
labelled demo: the worker refuses to deliver signals derived from the simulated
feed to a real audience, and that switch is the only thing that overrides it.

Delivery status is reported honestly and is worth reading as a ledger, not a
number:

| Status | Meaning | Retried automatically? |
| --- | --- | --- |
| `SENT` | Bot API returned a message id | — |
| `UNKNOWN` | response lost | **No.** A duplicate post is unrecoverable, so it is filed and left alone. |
| `FAILED` | request rejected | No, within the same call |

```bash
curl -sS 'https://<relay-host>/admin/deliveries?status=FAILED' \
  -H "authorization: Bearer $VORTEX_ADMIN_TOKEN" | jq
```

---

## 7. Verifying the running system

Not one command — each proves a different thing, and none of them proves the
next one.

```bash
RELAY=https://<relay-host>

# 1. Real market data actually arriving (rows, not promises)
psql "$DATABASE_URL_DIRECT" -c "
  select pair, max(close_time) as newest, count(*) as candles
  from candles where timeframe='M1' group by pair order by pair;"

# 2. Ingestion jobs running on their slots, one row per slot
psql "$DATABASE_URL_DIRECT" -c "
  select job_name, status, count(*), max(started_at) as last
  from job_runs where started_at > now() - interval '1 hour'
  group by job_name, status order by job_name;"

# 3. Worker heartbeat (the only honest liveness signal)
curl -sS $RELAY/api/summary | jq '.data.worker | {workerId,liveness,lastJob,secondsSince}'

# 4. Outcomes being settled, draws and unresolved counted separately
psql "$DATABASE_URL_DIRECT" -c "
  select outcome, count(*) from signals where outcome is not null group by outcome;"

# 5. Loss monitoring — the signals component reflects real counts
curl -sS $RELAY/api/health | jq '.data[] | select(.id=="signals")'

# 6. Scheduled training (runs once a day after VORTEX_TRAIN_CRON's hour)
psql "$DATABASE_URL_DIRECT" -c "
  select version, status, promoted_at, metrics->>'accuracy' as accuracy
  from model_versions order by created_at desc limit 5;"
```

Acceptance criteria — all must hold before you call staging operational:

- newest `M1` candle per pair is younger than `VORTEX_MAX_CANDLE_AGE_SECONDS`
  while the FX market is open;
- `ingest_market_data` rows are `SUCCEEDED` roughly once a minute, never two
  `RUNNING` rows for the same slot;
- worker `liveness` is `CONNECTED` and `lastJob` is a real job name;
- `outcome` counts include `WIN`/`LOSS` with `DRAW` and `UNRESOLVED` reported
  as their own rows — never folded into wins;
- `model_versions` gains a row per training day. **No row means training did not
  run**; a green local smoke test does not count as evidence.

Everything below is *not* evidence of operation: a successful `npm run smoke`
(embedded PGlite + simulated feed), a Render deploy log ending in "Success", or
`/health` returning `ok`. `/health` proves the relay answered. It says nothing
about ingestion, settlement or training — those come from the heartbeat table
and the job ledger above.

---

## 8. Operating it

| Situation | What happens | What to do |
| --- | --- | --- |
| Relay redeploy | `/health` may 502 for a few seconds; the worker keeps ingesting | nothing |
| Worker crash | Render restarts it; the lease TTL (`VORTEX_JOB_LOCK_TTL_SECONDS`) blocks any second instance meanwhile | check `job_runs` for `FAILED` slots |
| Two worker instances | one holds the lease, the other logs "standby" and writes no heartbeat | set `VORTEX_INSTANCE_LABEL` differently per instance |
| Deploy needed | both services use the same `main`; trigger each deploy manually | — |
| Rollback | `git revert` on `main`, wait for CI, redeploy both | migrations are forward-only; a revert never drops data |

### Going from staging to production

Nothing in this repository changes between them except:

1. `autoDeployTrigger: commit` in `render.yaml` (or keep manual — safer);
2. a real `VORTEX_PAIRS` value that fits the provider plan you actually hold;
3. `VORTEX_TELEGRAM_ENABLED=true` with real channels, once you have read
   §6 and accept what `UNKNOWN` means.

Then re-run the whole of §7 against production and keep the numbers.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/health` → `degraded`, `database.ok=false` | wrong `DATABASE_URL`, or the pooler URI without the password | re-copy the **Session pooler** URI from Supabase |
| `/health` → `reasons: ["VORTEX_ADMIN_TOKEN…"]` | token shorter than 24 chars in production | re-mint with `scripts/generate-secrets.mjs` |
| `/admin/*` → `503 configuration_required` | `VORTEX_ADMIN_TOKEN` unset or < 16 chars on the relay | set it on the relay |
| Worker liveness `NOT VERIFIED` | worker down, or DB unreachable | Render → `vortex-si-worker` → Logs |
| No candles ingested | no key stored, or quota exhausted | `/admin/keys`, `/admin/provider` |
| `exhausted: true` in the ingest summary | daily plan reached | wait for the UTC day to roll, or reduce `VORTEX_PAIRS` |
| Dashboard loads but shows "relay unreachable" | `VITE_RELAY_URL` wrong, or CORS origin missing | rebuild Pages; check `VORTEX_CORS_ORIGINS` |
| Dashboard blank on Pages | wrong base path | leave `VITE_BASE_PATH` as `./` |
| `Migration checksum drift` | an applied migration was edited | add a new migration; never edit history |