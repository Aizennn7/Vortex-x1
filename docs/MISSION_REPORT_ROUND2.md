# VORTEX SI — autonomous mission report (round 2)

Branch `arena/fd26ee8d-vortex-x1` · base `main` @ `dac1747` · head `74541f5`
PR #5 — OPEN, MERGEABLE, CI green (`39002954050`)

---

## 1. Trading engine

**Is the 1-minute figure a prediction horizon, or the data cadence?** It is the
prediction horizon. `signalHorizonSeconds = 60` sets how long a published signal
is exposed (`scheduledEntryAt → horizonEnd`); data cadence is
`scanCadenceMinutes = 5` and candle granularity is M1. The scheduler publishes
`publishLeadSeconds` (60 s) before entry and refuses any slot whose publish
instant is under 15 s away. I verified those three numbers independently in
`config.ts`, `planNextSlot`/`publishability`, and the settlement path — they are
not conflated anywhere.

### Every NO_TRADE cause, classified

I instrumented the real evaluation path (real `normalizeBatch` → `onlyFinal` →
`aggregate` → `detectRegime` → `evaluatePrediction`) over 576 pair-slots of the
simulated feed:

| outcome | count |
| --- | --- |
| BUY / SELL (published) | 282 / 170 |
| NO_TRADE | 124 (21.5 %) |
| — failed gate `confidence` + `abstained` | 124 |
| — failed gate `strategy_consensus` | 24 (subset) |

Regime mix: TREND_UP 210, RANGE 142, TREND_DOWN 116, QUIET 80, VOLATILE 28.

Classification of the causes found:

* **Correct risk rejection** — the confidence/consensus rejections above. The
  ensemble is meant to abstain when strategies disagree; 21.5 % abstention on a
  structureless feed is the expected signature of a working gate, not a fault.
* **Insufficient / stale data** — real defect, fixed (see below): coverage loss
  was invisible.
* **Provider-infra failure** — already classified and alerted (prior round);
  re-verified: an all-fetch-failed cycle records `FAILED`, not `SUCCEEDED`.
* **Invalid model output** — rejected by the model service with a reason and a
  fallback to the ensemble-only path (prior round, still covered by tests).
* **Bad feature calc** — two real defects, fixed: flat-market RSI returned 100;
  `safeDiv` let a NaN numerator propagate.
* **Overly restrictive threshold** — evaluated, **not** changed. `minConfidence
  0.62` rejects 21.5 % on synthetic data; loosening a risk gate on a random walk
  would be tuning to noise. No threshold, gate or promotion criterion was
  weakened anywhere in this round.
* **Unsupported instrument / horizon** — `instrumentMeta` covers pip size,
  digits and tier for FX and metals; unknown pairs fall back safely rather than
  throwing.
* **Genuine no opportunity** — now visible as its own dashboard verdict.

### Two defects that made "no trade" lie

1. **Coverage loss was invisible.** Gap detection ran on one fetched batch, and
   every provider batch is internally contiguous, so `written.gaps` was always
   empty: the `DEGRADED` branch was unreachable and `gapsDetected` stayed at 0
   through real outages. Ingestion now compares stored candles against the
   window it just fetched (`countGaps`). Test: a second batch covering only the
   tail produces `gapsDetected > 0`, `status = DEGRADED`, non-zero `gap_count`.
2. **NO-TRADE was indistinguishable from an outage.** The job `detail` (gate
   reasons) never reached the API. `GET /api/summary` now carries a `scan`
   block: evaluated / published / blocked, the NO-TRADE flag, the closest miss
   with its failed gate names, and the job's own notes — rendered in a dedicated
   card, with `NO_DATA` (nothing to evaluate) kept distinct from `NO_TRADE`
   (candidates judged and rejected).

### Data-integrity checks

* **Timestamps / TZ** — all boundaries are UTC ms; `lastClosedBoundary` derives
  expected candle opens; settlement requires the candle whose open *equals* the
  scheduled entry, so a late or shifted candle cannot be used as a fill.
* **No look-ahead** — `onlyFinal` drops the in-progress bar; the settlement
  window starts at the entry instant; learning embargo is ≥ the configured
  horizon (test pins a 3600 s row and a 60 s horizon).
* **Duplicates / revisions** — deduped on `(pair, timeframe, open_time)`; an
  upsert only advances on a newer revision (DB layer, untouched).
* **Gaps** — now measured across batches (fix 1).
* **Stale quotes / spreads** — `freshness` + `maxCandleAgeSeconds = 90` and
  `maxSpreadPips = 2.5`; the simulated provider labels spreads
  `spreadSource: 'modelled'` and the UI says "not live market data".
* **Precision** — pip size is per instrument (0.0001 / 0.01), and prices are
  rounded with `roundPrice` before storage and comparison.
* **Feature alignment** — features are computed from the same closed-candle
  window that produced the decision; `FEATURE_SET_VERSION` is stamped with the
  model; short-horizon rows are excluded from training.

### Indicators verified against independent fixtures

