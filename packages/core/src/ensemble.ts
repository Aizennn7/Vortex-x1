/**
 * Prediction ensemble.
 *
 * Votes from every enabled strategy are combined using regime-aware weights,
 * then filtered through hard gates (data quality, spread, confidence, regime
 * confidence, model probability). If a gate fails the engine returns NO_TRADE
 * — a real, recorded and respected decision, never a hidden failure.
 */

import { buildFeatures, computeContext } from './features.js';
import { instrumentMeta } from './instruments.js';
import { REGIME_WEIGHTS } from './regime.js';
import { STRATEGY_NAMES, runStrategies, type StrategyContext } from './strategies.js';
import { clamp } from './indicators.js';
import type {
  Direction,
  MarketSnapshot,
  Prediction,
  PredictionContext,
  RegimeState,
  RiskPlan,
  StrategyVote,
} from './types.js';

export const ENGINE_VERSION_FALLBACK = 'vortex-engine-1.0.0';

export interface EngineOptions {
  engineVersion: string;
  minConfidence: number;
  minRewardRisk: number;
  maxSpreadPips: number;
  enabledStrategies?: string[];
  /** Optional learned model probability for the ensemble direction. */
  model?: { versionId: string; predict(features: ReturnType<typeof buildFeatures>): number } | null;
  /** Strategy weights learned from resolved outcomes (multiplicative). */
  learnedWeights?: Record<string, number> | null;
  /** Reward:risk targets. */
  targetRewardRisk?: number;
  /** Stop distance as a multiple of ATR. */
  stopAtrMultiple?: number;
  /** Hard cap on confidence from a single model, to avoid over-trust. */
  modelWeight?: number;
}

export interface EngineResult {
  decision: Direction | 'NO_TRADE';
  confidence: number;
  votes: StrategyVote[];
  reasons: string[];
  warnings: string[];
  weights: Record<string, number>;
  modelProbability: number | null;
  modelVersionId: string | null;
  gates: { gate: string; passed: boolean; detail: string }[];
}

const DEFAULT_STOP_ATR_MULTIPLE = 1.1;
const DEFAULT_TARGET_RR = 1.4;

/**
 * Convert votes into a decision.
 * Direction score = Σ(weighted strength × direction) / Σ(weighted strength).
 */
export function combineVotes(
  votes: StrategyVote[],
  regime: RegimeState,
  learnedWeights: Record<string, number> | null = null,
): { direction: Direction | 'NO_TRADE'; score: number; weights: Record<string, number>; agreement: number } {
  const regimeWeights = REGIME_WEIGHTS[regime.regime] ?? REGIME_WEIGHTS.UNKNOWN;
  const weights: Record<string, number> = {};
  let numerator = 0;
  let denominator = 0;
  let buy = 0;
  let sell = 0;

  for (const v of votes) {
    const base = regimeWeights[v.strategy] ?? 1;
    const learned = learnedWeights?.[v.strategy] ?? 1;
    const weight = base * learned;
    weights[v.strategy] = weight;
    if (v.direction === 'NO_TRADE') continue;
    const signed = (v.direction === 'BUY' ? 1 : -1) * v.strength * weight;
    numerator += signed;
    denominator += v.strength * weight;
    if (v.direction === 'BUY') buy += 1;
    else sell += 1;
  }

  if (denominator === 0) return { direction: 'NO_TRADE', score: 0, weights, agreement: 0 };
  const score = numerator / denominator;
  const actionable = buy + sell;
  const agreement = actionable === 0 ? 0 : Math.max(buy, sell) / actionable;
  const direction: Direction | 'NO_TRADE' = score > 0 ? 'BUY' : score < 0 ? 'SELL' : 'NO_TRADE';
  return { direction, score, weights, agreement };
}

