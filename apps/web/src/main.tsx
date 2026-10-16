/**
 * VORTEX SI status board.
 *
 * This is the first slice of the dashboard: an honest read-only view of what
 * the worker relay reports. It renders only measured facts and states plainly
 * when something is not configured, not reachable or not verified — no
 * placeholder numbers, no implied liveness, and no "live" claim for simulated
 * data.
 *
 * The planetary/animated control deck is the next milestone; this page is
 * deliberately small so the deployment path (static bundle → relay) is proven
 * first.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RELAY_BASE, relay, type HealthPayload, type SignalRow, type SummaryPayload } from './relay.js';
import './styles.css';

type Loadable<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; message: string };

function useRelay<T>(loader: () => Promise<{ ok: boolean; data: T | null; error: string | null }>, pollMs: number) {
  const [result, setResult] = useState<Loadable<T>>({ state: 'loading' });
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await loader();
    if (response.ok && response.data !== null) {
      setResult({ state: 'ready', value: response.data });
      setRefreshedAt(new Date().toISOString());
    } else {
      setResult({ state: 'error', message: response.error ?? 'unknown relay error' });
    }
  }, [loader]);

  useEffect(() => {
    void refresh();
    if (pollMs <= 0) return undefined;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { result, refresh, refreshedAt };
}

function Card({ title, status, children }: { title: string; status?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <header>
        <h2>{title}</h2>
        {status ? <span className={`badge badge-${status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{status}</span> : null}
      </header>
      {children}
    </section>
  );
}

function Loading() {
  return <p className="muted">Loading…</p>;
}

function Failure({ message }: { message: string }) {
  return (
    <p className="failure">
      <strong>Not available.</strong> {message}
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

function Dashboard() {
  const health = useRelay<HealthPayload>(relay.health, 15_000);
  const summary = useRelay<SummaryPayload>(relay.summary, 15_000);
  const signals = useRelay<{ signals: SignalRow[]; count: number }>(() => relay.signals(25), 30_000);

  const signalsValue = summary.result.state === 'ready' ? summary.result.value.signals : null;
  const worker = summary.result.state === 'ready' ? summary.result.value.worker : null;
  const budget = summary.result.state === 'ready' ? summary.result.value.providerBudget : null;
  const telegram = summary.result.state === 'ready' ? summary.result.value.telegram : null;
  const alerts = summary.result.state === 'ready' ? summary.result.value.alerts : [];

  const synthetic = health.result.state === 'ready' ? health.result.value.provider.synthetic : null;
  const banner = useMemo(() => {
    if (synthetic === true) {
      return {
        tone: 'warn',
        text: 'This deployment is running on the SIMULATED data feed. Nothing shown here reflects live market data.',
      };
    }
    if (health.result.state === 'ready' && !health.result.value.ready) {
      return { tone: 'warn', text: `Relay answered but reports not ready: ${health.result.value.reasons.join('; ')}` };
    }
    return null;
  }, [synthetic, health.result]);

  return (
    <main>
      <header className="masthead">
        <div>
          <h1>VORTEX SI</h1>
          <p className="muted">
            Read-only status board. Signals are informational; no orders are placed anywhere. Paper figures charge
            spread and slippage and are not realised profit.
          </p>
        </div>
        <div className="masthead-meta">
          <span className="muted">relay: {RELAY_BASE || 'same origin'}</span>
          {health.refreshedAt ? <span className="muted">checked {new Date(health.refreshedAt).toLocaleTimeString()}</span> : null}
          <button type="button" onClick={() => { void health.refresh(); void summary.refresh(); void signals.refresh(); }}>
            Refresh
          </button>
        </div>
      </header>

      {banner ? <p className={`banner banner-${banner.tone}`}>{banner.text}</p> : null}

      <div className="grid">
        <Card
          title="Relay"
          status={
            health.result.state === 'ready' ? (health.result.value.status === 'ok' ? 'CONNECTED' : 'DEGRADED') : undefined
          }
        >
          {health.result.state === 'loading' ? <Loading /> : null}
          {health.result.state === 'error' ? (
            <Failure message={`${health.result.message}. Set VITE_RELAY_URL at build time or serve the dashboard behind the relay.`} />
          ) : null}
          {health.result.state === 'ready' ? (
            <dl className="facts">
              <div><dt>service</dt><dd>{health.result.value.service}</dd></div>
              <div><dt>engine</dt><dd>{health.result.value.version}</dd></div>
              <div><dt>uptime</dt><dd>{Math.floor(health.result.value.uptimeSeconds / 60)} min</dd></div>
              <div><dt>database</dt><dd>{health.result.value.database.ok ? 'reachable' : health.result.value.database.detail}</dd></div>
              <div><dt>provider</dt><dd>{health.result.value.provider.name}{health.result.value.provider.synthetic ? ' (simulated)' : ''}</dd></div>
            </dl>
          ) : null}
        </Card>

        <Card title="Worker" status={worker ? worker.liveness : summary.result.state === 'ready' ? 'NOT VERIFIED' : undefined}>
          {summary.result.state === 'loading' ? <Loading /> : null}
          {summary.result.state === 'error' ? <Failure message={summary.result.message} /> : null}
          {summary.result.state === 'ready' ? (
            worker ? (
              <dl className="facts">
                <div><dt>worker id</dt><dd>{worker.workerId}</dd></div>
                <div><dt>last heartbeat</dt><dd>{worker.secondsSince}s ago</dd></div>
                <div><dt>last job</dt><dd>{worker.lastJob ?? 'n/a'}</dd></div>
                <div><dt>market</dt><dd>{summary.result.value.marketOpen ? 'open' : 'closed'}</dd></div>
              </dl>
            ) : (
              <p className="muted">
                No heartbeat recorded yet. Liveness is only claimed from the heartbeat table — start{' '}
                <code>npm run worker</code> and this panel will report it.
              </p>
            )
          ) : null}
        </Card>

        <Card
          title="Provider budget"
          status={budget ? (budget.dayRemainingPercent < 10 ? 'DEGRADED' : 'CONNECTED') : undefined}
        >
          {budget ? (
            <>
              <div className="stats">
                <Stat label="keys" value={`${budget.usableKeys}/${budget.enabledKeys}`} hint="usable / configured" />
                <Stat label="day left" value={`${budget.dayRemainingPercent.toFixed(1)}%`} />
                <Stat label="day used" value={`${budget.dayUsed}/${budget.dayCapacity}`} />
              </div>
              {budget.warnings.length > 0 ? (
                <ul className="warnings">
                  {budget.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <p className="muted">No provider budget to report (database not reachable).</p>
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
                  value={signalsValue.accuracy === null ? 'n/a' : `${signalsValue.accuracy}%`}
                  hint={signalsValue.decisive === 0 ? 'no decisive outcomes yet' : `${signalsValue.decisive} decisive`}
                />
                <Stat
                  label="unresolved"
                  value={String(signalsValue.unresolved)}
                  hint="excluded from accuracy, kept in the cohort"
                />
              </div>
              <p className="muted">{signalsValue.note}</p>
            </>
          ) : (
            <p className="muted">No signal statistics available.</p>
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
                  <span className="muted"> {alert.code}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent signals">
        {signals.result.state === 'loading' ? <Loading /> : null}
        {signals.result.state === 'error' ? <Failure message={signals.result.message} /> : null}
        {signals.result.state === 'ready' ? (
          signals.result.value.signals.length === 0 ? (
            <p className="muted">
              No signals published yet. That is a normal state: the engine only publishes when every gate passes.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>pair</th>
                  <th>side</th>
                  <th>entry (UTC)</th>
                  <th>strategy</th>
                  <th>confidence</th>
                  <th>status</th>
                  <th>outcome</th>
                  <th>net pips</th>
                </tr>
              </thead>
              <tbody>
                {signals.result.value.signals.map((signal) => (
                  <tr key={signal.id}>
                    <td>{signal.pair}</td>
                    <td>{signal.decision}</td>
                    <td>{signal.scheduledEntryAt.replace('T', ' ').replace('.000Z', 'Z')}</td>
                    <td>{signal.strategy}</td>
                    <td>{(signal.confidence * 100).toFixed(0)}%</td>
                    <td>{signal.status}</td>
                    <td>{signal.outcome ?? '—'}</td>
                    <td>{signal.realizedPips === null || signal.realizedPips === undefined ? '—' : signal.realizedPips.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
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
