/**
 * Outcome settlement.
 *
 * DOCUMENTED RULES — version `net_after_costs_v1`
 *
 * 1. `entryPrice` is the OPEN of the M1 candle whose openTime equals the
 *    scheduled entry (the first price genuinely tradable at that instant).
 *    If that candle is absent, the first available candle whose openTime lies
 *    within `entryGraceSeconds` is used and the record is flagged
 *    `entry_price_late`. If nothing is available → UNRESOLVED(`missing_entry_candle`).
 * 2. `exitPrice` is the CLOSE of the M1 candle that closes exactly at
 *    `horizonEnd` (one-minute horizon ⇒ the entry candle itself). Missing →
 *    UNRESOLVED(`missing_exit_candle`). Never interpolated.
 * 3. `grossPips  = direction × (exitPrice − entryPrice) / pipSize`
 *    `costPips   = spreadPips + slippagePips` (round-trip spread + configured slippage)
 *    `realizedPips = grossPips − costPips`  ← the number that decides the outcome.
 * 4. `MAE` (max adverse excursion) and `MFE` (max favourable excursion) are
 *    computed from the highs/lows of every candle inside the horizon window,
 *    also net of costs.
 * 5. Protective stop / objective override (worst case first):
 *    - if MAE ≥ stopPips  → LOSS (assumed hit before the objective)
 *    - else if MFE ≥ targetPips → WIN
 * 6. Otherwise: WIN when realizedPips > tiePips, LOSS when < −tiePips,
 *    DRAW when |realizedPips| ≤ tiePips (tiePips default 0.1).
 * 7. A signal whose intent could not be verified against real prices is
 *    recorded UNRESOLVED — never guessed, never counted as a win.
 * 8. Settlement is idempotent: re-running with the same candles yields the
 *    same verdict because every input is an immutable stored candle.
 */

import { toDate, type TimeInput } from './time.js';
import { instrumentMeta, toPips } from './instruments.js';
import { TIMEFRAME_SECONDS, type Candle, type Direction, type Outcome, type SignalStatus } from './types.js';

export const OUTCOME_RULE_VERSION = 'net_after_costs_v1';
export const DEFAULT_TIE_PIPS = 0.1;

export interface SettlementInput {
  pair: string;
  direction: Direction;
  scheduledEntryAt: string;
  horizonSeconds: number;
  stopPips: number;
  targetPips: number;
  spreadPips: number;
  slippagePips: number;
  /** Final M1 candles; may contain candles outside the window. */
  candles: Candle[];
  /** Guards against settling before the data exists. */
  now: TimeInput;
  tiePips?: number;
  entryGraceSeconds?: number;
  exitGraceSeconds?: number;
}

export interface SettlementResult {
  outcome: Outcome;
  status: SignalStatus;
  entryPrice: number | null;
  exitPrice: number | null;
  grossPips: number | null;
  costPips: number;
  realizedPips: number | null;
  mfePips: number | null;
  maePips: number | null;
  flags: string[];
  rule: string;
  detail: string;
  /** Candle open times actually used, for auditability. */
  usedCandles: { entry: string | null; exit: string | null };
}

function pickCandles(
  candles: Candle[],
  entryMs: number,
  horizonEndMs: number,
): { entry: Candle | null; exit: Candle | null; window: Candle[] } {
  const sorted = [...candles].sort((a, b) => new Date(a.openTime).getTime() - new Date(b.openTime).getTime());
  const entry = sorted.find((c) => new Date(c.openTime).getTime() === entryMs) ?? null;
  const exit = sorted.find((c) => new Date(c.closeTime).getTime() === horizonEndMs) ?? null;
  const window = sorted.filter((c) => {
    const open = new Date(c.openTime).getTime();
    const close = new Date(c.closeTime).getTime();
    return close > entryMs && open < horizonEndMs;
  });
  return { entry, exit, window };
}

