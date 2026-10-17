/**
 * Performance analytics.
 *
 * Denominators are explicit and never flattering:
 *   decisive  = wins + losses
 *   settled   = decisive + draws
 *   cohort    = settled + unresolved
 *
 * `accuracy` uses the decisive denominator (the honest accuracy of the
 * calls that produced a verdict) and `accuracyConservative` charges every
 * unresolved record as a failure against the whole cohort, so a data outage
 * can never make the system look better than it is.
 */

import { mean, percentile, profitFactor, sharpeRatio, standardDeviation, wilsonInterval } from './stats.js';
import type { Outcome, PerformanceBreakdown, SignalRecord } from './types.js';

export interface PerformanceSummary {
  cohort: number;
  settled: number;
  decisive: number;
  wins: number;
  losses: number;
  draws: number;
  unresolved: number;
  pending: number;
  accuracy: number | null;
  accuracyConservative: number | null;
  accuracyInterval: { lower: number; upper: number } | null;
  avgPips: number | null;
  medianPips: number | null;
  totalPips: number;
  profitFactor: number;
  expectancyPips: number | null;
  stdevPips: number | null;
  sharpe: number;
  maxDrawdownPips: number;
  avgConfidence: number | null;
  /**
   * Confidence calibration gap on the decisive cohort: observed win rate minus
   * the mean confidence of those SAME signals. Unresolved rows are excluded
   * from both sides so the two numbers describe one population.
   */
  calibrationGap: number | null;
  avgUnresolvedRate: number;
}

const PENDING_STATUSES = new Set(['PLANNED', 'PUBLISHED', 'ACTIVE']);

export function summarize(signals: Pick<SignalRecord, 'outcome' | 'realizedPips' | 'confidence' | 'status'>[]): PerformanceSummary {
  const wins = signals.filter((s) => s.outcome === 'WIN');
  const losses = signals.filter((s) => s.outcome === 'LOSS');
  const draws = signals.filter((s) => s.outcome === 'DRAW');
  const unresolved = signals.filter((s) => s.outcome === 'UNRESOLVED');
  const pending = signals.filter((s) => PENDING_STATUSES.has(s.status as string) && !s.outcome);
  const decisive = wins.length + losses.length;
  const settled = decisive + draws.length;
  const cohort = settled + unresolved.length;
  const pips = signals
    .filter((s) => typeof s.realizedPips === 'number' && s.outcome !== 'UNRESOLVED')
    .map((s) => s.realizedPips as number);
  const equity: number[] = [];
  let running = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pips) {
    running += p;
    equity.push(running);
    peak = Math.max(peak, running);
    maxDd = Math.max(maxDd, peak - running);
  }
  const accuracy = decisive === 0 ? null : wins.length / decisive;
  const decisiveSignals = signals.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
  const confidenceValues = decisiveSignals
    .filter((s) => typeof s.confidence === 'number')
    .map((s) => s.confidence);
  const avgConfidence = confidenceValues.length === 0 ? null : mean(confidenceValues);

  return {
    cohort,
    settled,
    decisive,
    wins: wins.length,
    losses: losses.length,
    draws: draws.length,
    unresolved: unresolved.length,
    pending: pending.length,
    accuracy,
    accuracyConservative: cohort === 0 ? null : wins.length / cohort,
    accuracyInterval: decisive === 0 ? null : wilsonInterval(wins.length, decisive),
    avgPips: pips.length === 0 ? null : Number(mean(pips).toFixed(2)),
    medianPips: pips.length === 0 ? null : Number(percentile(pips, 50).toFixed(2)),
    totalPips: Number(pips.reduce((a, b) => a + b, 0).toFixed(2)),
    profitFactor: Number.isFinite(profitFactor(pips)) ? Number(profitFactor(pips).toFixed(2)) : Number.POSITIVE_INFINITY,
    expectancyPips: pips.length === 0 ? null : Number(mean(pips).toFixed(3)),
    stdevPips: pips.length < 2 ? null : Number(standardDeviation(pips).toFixed(3)),
    sharpe: pips.length < 5 ? 0 : Number(sharpeRatio(pips, 24 * 60).toFixed(3)),
    maxDrawdownPips: Number(maxDd.toFixed(2)),
    avgConfidence: avgConfidence === null ? null : Number(avgConfidence.toFixed(4)),
    calibrationGap: avgConfidence === null || accuracy === null ? null : Number((accuracy - avgConfidence).toFixed(4)),
    avgUnresolvedRate: cohort === 0 ? 0 : Number((unresolved.length / cohort).toFixed(4)),
  };
}

function breakdown(key: string, signals: SignalRecord[]): PerformanceBreakdown {
  const wins = signals.filter((s) => s.outcome === 'WIN').length;
  const losses = signals.filter((s) => s.outcome === 'LOSS').length;
  const draws = signals.filter((s) => s.outcome === 'DRAW').length;
  const unresolved = signals.filter((s) => s.outcome === 'UNRESOLVED').length;
  const settled = wins + losses + draws;
  const decisive = wins + losses;
  const pips = signals
    .filter((s) => typeof s.realizedPips === 'number' && s.outcome !== 'UNRESOLVED')
    .map((s) => s.realizedPips as number);
  return {
    key,
    settled,
    wins,
    losses,
    draws,
    unresolved,
    accuracy: decisive === 0 ? null : Number((wins / decisive).toFixed(4)),
    accuracyConservative: settled + unresolved === 0 ? null : Number((wins / (settled + unresolved)).toFixed(4)),
    avgPips: pips.length === 0 ? null : Number(mean(pips).toFixed(2)),
    totalPips: Number(pips.reduce((a, b) => a + b, 0).toFixed(2)),
  };
}

