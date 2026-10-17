/**
 * VORTEX SI — core domain types.
 *
 * Everything in this package is pure and deterministic so that the trading
 * logic can be unit tested without a network, a database or a clock.
 * Time is always injected; money is always computed from candles.
 */

export type Pair = string; // canonical "EUR/USD" form
export type Timeframe = 'M1' | 'M3' | 'M5' | 'M15' | 'H1';

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  M1: 60,
  M3: 180,
  M5: 300,
  M15: 900,
  H1: 3600,
};

export type Direction = 'BUY' | 'SELL';
export type Decision = Direction | 'NO_TRADE';

export interface Candle {
  pair: Pair;
  timeframe: Timeframe;
  /** Inclusive candle open time, ISO-8601 UTC. */
  openTime: string;
  /** Exclusive candle close time, ISO-8601 UTC. */
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
  provider: string;
  /** True when the provider has confirmed the candle is complete (t+1 convention). */
  isFinal: boolean;
  /** Provider revision counter; >1 means the candle was re-issued/corrected. */
  revision?: number;
  receivedAt?: string;
}

/** Result of validating an ingested candle / candle batch. */
export interface DataQuality {
  ok: boolean;
  /** Candle open times that are missing inside a requested range. */
  gaps: string[];
  /** Duplicate open times found in the payload. */
  duplicates: string[];
  /** Structurally invalid candles (OHLC violations, non-finite values). */
  invalid: string[];
  /** openTime -> reason, when a candle was discarded. */
  reasons: Record<string, string>;
}

export interface StrategyVote {
  strategy: string;
  direction: Decision;
  /** 0..1 conviction of the strategy for its own direction. */
  strength: number;
  reasons: string[];
  warnings: string[];
}

export type Regime = 'TREND_UP' | 'TREND_DOWN' | 'RANGE' | 'VOLATILE' | 'QUIET' | 'UNKNOWN';

export interface RegimeState {
  regime: Regime;
  /** 0..1 confidence in the regime classification. */
  confidence: number;
  atrPips: number;
  atrPercentile: number;
  adx: number;
  reasons: string[];
}

export interface MarketSnapshot {
  pair: Pair;
  /** Candle close time of the newest final M1 candle. */
  asOf: string;
  price: number;
  bid?: number;
  ask?: number;
  spreadPips: number;
  /** Where the spread came from — provider tick data or a documented model. */
  spreadSource: 'provider' | 'modelled';
  /** Upstream data source recorded on every candle (e.g. twelvedata, simulated). */
  dataProvider: string;
  /** True when the candles came from the simulated feed. */
  synthetic: boolean;
  m1: Candle[];
  m3: Candle[];
  /** Freshness of the newest final candle, seconds. */
  ageSeconds: number;
  /** True when the spread is within the configured tolerance. */
  spreadOk: boolean;
  dataQuality: 'OK' | 'STALE' | 'GAPPY' | 'INSUFFICIENT' | 'FUTURE_DATA';
}

export interface PredictionContext {
  pair: Pair;
  /** Decision price = close of the newest final M1 candle. */
  price: number;
  regime: Regime;
  regimeConfidence: number;
  atrPips: number;
  atrPercentile: number;
  spreadPips: number;
  spreadSource: 'provider' | 'modelled';
  /** Provenance carried into the stored signal so it can always be audited. */
  dataProvider: string;
  synthetic: boolean;
  rsi: number;
  adx: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  macdHist: number;
  bbWidthPercentile: number;
  session: Session;
  /** Hour of day (UTC) — used for time-of-day features. */
  hourUtc: number;
  /** Agreement between strategies: 0..1. */
  agreement: number;
  votes: StrategyVote[];
  m3Trend: 'UP' | 'DOWN' | 'FLAT';
  dataQuality: MarketSnapshot['dataQuality'];
}

export type Session = 'SYDNEY' | 'TOKYO' | 'LONDON' | 'NEW_YORK' | 'OVERLAP' | 'OFF_HOURS';

