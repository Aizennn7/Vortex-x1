# Prediction, evaluation and controlled learning

This document describes what the engine actually computes, how it is evaluated,
and which limits apply. It deliberately separates **measured facts** from
**assumptions**.

> VORTEX SI is a research and notification system. It places no orders, it is
> not financial advice, and paper results are simulations.

---

## 1. Data path

```
Twelve Data / SimulatedProvider
        │  (raw candles, validated per row)
        ▼
normalizeBatch ─ validateCandle ─ mergeCandles ─ aggregate(M3)
        │
        ▼
freshness()      → OK | STALE | GAPPY | INSUFFICIENT | FUTURE_DATA
        │
        ▼
detectRegime()   → TREND_UP | TREND_DOWN | RANGE | VOLATILE | QUIET | UNKNOWN
        │
        ▼
runStrategies()  → per-strategy votes (direction, strength, reasons, warnings)
        │
        ▼
combineVotes()   → weighted direction score + agreement
        │
        ▼
evaluatePrediction() → decision, confidence, gates, model probability
        │
        ▼
insertSignal()   → immutable record (features, context, engine version, gates)
        │
        ▼
settleSignal()   → WIN | LOSS | DRAW | UNRESOLVED, net of spread + slippage
        │
        ▼
learning cycle   → dataset → holdout metrics → promotion decision
```

### Candle validation rules

* `isFinal` must be true: the in-progress bar is never used, because the
  provider re-issues it and acting on it leaks partial-bar information.
* OHLC must be finite, strictly positive and self-consistent
  (`low ≤ min(open, close) ≤ max(open, close) ≤ high`).
* `openTime` must be aligned to the timeframe boundary; `closeTime` is derived.
* Batch duplicates collapse to the highest `revision`; gaps are **reported, never
  interpolated**.
* `TwelveDataProvider.fetchTimeSeries()` drops malformed rows before they can be
  stored; a response with no usable rows yields an empty series, not an error,
  but an unparseable body or a `status: "error"` payload is raised as a
  `ProviderError`.

### Freshness classes

| Class | Meaning | Effect |
|---|---|---|
| `OK` | newest final candle is inside `VORTEX_MAX_CANDLE_AGE_SECONDS`, no recent gaps | eligible for signals |
| `STALE` | candle age above the limit | **NO-TRADE** |
| `GAPPY` | a candle is missing inside the recent 20-bar window | **NO-TRADE** |
| `INSUFFICIENT` | fewer than the minimum candles stored | **NO-TRADE** |
| `FUTURE_DATA` | the newest candle closes in the future (clock skew, or a provider leaking a partial bar) | **NO-TRADE** |

Age is measured from the candle **close** time, so a normal one-minute publish
delay is not reported as staleness.

---

## 2. Prediction outputs (and what they are not)

| Field | Definition | Important caveat |
|---|---|---|
| `decision` | `BUY`, `SELL` or `NO_TRADE` | `NO_TRADE` is a recorded decision with the failed gate names, not an error |
| `confidence` | 0–1 ranking score from vote strength × consensus × regime certainty × magnitude | **not** a probability and **not** a win expectation |
| `modelProbability` | calibrated logistic probability for the ensemble direction, when a champion model is loaded | `null` when no model has been promoted |
| `modelVersionId` | registry id of the model that produced the probability | keeps every signal reproducible after rollbacks |
| `stopPips` / `targetPips` / `rewardRisk` | ATR-derived risk plan | risk management, computed independently of the prediction |
| `reasons` / `warnings` | human-readable rationale and machine flags | `synthetic_data_feed` marks simulated input |

Abstention is explicit: the engine returns `NO_TRADE` when the data-quality,
spread, regime-confidence or strategy-consensus gates fail, when the ensemble has
no directional consensus, when confidence is below `VORTEX_MIN_CONFIDENCE`, or
when the model disagrees strongly enough to drag confidence under the threshold.

### Feature vector (22 values, `packages/core/src/features.ts`)

`bias`, `confidence`, `rsi`, `adx`, `emaFastVsSlow`, `emaVsTrend`,
`macdHistNorm`, `atrPercentile`, `bbWidthPercentile`, `agreement`, `spreadNorm`,
five regime one-hots, four session one-hots, `regimeConfidence`, `m3Agreement`.

Features are computed **only** from candles that had already closed at decision
time, and the exact vector is persisted with the signal, so an offline dataset
can be rebuilt without re-running the indicators.

`atrNorm` and the MACD normalisation are documented approximations, not
industry-standard formulae: they exist to keep inputs bounded, not to make a
claim about their statistical power.

---

## 3. Settlement rules — `net_after_costs_v1`