export function settleSignal(input: SettlementInput): SettlementResult {
  const meta = instrumentMeta(input.pair);
  const tiePips = input.tiePips ?? DEFAULT_TIE_PIPS;
  const entryGrace = input.entryGraceSeconds ?? 45;
  const exitGrace = input.exitGraceSeconds ?? 45;
  const costPips = input.spreadPips + input.slippagePips;
  const entryMs = new Date(input.scheduledEntryAt).getTime();
  const horizonEndMs = entryMs + input.horizonSeconds * 1000;
  const nowMs = toDate(input.now).getTime();
  const flags: string[] = [];

  const base: SettlementResult = {
    outcome: 'UNRESOLVED',
    status: 'UNRESOLVED',
    entryPrice: null,
    exitPrice: null,
    grossPips: null,
    costPips: Number(costPips.toFixed(3)),
    realizedPips: null,
    mfePips: null,
    maePips: null,
    flags,
    rule: OUTCOME_RULE_VERSION,
    detail: '',
    usedCandles: { entry: null, exit: null },
  };

  if (nowMs < horizonEndMs) {
    return { ...base, detail: 'settlement attempted before the horizon elapsed', flags: ['too_early'] };
  }

  const allFinal = input.candles.filter((c) => c.isFinal !== false);
  const { entry: exactEntry, exit: exactExit, window } = pickCandles(allFinal, entryMs, horizonEndMs);

  let entryCandle = exactEntry;
  if (!entryCandle) {
    const candidates = allFinal.filter((c) => {
      const open = new Date(c.openTime).getTime();
      return open >= entryMs && open <= entryMs + entryGrace * 1000;
    });
    entryCandle = candidates[0] ?? null;
    if (entryCandle) flags.push('entry_price_late');
  }
  if (!entryCandle) {
    return { ...base, detail: 'no M1 candle available at the scheduled entry', flags: [...flags, 'missing_entry_candle'] };
  }

  let exitCandle = exactExit ?? window[window.length - 1] ?? null;
  if (!exitCandle) {
    return { ...base, detail: 'no M1 candle available at the horizon end', flags: [...flags, 'missing_exit_candle'] };
  }
  if (!exactExit) {
    const exitDelta = Math.abs(new Date(exitCandle.closeTime).getTime() - horizonEndMs) / 1000;
    if (exitDelta > exitGrace) {
      return {
        ...base,
        detail: `nearest exit candle is ${Math.round(exitDelta)}s away from the horizon end`,
        flags: [...flags, 'exit_price_far_from_horizon'],
      };
    }
    flags.push('exit_price_early');
  }

  const entryPrice = entryCandle.open;
  const exitPrice = exitCandle.close;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0 || exitPrice <= 0) {
    return { ...base, detail: 'non-finite price encountered', flags: [...flags, 'invalid_price'] };
  }

  const dir = input.direction === 'BUY' ? 1 : -1;
  const grossPips = toPips(input.pair, (exitPrice - entryPrice) * dir);
  const realizedPips = grossPips - costPips;

  // Excursions over the whole horizon window (worst case first).
  const highs = window.length > 0 ? Math.max(...window.map((c) => c.high)) : entryPrice;
  const lows = window.length > 0 ? Math.min(...window.map((c) => c.low)) : entryPrice;
  const favorablePrice = input.direction === 'BUY' ? highs : lows;
  const adversePrice = input.direction === 'BUY' ? lows : highs;
  const mfePips = toPips(input.pair, (favorablePrice - entryPrice) * dir) - costPips;
  const maePips = toPips(input.pair, (adversePrice - entryPrice) * dir) - costPips;

  let outcome: Outcome;
  let detail: string;
  const stop = input.stopPips > 0 ? input.stopPips : Number.POSITIVE_INFINITY;
  const target = input.targetPips > 0 ? input.targetPips : Number.POSITIVE_INFINITY;

  if (maePips <= -Math.abs(stop)) {
    outcome = 'LOSS';
    detail = `protective stop reached (MAE ${maePips.toFixed(2)} pips vs stop ${input.stopPips.toFixed(2)})`;
    flags.push('stop_hit');
  } else if (mfePips >= Math.abs(target)) {
    outcome = 'WIN';
    detail = `objective reached (MFE ${mfePips.toFixed(2)} pips vs target ${input.targetPips.toFixed(2)})`;
    flags.push('target_hit');
  } else if (realizedPips > tiePips) {
    outcome = 'WIN';
    detail = `closed ${realizedPips.toFixed(2)} pips net in favour`;
  } else if (realizedPips < -tiePips) {
    outcome = 'LOSS';
    detail = `closed ${realizedPips.toFixed(2)} pips net against`;
  } else {
    outcome = 'DRAW';
    detail = `closed within ±${tiePips} pips after costs`;
    flags.push('draw');
  }

  void meta;
  void TIMEFRAME_SECONDS;

  return {
    outcome,
    status: 'SETTLED',
    entryPrice,
    exitPrice,
    grossPips: Number(grossPips.toFixed(3)),
    costPips: Number(costPips.toFixed(3)),
    realizedPips: Number(realizedPips.toFixed(3)),
    mfePips: Number(mfePips.toFixed(3)),
    maePips: Number(maePips.toFixed(3)),
    flags,
    rule: OUTCOME_RULE_VERSION,
    detail,
    usedCandles: { entry: entryCandle.openTime, exit: exitCandle.openTime },
  };
}

/**
 * Whether an outcome may enter a binary supervised dataset.
 * Only decisive, fully verified verdicts qualify.
 */
export function isLabelEligible(outcome: Outcome | null, flags: string[] = []): boolean {
  if (outcome !== 'WIN' && outcome !== 'LOSS') return false;
  const disqualifying = ['entry_price_late', 'exit_price_early', 'missing_entry_candle', 'missing_exit_candle'];
  return !flags.some((f) => disqualifying.includes(f));
}

export const EXCLUDED_LABELS: Outcome[] = ['DRAW', 'UNRESOLVED'];