export interface RiskPlan {
  /** Pips at risk from reference price to the protective stop. */
  stopPips: number;
  /** Pips to the profit objective. */
  targetPips: number;
  rewardRisk: number;
  /** Sizing derived from the paper-trading configuration. */
  positionUnits: number;
  riskAmount: number;
}

export interface Prediction {
  pair: Pair;
  /** Instant the signal must reach subscribers (entry minus the publish lead). */
  publishAt: string;
  /** Scheduled entry: exact candle boundary, ISO-8601 UTC. */
  entryTime: string;
  horizonSeconds: number;
  decision: Decision;
  direction: Direction | null;
  confidence: number;
  strategy: string;
  /** Strategy weights used, for reproducibility. */
  weights: Record<string, number>;
  regime: Regime;
  referencePrice: number;
  stopPips: number;
  targetPips: number;
  rewardRisk: number;
  /** Modelled or provider-sourced spread charged to this signal, in pips. */
  spreadPips?: number | null;
  reasons: string[];
  warnings: string[];
  context: PredictionContext;
  /** Model version that contributed a probability, when one is active. */
  modelVersionId: string | null;
  modelProbability: number | null;
  createdAt: string;
  /** Deterministic identity of the opportunity; used for idempotency. */
  idempotencyKey: string;
  engineVersion: string;
}

export type SignalStatus =
  | 'PLANNED'
  | 'PUBLISHED'
  | 'ACTIVE'
  | 'SETTLED'
  | 'UNRESOLVED'
  | 'EXPIRED'
  | 'CANCELLED';

export type Outcome = 'WIN' | 'LOSS' | 'DRAW' | 'UNRESOLVED';

export interface SignalRecord {
  id: string;
  idempotencyKey: string;
  pair: Pair;
  direction: Direction;
  decision: Decision;
  status: SignalStatus;
  strategy: string;
  timeframe: Timeframe;
  confidence: number;
  regime: Regime;
  scheduledEntryAt: string;
  publishAt: string;
  publishedAt: string | null;
  horizonSeconds: number;
  referencePrice: number;
  stopPips: number;
  targetPips: number;
  rewardRisk: number;
  /** Modelled or provider-sourced spread charged to this signal, in pips. */
  spreadPips?: number | null;
  reasons: string[];
  warnings: string[];
  context: PredictionContext;
  modelVersionId: string | null;
  modelProbability: number | null;
  engineVersion: string;
  outcome: Outcome | null;
  settledAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  realizedPips: number | null;
  mfePips: number | null;
  maePips: number | null;
  outcomeRule: string | null;
  /** Why the verdict is what it is — required reading for UNRESOLVED. */
  outcomeDetail?: string | null;
  /** Machine-readable flags attached to the verdict (e.g. data_unavailable). */
  outcomeFlags?: string[];
  grossPips?: number | null;
  /** Charged spread + slippage, in pips. Never hidden from the performance view. */
  costPips?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Aggregated performance view. Denominators are always explicit. */
export interface PerformanceBreakdown {
  key: string;
  settled: number;
  wins: number;
  losses: number;
  draws: number;
  unresolved: number;
  /** wins / (wins + losses); null when no decisive outcome exists. */
  accuracy: number | null;
  /** wins / (settled + unresolved) — never inflates for missing data. */
  accuracyConservative: number | null;
  avgPips: number | null;
  totalPips: number;
}

export interface ProviderUsageSnapshot {
  keyId: string;
  label: string;
  maskedKey: string;
  enabled: boolean;
  status: ApiKeyStatus;
  minuteUsed: number;
  minuteLimit: number;
  dayUsed: number;
  dayLimit: number;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
}

export type ApiKeyStatus = 'ACTIVE' | 'COOLDOWN' | 'EXHAUSTED' | 'INVALID' | 'DISABLED';

export type ServiceStatus =
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'DEGRADED'
  | 'CONFIGURATION REQUIRED'
  | 'NOT VERIFIED';

export interface HealthComponent {
  id: string;
  label: string;
  status: ServiceStatus;
  detail: string;
  /** ISO timestamp of the observation backing this status. */
  observedAt: string;
  metadata?: Record<string, unknown>;
}