See the header of `packages/core/src/outcome.ts` for the authoritative list.
Summary:

1. Entry price = **open** of the M1 candle at the scheduled entry (a late entry
   within the grace window is flagged `entry_price_late`).
2. Exit price = **close** of the candle whose close equals the horizon end. It is
   never interpolated; a missing candle yields `UNRESOLVED`.
3. `realizedPips = direction × (exit − entry) / pipSize − (spread + slippage)`.
   Costs are always charged, including on wins.
4. MFE/MAE come from the highs/lows inside the window; a stop hit is assumed to
   occur before the objective when both are touched.
5. `UNRESOLVED` is recorded when the prices cannot be verified, and it stays in
   the cohort denominator — it never becomes a win.
6. Settlement is idempotent: every input is an immutable stored candle, and
   `applySettlement` only updates rows whose outcome is still null.

Records carrying `entry_price_late`, `exit_price_early`, `missing_entry_candle`,
`missing_exit_candle`, `invalid_price`, `too_early` or
`exit_price_far_from_horizon` are excluded from training labels and counted in
`dataset.exclusions`. A record whose `horizon_seconds` differs from the
configured horizon (or cannot be verified) is counted as `horizonMismatch`:
a 60-second label and a one-hour label are different targets and are never
pooled into one dataset.

---

## 4. Evaluation methodology

* **Splits are chronological** with an embargo of one full prediction horizon.
  The dataset is filtered to `VORTEX_SIGNAL_HORIZON_SECONDS` first, so that
  configuration is authoritative; a row excluded for a mismatched horizon
  cannot inflate the window for the rows that remain. The embargo is anchored
  to the last **retained** row of the previous block, so dropping a row can
  never shorten the gap.
* **The candidate is fitted on the training block only.** There is no fallback
  that trains on the full dataset; an undersized training block aborts the run.
* **Holdout reporting is explicit.** Metrics come from the test block, or from
  the validation block when the test block is smaller than the minimum holdout
  size. The chosen set is recorded on the model version.
* **Walk-forward folds** expand chronologically; each fold reports its training
  cutoff, the validation window, and how many rows the embargo removed.
* **Baselines**: the no-skill reference is the constant base-rate predictor
  measured on the same holdout rows. Its log loss is the entropy of the class
  balance (`ln 2` at 50/50), so it cannot be beaten by simply learning the
  majority class. It is stored next to the candidate and is **required** for
  promotion.
* Reported metrics: accuracy, balanced accuracy, Matthews correlation,
  precision/recall/F1, confusion matrix, AUC, log loss, Brier score, expected
  calibration error (10 bins), plus the probability distribution of the
  holdout.

### Promotion gates

A candidate is promoted **only** when every check passes
(`decidePromotion` / `DEFAULT_PROMOTION_CRITERIA`):

| Gate | Default | Purpose |
|---|---|---|
| `sample_size` | ≥ `VORTEX_TRAIN_MIN_SAMPLES` | enough labelled rows |
| `evaluation_size` | ≥ 40 holdout rows | no decisions from a handful of rows |
| `accuracy` | ≥ `VORTEX_MODEL_PROMOTION_MIN_ACCURACY` | better than the floor |
| `balanced_accuracy` | strictly > 0.5 (chance) | a majority-class-only model cannot pass |
| `baseline_skill` | holdout log loss **<** base-rate baseline on the same rows | measured skill, not just accuracy; a missing baseline refuses promotion |
| `auc` | ≥ `VORTEX_MODEL_PROMOTION_MIN_AUC` | ranking quality |
| `class_balance` | win rate inside 5–95% | rejects degenerate data |
| `calibration` | ECE ≤ 0.15 | probabilities must be meaningful |
| `walk_forward` | ≥ 3 folds, 70% above the accuracy floor | stability over time |
| `log_loss_regression` | ≤ `VORTEX_MODEL_MAX_LOG_LOSS_REGRESSION` vs champion | no silent degradation |
| `champion_accuracy` | not more than 1pp below the champion | protects the incumbent |

Failure keeps the current champion and stores the failed gate names on the
candidate. Promotion and rollback are single transactional statements, and the
previous champion is archived rather than deleted.

### Guarded retraining

`shouldRetrain` compares the dataset checksum with the previous **successful**
run. The checksum covers the learning version, the feature-set version, the
feature names, the prediction horizon and every sample, so a changed target,
feature representation or row population is never mistaken for "nothing has
changed". An unchanged dataset is recorded as a `SKIPPED` learning run with a reason
instead of being refitted, so a nightly schedule costs nothing when no new
outcomes exist. Failed runs are always retryable. The worker derives its
minimum holdout gate from `DEFAULT_PROMOTION_CRITERIA` (40 rows) and has no
setting that can lower it.

