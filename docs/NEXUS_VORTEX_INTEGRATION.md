# NEXUS → VORTEX integration plan

**Status:** one consolidated integration PR. All code changes for this integration are kept in this PR; this does not claim hosted services are live or that NEXUS's separate backend has been deployed.

## Decision

Use **VORTEX SI as the canonical runtime and data model** and selectively port the best NEXUS presentation and research ideas. Do not paste NEXUS's 533 KB single-file browser application into VORTEX or run two prediction engines side by side. The projects have different architectures, data schemas, timeframes, and operating assumptions.

- VORTEX: TypeScript workspaces, scheduled GitHub Actions jobs, Postgres/Supabase migrations, a read-only React dashboard, M1 candles and a 5-minute signal horizon.
- NEXUS: single-file browser UI and strategy engine, M1/M3 signal streams, authenticated API relay, separate worker/trainer and Supabase schema.

NEXUS is currently readable through the connected GitHub integration but reports no push permission. This integration therefore makes changes in VORTEX only; it does not modify the NEXUS repository.

## Scope of this single PR

- Apply NEXUS's midnight-ocean Liquid Glass visual direction to VORTEX's existing React dashboard, including responsive surfaces, keyboard focus, and reduced-motion support.
- Add a searchable, outcome-filterable signal registry and CSV export of the currently loaded, filtered records. Export includes UTC entry time, ranking score, status, outcome and paper pips; it does not imply that confidence is a win probability.
- Add a market explorer chart backed by stored, final M1 candles. The HTTP endpoint is read-only, pair-allowlisted, and capped at 120 rows; Supabase mode uses the RLS-protected `public_candles` view. No synthetic candle values are generated.
- Keep VORTEX's live data states, UTC timestamps, failure/backoff behavior, stale-data warnings, NO-TRADE/NO-DATA distinction, operational health, provider budget, model validation and learning views as the canonical source of truth.
- Do not run NEXUS's independent browser prediction engine alongside VORTEX. Its current audit documents settlement, candle timing and persistence risks; those patterns are not safe to transplant as-is.
- The new registry interactions are read-only. No signal gates, provider usage, schema, delivery, credentials, schedules, model weights or settlement behavior are changed by these UI features.

## Port selectively, not wholesale

| NEXUS capability | VORTEX integration direction | Acceptance condition |
|---|---|---|
| Ocean-glass design system and responsive shell | Reuse the visual language in VORTEX's React dashboard | Desktop/mobile checks; keyboard focus and reduced-motion support; no change to data behavior |
| Signal registry and detail history | Existing durable VORTEX rows plus searchable/filterable UI and CSV export in this PR | No client-created outcomes; export only real records loaded from the configured data source |
| Market explorer and candle chart | This PR adds the final-M1-candle read contract for the relay and Supabase public view, plus a chart with OHLC hover details | Read-only, bounded, final candles only; show actual provider/timestamp provenance and empty/error states |
| Operational health matrix | Build on VORTEX's existing health, job, provider-budget and learning read models | Every state has a real source and timestamp; no fake liveness between Actions runs |
| Learning and model validation | Retain VORTEX's walk-forward validation, holdout/embargo, calibration and promotion gates | Shadow-only training first; model promotion requires recorded validation evidence and rollback |
| Telegram / outbound notifications | Keep delivery separately configured and disabled by default | Idempotent delivery ledger; no secrets in the browser; no implicit activation |
| NEXUS strategy weights / agents | Do not transplant directly into VORTEX's engine | Only consider a strategy after data-leakage review, chronological out-of-sample evaluation and measurable improvement over the current baseline |

## Mandatory correctness gates before expanding the engine

1. **Settlement integrity:** settle only against the exact target candle after its close and after the provider's revision window; use UTC candle timestamps, not display strings or mutable timezone preferences.
2. **No look-ahead:** every feature and candle used to create a signal must have been available at that signal's decision time. Use chronological walk-forward folds and a horizon-length embargo.
3. **Independent evidence:** keep untouched holdout results, calibration by confidence bucket, sample counts and uncertainty intervals. Do not tune thresholds against the final holdout.
4. **Quality-first cadence:** evaluate every scheduled five-minute slot, but publish only if a real market is open, the feed is fresh, the pair has enough valid candles, and every edge/risk gate passes. A valid NO-TRADE result is better than a manufactured signal.
5. **Automated learning:** record outcomes, train in shadow mode, compare against the currently promoted model, and promote only through a verified atomic model-registry change with rollback. Do not equate retraining with improved accuracy.
6. **Quota and credential safety:** use the existing VORTEX provider budget; never add key rotation to bypass a shared provider-account limit. Keep all private keys server-side.
7. **Production separation:** do not apply hosted database migrations, enable Telegram, activate schedules or start persistent workers as part of a UI merge. Verify hosted configuration separately and require explicit approval for production changes.

## Verification checklist

- [ ] npm run typecheck
- [ ] npm test
- [ ] npm run smoke
- [ ] npm run build:web
- [ ] npm run guard:bundle
- [ ] npm run validate:workflows
- [ ] Inspect GitHub Actions results for this branch/PR
- [ ] Confirm the deployed dashboard still reports real runtime state, not a static mock
- [ ] Verify a full ingest → signal evaluation → settlement → shadow training cycle against an approved non-production database
- [ ] Confirm no production secrets, migration state, schedule settings or Telegram settings were changed

## Important boundary

A green local/CI run proves code checks passed; it does not prove a hosted database is migrated, a provider is reachable, the model is profitable, or a qualified signal will exist every five minutes. The system must keep reporting the actual blocker when no signal qualifies.
