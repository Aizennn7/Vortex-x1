/**
 * Model service — bridges stored model versions to the pure inference code in
 * @vortex/core. The champion and the active strategy weights are cached for a
 * short window so the hot path never queries the database per pair.
 */

import { predictLogistic, type LogisticModel } from '@vortex/core';
import { getActiveStrategyWeights, getChampion, listModelVersions, type ModelVersion, type SqlClient } from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';

export interface LoadedModel {
  versionId: string;
  version: string;
  predict: (features: Record<string, number>) => number;
  trainedAt: string;
  trainedSamples: number;
  datasetChecksum: string;
  metrics: ModelVersion['metrics'];
}

const CACHE_TTL_MS = 60_000;

export class ModelService {
  private championCache: { at: number; model: LoadedModel | null } | null = null;
  private weightsCache: { at: number; weights: Record<string, number> | null; version: string | null } | null = null;

  constructor(private readonly runtime: WorkerRuntime) {}

  private get db(): SqlClient {
    return this.runtime.db.client;
  }

  /** The champion model, or null when none has been promoted yet. */
  async champion(force = false): Promise<LoadedModel | null> {
    const now = Date.now();
    if (!force && this.championCache && now - this.championCache.at < CACHE_TTL_MS) return this.championCache.model;
    const version = await getChampion(this.db);
    const model = version ? toLoadedModel(version) : null;
    this.championCache = { at: now, model };
    return model;
  }

  async strategyWeights(force = false): Promise<{ weights: Record<string, number> | null; version: string | null }> {
    const now = Date.now();
    if (!force && this.weightsCache && now - this.weightsCache.at < CACHE_TTL_MS) {
      return { weights: this.weightsCache.weights, version: this.weightsCache.version };
    }
    const active = await getActiveStrategyWeights(this.db);
    const result = { weights: active?.weights ?? null, version: active?.version ?? null };
    this.weightsCache = { at: now, weights: result.weights, version: result.version };
    return result;
  }

  async versions(limit = 20): Promise<ModelVersion[]> {
    return listModelVersions(this.db, limit);
  }

  invalidate(): void {
    this.championCache = null;
    this.weightsCache = null;
  }
}

export function toLoadedModel(version: ModelVersion): LoadedModel | null {
  const params = version.parameters as Partial<LogisticModel>;
  if (
    !params ||
    !Array.isArray(params.coefficients) ||
    !Array.isArray(params.mean) ||
    !Array.isArray(params.std) ||
    typeof params.intercept !== 'number'
  ) {
    return null;
  }
  const model: LogisticModel = {
    kind: 'logistic_regression',
    version: version.version,
    featureNames: version.featureNames,
    mean: params.mean,
    std: params.std,
    coefficients: params.coefficients,
    intercept: params.intercept,
    hyper: params.hyper ?? { learningRate: 0, l2: 0, epochs: 0, batchSize: 0, classWeight: null },
    trainedAt: version.createdAt,
    trainedSamples: version.datasetSize,
    datasetChecksum: version.datasetChecksum,
  };
  return {
    versionId: version.id,
    version: version.version,
    predict: (features: Record<string, number>) => {
      const values = version.featureNames.map((name) => features[name] ?? 0);
      return predictLogistic(model, values);
    },
    trainedAt: version.createdAt,
    trainedSamples: version.datasetSize,
    datasetChecksum: version.datasetChecksum,
    metrics: version.metrics,
  };
}