export function evaluatePrediction(params: {
  snapshot: MarketSnapshot;
  regime: RegimeState;
  m1: import('./types.js').Candle[];
  m3: import('./types.js').Candle[];
  options: EngineOptions;
}): { result: EngineResult; context: PredictionContext } {
  const { snapshot, regime, m1, m3, options } = params;
  const strategyCtx: StrategyContext = {
    m1,
    m3,
    regime,
    spreadPips: snapshot.spreadPips,
    maxSpreadPips: options.maxSpreadPips,
  };
  const votes = runStrategies(strategyCtx, options.enabledStrategies ?? STRATEGY_NAMES);
  const combined = combineVotes(votes, regime, options.learnedWeights ?? null);
  const context = computeContext({ snapshot, regime, votes, m1, m3 });

  const reasons: string[] = [];
  const warnings: string[] = [];
  const gates: EngineResult['gates'] = [];
  const addGate = (gate: string, passed: boolean, detail: string) => {
    gates.push({ gate, passed, detail });
    if (!passed) warnings.push(gate);
  };

  addGate(
    'data_quality',
    snapshot.dataQuality === 'OK',
    snapshot.dataQuality === 'OK' ? 'fresh, gap-free data' : `data quality is ${snapshot.dataQuality}`,
  );
  addGate('spread', snapshot.spreadOk, `spread ${snapshot.spreadPips.toFixed(2)} / max ${options.maxSpreadPips}`);
  addGate(
    'regime_confidence',
    regime.regime !== 'UNKNOWN' && regime.confidence >= 0.35,
    `regime ${regime.regime} @ ${regime.confidence.toFixed(2)}`,
  );
  addGate('strategy_consensus', combined.agreement >= 0.6, `agreement ${combined.agreement.toFixed(2)}`);

  const directionVotes = votes.filter((v) => v.direction === combined.direction && v.direction !== 'NO_TRADE');
  const opposingVotes = votes.filter((v) => v.direction !== 'NO_TRADE' && v.direction !== combined.direction);

  const baseConfidence =
    directionVotes.length === 0
      ? 0
      : directionVotes.reduce((acc, v) => acc + v.strength, 0) / Math.max(directionVotes.length, 1);

  const consensusFactor = 0.55 + combined.agreement * 0.45;
  const regimeFactor = 0.75 + clamp(regime.confidence) * 0.25;
  const magnitudeFactor = 0.6 + clamp(Math.abs(combined.score)) * 0.4;

  let modelProbability: number | null = null;
  let modelVersionId: string | null = null;
  let weightedConfidence = baseConfidence * consensusFactor * regimeFactor * magnitudeFactor;

  if (options.model && combined.direction !== 'NO_TRADE') {
    try {
      const features = buildFeatures({
        snapshot,
        context,
        regime,
        votes,
        decision: combined.direction,
        confidence: weightedConfidence,
      });
      const p = options.model.predict(features);
      if (Number.isFinite(p)) {
        modelProbability = clamp(p);
        modelVersionId = options.model.versionId;
        const modelWeight = clamp(options.modelWeight ?? 0.35, 0, 0.6);
        // Model output is treated as a probability OF the ensemble direction,
        // so distance from 0.5 translates into confidence above/below neutral.
        const modelConfidence = 0.5 + Math.abs(modelProbability - 0.5) * 2 * (modelProbability >= 0.5 ? 1 : -1);
        weightedConfidence = weightedConfidence * (1 - modelWeight) + Math.max(0, modelConfidence) * modelWeight;
        addGate(
          'model_agreement',
          modelProbability >= 0.5,
          `model P(${combined.direction}) = ${modelProbability.toFixed(3)}`,
        );
      }
    } catch (error) {
      warnings.push('model_error');
      reasons.push(`model unavailable: ${(error as Error).message}`);
    }
  }

  const confidence = clamp(weightedConfidence);
  const hasHardFail = gates.some(
    (g) => !g.passed && ['data_quality', 'spread', 'regime_confidence', 'strategy_consensus'].includes(g.gate),
  );
  const belowThreshold = confidence < options.minConfidence;
  addGate('confidence', !belowThreshold, `confidence ${confidence.toFixed(3)} / min ${options.minConfidence}`);

  if (directionVotes.length > 0) {
    reasons.push(...directionVotes.flatMap((v) => v.reasons.map((r) => `${v.strategy}: ${r}`)).slice(0, 8));
  }
  if (opposingVotes.length > 0) {
    reasons.push(
      `dissent: ${opposingVotes.map((v) => v.strategy).join(', ')} favour ${opposingVotes[0]!.direction}`,
    );
  }
  warnings.push(...votes.flatMap((v) => v.warnings).filter((w, i, arr) => arr.indexOf(w) === i));

  const decision: Direction | 'NO_TRADE' =
    hasHardFail || belowThreshold || combined.direction === 'NO_TRADE' ? 'NO_TRADE' : combined.direction;

  if (decision === 'NO_TRADE') {
    // Abstention is a first-class outcome: the failed gate names are the
    // machine-readable reason, and every signal built from this evaluation
    // carries them into the database.
    const abstainReason =
      gates
        .filter((g) => !g.passed)
        .map((g) => g.gate)
        .join(', ') || 'no directional consensus';
    reasons.unshift(`NO-TRADE: ${abstainReason}`);
    addGate('abstained', false, abstainReason);
  }

  return {
    result: {
      decision,
      // `confidence` is a 0..1 ranking score for the ensemble's own call — it is
      // NOT a probability. `modelProbability` is the only calibrated number in
      // this result, and it is null when no model is loaded.
      confidence: Number(confidence.toFixed(4)),
      votes,
      reasons,
      warnings: [...new Set(warnings)],
      weights: combined.weights,
      modelProbability,
      modelVersionId,
      gates,
    },
    context,
  };
}

