# VORTEX SI

Signal intelligence for spot FX pairs. The system ingests 1-minute candles, scores every enabled pair with a
strategy ensemble, publishes a signal to Telegram only when every gate passes, then settles the outcome against the
same market data and reports what actually happened — including the signals it refused to publish.

It never places an order. Every profit figure is a paper simulation that charges spread and slippage.

```
packages/core      pure domain: indicators, regimes, strategies, ensemble, scheduling, settlement, learning
packages/provider  market-data adapters (Twelve Data, deterministic simulator)
packages/db        schema, migrations, repositories (Postgres in production, embedded PGlite in tests/CI)
apps/worker        the always-on service: ingestion, scan/publish, settlement, training, Telegram, HTTP relay
apps/web           static dashboard (React + Vite), relay-only, no secrets in the bundle
scripts            smoke test, Supabase migration sync, bundle guard
```

## Quick start

```bash
npm install
npm run typecheck      # every workspace
npm test               # 254 tests, embedded Postgres — no external services needed
npm run smoke          # runs the whole pipeline end to end against the simulator
```

`npm run smoke` is the fastest way to see the system work: it migrates an embedded database, stores a provider key,
ingests candles, runs a signal cycle, settles the results and prints each stage. Add `-- --database` to run it against
a real `DATABASE_URL`.

## Running the service

```bash
cp .env.example .env
# fill in DATABASE_URL, VORTEX_SECRET_KEY (openssl rand -hex 32), VORTEX_ADMIN_TOKEN,
# TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNELS when you want delivery
npm run worker
```

The worker binds `0.0.0.0:8787` and exposes two planes:

| Plane | Routes | Access |
| --- | --- | --- |
| Public | `/health`, `/ready`, `/api/{summary,config,signals,performance,quality,health}` | read-only, secret-free |
| Privileged | `/admin/*` (keys, telegram, settings, models, jobs, deliveries, alerts, logs, audit, paper, provider) | `Authorization: Bearer $VORTEX_ADMIN_TOKEN` |

If `VORTEX_ADMIN_TOKEN` is unset or shorter than 16 characters the privileged plane answers `503
configuration_required` rather than being left open. Every response passes through the redaction filter, so a
configuration mistake cannot leak a key through the API surface.

### Roles

One codebase, three process roles (`VORTEX_ROLE`, or `--role=` on the command line):

| Role | Binds a port | Schedules work | Use for |
| --- | --- | --- | --- |
| `relay` | yes | never | the public web service |
| `worker` | no | yes | the background worker |
| `all` (default) | yes | yes | local development |

```bash
npm run start:relay    # == tsx apps/worker/src/main.ts --role=relay
npm run start:worker   # == tsx apps/worker/src/main.ts --role=worker
npm run start:all      # == tsx apps/worker/src/main.ts --role=all
```

Splitting them means a redeploy of the public API cannot interrupt ingestion. Running
several workers is safe: the `vortex-scheduler` lease (`job_locks`) makes exactly one of
them the active scheduler, and the others log `standby` and write no heartbeat, so the
dashboard never shows a worker that is alive but idle. Job slots in `job_runs` still stop
any single cycle from running twice.

### Database

Migrations live in `packages/db/migrations` and are applied by the worker (`VORTEX_AUTO_MIGRATE=true`) or manually:

```bash
npm run migrate:status
npm run migrate
```

For Supabase, `npm run db:sync-supabase` mirrors the same SQL into `supabase/migrations/` so `supabase db push`
applies exactly what the tests ran against. Migration 0007 enables row-level security on every table, revokes access
from `anon`/`authenticated` and grants `SELECT` only on the `public_*` views, so the browser can read the dashboard's
views and no base table.

### Dashboard

```bash
npm run dev:web        # Vite dev server, proxies /api and /health to the relay
npm run build:web      # static bundle in apps/web/dist (portable base path)
npm run guard:bundle   # fails if the bundle contains a secret shape or a loopback API base
```

Set `VITE_RELAY_URL` when the relay is on a different origin; otherwise the bundle calls the origin it was served
from. `VITE_BASE_PATH` overrides the public base path — `./` (the default) is correct for a GitHub Pages project site
at `https://<owner>.github.io/<repo>/`.

```bash
node scripts/assert-relay-base.mjs https://<relay-host>   # fails if the built bundle calls anything else
```

