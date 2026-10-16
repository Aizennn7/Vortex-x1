/**
 * VORTEX SI status board.
 *
 * This is the read-only operational dashboard: it renders only measured facts
 * and states plainly when something is not configured, not reachable, stale,
 * or idle between scheduled GitHub Actions runs — no placeholder numbers, no
 * implied 24/7 liveness, and no "live" claim for simulated or stale data.
 *
 * Two behavioural rules the whole file obeys:
 *   1. A failing refresh never deletes data that was read successfully — the
 *      last good payload stays on screen, clearly annotated with how old it is.
 *   2. Every date is rendered from an ISO-8601 UTC string and labelled UTC, so
 *      a reader in any timezone can verify it against the database.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DATA_SOURCE_MODE,
  RELAY_BASE,
  SUPABASE_URL,
  failureGuidance,
  relay,
  wilsonInterval,
  type HealthPayload,
  type RelayFailureKind,
  type SignalRow,
  type SummaryPayload,
} from './relay.js';
import './styles.css';

type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string; kind: RelayFailureKind };

interface RelayState<T> {
  result: Loadable<T>;
  lastError: { message: string; kind: RelayFailureKind } | null;
  refreshedAt: string | null;
}

/**
 * Poll a read endpoint. On failure the previous successful payload is kept and
 * the error is surfaced alongside it, so a transient network blip cannot blank
 * the board into a misleading "everything is broken" screen.
 */
function useRelay<T>(
  loader: () => Promise<{ ok: boolean; data: T | null; error: string | null; kind: RelayFailureKind }>,
  pollMs: number,
): RelayState<T> & { refresh: () => Promise<void> } {
  const [state, setState] = useState<RelayState<T>>({ result: { state: 'loading' }, lastError: null, refreshedAt: null });
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const response = await loader();
    if (!mounted.current) return;
    setState((previous) => {
      if (response.ok && response.data !== null) {
        return {
          result: { state: 'ready', value: response.data },
          lastError: null,
          refreshedAt: new Date().toISOString(),
        };
      }
      const error = { message: response.error ?? 'unknown error', kind: response.kind };
      // Keep the last good payload when there is one; otherwise report the error.
      if (previous.result.state === 'ready') return { ...previous, lastError: error };
      return { result: { state: 'error', message: error.message, kind: error.kind }, lastError: error, refreshedAt: previous.refreshedAt };
    });
  }, [loader]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    if (pollMs <= 0) return undefined;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, pollMs]);

  return { ...state, refresh };
}

