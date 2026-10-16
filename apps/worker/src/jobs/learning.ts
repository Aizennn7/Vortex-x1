/**
 * Nightly learning pipeline.
 *
 * 1. Pull every resolved outcome (plus its stored feature vector).
 * 2. Build a chronological dataset — DRAW/UNRESOLVED and data-damaged records
 *    are excluded and counted, never guessed.
 * 3. Audit the dataset (duplicates, single class, future timestamps).
 * 4. Train a candidate logistic model and evaluate it with walk-forward folds.
 * 5. Compare against the champion and the majority-class baseline.
 * 6. Promote only when every gate passes; otherwise keep the champion and
 *    record why.
 * 7. Update bounded, aggregated strategy weights and write a drift report.
 *
 * Everything is written to `model_versions` / `learning_runs` so the whole
 * history is auditable and a rollback is a single statement.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  auditDataset,
  baselineMetrics,
  buildDataset,
  chronologicalSplit,
  decidePromotion,
  detectDrift,
  evaluate,
  learnStrategyWeights,
  predictLogistic,
  trainLogistic,
  walkForward,
  type Dataset,
  type ResolvedRecord,
  type TrainingSample,
} from '@vortex/core';
import {
  finishLearningRun,
  getChampion,
  insertModelVersion,
  listResolvedForLearning,
  promoteModel,
  recordArtifact,
  recordDrift,
  rejectModel,
  saveStrategyWeights,
  startLearningRun,
  type SqlClient,
} from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';
import { withJob, type WithJobOptions } from './job.js';

export interface LearningSummary {
  datasetSize: number;
  checksum: string;
  exclusions: Record<string, number>;
  candidateVersion: string | null;
  promoted: boolean;
  summary: string;
  walkForwardAccuracy: number[];
}

export async function runLearningCycle(runtime: WorkerRuntime, now = new Date()): Promise<LearningSummary> {
  const cfg = runtime.config;
  const db = runtime.db.client as SqlClient;
  const summary: LearningSummary = {
    datasetSize: 0,
    checksum: '',
    exclusions: {},
    candidateVersion: null,
    promoted: false,
    summary: '',
    walkForwardAccuracy: [],
  };
  if (!cfg.learningEnabled) {
    summary.summary = 'learning is disabled by configuration';
    return summary;
  }

  const runId = await startLearningRun(db, { workerId: cfg.workerId });
  try {
    const rows = await listResolvedForLearning(db, { sinceDays: 365, limit: 100_000 });
    const records: ResolvedRecord[] = rows.map((row) => ({
      signalId: row.signalId,
      pair: row.pair,
      strategy: row.strategy,
      regime: row.regime,
      confidence: row.confidence,
      decidedAt: row.decidedAt,
      horizonSeconds: row.horizonSeconds,
      outcome: row.outcome,
      outcomeFlags: row.outcomeFlags,
      features: row.features ?? [],
      modelProbability: row.modelProbability,
      engineVersion: row.engineVersion,
    }));

    // Strategy weights are learned from the same resolved population but with
    // their own, lower sample threshold: they are bounded and reversible.
    const weightUpdate = learnStrategyWeights(records, {
      minSamples: Math.max(20, Math.floor(cfg.trainMinSamples / 5)),
      priorStrength: 25,
      version: `${cfg.engineVersion}#weights`,
    });
    const weightSample = records.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS').length;
    if (weightSample >= 20) {
      await saveStrategyWeights(db, {
        version: `${cfg.engineVersion}#weights-${now.toISOString().slice(0, 13)}`,
        weights: weightUpdate.weights,
        evidence: weightUpdate.evidence,
        sampleSize: weightSample,
        notes: `learned from ${weightSample} decisive outcomes; ${weightUpdate.skipped.length} strategy(ies) below the evidence threshold`,
      });
      runtime.models.invalidate();
    }

    const dataset: Dataset = buildDataset(records, {
      checksum: (input) => createHash('sha256').update(input).digest('hex'),
    });
    summary.datasetSize = dataset.samples.length;
    summary.checksum = dataset.checksum;
    summary.exclusions = { ...dataset.exclusions };

    const sourceCounts = tallyOutcomes(records);
    const audit = auditDataset(dataset, cfg.trainMinSamples);
    if (!audit.ok) {
      await finishLearningRun(db, {
        id: runId,
        status: 'SKIPPED',
        datasetChecksum: dataset.checksum,
        datasetSize: dataset.samples.length,
        datasetFrom: dataset.from,
        datasetTo: dataset.to,
        exclusions: { ...dataset.exclusions },
        sourceCounts,
      });
      summary.summary = `no training run: ${audit.issues.slice(0, 3).join('; ')}`;
      return summary;
    }

    const split = chronologicalSplit(dataset.samples, { train: 0.6, validation: 0.2, test: 0.2 }, 60);
    const folds = walkForward(dataset.samples, {
      folds: 4,
      minTrainSize: Math.max(40, Math.floor(dataset.samples.length * 0.4)),
      embargoSeconds: 60,
      train: (trainSamples) => {
        const foldModel = trainLogistic(trainSamples, {
          trainedAt: now.toISOString(),
          datasetChecksum: dataset.checksum,
          version: `fold-${now.toISOString().slice(0, 19)}`,
          epochs: 320,
          learningRate: 0.1,
          l2: 0.02,
          balanceClasses: true,
        });
        return { predict: (features: number[]) => predictLogistic(foldModel, features) };
      },
    });

    const model = trainLogistic(split.train.length >= 40 ? split.train : dataset.samples, {
      trainedAt: now.toISOString(),
      datasetChecksum: dataset.checksum,
      version: `candidate-${now.toISOString().slice(0, 19)}`,
      epochs: 400,
      learningRate: 0.09,
      l2: 0.015,
      balanceClasses: true,
    });

    const testSet: TrainingSample[] = split.test.length >= 20 ? split.test : split.validation;
    const testProbabilities = testSet.map((s) => predictLogistic(model, s.features));
    const testMetrics = evaluate(
      testSet.map((s) => s.label),
      testProbabilities,
    );
    const baselines = baselineMetrics(testSet.length > 0 ? testSet : dataset.samples);
    const champion = await getChampion(db);
    const decision = decidePromotion({
      candidate: {
        metrics: testMetrics,
        walkForward: folds,
        trainedSamples: dataset.samples.length,
        version: model.version,
      },
      champion: champion
        ? { metrics: champion.metrics as never, version: champion.version }
        : null,
      criteria: {
        minSamples: cfg.trainMinSamples,
        minAccuracy: cfg.promotionMinAccuracy,
        minAuc: cfg.promotionMinAuc,
        maxLogLossRegression: cfg.promotionMaxLogLossRegression,
      },
    });

    summary.walkForwardAccuracy = folds.map((f) => Number(f.metrics.accuracy.toFixed(4)));
    const artifact = await persistArtifact(runtime, model, dataset, folds);

    const candidate = await insertModelVersion(db, {
      version: model.version,
      status: 'CANDIDATE',
      datasetChecksum: dataset.checksum,
      datasetSize: dataset.samples.length,
      datasetFrom: dataset.from,
      datasetTo: dataset.to,
      featureNames: [...model.featureNames],
      hyper: model.hyper as unknown as Record<string, unknown>,
      parameters: model as unknown as Record<string, unknown>,
      metrics: testMetrics as unknown as Record<string, unknown>,
      walkForward: folds as unknown as unknown[],
      baselines: baselines.majority as unknown as Record<string, unknown>,
      promotion: decision as unknown as Record<string, unknown>,
      artifactChecksum: artifact.checksum,
      notes: `trained on ${dataset.samples.length} labelled outcomes; ${JSON.stringify(dataset.exclusions)}`,
    });
    summary.candidateVersion = candidate.version;

    if (decision.promote) {
      const result = await promoteModel(db, {
        candidateId: candidate.id,
        promotion: decision as unknown as Record<string, unknown>,
        actor: `worker:${cfg.workerId}`,
      });
      summary.promoted = result.promoted;
      summary.summary = `${decision.summary} Promoted=${result.promoted}.`;
      runtime.models.invalidate();
    } else {
      await rejectModel(db, candidate.id, decision.summary);
      summary.summary = decision.summary;
    }

    await recordDrift(db, buildDriftReport(records));

    await finishLearningRun(db, {
      id: runId,
      status: 'SUCCEEDED',
      datasetChecksum: dataset.checksum,
      datasetSize: dataset.samples.length,
      datasetFrom: dataset.from,
      datasetTo: dataset.to,
      exclusions: { ...dataset.exclusions },
      sourceCounts,
      candidateId: candidate.id,
      promotion: decision as unknown as Record<string, unknown>,
    });
    return summary;
  } catch (error) {
    await finishLearningRun(db, { id: runId, status: 'FAILED', error: (error as Error).message });
    throw error;
  }
}

function tallyOutcomes(records: ResolvedRecord[]): Record<string, number> {
  const counts: Record<string, number> = { WIN: 0, LOSS: 0, DRAW: 0, UNRESOLVED: 0, PENDING: 0 };
  for (const r of records) {
    if (!r.outcome) counts.PENDING = (counts.PENDING ?? 0) + 1;
    else counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  }
  return counts;
}

function buildDriftReport(records: ResolvedRecord[]) {
  const decisive = records
    .filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS')
    .sort((a, b) => new Date(a.decidedAt).getTime() - new Date(b.decidedAt).getTime());
  const recentWindow = decisive.slice(-100);
  const baselineWindow = decisive.slice(-500, -100);
  const count = (list: ResolvedRecord[]) => ({
    wins: list.filter((r) => r.outcome === 'WIN').length,
    losses: list.filter((r) => r.outcome === 'LOSS').length,
  });
  const report = detectDrift(count(recentWindow), count(baselineWindow), { minSamples: 50, accuracyDrop: 0.12 });
  return {
    modelVersionId: null,
    drifting: report.drifting,
    recentAccuracy: report.recentAccuracy,
    baselineAccuracy: report.baselineAccuracy,
    recentSamples: recentWindow.length,
    detail: report.detail,
    action: report.drifting ? 'flagged for review — champion retained until a candidate passes every gate' : 'none',
  };
}

async function persistArtifact(
  runtime: WorkerRuntime,
  model: unknown,
  dataset: Dataset,
  folds: unknown[],
): Promise<{ path: string; checksum: string }> {
  const dir = process.env.VORTEX_ARTIFACT_DIR ?? join(process.cwd(), 'artifacts');
  const payload = JSON.stringify(
    { model, datasetChecksum: dataset.checksum, datasetSize: dataset.samples.length, folds },
    null,
    2,
  );
  const checksum = createHash('sha256').update(payload).digest('hex');
  const path = join(dir, `model-${checksum.slice(0, 12)}.json`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, payload, 'utf8');
    await recordArtifact(runtime.db.client, {
      kind: 'model',
      path,
      checksum,
      bytes: Buffer.byteLength(payload, 'utf8'),
      metadata: { datasetChecksum: dataset.checksum },
    });
  } catch (error) {
    runtime.logger.warn('model artifact could not be written to disk', {
      component: 'learning',
      path,
      error: (error as Error).message,
    });
  }
  return { path, checksum };
}

export async function runLearningJob(
  runtime: WorkerRuntime,
  now = new Date(),
  options: WithJobOptions = {},
): Promise<{ ran: boolean; status: string; detail?: Record<string, unknown> }> {
  const slot = `learning-${now.toISOString().slice(0, 10)}`;
  return withJob(
    runtime,
    'learning_cycle',
    slot,
    async () => {
      const summary = await runLearningCycle(runtime, now);
      return { status: 'SUCCEEDED', detail: { ...summary } };
    },
    { staleAfterSeconds: 3600, alertCode: 'learning-failing', ...options },
  );
}
