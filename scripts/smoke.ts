/**
 * Smoke test — prove the whole pipeline works in one command.
 *
 *   npm run smoke            # embedded database (PGlite), simulated feed
 *   DATABASE_URL=... npm run smoke -- --database   # run against a real Postgres
 *
 * It applies migrations, seeds a provider key, then runs one ingestion, one
 * signal cycle, one settlement pass and one maintenance pass against the
 * simulated market-data provider, and prints what actually happened at each
 * stage. Any stage that cannot do its job fails the process, so this doubles as
 * the "is my deployment wired up?" check.
 */

import { randomUUID } from 'node:crypto';
import {
  PgliteClient,
  createPostgresClientFromTarget,
  encryptSecret,
  getAccount,
  insertKey,
  keyFingerprint,
  listHealth,
  listQuality,
  listSignals,
  migrate,
  resolveDatabaseConnection,
  workerStatus,
  type SqlClient,
} from '@vortex/db';
import { maskKey } from '@vortex/core';
import { WorkerRuntime } from '../apps/worker/src/runtime.js';
import { SimulatedProvider } from '@vortex/provider';
import { runIngestionCycle } from '../apps/worker/src/jobs/ingest.js';
import { runSignalCycle } from '../apps/worker/src/jobs/signals.js';
import { runSettlementCycle } from '../apps/worker/src/jobs/settle.js';
import { runMaintenance } from '../apps/worker/src/jobs/maintenance.js';

const useDatabase = process.argv.includes('--database');
const SECRET_KEY = process.env.VORTEX_SECRET_KEY ?? '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const SMOKE_KEY = 'smoke-test-provider-key-0123456789';

interface Stage {
  name: string;
  detail: string;
  ok: boolean;
}

const stages: Stage[] = [];

function record(name: string, detail: string, ok = true): void {
  stages.push({ name, detail, ok });
  console.log(`${ok ? '  ok  ' : ' fail '} ${name.padEnd(22)} ${detail}`);
}

async function openClient(): Promise<{ client: SqlClient; label: string }> {
  if (useDatabase) {
    const resolved = resolveDatabaseConnection({ purpose: 'migration' });
    if (!resolved.target) throw new Error('DATABASE_URL (Session Pooler) is required with --database');
    for (const warning of resolved.warnings) console.log(`  warning: ${warning}`);
    const client = createPostgresClientFromTarget(resolved.target, { applicationName: 'vortex-smoke', max: 2 });
    const ping = await client.ping();
    if (!ping.ok) throw new Error(`database unreachable: ${ping.detail}`);
    return { client, label: `postgres (${resolved.target.describe().kind})` };
  }
  return { client: await PgliteClient.create(), label: 'embedded PGlite' };
}