There was **no direct indicator test file** — indicators were only exercised
through the engine. Added `packages/core/tests/indicators.test.ts` (25
assertions) with hand-computed values rather than the implementation's own
output: SMA/EMA/stdev/Bollinger/Donchian/true-range, forced identities (all
gains ⇒ RSI 100, all losses ⇒ 0, flat ⇒ 50), ADX = 100 on a clean trend and 0
on a flat market, `histogram = macd − signal`, and the `slope` contract
(mean-normalised fractional change per bar, identical for a 1.1-priced and a
151-priced series). Writing them caught two of my own arithmetic errors and one
real bug: `safeDiv` returned NaN for a NaN numerator.

---

## 2. Does a ~90 % success-probability setup exist?

**No — and this codebase never claims one.** `confidence` is the ensemble's
ranking score; the UI and `docs/PREDICTION_AND_LEARNING.md` both say so, and no
code path labels it a win probability. I then tested the stronger hypothesis
empirically.

Experiment: 1,276 decisions from the simulated feed, each settled through the
real settlement path (stop 10 / target 14 pips, 0.8 spread, 0.2 slippage, 60 s
horizon). Synthetic data cannot prove anything about markets — it can prove
whether the *metric* behaves like a probability.

| confidence band | n | observed win rate | mean confidence |
| --- | --- | --- | --- |
| 0.6 – 0.7 | 419 | 0.480 | 0.665 |
| 0.7 – 0.8 | 521 | 0.405 | 0.746 |
| 0.8 – 0.9 | 288 | 0.497 | 0.835 |
| 0.9 – 1.0 | 28 | 0.643 | 0.930 |

* Decisive settlements: 1,256; unresolved 0. **Base rate 45.6 %.**
* Confidence ≥ 0.80: n = 316, win rate **50.9 %**, Wilson 95 % **CI [45.5 %, 56.4 %]**.
* Treated as a probability: mean 0.744 vs base rate 0.456 → **ECE 0.287**,
  log loss 0.899, Brier 0.335 against a constant-base-rate baseline of 0.248.
  It is *worse* than always predicting the base rate.
* Mean net result per trade: **−0.52 pips** after modelled costs.

Interpretation, with its limits stated: confidence is monotone in strategy
agreement, not in outcome frequency; on a structureless feed no band approaches
90 %, and the CI on the most confident band excludes 90 % by a wide margin.
A 90 % claim would need a lower CI bound above 0.9 — at n = 28 that requires
roughly 26/28 wins, which this data does not show. This is **not** evidence that
no 90 % setup exists in live markets; it is evidence that this system does not
have one, does not claim one, and that its confidence must not be read as a
probability. Selection, repeated testing, class imbalance and overlapping
outcomes all push the other way, so the honest answer is "not established".

---

## 3. Self-learning engine

Audited end-to-end; the safeguards hold.

* **Chronological splits** with a **full-horizon embargo**; the final slice is
  an untouched holdout and a candidate trained on it is refused.
* **Deterministic dataset** with a checksum; feature version is part of the
  shortcut key (`horizon + feature version + config`), so an incompatible run
  cannot be reused.
* **Fail closed** on missing or malformed evidence: a missing baseline is a
  failure, not a pass. Promotion still requires the configured minimum sample
  size, evaluation size, balanced accuracy, AUC, baseline skill, log-loss
  regression, walk-forward folds and calibration — none were weakened.
