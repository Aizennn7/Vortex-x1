/**
 * Self-learning loop, end to end, on a real (embedded) database.
 *
 * The properties under test are the ones that keep a learning system honest:
 *   - only verified WIN/LOSS rows become labels, and exclusions are counted;
 *   - the embargo equals the recorded prediction horizon, not a hardcoded 60s;
 *   - a candidate is never trained on its own holdout;
 *   - re-running on an unchanged dataset does not refit (idempotent, cheap);
 *   - new outcomes do trigger a fresh run, and promotion stays bounded.
 *
 * Nothing here touches a live provider or a hosted database.
 */

import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES } from '@vortex/core';
import {
  applySettlement,
  getActiveStrategyWeights,
  getChampion,
  listLearningRuns,
  listModelVersions,
  insertSignal,
} from '@vortex/db';
import { createHarness } from './helpers.js';
import { runLearningCycle } from '../src/jobs/learning.js';

const HORIZON_SECONDS = 300;
const SAMPLE_COUNT = 200;
const HOUR_MS = 3_600_000;

/**
 * A deterministic, learnable population: `bias` carries the label, every other
 * feature is stable noise. That keeps the assertion about the *pipeline*
 * (labels, embargo, holdout, idempotency) rather than about the model's luck.
 */
function featuresFor(index: number, label: 0 | 1, blank = false): number[] {
  if (blank) return FEATURE_NAMES.map(() => 0);
  return FEATURE_NAMES.map((name, position) => {
    if (name === 'bias') return label === 1 ? 1 : -1;
    const wave = Math.sin((index + 1) * (position + 1)) * 0.5;
    return Number(wave.toFixed(6));
  });
}

interface Seeded {
  ids: string[];
  decidedAt: string[];
}

async function seedResolved(
  h: Awaited<ReturnType<typeof createHarness>>,
  params: { count: number; startMs: number; offset?: number; blankFeatures?: boolean },
): Promise<Seeded> {
  const ids: string[] = [];
  const decidedAt: string[] = [];
  const { count, startMs, offset = 0, blankFeatures = false } = params;
  for (let i = 0; i < count; i += 1) {
    const index = offset + i;
    const entryMs = startMs + index * HOUR_MS;
    const entryIso = new Date(entryMs).toISOString();
    const label: 0 | 1 = index % 2 === 0 ? 1 : 0;
    const direction = label === 1 ? 'BUY' : 'SELL';
    const inserted = await insertSignal(h.client, {
      idempotencyKey: `learning|${entryIso}|${direction}|engine-test`,
      pair: index % 3 === 0 ? 'GBP/USD' : 'EUR/USD',
      timeframe: 'M1',
      direction,
      decision: direction,
      strategy: label === 1 ? 'trend_follow' : 'mean_reversion',
      confidence: 0.6 + (index % 5) * 0.02,
      regime: index % 2 === 0 ? 'TREND_UP' : 'RANGE',
      scheduledEntryAt: entryIso,
      publishAt: new Date(entryMs - 60_000).toISOString(),
      horizonSeconds: HORIZON_SECONDS,
      referencePrice: 1.1,
      stopPips: 10,
      targetPips: 14,
      rewardRisk: 1.4,
      spreadPips: 0.8,
      reasons: ['seeded for the learning test'],
      warnings: [],
      context: {
        session: 'LONDON',
        spreadPips: 0.8,
        spreadSource: 'modelled',
        dataQuality: 'OK',
        regime: index % 2 === 0 ? 'TREND_UP' : 'RANGE',
      } as never,
      features: featuresFor(index, label, blankFeatures),
      modelVersionId: null,
      modelProbability: null,
      engineVersion: 'engine-test',
    });
    const record = inserted.record;
    expect(record).not.toBeNull();
    await h.client.query(`update signals set status = 'ACTIVE' where id = $1`, [record!.id]);
    await applySettlement(h.client, {
      id: record!.id,
      outcome: label === 1 ? 'WIN' : 'LOSS',
      status: 'SETTLED',
      entryPrice: 1.1,
      exitPrice: 1.1005,
      grossPips: label === 1 ? 5 : -5,
      costPips: 0.9,
      realizedPips: label === 1 ? 4.1 : -5.9,
      mfePips: 6,
      maePips: -3,
      outcomeRule: 'net_after_costs_v1',
      outcomeFlags: [],
      outcomeDetail: 'seeded',
    });
    ids.push(record!.id);
    decidedAt.push(entryIso);
  }
  return { ids, decidedAt };
}