### Known evaluation limits

* Thresholds are configured, not optimised on the evaluation set. There is no
  hyper-parameter search that could overfit the holdout.
* Costs are modelled as `spread + slippage` per trade; broker margin, swap and
  financing costs are not modelled.
* Regime labels come from the same indicator family as the features, so
  "performance by regime" is descriptive, not independent.
* Synthetic fixtures are labelled as synthetic everywhere. The end-to-end
  learning test uses a perfectly separable synthetic pattern to exercise the
  gates; it is **not** evidence of predictive skill.
* `NO_TRADE` evaluations are not persisted as rows (only the last cycle's
  blocked-gate summary is kept in the job detail), so coverage and historical
  abstention rate cannot be measured from the database. Persisting them would
  be a schema change and is deliberately out of scope for this mission.
* Promotion metrics are out-of-sample for the evaluated window; they are not a
  forecast of future profitability and do not establish that a champion will
  keep its edge.

---

## 5. Provider reliability and quota discipline

* Quota is reserved **before** the HTTP call (`reserveQuota`), so concurrent
  workers cannot overspend the plan.
* Failures are classified: 429/quota → rotate with exponential cooldown and
  refund of the unused reservation; 401/403 → key marked `INVALID`; 404/400/422 →
  request error, no rotation; 5xx/408/timeout → bounded retry with backoff.
* Retries are bounded by `VORTEX_PROVIDER_MAX_ATTEMPTS`. The pool never loops
  indefinitely: each eligible key is tried once per call.
* `exhausted` means **capacity**, not error: no keys, all cooling down, or quota
  spent. A request that failed on the wire with budget still available is
  reported as a normal failure (`no_alternative_key`), so a provider outage can
  never be recorded as deliberate degradation.
* Multiple keys belonging to one account share that account's quota; rotation is
  not a way around plan limits, and the pool debits an account-level cap as well
  as a per-key cap.
* API keys are masked (`••••1234`) and never logged, and the request URL reported
  to observers has `apikey=[redacted]`.
* GitHub Actions runs are one-shot: the worker never claims 24/7 liveness. When
  no run is active, the dashboard shows `DISCONNECTED` with the age of the last
  successful job.

---

## 6. Configuration reference (names only — never commit values)

| Variable | Purpose |
|---|---|
| `VORTEX_PROVIDER` | `twelvedata` or `simulated` |
| `TWELVEDATA_API_KEY[_2..4]` | server-only provider keys |
| `VORTEX_PROVIDER_RPM_PER_KEY`, `VORTEX_PROVIDER_RPD_PER_KEY`, `VORTEX_PROVIDER_HEADROOM_PERCENT` | quota accounting |
| `VORTEX_PROVIDER_TIMEOUT_MS`, `VORTEX_PROVIDER_MAX_ATTEMPTS` | bounded retries |
| `VORTEX_MAX_CANDLE_AGE_SECONDS` | freshness limit (feeds the NO-TRADE gate) |
| `VORTEX_PAIRS` | enabled instrument universe |
| `VORTEX_SIGNAL_HORIZON_SECONDS` | prediction horizon (also the fallback embargo) |
| `VORTEX_MIN_CONFIDENCE` | abstention threshold |
| `VORTEX_TRAIN_MIN_SAMPLES` | minimum labelled rows for training |
| `VORTEX_MODEL_PROMOTION_MIN_ACCURACY`, `VORTEX_MODEL_PROMOTION_MIN_AUC`, `VORTEX_MODEL_MAX_LOG_LOSS_REGRESSION` | promotion gates |
| `VORTEX_LEARNING_ENABLED` | enables the scheduled learning job |
| `VORTEX_ARTIFACT_DIR` | where model artifacts are written |
| `VORTEX_SECRET_KEY` | AES-256-GCM key for provider keys at rest (server-only) |

---

## 7. Current limitations (verified, not hypothetical)

* **Database initialisation is out of scope for this work.** The application
  code, migrations and dashboard are written against the documented schema, but
  a Supabase project whose tables have not been created will answer the dashboard
  with a `setup-required` state. That state is honest: no data is invented, and
  nothing claims success.
* No live provider key is required to run any test in this repository: every
  provider test uses a mocked `fetch`, and every pipeline test uses the embedded
  database plus the deterministic simulated feed.
* The dashboard reads only the secret-free `public_*` views. When those views
  are absent, the corresponding panels report unavailability instead of zeros.
* There is no evidence of out-of-sample predictive skill for the rule ensemble
  or for any candidate model in this repository. Nothing here should be read as
  a performance claim.
