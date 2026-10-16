/**
 * End-to-end worker pipeline on an embedded database.
 *
 * This is the closest thing to running the worker: the real ingestion,
 * signal, settlement and telegram services execute in sequence against the
 * real schema with the simulated market-data provider, so the wiring between
 * them is actually exercised rather than mocked.
 *
 * The simulated feed is deterministic, so the only assertions are about
 * *contracts*: rows are created once, timings are respected, money is charged,
 * unresolved data is reported honestly and nothing throws.
 */

import { describe, expect, it } from 'vitest';
import {
  activateDue,
  getAccount,
  insertSignal,
  listKeys,
  listPositions,
  listSignals,
  markPublished,
  updateKey,
} from '@vortex/db';
import { createProvider } from '@vortex/provider';
import { createHarness, seedKey, simulatedProvider } from './helpers.js';
import { runIngestionCycle } from '../src/jobs/ingest.js';
import { runSignalCycle } from '../src/jobs/signals.js';
import { runSettlementCycle } from '../src/jobs/settle.js';
import { runMaintenance } from '../src/jobs/maintenance.js';

/**
 * Tuesday 2026-03-03, 10:03:45 UTC — inside the London session and exactly
 * inside the publish window of the 10:05 entry (publish lead 60s, and the
 * scheduler refuses slots whose publish instant is less than 15s away).
 */
const T_INGEST = new Date('2026-03-03T10:03:45.000Z');
const T_PUBLISH = new Date('2026-03-03T10:03:45.000Z');
const T_ENTRY = new Date('2026-03-03T10:05:00.000Z');
const T_SETTLE = new Date('2026-03-03T10:06:30.000Z');

async function withKeys<T>(h: Awaited<ReturnType<typeof createHarness>>, fn: () => Promise<T>): Promise<T> {
  await seedKey(h.client, { label: 'pipeline', minuteLimit: 60, dayLimit: 600 });
  try {
    return await fn();
  } finally {
    for (const key of await listKeys(h.client)) {
      await updateKey(h.client, key.id, { enabled: false });
    }
    h.runtime.keyPool.invalidate();
  }
}

