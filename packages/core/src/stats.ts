/**
 * Evaluation metrics for the learning pipeline. Deliberately explicit about
 * denominators so that accuracy can never be inflated by unresolved records.
 */

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface CalibrationBin {
  lower: number;
  upper: number;
  count: number;
  meanPredicted: number;
  observedRate: number;
}

export interface EvaluationMetrics {
  samples: number;
  accuracy: number;
  auc: number | null;
  logLoss: number;
  brier: number;
  precision: number;
  recall: number;
  f1: number;
  confusion: ConfusionMatrix;
  calibration: CalibrationBin[];
  /** Expected calibration error weighted by bin population. */
  ece: number;
  baseRate: number;
}

export const EPSILON = 1e-9;

export function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function clampProbability(p: number): number {
  return Math.min(1 - 1e-6, Math.max(1e-6, p));
}

export function logLoss(labels: number[], probabilities: number[]): number {
  if (labels.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const p = clampProbability(probabilities[i] ?? 0.5);
    const y = labels[i] ?? 0;
    sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return sum / labels.length;
}

export function brierScore(labels: number[], probabilities: number[]): number {
  if (labels.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < labels.length; i += 1) {
    const diff = (probabilities[i] ?? 0.5) - (labels[i] ?? 0);
    sum += diff * diff;
  }
  return sum / labels.length;
}

/** Rank-based AUC with tie handling (Mann–Whitney U). */
export function rocAuc(labels: number[], scores: number[]): number | null {
  const positives = labels.filter((l) => l === 1).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const pairs = labels.map((label, i) => ({ label, score: scores[i] ?? 0 }));
  pairs.sort((a, b) => a.score - b.score);
  let rank = 1;
  let i = 0;
  let rankSumPositive = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1]!.score === pairs[i]!.score) j += 1;
    const averageRank = (rank + (rank + (j - i))) / 2;
    for (let k = i; k <= j; k += 1) {
      if (pairs[k]!.label === 1) rankSumPositive += averageRank;
    }
    rank += j - i + 1;
    i = j + 1;
  }
  return (rankSumPositive - (positives * (positives + 1)) / 2) / (positives * negatives);
}

export function calibrationBins(labels: number[], probabilities: number[], binCount = 10): CalibrationBin[] {
  const bins: CalibrationBin[] = [];
  for (let b = 0; b < binCount; b += 1) {
    const lower = b / binCount;
    const upper = (b + 1) / binCount;
    const idx = labels
      .map((_, i) => i)
      .filter((i) => {
        const p = probabilities[i] ?? 0.5;
        return p >= lower && (b === binCount - 1 ? p <= upper : p < upper);
      });
    if (idx.length === 0) {
      bins.push({ lower, upper, count: 0, meanPredicted: 0, observedRate: 0 });
      continue;
    }
    const meanPredicted = idx.reduce((acc, i) => acc + (probabilities[i] ?? 0), 0) / idx.length;
    const observedRate = idx.reduce((acc, i) => acc + (labels[i] ?? 0), 0) / idx.length;
    bins.push({ lower, upper, count: idx.length, meanPredicted, observedRate });
  }
  return bins;
}

export function expectedCalibrationError(bins: CalibrationBin[], total: number): number {
  if (total === 0) return 0;
  return bins.reduce((acc, b) => acc + (b.count / total) * Math.abs(b.observedRate - b.meanPredicted), 0);
}

export function evaluate(labels: number[], probabilities: number[], threshold = 0.5): EvaluationMetrics {
  const n = labels.length;
  const predicted = probabilities.map((p) => (p >= threshold ? 1 : 0));
  const confusion: ConfusionMatrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (let i = 0; i < n; i += 1) {
    const y = labels[i] ?? 0;
    const p = predicted[i] ?? 0;
    if (y === 1 && p === 1) confusion.tp += 1;
    else if (y === 0 && p === 1) confusion.fp += 1;
    else if (y === 0 && p === 0) confusion.tn += 1;
    else confusion.fn += 1;
  }
  const accuracy = n === 0 ? 0 : (confusion.tp + confusion.tn) / n;
  const precision = confusion.tp + confusion.fp === 0 ? 0 : confusion.tp / (confusion.tp + confusion.fp);
  const recall = confusion.tp + confusion.fn === 0 ? 0 : confusion.tp / (confusion.tp + confusion.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const bins = calibrationBins(labels, probabilities);
  return {
    samples: n,
    accuracy,
    auc: rocAuc(labels, probabilities),
    logLoss: logLoss(labels, probabilities),
    brier: brierScore(labels, probabilities),
    precision,
    recall,
    f1,
    confusion,
    calibration: bins,
    ece: expectedCalibrationError(bins, n),
    baseRate: n === 0 ? 0 : labels.filter((l) => l === 1).length / n,
  };
}

/** Wilson score interval — honest small-sample uncertainty reporting. */
export function wilsonInterval(successes: number, total: number, z = 1.96): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };
  const phat = successes / total;
  const denom = 1 + (z * z) / total;
  const centre = phat + (z * z) / (2 * total);
  const spread = z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total));
  return { lower: Math.max(0, (centre - spread) / denom), upper: Math.min(1, (centre + spread) / denom) };
}

/** Two-proportion z-test used before allowing a change of behaviour. */
export function twoProportionZTest(aSuccess: number, aTotal: number, bSuccess: number, bTotal: number): number {
  if (aTotal === 0 || bTotal === 0) return 0;
  const pA = aSuccess / aTotal;
  const pB = bSuccess / bTotal;
  const pooled = (aSuccess + bSuccess) / (aTotal + bTotal);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / aTotal + 1 / bTotal));
  if (se === 0) return 0;
  return (pA - pB) / se;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx] as number;
}

export function sharpeRatio(returns: number[], periodsPerYear = 252): number {
  const sd = standardDeviation(returns);
  if (sd === 0) return 0;
  return (mean(returns) / sd) * Math.sqrt(periodsPerYear);
}

export function maxDrawdown(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.min(worst, (v - peak) / peak);
  }
  return Math.abs(worst);
}

export function profitFactor(pips: number[]): number {
  const gross = pips.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const loss = Math.abs(pips.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  if (loss === 0) return gross > 0 ? Number.POSITIVE_INFINITY : 0;
  return gross / loss;
}