* **Drift never auto-promotes or rolls back**; it reports.
* **Failures are diagnosable and retryable** — stale runs are recovered on
  boot, and a skipped run carries its reason ("dataset audit failed: only 0
  labelled samples (need 200)"), visible in the dashboard.
* **Calibration denominators** were made honest this round: `count` is decisive
  rows, `sampleSize` is all rows, and `observedWinRate` is `null` instead of 0
  for a bin with no decisive outcome — an empty high-confidence bin can no
  longer read as "wins 0 % of the time".
* **Lineage** (dataset checksum, row counts, split windows, decisions) is
  preserved with the model version.

---

## 4. Cleanup (conservative, verified)

* Removed `build:core` from the root scripts: it ran `npm run build -w
  @vortex/core`, but `@vortex/core` defines no `build` script, so it could only
  ever fail. Checked first — no workflow, doc, script or import referenced it;
  the root `build` already uses `--if-present`.
* Removed a duplicate `configured:` key in the snapshot exporter's
  no-database branch (TS1117), found by compiling the script.
* `.env.example` contains placeholders only; no key, token or connection string
  is present, and `guard:bundle` confirms nothing secret reaches the bundle.
* **Nothing was deleted on suspicion.** `countGaps` is still exported by
  `packages/db` even though ingestion no longer imports it — that package is
  frozen and untouched by design.

---

## 5. Web testing — a browser was actually launched

Headless **Chromium 131.0.6778.0** (`@sparticuz/chromium` + `puppeteer-core`,
outside the repo) driving the **live Vite dev server** against the **live
relay** with an embedded database and the simulated feed on a pinned weekday
clock. Nothing was mocked in the browser.

| check | result |
| --- | --- |
| desktop load (1440 px) | HTTP 200, 11 cards, **0 console errors, 0 page errors, 0 failed requests** |
| Opportunity scan card | badge `NO TRADE`; 4 evaluated, 0 published, 4 blocked; closest miss `USD/CHF (confidence,abstained)` |
| manual Refresh | 4 → 8 API requests (control works) |
| request volume | **4 requests in 12 s** (was hundreds/minute — see §6) |
| accessibility | 1 × h1, 11 × h2, 11/11 cards labelled, 1 live region, `lang=en`, no image without alt |
| responsive 820 / 390 / 320 px | no horizontal overflow at any width |
| relay unreachable | explicit failure copy per panel + "showing the last successful reading" banner |
| malformed JSON (`{"ok":true,"data":`) | graceful message, **0 page errors** |
| malformed `scan` block | "No completed scan is recorded yet" — no fabricated zero row |

Two defects were found *by* this pass and fixed: the request storm, and the scan
card claiming "every candidate failed a gate" when zero candidates existed.

---

## 6. Verification — exact commands and counts

Run after the final change (`74541f5`):

```
npm run typecheck                                   # all workspaces, clean
npx vitest run                                      # 20 files, 416 tests passed
npm run build:web                                   # built in 0.9 s
npm run guard:bundle                                # no secrets, no loopback bases
npm run validate:workflows                          # 4 workflows, all checks passed
VORTEX_PROVIDER=simulated npm run smoke             # 13/13 stages ok
VORTEX_USE_EMBEDDED_DB=true … npm run job:run -- --job=all
                                                    # ingest, activation, settle,
                                                    # signal_cycle, learning, maintenance
gh run watch 39002954050 --exit-status              # CI green on 74541f5
```

Additional live checks: five malformed query URLs → `400 invalid_request`
(no DB text); `?limit=999999` → 200; `/health`, `/ready`, `/api/config` → 200;
`/admin/status` without a token → 503 `configuration_required` (correct);
unknown route → 404.

**No lint/format script exists in this repository** (verified against
`package.json`), so there is no lint stage to report; formatting is not enforced
by tooling here.

---

## 7. Database-freeze audit

* `git diff --name-only dac1747..HEAD | grep -cE "^(supabase/|packages/db/|.*\.sql$)"` → **0**.
* No migration, schema, policy, seed, bootstrap or `db:sync-supabase` command was
  run. No hosted database was contacted; every run used PGlite embedded in the
  test/preview process.
* All database inspection was read-only. The only writes were inside
  throw-away embedded databases in tests and the preview harness.
* No live trades, orders or fund transfers were placed; the paper ledger is
  simulated and labelled as such everywhere.

---

## 8. Git state

* Branch `arena/fd26ee8d-vortex-x1`, head **`74541f5`**, pushed
  (`a9c91ff..74541f5`), working tree **clean**.
* 21 commits since `dac1747`; 37 files, **+5086 / −367**.
* PR #5 updated with the round-2 summary; **not merged** (never self-merge).
* `git status --short` empty; `git diff --check` clean; no destructive git
  command was used and no unrelated files were touched.

---

## 9. Remaining risks

1. **No live-market evidence.** Every number above comes from a deterministic
   simulated feed. Nothing here demonstrates edge in real markets, and the
   negative expectancy on a cost-charged random walk is a reminder that the cost
   model, not just the signal, decides profitability.
2. **Regime coverage.** `detectRegime` needs ≥ 60 M1 candles; the simulator
   supplies them, but a real provider returning fewer would yield `UNKNOWN` and
   a default weight set. Worth a guard that refuses to publish on `UNKNOWN`.
3. **Timeout / rate-limit telemetry.** The relay warns on requests > 2 s and
   rate-limits per IP, but there is no counter exported for either, so the
   dashboard cannot show backpressure history.
4. **Calibration sample size.** The learning path never promotes without the
   configured minimums, but the calibration table itself is descriptive — a
   reader could over-read a wide bin. The UI does not currently render it.
5. **Browser matrix.** Verified in Chromium only. No Firefox/WebKit pass was
   possible in this sandbox (only PyPI/npm egress, no browser distribution
   downloads).
6. **Embedded-DB divergence.** Tests run on PGlite; Postgres-specific behaviour
   (planner, pooler latency) is not exercised. The SQL is standard, but this is
   untested territory.

---

## 10. Single highest-value next action

**Run the engine against real, read-only market history for a fixed period and
record calibration on it.** Everything about the 90 % question is currently
unanswerable with synthetic data. Pulling a few months of M1 history from the
free provider tier into an offline fixture, replaying the exact decision path
over it with costs, and reporting reliability, base rate and CI per confidence
band would settle whether the ensemble has any edge — and would give the
learning engine a dataset worth training on. Until then, the honest headline
remains: the pipeline is now observable and correct, its confidence is not a
probability, and no 90 % setup has been demonstrated.