describe('worker pipeline', () => {
  it('ingests candles, publishes a signal for the next slot and settles it', async () => {
    // The simulated feed is pinned to the same instant the cycles are told it
    // is, so the whole pipeline is deterministic without mocking the database.
    const clock = simulatedProvider(T_INGEST.getTime());
    const h = await createHarness({ provider: clock.provider });
    try {
      await withKeys(h, async () => {
        /* ---------------------------------------------------------- ingest */
        const ingest = await runIngestionCycle(h.runtime, T_INGEST);
        expect(ingest.candlesInserted + ingest.candlesUpdated).toBeGreaterThan(0);
        expect(ingest.exhausted).toBe(false);
        const stored = await h.client.query<{ count: string }>(
          'select count(*)::text as count from candles where timeframe = $1',
          ['M1'],
        );
        expect(Number(stored.rows[0]?.count)).toBeGreaterThan(0);

        /* ---------------------------------------------------- signal cycle */
        const scan = await runSignalCycle(h.runtime, T_PUBLISH);
        expect(scan.slot).not.toBeNull();
        expect(scan.evaluated).toBeGreaterThan(0);
        expect(scan.publishedIds.length).toBe(scan.published);

        // A cycle that runs twice must not duplicate the slot's opportunities.
        const replay = await runSignalCycle(h.runtime, T_PUBLISH);
        expect(replay.publishedIds.filter((id) => scan.publishedIds.includes(id))).toHaveLength(0);

        const published = await listSignals(h.client, { limit: 20 });
        if (scan.published > 0) {
          const signal = published.find((s) => scan.publishedIds.includes(s.id))!;
          expect(signal.status === 'PUBLISHED' || signal.status === 'PLANNED').toBe(true);
          expect(signal.scheduledEntryAt).toBe(T_ENTRY.toISOString());
          expect(signal.idempotencyKey).toContain(signal.pair);
          expect(signal.strategy.length).toBeGreaterThan(0);
          expect(signal.stopPips).toBeGreaterThan(0);
          expect(signal.spreadPips).toBeGreaterThan(0);
        } else {
          // NO_TRADE is a legitimate outcome; the gates must be reported.
          expect(scan.bestMiss ?? scan.detail.join(' ')).toBeTruthy();
        }

        /* ------------------------------------------------- ingress buffer */
        // Settlement reads the closing candle, so ingest the window first.
        clock.setNow(T_SETTLE.getTime());
        const after = await runIngestionCycle(h.runtime, T_SETTLE);
        expect(after.exhausted).toBe(false);

        /* -------------------------------------------------------- settle */
        const settle = await runSettlementCycle(h.runtime, T_SETTLE);
        expect(settle.candidates).toBe(scan.published);
        expect(settle.settled + settle.unresolved).toBe(settle.candidates);
        expect(settle.wins + settle.losses + settle.draws).toBe(settle.settled);

        const settledRows = await listSignals(h.client, { limit: 50 });
        for (const id of scan.publishedIds) {
          const row = settledRows.find((s) => s.id === id)!;
          expect(['WIN', 'LOSS', 'DRAW', 'UNRESOLVED']).toContain(row.outcome ?? 'UNRESOLVED');
          if (row.outcome === 'UNRESOLVED') {
            // Honest failure: an explanation must be attached.
            expect(row.outcomeDetail ?? '').toBeTruthy();
          } else {
            expect(row.realizedPips).not.toBeNull();
            expect(row.status).toBe('SETTLED');
          }
        }

        /* -------------------------------------------------------- replay */
        const secondSettle = await runSettlementCycle(h.runtime, T_SETTLE);
        expect(secondSettle.settled).toBe(0);

        /* --------------------------------------------------- paper ledger */
        const account = await getAccount(h.client, 'default');
        if (account) {
          expect(account.startingBalance).toBe(10000);
          expect(Number.isFinite(account.balance)).toBe(true);
          const positions = await listPositions(h.client, 50);
          for (const position of positions) {
            expect(position.signalId).toBeTruthy();
            expect(['OPEN', 'CLOSED', 'CANCELLED']).toContain(position.status);
            if (position.status === 'CLOSED') expect(position.realizedPips).not.toBeNull();
          }
        }
      });
    } finally {
      await h.close();
    }
  });

  it('leaves the door open: an unresolved settlement is deferred, not faked', async () => {
    const h = await createHarness();
    try {
      // A signal whose window has no stored candles at all: settlement must not
      // invent a price. Two deferred attempts then UNRESOLVED.
      // It must be published and active before it can settle — a signal that was
      // never delivered never entered and must not be judged.
      const inserted = await insertSignal(h.client, {
        idempotencyKey: 'pipeline|never-published|2026-03-04T10:05:00.000Z|BUY|pipeline-engine',
        pair: 'GBP/USD',
        timeframe: 'M1',
        direction: 'BUY',
        decision: 'BUY',
        strategy: 'trend_follow',
        confidence: 0.7,
        regime: 'TREND_UP',
        scheduledEntryAt: '2026-03-04T10:05:00.000Z',
        publishAt: '2026-03-04T10:04:00.000Z',
        horizonSeconds: 60,
        referencePrice: 1.1,
        stopPips: 10,
        targetPips: 14,
        rewardRisk: 1.4,
        spreadPips: 0.8,
        reasons: [],
        warnings: [],
        context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled' } as never,
        features: [1, 0.5, 0.2],
        modelVersionId: null,
        modelProbability: null,
        engineVersion: 'pipeline-engine',
      });
      // Only the published row is eligible; the other one is ignored entirely.
      const published = await insertSignal(h.client, {
        idempotencyKey: 'pipeline|published|2026-03-04T10:05:00.000Z|BUY|pipeline-engine',
        pair: 'EUR/USD',
        timeframe: 'M1',
        direction: 'BUY',
        decision: 'BUY',
        strategy: 'trend_follow',
        confidence: 0.7,
        regime: 'TREND_UP',
        scheduledEntryAt: '2026-03-04T10:05:00.000Z',
        publishAt: '2026-03-04T10:04:00.000Z',
        horizonSeconds: 60,
        referencePrice: 1.1,
        stopPips: 10,
        targetPips: 14,
        rewardRisk: 1.4,
        spreadPips: 0.8,
        reasons: [],
        warnings: [],
        context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled' } as never,
        features: [1, 0.5, 0.2],
        modelVersionId: null,
        modelProbability: null,
        engineVersion: 'pipeline-engine',
      });
      expect(inserted.created).toBe(true);
      expect(published.record).not.toBeNull();
      await markPublished(h.client, [published.record!.id], '2026-03-04T10:04:00.000Z');
      await activateDue(h.client, '2026-03-04T10:05:01.000Z');

      const first = await runSettlementCycle(h.runtime, new Date('2026-03-04T10:06:30.000Z'));
      const second = await runSettlementCycle(h.runtime, new Date('2026-03-04T10:07:30.000Z'));
      const third = await runSettlementCycle(h.runtime, new Date('2026-03-04T10:08:30.000Z'));
      expect(first.deferred).toBe(1);
      expect(second.deferred).toBe(1);
      expect(third.unresolved).toBe(1);
      const rows = await listSignals(h.client, { limit: 5 });
      const row = rows.find((s) => s.idempotencyKey === 'pipeline|published|2026-03-04T10:05:00.000Z|BUY|pipeline-engine')!;
      expect(row.outcome).toBe('UNRESOLVED');
      expect(row.outcomeDetail).toMatch(/data|candle|unavailable/i);
      const never = rows.find((s) => s.idempotencyKey === 'pipeline|never-published|2026-03-04T10:05:00.000Z|BUY|pipeline-engine')!;
      expect(never.outcome).toBeNull();
      expect(never.status).toBe('PLANNED');
    } finally {
      await h.close();
    }
  });

  it('reports data quality and worker health from maintenance', async () => {
    const h = await createHarness({ provider: simulatedProvider(T_INGEST.getTime()).provider });
    try {
      await withKeys(h, async () => {
        await runIngestionCycle(h.runtime, T_INGEST);
      });
      const summary = await runMaintenance(h.runtime, T_INGEST);
      expect(summary.components).toBeTruthy();
      const quality = await h.client.query<{ pair: string; status: string; age_seconds: number | null }>(
        'select pair, status, age_seconds from market_data_quality',
      );
      expect(quality.rows.length).toBeGreaterThan(0);
      for (const row of quality.rows) {
        expect(['CONNECTED', 'DEGRADED', 'DISCONNECTED', 'CONFIGURATION REQUIRED', 'NOT VERIFIED']).toContain(
        row.status,
      );
      }
      // No heartbeat has been written, so liveness must not claim CONNECTED.
      const components = summary.components as Record<string, string>;
      expect(components.worker).toBe('NOT VERIFIED');
      expect(components.database).toBe('CONNECTED');
    } finally {
      await h.close();
    }
  });

  it('skips ingestion entirely while the market is closed', async () => {
    const h = await createHarness();
    try {
      const saturday = new Date('2026-03-07T12:00:00.000Z');
      const summary = await runIngestionCycle(h.runtime, saturday);
      expect(summary.pairsFetched).toBe(0);
      expect(summary.detail.join(' ')).toContain('market closed');
    } finally {
      await h.close();
    }
  });

  it('labels synthetic data as simulated so the UI can never imply real quotes', async () => {
    const h = await createHarness({ provider: simulatedProvider(T_INGEST.getTime()).provider });
    try {
      expect(h.runtime.providerSynthetic).toBe(true);
      expect(h.runtime.provider.synthetic).toBe(true);
      expect(h.runtime.provider.name).toBe('simulated');
      await withKeys(h, async () => {
        const summary = await runIngestionCycle(h.runtime, T_INGEST);
        expect(summary.candlesInserted).toBeGreaterThan(0);
      });
      const quality = await h.client.query<{ detail: string | null }>('select detail from market_data_quality limit 1');
      expect(String(quality.rows[0]?.detail ?? '')).toMatch(/simulat|synthetic/i);
    } finally {
      await h.close();
    }
  });
});
