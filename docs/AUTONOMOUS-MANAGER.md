# VORTEX Autonomous Manager

## Purpose

The built-in root-level AI Operator is the control-room interface for VORTEX. The manager is responsible for observing the platform, coordinating the existing scheduled pipeline, explaining decisions, and recommending bounded recovery steps. It must not invent market data or bypass the prediction engine's quality and promotion gates.

This document is the operating contract for the manager. It does not claim that every action described here is already implemented.

## Existing automated components

VORTEX already provides these separate worker jobs:

- **Every five minutes during configured FX sessions:** scheduled pipeline runs ingestion, activation, settlement, signal generation, and maintenance. GitHub Actions cron can be delayed; it is not a guaranteed real-time execution service.
- **Nightly:** the learning workflow evaluates resolved outcomes, creates a candidate only when data is eligible, uses chronological walk-forward evaluation and a holdout, and promotes only when all configured gates pass.
- **Maintenance:** reconciles health, monitors stale workers, provider quality/quota, and alerts.
- **Dashboard:** displays measured state from public read views or the configured relay. GitHub Pages is static and cannot securely host database credentials or run a persistent model server.

## Manager control loop

The intended manager loop is observe → diagnose → propose → authorize → execute → verify → record.

1. **Observe:** read health, latest job outcomes, feed freshness, signal/settlement counts, learning-run status, champion/candidate metrics, drift, and provider budget through authenticated server-side APIs.
2. **Diagnose:** classify each condition as healthy, degraded, blocked by configuration, stale, or unknown. Unknown is never treated as healthy.
3. **Plan:** choose only a documented action from a fixed allowlist. Prefer no-op or safe recovery over repeated retries.
4. **Authorize:** status reads and recommendations may be automatic. Workflow dispatch, configuration changes, model overrides, provider-key changes, and any order placement require explicit authorization and audit logging.
5. **Execute:** invoke existing idempotent jobs through authenticated server-side handlers; never execute model-generated shell, SQL, URLs, or arbitrary code.
6. **Verify:** reread state after the action and confirm the intended effect. A successful HTTP response alone is not proof that a job completed.
7. **Record:** persist the observation, decision, action, actor/authorization, result, and failure reason without recording secrets.

## Automatic learning and prediction updates

The learning worker remains the only component allowed to propose and promote model versions. The manager may schedule or monitor a learning run, but it cannot relax training thresholds.

- Only resolved, verified outcomes at the configured prediction horizon enter the training dataset.
- Dataset audits, chronological splits, horizon embargo, walk-forward folds, holdout evaluation, and baseline comparisons remain mandatory.
- A candidate is promoted only if every configured promotion gate passes. Otherwise, keep the existing champion and record why.
- Drift triggers an alert and an evaluation request, not an unconditional model swap.
- Keep candidate, champion, previous champion, metrics, dataset checksum, and promotion decision auditable and rollback-capable.
- If the dataset has not changed or there are too few valid samples, record a skipped run instead of fabricating training data.

## Trading and risk modes

The manager must expose a visible operating mode:

1. **Observe-only (default):** inspect state and provide recommendations; no order execution.
2. **Paper trading:** simulate orders against verified prices and realistic spread/slippage; persist every order, fill, rejection, and outcome. Enforce max position, per-trade risk, daily loss, drawdown, stale-feed, and duplicate-order limits.
3. **Live trading (disabled by default):** not available until a broker adapter is reviewed, account-specific limits and kill switch are implemented, credentials are server-only, idempotent order handling and reconciliation are tested, and the account owner explicitly enables it. Never enable live trading from a model-generated instruction.

Any feed that is stale, gappy, simulated when live data is required, or otherwise fails quality gates must produce NO-TRADE. An unavailable risk/account state must also fail closed.

## Security boundaries

- Never ship provider credentials, database credentials, admin tokens, or broker credentials in the dashboard bundle or browser storage.
- Keep privileged actions on the server, authenticated, rate-limited, allowlisted, and audited.
- MCP/plugin endpoints must be configured server-side; do not accept arbitrary endpoints or tool schemas from the browser.
- Do not expose shell execution, arbitrary SQL, arbitrary HTTP fetches, unrestricted filesystem access, or unrestricted GitHub writes to the model.
- Require a human confirmation for consequential operations. Model text is untrusted input, not executable policy.
- Keep the AI Operator built into the dashboard root/navigation; its absence of backend connectivity must be shown as disconnected, not silently treated as operational.

## Acceptance checklist

- [ ] Root dashboard and every workspace show the same built-in Operator entry.
- [ ] Operator obtains diagnostics through authenticated, server-side allowlisted tools.
- [ ] Read-only diagnosis works without exposing secret inventory.
- [ ] Job dispatch requires authorization, is idempotent, and is audited.
- [ ] Operator verifies job completion by reading persisted job status.
- [ ] Paper ledger and risk gates are tested against duplicate, stale-feed, loss-limit, and unavailable-account scenarios.
- [ ] Learning uses only verified resolved outcomes; promotion gates cannot be lowered by the model.
- [ ] Drift produces an alert/re-evaluation request, not an automatic blind promotion.
- [ ] Live order execution remains disabled unless separately authorized and tested.
- [ ] CI, migrations, and deployment pass before claiming production readiness.

## Operational truth

A scheduled workflow can be queued, delayed, or fail because GitHub Actions, database migrations, credentials, or provider quota are unavailable. The manager must surface the actual last successful run and exact failure state. It must never claim continuous operation merely because a schedule exists.
