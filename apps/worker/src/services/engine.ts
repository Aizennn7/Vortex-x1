/**
 * Engine service — turns stored market data into scored opportunities.
 *
 * A {@link MarketSnapshot} is assembled from FINAL candles only, quality is
 * evaluated, and the pure ensemble from @vortex/core produces the decision.
 * No network calls happen here: everything reads what ingestion already
 * persisted, which keeps signal generation fast and reproducible.
 */

import {
  aggregate,
  buildFeatures,
  buildRiskPlan,
  buildPrediction,
  detectRegime,
  evaluatePrediction,
  freshness,
  onlyFinal,
  signalIdempotencyKey,
  type Decision,
  type Direction,
  type EngineResult,
  type MarketSnapshot,
  type Prediction,
  type PredictionContext,
  type RegimeState,
  type RiskPlan,
} from '@vortex/core';
import { getCandles, type SqlClient } from '@vortex/db';
import { modelledSpreadPips } from '@vortex/provider';
import type { WorkerRuntime } from '../runtime.js';

export interface PreparedOpportunity {
  pair: string;
  snapshot: MarketSnapshot;
  regime: RegimeState;
  evaluation: EngineResult;
  context: PredictionContext;
  plan: RiskPlan;
  features: Record<string, number>;
  blocked: boolean;
}

export interface BuildSnapshotOptions {
  pair: string;
  maxCandleAgeSeconds: number;
  maxSpreadPips: number;
  /** Spread from a provider quote when one was fetched; otherwise modelled. */
  quote?: { spreadPips: number; source: 'provider' | 'modelled'; price?: number; bid?: number; ask?: number } | null;
  now?: Date;
}

export class EngineService {
  constructor(private readonly runtime: WorkerRuntime) {}

  private get db(): SqlClient {
    return this.runtime.db.client;
  }

  /** Assemble a validated snapshot from persisted candles. */
  async buildSnapshot(options: BuildSnapshotOptions): Promise<MarketSnapshot | null> {
    const now = options.now ?? new Date();
    const rawM1 = await getCandles(this.db, {
      pair: options.pair,
      timeframe: 'M1',
      limit: 400,
      finalOnly: true,
    });
    if (rawM1.length === 0) return null;
    const m1 = onlyFinal(rawM1, now, 'M1');
    // Candles exist but none has closed at `now` (clock skew, a replayed cycle
    // or a feed that is ahead): there is no usable price, so say so instead of
    // throwing inside the cycle.
    if (m1.length === 0) return null;
    const m3 = aggregate(m1, 'M3', rawM1[0]?.provider ?? 'unknown');
    const report = freshness(m1, now, 'M1', options.maxCandleAgeSeconds, 60);
    const last = m1[m1.length - 1]!;
    const spreadPips = options.quote?.spreadPips ?? modelledSpreadPips(options.pair);
    const spreadSource = options.quote?.source ?? 'modelled';
    const spreadOk = spreadPips <= options.maxSpreadPips;
    const price = options.quote?.price && options.quote.price > 0 ? options.quote.price : last.close;
    return {
      pair: options.pair,
      asOf: last.closeTime,
      price,
      bid: options.quote?.bid,
      ask: options.quote?.ask,
      spreadPips,
      spreadSource,
      dataProvider: last.provider || this.runtime.provider.name,
      synthetic: this.runtime.providerSynthetic || last.provider === 'simulated',
      m1,
      m3,
      ageSeconds: report.ageSeconds,
      spreadOk,
      dataQuality: report.quality,
    };
  }

  /**
   * Score one pair. Returns null when the pair has no usable data at all,
   * otherwise a fully-formed opportunity (which may be a NO_TRADE decision).
   */
  async evaluatePair(params: {
    pair: string;
    now: Date;
    quote?: BuildSnapshotOptions['quote'];
  }): Promise<PreparedOpportunity | null> {
    const cfg = this.runtime.config;
    const snapshot = await this.buildSnapshot({
      pair: params.pair,
      maxCandleAgeSeconds: cfg.maxCandleAgeSeconds,
      maxSpreadPips: cfg.maxSpreadPips,
      quote: params.quote ?? null,
      now: params.now,
    });
    if (!snapshot) return null;

    const regime = detectRegime(snapshot.m1, snapshot.m3);
    const model = await this.runtime.models.champion();
    const weights = await this.runtime.models.strategyWeights();

    const { result, context } = evaluatePrediction({
      snapshot,
      regime,
      m1: snapshot.m1,
      m3: snapshot.m3,
      options: {
        engineVersion: cfg.engineVersion,
        minConfidence: cfg.minConfidence,
        minRewardRisk: cfg.minRewardRisk,
        maxSpreadPips: cfg.maxSpreadPips,
        learnedWeights: weights.weights,
        model: model ? { versionId: model.versionId, predict: model.predict } : null,
        modelWeight: 0.35,
        stopAtrMultiple: 1.1,
        targetRewardRisk: Math.max(cfg.minRewardRisk, 1.4),
      },
    });

    const plan = buildRiskPlan({
      pair: snapshot.pair,
      direction: (result.decision === 'NO_TRADE' ? (context.m3Trend === 'DOWN' ? 'SELL' : 'BUY') : result.decision) as Direction,
      price: snapshot.price,
      atrPips: context.atrPips,
      spreadPips: snapshot.spreadPips,
      accountBalance: cfg.paperStartingBalance,
      riskPercent: cfg.paperRiskPercent,
      targetRewardRisk: Math.max(cfg.minRewardRisk, 1.4),
    });

    const features = buildFeatures({
      snapshot,
      context,
      regime,
      votes: result.votes,
      decision: result.decision,
      confidence: result.confidence,
    });

    const blocked = result.decision === 'NO_TRADE';
    return { pair: snapshot.pair, snapshot, regime, evaluation: result, context, plan, features, blocked };
  }

  /** Materialise the immutable prediction record for a scheduled slot. */
  buildPredictionRecord(params: {
    opportunity: PreparedOpportunity;
    entryTime: string;
    publishAt: string;
    now: string;
    horizonSeconds: number;
  }): Prediction {
    const cfg = this.runtime.config;
    return buildPrediction({
      pair: params.opportunity.pair,
      entryTime: params.entryTime,
      publishAt: params.publishAt,
      now: params.now,
      horizonSeconds: params.horizonSeconds,
      snapshot: params.opportunity.snapshot,
      context: params.opportunity.context,
      evaluation: params.opportunity.evaluation,
      plan: params.opportunity.plan,
      engineVersion: cfg.engineVersion,
      idempotencyKey: signalIdempotencyKey({
        pair: params.opportunity.pair,
        entryTime: params.entryTime,
        direction: params.opportunity.evaluation.decision,
        engineVersion: cfg.engineVersion,
      }),
    });
  }

  /** Rank opportunities: decisive first, then by confidence. */
  rank(opportunities: PreparedOpportunity[]): PreparedOpportunity[] {
    return [...opportunities].sort((a, b) => {
      const aBlocked = a.blocked ? 1 : 0;
      const bBlocked = b.blocked ? 1 : 0;
      if (aBlocked !== bBlocked) return aBlocked - bBlocked;
      return b.evaluation.confidence - a.evaluation.confidence;
    });
  }

  summariseBlock(opportunity: PreparedOpportunity): string {
    const failed = opportunity.evaluation.gates.filter((g) => !g.passed).map((g) => g.gate);
    if (failed.length > 0) return failed.join(',');
    return 'no_consensus';
  }

  decisionLabel(decision: Decision): string {
    return decision === 'NO_TRADE' ? 'NO_TRADE' : decision;
  }
}