/** Stop/target plan derived from ATR and the configured reward:risk target. */
export function buildRiskPlan(params: {
  pair: string;
  direction: Direction;
  price: number;
  atrPips: number;
  spreadPips: number;
  accountBalance: number;
  riskPercent: number;
  stopAtrMultiple?: number;
  targetRewardRisk?: number;
  /** Account currency per pip per standard lot, rarely needed for paper math. */
  valuePerPipPerUnit?: number;
}): RiskPlan {
  const meta = instrumentMeta(params.pair);
  const stopAtrMultiple = params.stopAtrMultiple ?? DEFAULT_STOP_ATR_MULTIPLE;
  const targetRr = params.targetRewardRisk ?? DEFAULT_TARGET_RR;
  const spreadBuffer = Math.max(params.spreadPips, meta.pipSize === 0.01 ? 0.6 : 0.9);
  const stopPips = Math.max(2.5, params.atrPips * stopAtrMultiple + spreadBuffer * 0.5);
  const targetPips = stopPips * targetRr;
  const riskAmount = (params.accountBalance * params.riskPercent) / 100;
  const pipValuePerUnit = meta.pipSize; // quote-currency pips per unit
  const units = stopPips === 0 ? 0 : riskAmount / (stopPips * pipValuePerUnit);
  return {
    stopPips: Number(stopPips.toFixed(2)),
    targetPips: Number(targetPips.toFixed(2)),
    rewardRisk: Number(targetRr.toFixed(2)),
    positionUnits: Math.max(0, Math.round(units)),
    riskAmount: Number(riskAmount.toFixed(2)),
  };
}

/** Assemble the immutable prediction record persisted by the worker. */
export function buildPrediction(params: {
  pair: string;
  entryTime: string;
  publishAt: string;
  now: string;
  horizonSeconds: number;
  snapshot: MarketSnapshot;
  context: PredictionContext;
  evaluation: EngineResult;
  plan: RiskPlan;
  engineVersion: string;
  idempotencyKey: string;
}): Prediction {
  const { evaluation } = params;
  // Provenance is never lost: a signal built from the simulated feed carries a
  // warning, which is what the delivery layer checks before publishing.
  const warnings = params.context.synthetic
    ? [...evaluation.warnings.filter((w) => w !== 'synthetic_data_feed'), 'synthetic_data_feed']
    : [...evaluation.warnings];
  return {
    pair: params.pair,
    publishAt: params.publishAt,
    entryTime: params.entryTime,
    horizonSeconds: params.horizonSeconds,
    decision: evaluation.decision,
    direction: evaluation.decision === 'NO_TRADE' ? null : evaluation.decision,
    confidence: evaluation.confidence,
    strategy: dominantStrategy(evaluation.votes, evaluation.decision),
    weights: evaluation.weights,
    regime: params.context.regime,
    referencePrice: params.snapshot.price,
    stopPips: params.plan.stopPips,
    targetPips: params.plan.targetPips,
    rewardRisk: params.plan.rewardRisk,
    reasons: evaluation.reasons,
    warnings,
    context: params.context,
    modelVersionId: evaluation.modelVersionId,
    modelProbability: evaluation.modelProbability,
    createdAt: params.now,
    idempotencyKey: params.idempotencyKey,
    engineVersion: params.engineVersion,
  };
}

export function dominantStrategy(votes: StrategyVote[], decision: Direction | 'NO_TRADE'): string {
  if (decision === 'NO_TRADE') {
    const best = [...votes].sort((a, b) => b.strength - a.strength)[0];
    return best ? `none (${best.strategy} strongest)` : 'none';
  }
  const eligible = votes.filter((v) => v.direction === decision);
  if (eligible.length === 0) return 'ensemble';
  return eligible.sort((a, b) => b.strength - a.strength)[0]!.strategy;
}
