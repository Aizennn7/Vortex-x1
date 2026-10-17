# VORTEX SI

VORTEX SI is a market-signal research, paper-settlement, and Telegram notification system for spot FX and XAU/USD on the 1-minute timeframe (5-minute horizon).

It is **not** a broker, an execution venue, or financial advice. It places no orders. "Win", "loss", and "expectancy" figures are paper settlements on 1-minute OHLC bars with spread and slippage charged on every trade; they are not realised profit.

---

## Free-tier architecture

VORTEX SI is designed to run end-to-end on **free-tier services only** without requiring paid Render hosting or a 24/7 server:

```
┌───────────────────────────┐   HTTPS (RLS public_* views   ┌─────────────────────────────┐
│  apps/web                 │   or static snapshot.json)    │  Supabase Free (Postgres)   │
│  Static React dashboard   │ ────────────────────────────▶ │  • 0001..0007 migrations    │
│  Hosted on GitHub Pages   │                               │  • RLS enabled on all tables│
│  (holds NO secrets)       │                               │  • anon reads public_* only │
└───────────────────────────┘                               └──────────────▲──────────────┘
                                                                           │
                                                            Postgres TLS (`DATABASE_URL`)
                                                                           │
┌───────────────────────────┐                               ┌──────────────┴──────────────┐
│  Twelve Data Free API     │ ◀──────────────────────────── │  GitHub Actions Jobs        │
│  • 8 req/min, 800 req/day │   Quota-reserved M1 ingest    │  • vortex-jobs.yml (*/5m)   │
├───────────────────────────┤                               │  • vortex-learning.yml (1d) │
│  Telegram Bot API         │ ◀──────────────────────────── │  • apps/worker --once       │
│  • Signal & digest alerts │   Idempotent delivery ledger  │  (holds server secrets)     │
└───────────────────────────┘                               └─────────────────────────────┘
```

| Layer | Service | Role |
|---|---|---|
| **Frontend** (`apps/web`) | **GitHub Pages** | Read-only status dashboard built by `.github/workflows/pages.yml`. Contains zero secrets. |
| **Database** (`packages/db`, `supabase/migrations`) | **Supabase Free** | Stores candles, signals, settlements, quota buckets, encrypted key pool, model versions, job locks, and heartbeats. |
| **Backend jobs** (`apps/worker`) | **GitHub Actions** | `.github/workflows/vortex-jobs.yml` runs ingestion, activation, settlement, signal evaluation, and loss/health monitoring; `.github/workflows/vortex-learning.yml` runs nightly walk-forward training and drift checks. |

### Does the architecture require a persistent HTTP relay?

**No.** In the original layout, `apps/web` fetched `/health` and `/api/*` from a persistent HTTP relay (`apps/worker/src/http.ts`), which also hosted authenticated `POST /admin/*` endpoints. Running a 24/7 HTTP relay and background worker on Render required paid hosting.

VORTEX SI eliminates the paid relay requirement **without exposing privileged credentials or adding any unauthenticated public endpoint**:

1. **Read-only dashboard data (Supabase `public_*` views or static snapshot)**:
   - Migration `0007_access_control.sql` enables Row-Level Security (RLS) on every base table, revokes all privileges on base tables and sequences from `PUBLIC`, `anon`, and `authenticated`, and grants `SELECT` only on 16 curated, secret-free `public_*` views (`public_worker_status`, `public_market_quality`, `public_provider_budget`, `public_quota_usage`, `public_overall_performance`, `public_signals`, `public_alerts`, `public_agent_status`, etc.).
   - Sensitive tables (`provider_keys` ciphertext, `audit_log`, `job_locks`) have no public view and cannot be queried with the Supabase `anon` key.
   - When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set, the GitHub Pages dashboard queries those read-only `public_*` views directly over HTTPS.
   - Alternatively, `.github/workflows/pages.yml` can export a sanitized, secret-checked `snapshot.json` at build time (`npm run snapshot:export`, `VITE_DATA_SOURCE=snapshot`).
   - The HTTP relay (`npm run start:relay`) remains available for local development or optional self-hosting.
2. **Privileged operations (key encryption, ingestion, Telegram tests)**:
   - Write operations and secret handling run strictly server-side inside GitHub Actions workflows (`vortex-jobs.yml`, `vortex-learning.yml`) or the local admin CLI (`npm run admin`), authenticated directly to Postgres via `DATABASE_URL` and `VORTEX_SECRET_KEY`.

### GitHub Actions scheduling limits & honest status reporting

GitHub Actions is a batch CI scheduler, **not a continuous 24/7 real-time daemon**:
- **Minimum cron interval**: GitHub Actions supports a minimum schedule interval of **5 minutes** (`*/5 * * * 1-5`).
- **Queue delays**: Scheduled runs can be delayed by tens of seconds to several minutes during peak GitHub load, and scheduled workflows on public repositories may be automatically disabled by GitHub after 60 days of repository inactivity.
- **Free-tier usage quotas**: GitHub Free provides 2,000 Actions minutes/month for private repositories (standard runners are free for public repositories). If running on a private repository, adjust the cron expression in `.github/workflows/vortex-jobs.yml` (for example `*/15 * * * 1-5`) to stay within 2,000 minutes/month.
- **No fake liveness**: When a one-shot job finishes, it marks its heartbeat `STOPPING` and releases the `vortex-scheduler` lease lock. Between runs, both `/api/summary` and the dashboard report the worker as **`DISCONNECTED` (`stopped / idle between scheduled runs`)**, display the exact **`lastSuccessfulJob`** timestamp and age, and recalculate candle staleness in real time (`STALE` once candle age exceeds `VORTEX_MAX_CANDLE_AGE_SECONDS`, which forces `NO-TRADE`).