export function groupBy(signals: SignalRecord[], keyFn: (s: SignalRecord) => string): PerformanceBreakdown[] {
  const groups = new Map<string, SignalRecord[]>();
  for (const s of signals) {
    const key = keyFn(s) || 'UNKNOWN';
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, list]) => breakdown(key, list))
    .sort((a, b) => b.settled - a.settled || a.key.localeCompare(b.key));
}

export function byPair(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.pair);
}

export function byStrategy(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.strategy);
}

export function byRegime(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.regime);
}

export function byDecision(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.direction);
}

export function byModel(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.modelVersionId ?? 'no_model');
}

export function byHourUtc(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => String(new Date(s.scheduledEntryAt).getUTCHours()).padStart(2, '0'));
}

export function bySession(signals: SignalRecord[]): PerformanceBreakdown[] {
  return groupBy(signals, (s) => s.context?.session ?? 'UNKNOWN');
}

/**
 * Confidence calibration: bins of predicted confidence against realised win
 * rate, using only decisive outcomes so draws cannot flatter the curve.
 */
export function confidenceCalibration(
  signals: SignalRecord[],
  binCount = 5,
): { lower: number; upper: number; count: number; meanConfidence: number; observedWinRate: number }[] {
  const bins: { lower: number; upper: number; count: number; meanConfidence: number; observedWinRate: number }[] = [];
  for (let b = 0; b < binCount; b += 1) {
    const lower = b / binCount;
    const upper = (b + 1) / binCount;
    const inBin = signals.filter(
      (s) => s.confidence >= lower && (b === binCount - 1 ? s.confidence <= upper : s.confidence < upper),
    );
    const decisive = inBin.filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS');
    if (inBin.length === 0) {
      bins.push({ lower, upper, count: 0, meanConfidence: 0, observedWinRate: 0 });
      continue;
    }
    bins.push({
      lower,
      upper,
      count: inBin.length,
      meanConfidence: Number(mean(inBin.map((s) => s.confidence)).toFixed(4)),
      observedWinRate: decisive.length === 0 ? 0 : Number((decisive.filter((s) => s.outcome === 'WIN').length / decisive.length).toFixed(4)),
    });
  }
  return bins;
}

/**
 * Paper-trading ledger. Simulated only — spread and slippage are charged on
 * every fill and the numbers are labelled as simulation everywhere they are
 * surfaced.
 */
export interface PaperTradeResult {
  trades: number;
  startingBalance: number;
  endingBalance: number;
  netProfit: number;
  returnPercent: number;
  avgPips: number;
  maxDrawdownPercent: number;
  simulated: true;
  assumptions: string[];
}

export function paperTradingPerformance(
  signals: SignalRecord[],
  params: { startingBalance: number; riskPercent: number; slippagePips: number; valuePerPipPerUnit?: number },
): PaperTradeResult {
  const settled = signals
    .filter((s) => (s.outcome === 'WIN' || s.outcome === 'LOSS' || s.outcome === 'DRAW') && typeof s.realizedPips === 'number')
    .sort((a, b) => new Date(a.scheduledEntryAt).getTime() - new Date(b.scheduledEntryAt).getTime());
  let balance = params.startingBalance;
  const equity: number[] = [balance];
  const pips: number[] = [];
  for (const s of settled) {
    const risk = (balance * params.riskPercent) / 100;
    const rMultiple = s.stopPips > 0 ? (s.realizedPips as number) / s.stopPips : 0;
    balance += risk * rMultiple;
    equity.push(balance);
    pips.push(s.realizedPips as number);
  }
  let peak = equity[0] ?? params.startingBalance;
  let maxDd = 0;
  for (const v of equity) {
    peak = Math.max(peak, v);
    maxDd = Math.max(maxDd, (peak - v) / (peak || 1));
  }
  return {
    trades: settled.length,
    startingBalance: params.startingBalance,
    endingBalance: Number(balance.toFixed(2)),
    netProfit: Number((balance - params.startingBalance).toFixed(2)),
    returnPercent: Number((((balance - params.startingBalance) / params.startingBalance) * 100).toFixed(2)),
    avgPips: pips.length === 0 ? 0 : Number(mean(pips).toFixed(2)),
    maxDrawdownPercent: Number((maxDd * 100).toFixed(2)),
    simulated: true,
    assumptions: [
      `fixed-fractional risk of ${params.riskPercent}% of balance per signal`,
      `outcome prices include ${params.slippagePips} pips slippage plus the recorded spread`,
      'each signal is treated as one independent paper position; no compounding beyond the ledger',
      'position sizing ignores broker margin, swap and financing costs',
    ],
  };
}

export function isPending(status: string): boolean {
  return PENDING_STATUSES.has(status);
}

export function outcomeCounts(signals: SignalRecord[]): Record<Outcome | 'PENDING', number> {
  return {
    WIN: signals.filter((s) => s.outcome === 'WIN').length,
    LOSS: signals.filter((s) => s.outcome === 'LOSS').length,
    DRAW: signals.filter((s) => s.outcome === 'DRAW').length,
    UNRESOLVED: signals.filter((s) => s.outcome === 'UNRESOLVED').length,
    PENDING: signals.filter((s) => isPending(s.status)).length,
  };
}