describe('learning cycle', () => {
  it('labels only verified outcomes, applies the horizon embargo and refuses to refit unchanged data', async () => {
    const h = await createHarness({
      env: {
        VORTEX_TRAIN_MIN_SAMPLES: '40',
        VORTEX_LEARNING_ENABLED: 'true',
        VORTEX_ARTIFACT_DIR: '/tmp/vortex-test-artifacts',
      },
    });
    try {
      // Start ~10 days back so the whole window is inside the 365-day lookback.
      const now = new Date();
      const startMs = now.getTime() - 10 * 24 * HOUR_MS;
      await seedResolved(h, { count: SAMPLE_COUNT, startMs });
      // A DRAW and an UNRESOLVED row must be excluded, never guessed.
      const noise = await seedResolved(h, { count: 2, startMs, offset: SAMPLE_COUNT });
      await h.client.query(
        `update signals set outcome = 'DRAW', outcome_flags = '["draw"]'::jsonb where id = $1`,
        [noise.ids[0]],
      );
      await h.client.query(
        `update signals set outcome = 'UNRESOLVED', outcome_flags = '["data_unavailable"]'::jsonb where id = $1`,
        [noise.ids[1]],
      );

      const first = await runLearningCycle(h.runtime, now);
      expect(first.datasetSize).toBe(SAMPLE_COUNT);
      expect(first.exclusions.draw).toBe(1);
      expect(first.exclusions.unresolved).toBe(1);
      // The embargo is one full horizon, taken from the stored signals.
      expect(first.embargoSeconds).toBe(HORIZON_SECONDS);
      expect(first.evaluationSet).toBe('test');
      expect(first.skipped).toBe(false);
      // The seeded pattern is cleanly separable, so every gate passes and the
      // candidate is promoted. This is a pipeline assertion, not a performance
      // claim: the data is synthetic and perfectly separable by construction.
      expect(first.walkForwardAccuracy.length).toBeGreaterThanOrEqual(3);
      expect(first.promoted).toBe(true);
      expect(first.summary).toMatch(/all \d+ gates passed/);

      const versionsAfterFirst = await listModelVersions(h.client, 10);
      expect(versionsAfterFirst).toHaveLength(1);
      expect(['CHAMPION', 'REJECTED']).toContain(versionsAfterFirst[0]!.status);
      expect(versionsAfterFirst[0]!.datasetChecksum).toBe(first.checksum);

      // Strategy weights are bounded and only written with enough evidence.
      const weights = await getActiveStrategyWeights(h.client);
      expect(weights).not.toBeNull();
      for (const value of Object.values(weights!.weights)) {
        expect(value).toBeGreaterThanOrEqual(0.75);
        expect(value).toBeLessThanOrEqual(1.3);
      }

      const runsAfterFirst = await listLearningRuns(h.client, 10);
      expect(runsAfterFirst[0]!.status).toBe('SUCCEEDED');

      // Re-running on the same dataset must not train a second model.
      const second = await runLearningCycle(h.runtime, new Date(now.getTime() + 60_000));
      expect(second.skipped).toBe(true);
      expect(second.summary).toMatch(/already trained/);
      const versionsAfterSecond = await listModelVersions(h.client, 10);
      expect(versionsAfterSecond).toHaveLength(1);

      const runsAfterSecond = await listLearningRuns(h.client, 10);
      const skipped = runsAfterSecond.find((r) => r.status === 'SKIPPED');
      expect(skipped?.error ?? '').toMatch(/already trained/);

      // A new verified outcome changes the dataset, so learning resumes.
      await seedResolved(h, { count: 4, startMs, offset: SAMPLE_COUNT + 2 });
      const third = await runLearningCycle(h.runtime, new Date(now.getTime() + 120_000));
      expect(third.skipped).toBe(false);
      expect(third.checksum).not.toBe(first.checksum);
      const versionsAfterThird = await listModelVersions(h.client, 10);
      expect(versionsAfterThird.length).toBeGreaterThan(versionsAfterSecond.length);

      // A champion may or may not exist, but never more than one.
      const champions = versionsAfterThird.filter((v) => v.status === 'CHAMPION');
      expect(champions.length).toBeLessThanOrEqual(1);
      const champion = await getChampion(h.client);
      if (champion) {
        expect(champion.status).toBe('CHAMPION');
        expect(champion.datasetChecksum).toBe(third.checksum);
      }
    } finally {
      await h.close();
    }
  }, 180_000);

  it('never promotes a candidate that carries no information', async () => {
    const h = await createHarness({
      env: { VORTEX_TRAIN_MIN_SAMPLES: '40', VORTEX_ARTIFACT_DIR: '/tmp/vortex-test-artifacts' },
    });
    try {
      const now = new Date();
      const startMs = now.getTime() - 10 * 24 * HOUR_MS;
      // Constant feature vectors: nothing to learn, so accuracy stays at the
      // base rate and every quality gate must fail.
      await seedResolved(h, { count: SAMPLE_COUNT, startMs, blankFeatures: true });

      const summary = await runLearningCycle(h.runtime, now);
      expect(summary.skipped).toBe(false);
      expect(summary.promoted).toBe(false);
      expect(summary.summary).toMatch(/Keeping the current model/);

      const versions = await listModelVersions(h.client, 5);
      expect(versions).toHaveLength(1);
      expect(versions[0]!.status).toBe('REJECTED');
      const promotion = versions[0]!.promotion as { checks?: { name: string; passed: boolean }[] };
      expect(promotion.checks?.some((c) => !c.passed)).toBe(true);
      // No champion is created, so live inference keeps using the rule ensemble.
      expect(await getChampion(h.client)).toBeNull();
    } finally {
      await h.close();
    }
  }, 180_000);

  it('skips honestly when there are too few labelled outcomes', async () => {
    const h = await createHarness({
      env: { VORTEX_TRAIN_MIN_SAMPLES: '200', VORTEX_ARTIFACT_DIR: '/tmp/vortex-test-artifacts' },
    });
    try {
      await seedResolved(h, { count: 5, startMs: Date.now() - 6 * HOUR_MS });
      const summary = await runLearningCycle(h.runtime, new Date());
      expect(summary.skipped).toBe(true);
      expect(summary.summary).toMatch(/no training run/);
      expect(await listModelVersions(h.client, 5)).toHaveLength(0);
      const runs = await listLearningRuns(h.client, 5);
      expect(runs[0]!.status).toBe('SKIPPED');
      expect(runs[0]!.error ?? '').toMatch(/labelled samples/);
    } finally {
      await h.close();
    }
  }, 120_000);
});