async function main(): Promise<void> {
  console.log(`VORTEX SI smoke test — ${new Date().toISOString()}`);
  const { client, label } = await openClient();
  console.log(`  database: ${label}\n`);

  let runtime: WorkerRuntime | null = null;
  try {
    const applied = await migrate(client, { log: () => undefined });
    record(
      'migrations',
      `${applied.applied.length} applied, ${applied.skipped.length} already present` +
        (applied.drifted.length > 0 ? `, ${applied.drifted.length} DRIFTED` : ''),
      applied.drifted.length === 0,
    );

    // Deterministic instant inside a London session (Monday 2026-03-02,
    // 10:03:45 UTC) — the simulated feed is pinned to the same instant so the
    // run is reproducible and the market is guaranteed open.
    let feedClock = new Date(process.env.SMOKE_AT ?? '2026-03-02T10:03:45.000Z').getTime();
    const smokeAt = new Date(feedClock);
    runtime = await WorkerRuntime.create({
      db: client,
      manual: true,
      provider: new SimulatedProvider({ now: () => feedClock }),
      env: {
        ...process.env,
        VORTEX_PROVIDER: 'simulated',
        VORTEX_PAIRS: process.env.VORTEX_PAIRS ?? 'EUR/USD,GBP/USD',
        VORTEX_SECRET_KEY: SECRET_KEY,
        VORTEX_ADMIN_TOKEN: process.env.VORTEX_ADMIN_TOKEN ?? 'smoke-admin-token-0123456789',
        VORTEX_TELEGRAM_ENABLED: 'false',
      } as NodeJS.ProcessEnv,
    });

    const configIssues = runtime.issues.filter((i) => i.severity === 'error');
    record(
      'configuration',
      configIssues.length === 0
        ? `provider=${runtime.config.provider} pairs=${runtime.config.pairs.join(',')}`
        : configIssues.map((i) => `${i.key}: ${i.message}`).join('; '),
      configIssues.length === 0,
    );

    const key = await insertKey(client, {
      label: `smoke-${randomUUID().slice(0, 6)}`,
      maskedKey: maskKey(SMOKE_KEY),
      ciphertext: encryptSecret(SMOKE_KEY, SECRET_KEY),
      fingerprint: keyFingerprint(SMOKE_KEY),
      minuteLimit: 60,
      dayLimit: 600,
    });
    runtime.keyPool.invalidate();
    record('provider key', `stored ${key.maskedKey} (ciphertext only in the database)`);

    const ingestAt = smokeAt;
    const ingest = await runIngestionCycle(runtime, ingestAt);
    const candles = await client.query<{ count: string }>('select count(*)::text as count from candles');
    record(
      'ingestion',
      `${candles.rows[0]?.count ?? '0'} candles stored; fetched ${ingest.pairsFetched}/${ingest.pairsConsidered} pair(s); exhausted=${ingest.exhausted}`,
      Number(candles.rows[0]?.count ?? 0) > 0,
    );

    const scan = await runSignalCycle(runtime, ingestAt);
    record(
      'signal cycle',
      `slot ${scan.slot ?? 'none'}; evaluated ${scan.evaluated}; published ${scan.published}; no-trade ${scan.noTrade}` +
        (scan.bestMiss ? `; closest miss: ${scan.bestMiss}` : ''),
      scan.slot !== null,
    );

    // Move the feed forward past the horizon, top the candles up, then settle —
    // the same sequence the scheduler performs, just compressed into one run.
    const settleAt = new Date(ingestAt.getTime() + 3 * 60_000 + 45_000);
    feedClock = settleAt.getTime();
    const topUp = await runIngestionCycle(runtime, settleAt);
    record('ingestion (top-up)', `+${topUp.candlesInserted} candle(s) for the settled window`);

    const settlement = await runSettlementCycle(runtime, settleAt);
    record(
      'settlement',
      `candidates ${settlement.candidates}; settled ${settlement.settled} (${settlement.wins}W/${settlement.losses}L/${settlement.draws}D); deferred ${settlement.deferred}; unresolved ${settlement.unresolved}`,
      settlement.unresolved === 0,
    );

    const maintenance = await runMaintenance(runtime, settleAt);
    const components = Object.entries(maintenance.components)
      .map(([name, status]) => `${name}=${status}`)
      .join(' ');
    record('maintenance', components || 'no components reported', Object.keys(maintenance.components).length > 0);

    const quality = await listQuality(client);
    if (quality.length > 0) {
      record(
        'data quality',
        quality.map((q) => `${q.pair}:${q.status}${q.ageSeconds === null ? '' : `(${q.ageSeconds}s)`}`).join(' '),
      );
    }

    const signals = await listSignals(client, { limit: 5 });
    record(
      'persisted signals',
      signals.length === 0
        ? 'none this slot (NO_TRADE) — the engine refused to trade, which is a valid outcome'
        : signals
            .map((s) => `${s.pair} ${s.decision} ${s.status} conf=${s.confidence.toFixed(2)}`)
            .join(' | '),
    );

    const account = await getAccount(client, 'default');
    if (account) {
      record('paper ledger', `balance ${account.balance.toFixed(2)} from ${account.startingBalance}`);
    }

    const health = await listHealth(client);
    record('health components', health.map((h) => `${h.component}=${h.status}`).join(' ') || 'none recorded');

    const workers = await workerStatus(client);
    record(
      'worker liveness',
      workers.length === 0
        ? 'not verified — no heartbeat yet (start the worker and re-run)'
        : workers.map((w) => `${w.workerId}:${w.liveness}`).join(' '),
      true,
    );

    // Clean up the seeded key so repeated smoke runs do not pollute a real DB.
    await client.query('delete from provider_keys where id = $1', [key.id]);

    const failed = stages.filter((s) => !s.ok);
    console.log(`\n${stages.length - failed.length}/${stages.length} stages ok`);
    if (failed.length > 0) {
      console.error(`failed: ${failed.map((f) => f.name).join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await runtime?.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(`smoke test crashed: ${(error as Error).message}`);
  process.exitCode = 1;
});