## Deploying

Full runbook — Supabase, Render, GitHub Pages, provider quotas, Telegram, and the checks
that prove the system is actually running — in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

The short version:

| Piece | Host | Configured by |
| --- | --- | --- |
| Dashboard | GitHub Pages | `.github/workflows/pages.yml` + repo variable `VITE_RELAY_URL` |
| Relay + worker | Render | `render.yaml` (Blueprint) |
| Database | Supabase | `npm run migrate` against `DATABASE_URL_DIRECT` |

```bash
node scripts/generate-secrets.mjs   # prints VORTEX_SECRET_KEY + VORTEX_ADMIN_TOKEN, writes nothing to disk
```

Secrets live only in the Render dashboard and in Supabase. Nothing in this repository contains one.

## How a signal is produced

1. **Ingest** — one request per due pair, sized to the gap. Every candle is validated before it is stored; rejects are
   recorded, not silently dropped. Data freshness and gaps land in `market_data_quality`.
2. **Scan** — every 5 minutes the engine evaluates each pair, on the clock of the *upcoming* slot: indicators →
   regime → strategies → ensemble vote → hard gates (`data_quality`, `spread`, `regime_confidence`,
   `strategy_consensus`, `confidence`) → ATR-based risk plan.
3. **Publish** — signals are written before the entry boundary (60 s lead) and delivered to Telegram. A slot that is
   already claimed is skipped, so restarts, replays and duplicate workers cannot double-post.
4. **Settle** — at `entry + horizon + 8s` the outcome is computed from the entry candle's open and the exit candle's
   close, minus modelled cost. Missing data is deferred twice, then filed `UNRESOLVED` with the reason — never faked.
5. **Learn** — nightly, a class-balanced logistic model is trained and walked forward. It is promoted only if it
   beats the champion on log loss, and can be rolled back in one click.

Accuracy always says which denominator it used: draws and unresolved records are reported separately and never
counted as wins.

## Honesty rules

These are enforced in code and in tests, not just in the docs:

- A Telegram message is `SENT` only when the Bot API returns a message id. A lost response is `UNKNOWN` and is never
  retried automatically, because a duplicate post is unrecoverable.
- Signals derived from the simulated feed are never delivered unless `VORTEX_ALLOW_SYNTHETIC_SIGNALS=true` is set on
  purpose for a demo.
- Provider quota is reserved inside a transaction *before* the HTTP call; a 429 refunds the reservation and cools the
  key down instead of burning the plan.
- Worker liveness comes from the heartbeat table only. The relay answering proves the relay answered — nothing more.
- No metric is reported without the count behind it.

## Environment

See `.env.example` for the full list. The ones that matter most:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres/Supabase connection string used by the relay and the worker |
| `DATABASE_URL_DIRECT` | Direct (unpooled) connection used by `npm run migrate` |
| `VORTEX_SECRET_KEY` | 32-byte key (hex or base64) that encrypts provider keys at rest — **identical on every service** |
| `VORTEX_ADMIN_TOKEN` | Bearer token for `/admin/*`; the privileged plane is closed without it |
| `VORTEX_ROLE` | `relay`, `worker` or `all`; which half of the system this process runs |
| `VORTEX_PROVIDER` | `twelvedata` or `simulated` |
| `VORTEX_PAIRS` | Comma-separated pairs, e.g. `EUR/USD,GBP/USD` |
| `VORTEX_PROVIDER_RPM_PER_KEY` / `VORTEX_PROVIDER_RPD_PER_KEY` | Your real provider plan limits; the pool never exceeds them |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHANNEL_PRIMARY` | Delivery destination(s) |
| `VORTEX_ALLOW_SYNTHETIC_SIGNALS` | Explicit opt-in before simulated signals may be delivered |
| `VITE_RELAY_URL` / `VITE_BASE_PATH` | Build-time only, read by the static dashboard bundle |

## Status

Implemented and covered by tests: domain core, provider adapters, persistence + RLS, worker (ingestion, signals,
settlement, learning, maintenance, Telegram), relay, and the CI pipeline.

Next: the animated planetary control deck in `apps/web` (the status board is the first slice), plus backfill tooling
for long historical windows.

## Disclaimer

Research and notification software. Not financial advice, not an execution system, and no guarantee of accuracy.
Paper figures are simulations — verify independently before acting on anything.