---

## Repository layout

| Workspace | Purpose |
|---|---|
| `packages/core` | Config schema (`FREE_TIER_DEFAULT_PAIRS`), 28-feature vector, 5 rule strategies, Platt-calibrated logistic model, walk-forward validator, paper-trade cost model, secret redaction. |
| `packages/db` | Postgres / PGlite client, forward-only migration runner with SHA-256 drift detection (`0001`–`0007`), repositories for candles, signals, keys (AES-256-GCM), quotas, locks, jobs, health, and learning. |
| `packages/provider` | Twelve Data HTTP client and deterministic `SimulatedProvider`. |
| `apps/worker` | One-shot GitHub Actions job runner (`src/runner.ts`), admin CLI (`src/cli/admin.ts`), continuous scheduler (`src/scheduler.ts`), optional local HTTP relay (`src/http.ts`), and the shared model/learning registry summary (`src/services/registry.ts`) used by both the relay and the snapshot exporter. |
| `apps/web` | Static React status board supporting Supabase `public_*` views, static `snapshot.json`, and local relay mode. |
| `supabase/migrations` | Byte-identical mirror of `packages/db/migrations` for the Supabase CLI. |

---

## Quick start (local, zero external accounts)

Requires Node.js `>= 20.11`.

```bash
npm ci
npm run typecheck
npm test
npm run smoke
npm run build:web && npm run guard:bundle
npm run validate:workflows
```

`guard:bundle` scans the built dashboard for secret shapes and loopback API
bases; `validate:workflows` checks the GitHub Actions definitions. Neither needs
credentials or network access beyond `npm ci`.

Run a one-shot pipeline cycle locally against embedded Postgres (`PGlite`) and the deterministic simulated provider:

```bash
VORTEX_USE_EMBEDDED_DB=true \
VORTEX_PROVIDER=simulated \
VORTEX_SECRET_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
npm run job:run -- --job=all
```

---

## Twelve Data Free Tier & quota discipline

Twelve Data's Free plan provides **8 requests/minute** and **800 requests/day** for a single API key:
- VORTEX SI reserves **15% safety headroom** by default (`6 req/min`, `680 req/day` usable) in `api_quota_usage`.
- Default pair universe is conservative (`VORTEX_PAIRS=EUR/USD,GBP/USD`, 2 pairs). At 5-minute scheduled intervals across 24 hours, 2 pairs consume at most `2 × 288 = 576 requests/day`, leaving headroom for retries and verification.
- Provide a single `TWELVEDATA_API_KEY` secret; `npm run job:run` encrypts it with `VORTEX_SECRET_KEY` and synchronizes it into `provider_keys` (`twelvedata-primary`). Do **not** register multiple free keys to bypass provider rate limits.

---

## Database migrations & data preservation

Migrations (`packages/db/migrations/0001_*.sql` through `0007_*.sql`) are strictly forward-only and tracked by SHA-256 checksum in `schema_migrations`:

```bash
npm run db:diagnose      # Read-only: validate URI, DNS, connection and migration status
npm run migrate:status   # Read-only: applied vs pending + checksum drift (never creates tables)
npm run migrate          # Apply pending migrations in a transaction (never drops data)
npm run migrate -- --dry-run  # Show what would be applied; writes nothing
```

### Database connection (Supabase Session Pooler)

`DATABASE_URL` must be the Supabase **Session Pooler** URI:

```
postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
```

- `<pooler-host>` is `aws-<index>-<region>.pooler.supabase.com`. Copy it from
  **Connect → Connection string → Session pooler** — the index and region cannot
  be derived from the project ref.
- The username is `postgres.<project-ref>` (plain `postgres` only works on the
  direct host). Port `5432` is session mode; port `6543` (transaction pooler) is
  rejected because the worker uses session-level advisory locks and
  multi-statement transactions.
- The Free-plan direct endpoint (`db.<project-ref>.supabase.co`) is IPv6-only
  and is rejected on GitHub Actions (`direct-ipv6`) unless
  `VORTEX_DB_ALLOW_DIRECT_CONNECTION=true` and the runner has IPv6.
- `DATABASE_URL` is authoritative. `DATABASE_URL_DIRECT` is only a fallback when
  `DATABASE_URL` is empty; an invalid optional secret can no longer override a
  working pooler secret. Values are validated before `pg` sees them, so a
  relative/empty/placeholder value fails with a precise configuration error
  instead of `getaddrinfo EAI_AGAIN base` (pg-connection-string's internal
  `postgres://base` fallback).
- `npm run db:diagnose` and `npm run migrate:status` never apply migrations,
  create tables, or change data/policies.

- Never run `supabase db reset` against an existing database.
- Both `.github/workflows/vortex-jobs.yml` and `.github/workflows/vortex-learning.yml` run `npm run migrate:status` before `npm run migrate`.
- `.github/workflows/database-diagnostic.yml` is a manual, strictly read-only check.

---

## Deployment

See **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)** for the complete free-tier deployment guide, exact GitHub Secrets & Variables table, and step-by-step checklist.

## How predictions are produced and evaluated

See **[`docs/PREDICTION_AND_LEARNING.md`](docs/PREDICTION_AND_LEARNING.md)** for the
feature definitions, data-quality classes (including the `FUTURE_DATA` guard),
the settlement rule version, the evaluation methodology (chronological splits
with a horizon-length embargo, honest holdouts, walk-forward folds) and the model
promotion/rollback gates.