/** Render an ISO-8601 instant in UTC with the timezone spelled out. */
function utcLabel(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ` +
    `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())} UTC`
  );
}

function Timestamp({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="muted">n/a</span>;
  return (
    <time dateTime={iso} title={`${iso} (UTC)`}>
      {utcLabel(iso)}
    </time>
  );
}

function Card({ title, status, children }: { title: string; status?: string; children: React.ReactNode }) {
  return (
    <section className="card" aria-label={title}>
      <header>
        <h2>{title}</h2>
        {status ? <span className={`badge badge-${status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{status}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Loading({ what }: { what: string }) {
  return <p className="muted">Reading {what}…</p>;
}

/**
 * A failed read. The headline distinguishes "nothing is configured yet", "the
 * database has no tables yet" and "the endpoint is unreachable", because the
 * operator's next action is completely different in each case.
 */
function Failure({ message, kind }: { message: string; kind: RelayFailureKind }) {
  const headline =
    kind === 'setup-required'
      ? 'Setup required.'
      : kind === 'unreachable'
        ? 'Data source unreachable.'
        : kind === 'unauthorized'
          ? 'Access denied.'
          : kind === 'not-found'
            ? 'Endpoint not found.'
            : 'Not available.';
  return (
    <div className="failure" role="alert">
      <p>
        <strong>{headline}</strong> {message}
      </p>
      <p className="muted">{failureGuidance(kind, DATA_SOURCE_MODE)}</p>
    </div>
  );
}

/** A refresh that failed while older data is still on screen. */
function StaleNotice({ message, since }: { message: string; since: string | null }) {
  return (
    <p className="banner banner-warn" role="status">
      The latest refresh failed ({message}). Showing the last successful reading{since ? ` from ${utcLabel(since)}` : ''} — it
      may already be out of date.
    </p>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  );
}

function percent(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || Number.isNaN(value) ? 'n/a' : `${value.toFixed(digits)}%`;
}

function Dashboard() {
  const health = useRelay<HealthPayload>(relay.health, 15_000);
  const summary = useRelay<SummaryPayload>(relay.summary, 15_000);
  const signals = useRelay<{ signals: SignalRow[]; count: number }>(() => relay.signals(25), 30_000);

  const refreshAll = useCallback(() => {
    void health.refresh();
    void summary.refresh();
    void signals.refresh();
  }, [health, summary, signals]);

  const summaryValue = summary.result.state === 'ready' ? summary.result.value : null;
  const signalsValue = summaryValue?.signals ?? null;
  const worker = summaryValue?.worker ?? null;
  const lastJob = summaryValue?.lastSuccessfulJob ?? null;
  const marketData = useMemo(() => summaryValue?.marketData ?? [], [summaryValue]);
  const budget = summaryValue?.providerBudget ?? null;
  const telegram = summaryValue?.telegram ?? null;
  const alerts = summaryValue?.alerts ?? [];
  const model = summaryValue?.model ?? null;
  const learning = summaryValue?.learning ?? null;

  const stalePairs = useMemo(
    () => marketData.filter((m) => m.stale === true || m.status === 'DEGRADED' || m.status === 'DISCONNECTED').map((m) => m.pair),
    [marketData],
  );

  const synthetic = health.result.state === 'ready' ? health.result.value.provider.synthetic : null;
  const healthWarning = health.lastError ?? summary.lastError ?? signals.lastError;
  const banner = useMemo(() => {
    if (synthetic === true) {
      return {
        tone: 'warn',
        text: 'This deployment is running on the SIMULATED data feed. Nothing shown here reflects live market data.',
      };
    }
    if (health.result.state === 'ready' && !health.result.value.ready) {
      return { tone: 'warn', text: `Data source answered but reports not ready: ${health.result.value.reasons.join('; ')}` };
    }
    if (stalePairs.length > 0) {
      return {
        tone: 'warn',
        text: `Stale market data detected for ${stalePairs.join(', ')}. Signals are suppressed (NO-TRADE) when candle age exceeds the freshness threshold.`,
      };
    }
    return null;
  }, [synthetic, health.result, stalePairs]);

  const sourceDescription =
    DATA_SOURCE_MODE === 'supabase'
      ? `supabase public views (${SUPABASE_URL})`
      : DATA_SOURCE_MODE === 'snapshot'
        ? 'static snapshot (./snapshot.json)'
        : `relay (${RELAY_BASE || 'same origin'})`;

  const sourceBadge =
    health.result.state !== 'ready' ? undefined : health.result.value.status === 'ok' ? 'CONNECTED' : 'DEGRADED';

  const workerBadge =
    !summaryValue ? undefined : worker?.liveness === 'CONNECTED' && worker.running !== false ? 'CONNECTED' : worker || lastJob ? 'DISCONNECTED' : 'NOT VERIFIED';

  const marketDataBadge =
    !summaryValue
      ? undefined
      : marketData.length === 0
        ? 'NOT VERIFIED'
        : stalePairs.length > 0
          ? 'DEGRADED'
          : marketData.some((m) => m.status === 'CONNECTED')
            ? 'CONNECTED'
            : 'NOT VERIFIED';

  const accuracyInterval =
    signalsValue && signalsValue.decisive > 0 ? wilsonInterval(signalsValue.wins, signalsValue.decisive) : null;

  return (
    <main aria-busy={health.result.state === 'loading' || summary.result.state === 'loading'}>
      <header className="masthead">
        <div>
          <h1>VORTEX SI</h1>
          <p className="muted">
            Read-only status board. Signals are informational; no orders are placed anywhere. Paper figures charge
            spread and slippage and are not realised profit. Free-tier scheduled jobs run on GitHub Actions (minimum
            5-minute cron interval, subject to queue delays — not continuous 24/7 execution).
          </p>
        </div>
        <div className="masthead-meta">
          <span className="muted">source: {sourceDescription}</span>
          <span className="muted">
            last successful read: <Timestamp iso={health.refreshedAt ?? summary.refreshedAt} />
          </span>
          <button type="button" onClick={refreshAll} aria-label="Refresh every panel">
            Refresh
          </button>
        </div>
      </header>

      <div aria-live="polite">
        {banner ? <p className={`banner banner-${banner.tone}`}>{banner.text}</p> : null}
        {healthWarning ? <StaleNotice message={healthWarning.message} since={health.refreshedAt ?? summary.refreshedAt} /> : null}
      </div>

      <div className="grid">
        <Card title="Data source" status={sourceBadge}>
          {health.result.state === 'loading' ? <Loading what="the data source" /> : null}
          {health.result.state === 'error' ? (
            <Failure
              message={`${health.result.message}. Configure VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (recommended free-tier read views), VITE_DATA_SOURCE=snapshot, or VITE_RELAY_URL.`}
              kind={health.result.kind}
            />
          ) : null}
          {health.result.state === 'ready' ? (
            <dl className="facts">
              <div><dt>service</dt><dd>{health.result.value.service}</dd></div>
              <div><dt>engine</dt><dd>{health.result.value.version}</dd></div>
              <div><dt>mode</dt><dd>{DATA_SOURCE_MODE}</dd></div>
              <div><dt>database</dt><dd>{health.result.value.database.ok ? 'reachable' : health.result.value.database.detail}</dd></div>
              <div>
                <dt>provider</dt>
                <dd>
                  {health.result.value.provider.name}
                  {health.result.value.provider.synthetic ? ' (simulated)' : ''}
                </dd>
              </div>
              <div><dt>checked at</dt><dd><Timestamp iso={health.result.value.timestamp} /></dd></div>
            </dl>
          ) : null}
          {health.result.state === 'ready' ? <p className="muted">{health.result.value.note}</p> : null}
        </Card>

        <Card title="Worker & jobs" status={workerBadge}>
          {summary.result.state === 'loading' ? <Loading what="worker status" /> : null}
          {summary.result.state === 'error' ? <Failure message={summary.result.message} kind={summary.result.kind} /> : null}
          {summaryValue ? (
            worker || lastJob ? (
              <dl className="facts">
                <div>
                  <dt>worker state</dt>
                  <dd>
                    {worker?.liveness === 'CONNECTED' && worker.running !== false
                      ? `running (${worker.workerId})`
                      : 'stopped / idle between scheduled runs'}
                  </dd>
                </div>
                <div>
                  <dt>last heartbeat</dt>
                  <dd>{worker ? `${worker.secondsSince}s ago (${worker.workerId})` : 'none active'}</dd>
                </div>
                <div>
                  <dt>last successful job</dt>
                  <dd>
                    {lastJob ? `${lastJob.jobName} (${lastJob.ageSeconds}s ago, slot ${lastJob.slotKey})` : worker?.lastJob ?? 'none recorded yet'}
                  </dd>
                </div>
                <div><dt>last job finished</dt><dd><Timestamp iso={lastJob?.finishedAt ?? worker?.lastJobAt} /></dd></div>
                <div><dt>market</dt><dd>{summaryValue.marketOpen ? 'open' : 'closed'}</dd></div>
              </dl>
            ) : (
              <p className="muted">
                No worker heartbeat or completed job recorded yet. Trigger the GitHub Actions workflow or run{' '}
                <code>npm run job:run</code> to execute a cycle.
              </p>
            )
          ) : null}
        </Card>

        <Card title="Market data" status={marketDataBadge}>
          {summary.result.state === 'loading' ? <Loading what="market data quality" /> : null}
          {summary.result.state === 'error' ? <Failure message={summary.result.message} kind={summary.result.kind} /> : null}
          {summaryValue ? (
            marketData.length === 0 ? (
              <p className="muted">
                No market data recorded yet. Ingestion has either not run or found nothing to store — no candles are
                invented to fill this panel.
              </p>
            ) : (
              <dl className="facts">
                {marketData.map((row) => {
                  const isStale = row.stale === true || row.status === 'DEGRADED' || row.status === 'DISCONNECTED';
                  const ageLabel = row.ageSeconds === null ? 'no candles' : `${row.ageSeconds}s old`;
                  return (
                    <div key={row.pair}>
                      <dt>{row.pair}</dt>
                      <dd>
                        {row.status} · {ageLabel}
                        {isStale ? ' (STALE — signals suppressed)' : ' (fresh)'}
                        {row.detail ? <span className="muted"> · {row.detail}</span> : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )
          ) : null}
        </Card>

        <Card title="Provider budget" status={budget ? (budget.dayRemainingPercent < 10 ? 'DEGRADED' : 'CONNECTED') : undefined}>
          {budget ? (
            <>
              <div className="stats">
                <Stat label="keys" value={`${budget.usableKeys}/${budget.enabledKeys}`} hint="usable / configured" />
                <Stat label="day left" value={`${budget.dayRemainingPercent.toFixed(1)}%`} />
                <Stat label="day used" value={`${budget.dayUsed}/${budget.dayCapacity}`} hint="provider credits" />
              </div>
              {budget.warnings.length > 0 ? (
                <ul className="warnings">
                  {budget.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              <p className="muted">
                Keys sharing one provider account share that account's quota — rotation is not a way around plan limits.
              </p>
            </>
          ) : (
            <p className="muted">No provider budget to report (database not reachable, or no keys configured yet).</p>
          )}
        </Card>

        <Card title="Signal accuracy">
          {signalsValue ? (
            <>
              <div className="stats">
                <Stat label="in flight" value={String(signalsValue.inFlight)} />
                <Stat label="wins" value={String(signalsValue.wins)} />
                <Stat label="losses" value={String(signalsValue.losses)} />
                <Stat
                  label="accuracy"
                  value={percent(signalsValue.accuracy)}
                  hint={
                    accuracyInterval
                      ? `${signalsValue.decisive} decisive · 95% CI ${(accuracyInterval.lower * 100).toFixed(0)}–${(accuracyInterval.upper * 100).toFixed(0)}%`
                      : 'no decisive outcomes yet'
                  }
                />
                <Stat
                  label="unresolved"
                  value={String(signalsValue.unresolved)}
                  hint="excluded from accuracy, kept in the cohort"
                />
                {signalsValue.accuracyConservative === null || signalsValue.accuracyConservative === undefined ? null : (
                  <Stat
                    label="conservative"
                    value={percent(signalsValue.accuracyConservative)}
                    hint="unresolved charged as failures"
                  />
                )}
                {signalsValue.expectancyPips === null || signalsValue.expectancyPips === undefined ? null : (
                  <Stat
                    label="expectancy"
                    value={`${signalsValue.expectancyPips.toFixed(2)} pips`}
                    hint="paper, net of spread + slippage"
                  />
                )}
              </div>
              <p className="muted">{signalsValue.note}</p>
            </>
          ) : (
            <p className="muted">No signal statistics available.</p>
          )}
        </Card>

        <Card
          title="Model & learning"
          status={model ? (model.champion ? 'CONNECTED' : model.candidateCount > 0 ? 'DEGRADED' : 'NOT VERIFIED') : undefined}
        >
          {!summaryValue ? null : (
            <>
              {model?.champion ? (
                <dl className="facts">
                  <div><dt>champion</dt><dd>{model.champion.version}</dd></div>
                  <div><dt>promoted</dt><dd><Timestamp iso={model.champion.promotedAt} /></dd></div>
                  <div>
                    <dt>training rows</dt>
                    <dd>
                      {model.champion.datasetSize ?? 'n/a'}
                      {model.champion.datasetFrom && model.champion.datasetTo ? (
                        <span className="muted"> · {utcLabel(model.champion.datasetFrom).slice(0, 10)} → {utcLabel(model.champion.datasetTo).slice(0, 10)}</span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt>holdout accuracy</dt>
                    <dd>
                      {model.champion.metrics?.accuracy === null || model.champion.metrics?.accuracy === undefined
                        ? 'n/a'
                        : `${(model.champion.metrics.accuracy * 100).toFixed(1)}%`}
                      {model.champion.metrics?.samples ? <span className="muted"> on {model.champion.metrics.samples} rows</span> : null}
                    </dd>
                  </div>
                  <div>
                    <dt>AUC · log loss · ECE</dt>
                    <dd>
                      {model.champion.metrics?.auc === null || model.champion.metrics?.auc === undefined ? 'n/a' : model.champion.metrics.auc.toFixed(3)}
                      {' · '}
                      {model.champion.metrics?.logLoss === null || model.champion.metrics?.logLoss === undefined ? 'n/a' : model.champion.metrics.logLoss.toFixed(3)}
                      {' · '}
                      {model.champion.metrics?.ece === null || model.champion.metrics?.ece === undefined ? 'n/a' : model.champion.metrics.ece.toFixed(3)}
                    </dd>
                  </div>
                </dl>
              ) : null}
              {model ? <p className="muted">{model.note}</p> : null}
              {model && model.champion && model.champion.walkForward.length > 0 ? (
                <p className="muted">
                  walk-forward folds:{' '}
                  {model.champion.walkForward
                    .map((fold) => `#${fold.fold} ${fold.accuracy === null || fold.accuracy === undefined ? 'n/a' : `${(fold.accuracy * 100).toFixed(1)}%`}`)
                    .join(' · ')}
                </p>
              ) : null}
              {learning ? (
                learning.lastRun ? (
                  <dl className="facts">
                    <div><dt>last learning run</dt><dd>{learning.lastRun.status}</dd></div>
                    <div><dt>finished</dt><dd><Timestamp iso={learning.lastRun.finishedAt ?? learning.lastRun.startedAt} /></dd></div>
                    <div><dt>dataset</dt><dd>{learning.lastRun.datasetSize === null ? 'n/a' : `${learning.lastRun.datasetSize} labelled rows`}</dd></div>
                  </dl>
                ) : (
                  <p className="muted">No learning run has been recorded yet.</p>
                )
              ) : null}
              {learning?.lastRun?.reason ? <p className="muted">reason: {learning.lastRun.reason}</p> : null}
              {learning ? <p className="muted">{learning.note}</p> : null}
              {summaryValue.model === null && summaryValue.learning === null ? (
                <p className="muted">Model registry not readable from this data source (the view may not exist yet).</p>
              ) : null}
            </>
          )}
        </Card>

        <Card title="Delivery" status={telegram?.configuration.status}>
          {telegram ? (
            <>
              <div className="stats">
                <Stat label="sent" value={String(telegram.sent)} />
                <Stat label="failed" value={String(telegram.failed)} />
                <Stat label="unconfirmed" value={String(telegram.unconfirmed)} hint="response lost — not retried" />
              </div>
              <p className="muted">{telegram.configuration.detail}</p>
            </>
          ) : (
            <p className="muted">Delivery state unavailable.</p>
          )}
        </Card>

        <Card title="Alerts" status={alerts.length === 0 ? 'CONNECTED' : 'DEGRADED'}>
          {alerts.length === 0 ? (
            <p className="muted">No open alerts.</p>
          ) : (
            <ul className="alerts">
              {alerts.map((alert) => (
                <li key={alert.code}>
                  <span className={`severity severity-${alert.severity.toLowerCase()}`}>{alert.severity}</span>
                  <strong>{alert.title}</strong>
                  <span className="muted"> {alert.code} · last seen <Timestamp iso={alert.lastSeenAt} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent signals">
        {signals.result.state === 'loading' ? <Loading what="recent signals" /> : null}
        {signals.result.state === 'error' ? <Failure message={signals.result.message} kind={signals.result.kind} /> : null}
        {signals.result.state === 'ready' ? (
          signals.result.value.signals.length === 0 ? (
            <p className="muted">
              No signals published yet. That is a normal state: the engine only publishes when every gate passes.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <caption className="muted">
                  Newest {signals.result.value.signals.length} published signals. All times are UTC. Paper results are net
                  of the modelled spread and slippage and are not realised profit.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">pair</th>
                    <th scope="col">side</th>
                    <th scope="col">entry (UTC)</th>
                    <th scope="col">strategy</th>
                    <th scope="col">confidence</th>
                    <th scope="col">status</th>
                    <th scope="col">outcome</th>
                    <th scope="col">net pips</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.result.value.signals.map((signal) => (
                    <tr key={signal.id}>
                      <td>{signal.pair}</td>
                      <td>{signal.decision}</td>
                      <td><Timestamp iso={signal.scheduledEntryAt} /></td>
                      <td>{signal.strategy}</td>
                      <td>{(signal.confidence * 100).toFixed(0)}%</td>
                      <td>{signal.status}</td>
                      <td>{signal.outcome ?? '—'}</td>
                      <td>{signal.realizedPips === null || signal.realizedPips === undefined ? '—' : signal.realizedPips.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
        <p className="muted">
          "confidence" is the ensemble's own 0–1 ranking score for its call, not a probability and not a win
          expectation. Where a model is active its calibrated probability is stored with the signal.
        </p>
      </Card>

      <footer className="muted">
        VORTEX SI is a research and notification system. Paper figures are simulations. Nothing here is financial advice.
      </footer>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');
createRoot(container).render(<Dashboard />);
