# Deploying VORTEX SI on Free-Tier Services

This runbook deploys VORTEX SI using **only free-tier services**:
1. **Supabase Free** for PostgreSQL persistence, quota tracking, job locks, and RLS-protected `public_*` read-only views.
2. **GitHub Actions** for scheduled ingestion, settlement, signal scanning, loss monitoring (`.github/workflows/vortex-jobs.yml`), and nightly self-learning (`.github/workflows/vortex-learning.yml`).
3. **GitHub Pages** for the static read-only status dashboard (`.github/workflows/pages.yml`).

No paid Render hosting or 24/7 VM is required.

---

## 1. Architectural notes & limitations

### How the dashboard works without a paid HTTP relay
- Migration `0007_access_control.sql` enables Row-Level Security (RLS) on every base table, revokes all base-table privileges from `PUBLIC`, `anon`, and `authenticated`, and grants `SELECT` to `anon` only on 16 secret-free `public_*` views (`public_worker_status`, `public_market_quality`, `public_provider_budget`, `public_quota_usage`, `public_overall_performance`, `public_signals`, `public_alerts`, `public_agent_status`, etc.).
- When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the public `anon` key, **never** the `service_role` key) are configured as GitHub Repository Variables, the GitHub Pages bundle queries those read-only `public_*` views directly.
- Both `apps/web/vite.config.ts` and `scripts/assert-no-secrets-in-bundle.mjs` fail the build if a `service_role` or `sb_secret_` credential is ever supplied.
- Privileged mutations (encrypting the Twelve Data API key, ingesting candles, settling trades, sending Telegram messages, training models) run exclusively inside GitHub Actions using server-only Repository Secrets (`DATABASE_URL`, `VORTEX_SECRET_KEY`, `TWELVEDATA_API_KEY`, `TELEGRAM_BOT_TOKEN`).

### GitHub Actions scheduling limits
- **Minimum cron interval**: GitHub Actions `schedule` triggers run at most every **5 minutes** (`*/5 * * * 1-5`).
- **Execution delays**: Scheduled workflows can be queued for several minutes during periods of high GitHub Actions load and are not guaranteed to fire on the exact second.
- **Minutes quota**: GitHub Free provides **2,000 Actions minutes/month** on private repositories (and unlimited standard-runner minutes on public repositories). On a private repository, running every 5 minutes (~45s/run) uses ~6,000 minutes/month; if your repository is private, change the cron in `.github/workflows/vortex-jobs.yml` to `*/15 * * * 1-5` or `*/30 * * * 1-5`.
- **Honest status & staleness**: Between scheduled runs, no worker process is running. The dashboard reports the worker as `DISCONNECTED` (`stopped / idle between scheduled runs`), displays the `lastSuccessfulJob` timestamp and age, and marks market data `STALE` once candle age exceeds `VORTEX_MAX_CANDLE_AGE_SECONDS` (90s default), which suppresses signal generation (`NO-TRADE`).

### Twelve Data Free Tier budget
- Twelve Data Free allows **8 requests/minute** and **800 requests/day** per account.
- VORTEX SI reserves **15% safety headroom** (`6 req/min`, `680 req/day` usable) in `api_quota_usage` and defaults to **2 pairs** (`EUR/USD,GBP/USD`), which consumes at most `576 requests/day` on a 5-minute schedule.
- Do **not** rotate multiple Twelve Data free keys to bypass rate limits.

---

## 2. Required GitHub Secrets and Variables

Configure these in **GitHub → Settings → Secrets and variables → Actions**.

### Repository Secrets (Server-Only — never exposed to browser)

| Secret Name | Required | Description |
|---|---|---|
| `DATABASE_URL` | **Yes** | Supabase **Session Pooler** URI (`postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`). Required because GitHub Actions runners are IPv4-only. |
| `VORTEX_SECRET_KEY` | **Yes** | 32-byte key (`node scripts/generate-secrets.mjs`) used for AES-256-GCM encryption of `TWELVEDATA_API_KEY` at rest in `provider_keys`. |
| `TWELVEDATA_API_KEY` | **Yes** (for live data) | Your Twelve Data Free API key. Automatically encrypted and upserted as `twelvedata-primary` during job runs. |
| `TELEGRAM_BOT_TOKEN` | Optional | Telegram Bot token from `@BotFather` (required only when `VORTEX_TELEGRAM_ENABLED=true`). |
| `TELEGRAM_CHANNEL_PRIMARY` | Optional | Primary Telegram chat/channel ID (e.g. `-1001234567890`). |
| `TELEGRAM_CHANNEL_SECONDARY` | Optional | Optional secondary Telegram chat/channel ID. |
| `VORTEX_ADMIN_TOKEN` | Optional | 32-byte hex token (`node scripts/generate-secrets.mjs`), needed only if you also run the optional HTTP relay. |

### Repository Variables (Non-secret configuration & public browser config)

| Variable Name | Recommended Value | Description |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Supabase project URL for the GitHub Pages dashboard to read `public_*` views. |
| `VITE_SUPABASE_ANON_KEY` | `eyJ...` or `sb_publishable_...` | Supabase **anon / public** key only (never `service_role`). Has `SELECT` access only to `public_*` views. |
| `VORTEX_PAIRS` | `EUR/USD,GBP/USD` | Comma-separated pair list (keep at 2–3 pairs on Twelve Data Free). |
| `VORTEX_PROVIDER` | `twelvedata` | Market data provider (`twelvedata` for real market data). |
| `VORTEX_TELEGRAM_ENABLED` | `false` (or `true`) | Set `true` once `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHANNEL_PRIMARY` are configured. |

---

## 3. Step-by-Step Deployment Checklist

1. **Prepare Supabase Free database (preserving existing data)**
   - In your Supabase project, go to **Connect → Connection String → URI → Session pooler** (port `5432`, IPv4 compatible) and copy the connection string as `DATABASE_URL`.
   - Never run `supabase db reset` on an existing database.
   - To inspect migration status locally before running workflows:
     ```bash
     DATABASE_URL="postgres://..." npm run migrate:status
     DATABASE_URL="postgres://..." npm run migrate
     ```
     (Both GitHub Actions workflows also run `npm run migrate:status` followed by `npm run migrate` automatically.)

2. **Generate `VORTEX_SECRET_KEY`**
   ```bash
   node scripts/generate-secrets.mjs
   ```

3. **Add GitHub Repository Secrets and Variables**
   - In your GitHub repository, open **Settings → Secrets and variables → Actions**.
   - Add the **Secrets** (`DATABASE_URL`, `VORTEX_SECRET_KEY`, `TWELVEDATA_API_KEY`, and optional `TELEGRAM_*`).
   - Add the **Variables** (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VORTEX_PAIRS=EUR/USD,GBP/USD`, `VORTEX_PROVIDER=twelvedata`).

4. **Enable GitHub Pages**
   - Open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.

5. **Trigger and verify workflows**
   - Open **Actions → Scheduled Pipeline Jobs** and click **Run workflow** (`job: cycle`) to verify database migration status, Twelve Data key encryption, candle ingestion, and health reporting.
   - Open **Actions → Deploy dashboard** and click **Run workflow** to build, scan (`npm run guard:bundle`), and publish the dashboard to GitHub Pages.

---

## 4. Deployment state (verified 2026-10-17)

Observed from CI on the default branch — both failures are **account/configuration facts, not code defects**:

- **Deploy dashboard** fails at `actions/configure-pages@v5` ("pages not enabled" class of error). GitHub Pages is not yet enabled for this repository: go to **Settings → Pages → Source → GitHub Actions**, then re-run the workflow. No workflow change can fix this from inside the repo.
- **Nightly Self-Learning** fails at its secrets/migration-status preflight step, consistent with the required repository secrets (`DATABASE_URL`, `VORTEX_SECRET_KEY`, and at least one `TWELVEDATA_API_KEY`) not being present in **Settings → Secrets and variables → Actions**. Add them per §2 and re-run.

Local verification on the unmodified tree and after the finishing pass: typecheck clean, full vitest suite green (428 tests), `guard:bundle` clean, `validate:workflows` clean, and `npm run smoke` completes 13/13 stages on the embedded PGlite + simulated provider. The hosted Supabase database itself was **not** contacted during this audit and remains unverified.
