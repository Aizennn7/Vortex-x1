/**
 * Strategy library. Each strategy is a pure function of closed candles and
 * produces a {@link StrategyVote}. Strategies never size positions and never
 * talk to a provider — the ensemble and the risk plan handle that.
 *
 * NO_TRADE is a first-class outcome: a strategy that sees no edge says so.
 */

import { adx, atr, bollinger, donchian, ema, lastDefined, macd, rsi, slope, stochastic, swingPoints } from './indicators.js';
import { instrumentMeta } from './instruments.js';
import type { Candle, Decision, RegimeState, StrategyVote } from './types.js';

export interface StrategyContext {
  m1: Candle[];
  m3: Candle[];
  regime: RegimeState;
  spreadPips: number;
  maxSpreadPips: number;
}

export interface Strategy {
  name: string;
  family: 'trend' | 'momentum' | 'mean_reversion' | 'breakout' | 'volatility' | 'price_action' | 'multi_timeframe';
  description: string;
  minCandles: number;
  evaluate(ctx: StrategyContext): StrategyVote;
}

function noTrade(name: string, reason: string, warnings: string[] = []): StrategyVote {
  return { strategy: name, direction: 'NO_TRADE', strength: 0, reasons: [reason], warnings };
}

function pips(pair: string, distance: number): number {
  return Math.abs(distance) / instrumentMeta(pair).pipSize;
}

function vote(
  name: string,
  direction: Decision,
  strength: number,
  reasons: string[],
  warnings: string[] = [],
): StrategyVote {
  return { strategy: name, direction, strength: Math.max(0, Math.min(1, strength)), reasons, warnings };
}

/** Shared guard: enough data, acceptable spread. */
function precheck(name: string, ctx: StrategyContext, minCandles: number): StrategyVote | null {
  if (ctx.m1.length < minCandles) return noTrade(name, `needs ${minCandles} M1 candles, has ${ctx.m1.length}`);
  if (ctx.spreadPips > ctx.maxSpreadPips) {
    return noTrade(name, `spread ${ctx.spreadPips.toFixed(2)} pips above tolerance`, ['spread_too_wide']);
  }
  return null;
}

export const trendFollow: Strategy = {
  name: 'trend_follow',
  family: 'trend',
  description: 'EMA structure alignment with ADX confirmation.',
  minCandles: 80,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    const values = ctx.m1.map((c) => c.close);
    const fast = lastDefined(ema(values, 9));
    const slow = lastDefined(ema(values, 21));
    const trend = lastDefined(ema(values, 50));
    const adxValue = lastDefined(adx(ctx.m1, 14)) ?? 0;
    if (fast === null || slow === null || trend === null) return noTrade(this.name, 'EMA warm-up incomplete');

    const bullish = fast > slow && slow > trend;
    const bearish = fast < slow && slow < trend;
    if (!bullish && !bearish) return noTrade(this.name, 'EMA structure not aligned');

    const separation = pips(ctx.m1[0]!.pair, fast - slow) / Math.max(1, ctx.regime.atrPips);
    const strength = Math.min(1, 0.35 + Math.min(0.35, separation * 2) + Math.min(0.3, adxValue / 60));
    const direction: Decision = bullish ? 'BUY' : 'SELL';
    return vote(this.name, direction, strength, [
      `EMA9 ${bullish ? '>' : '<'} EMA21 ${bullish ? '>' : '<'} EMA50`,
      `ADX ${adxValue.toFixed(1)} confirms ${bullish ? 'up' : 'down'} structure`,
    ]);
  },
};

export const momentum: Strategy = {
  name: 'momentum',
  family: 'momentum',
  description: 'RSI + MACD histogram agreement.',
  minCandles: 60,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    const values = ctx.m1.map((c) => c.close);
    const rsiValue = lastDefined(rsi(values, 14)) ?? 50;
    const macdResult = macd(values);
    const hist = lastDefined(macdResult.histogram) ?? 0;
    const prevHist = macdResult.histogram[macdResult.histogram.length - 2] ?? 0;
    if (rsiValue > 55 && hist > 0 && hist >= (prevHist ?? 0)) {
      return vote(this.name, 'BUY', Math.min(1, 0.4 + (rsiValue - 55) / 90 + 0.15), [
        `RSI ${rsiValue.toFixed(1)} above 55`,
        'MACD histogram expanding positive',
      ]);
    }
    if (rsiValue < 45 && hist < 0 && hist <= (prevHist ?? 0)) {
      return vote(this.name, 'SELL', Math.min(1, 0.4 + (45 - rsiValue) / 90 + 0.15), [
        `RSI ${rsiValue.toFixed(1)} below 45`,
        'MACD histogram expanding negative',
      ]);
    }
    return noTrade(this.name, `momentum mixed (RSI ${rsiValue.toFixed(1)}, hist ${hist.toFixed(5)})`);
  },
};

export const meanReversion: Strategy = {
  name: 'mean_reversion',
  family: 'mean_reversion',
  description: 'Bollinger band extremes with stochastic confirmation.',
  minCandles: 60,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    if (ctx.regime.regime === 'TREND_UP' || ctx.regime.regime === 'TREND_DOWN') {
      return noTrade(this.name, `disabled in ${ctx.regime.regime} regime`);
    }
    const values = ctx.m1.map((c) => c.close);
    const bb = bollinger(values, 20, 2);
    const stochResult = stochastic(ctx.m1, 14, 3);
    const upper = bb.upper[bb.upper.length - 1] ?? null;
    const lower = bb.lower[bb.lower.length - 1] ?? null;
    const k = lastDefined(stochResult.k) ?? 50;
    const price = ctx.m1[ctx.m1.length - 1]!.close;
    if (upper === null || lower === null) return noTrade(this.name, 'Bollinger warm-up incomplete');

    const bandWidth = upper - lower;
    if (bandWidth <= 0) return noTrade(this.name, 'degenerate band width');
    if (price <= lower && k < 25) {
      const depth = Math.min(1, (lower - price) / bandWidth + 0.4);
      return vote(this.name, 'BUY', depth, [`price at/below lower band`, `stochastic ${k.toFixed(0)} oversold`]);
    }
    if (price >= upper && k > 75) {
      const depth = Math.min(1, (price - upper) / bandWidth + 0.4);
      return vote(this.name, 'SELL', depth, [`price at/above upper band`, `stochastic ${k.toFixed(0)} overbought`]);
    }
    return noTrade(this.name, 'price inside bands');
  },
};

export const breakout: Strategy = {
  name: 'breakout',
  family: 'breakout',
  description: 'Donchian channel break with volatility filter.',
  minCandles: 60,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    const dc = donchian(ctx.m1.slice(0, -1), 20); // exclude the current bar to avoid self-confirmation
    const upper = lastDefined(dc.upper);
    const lower = lastDefined(dc.lower);
    if (upper === null || lower === null) return noTrade(this.name, 'channel warm-up incomplete');
    const bar = ctx.m1[ctx.m1.length - 1]!;
    const range = upper - lower;
    if (range <= 0) return noTrade(this.name, 'degenerate channel');
    if (bar.close > upper) {
      const excess = Math.min(1, (bar.close - upper) / range + 0.45);
      return vote(this.name, 'BUY', excess, [`close broke the 20-bar high (${upper.toFixed(5)})`]);
    }
    if (bar.close < lower) {
      const excess = Math.min(1, (lower - bar.close) / range + 0.45);
      return vote(this.name, 'SELL', excess, [`close broke the 20-bar low (${lower.toFixed(5)})`]);
    }
    return noTrade(this.name, 'no channel break');
  },
};

export const volatilityExpansion: Strategy = {
  name: 'volatility',
  family: 'volatility',
  description: 'ATR expansion with directional close location.',
  minCandles: 60,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    const atrSeries = atr(ctx.m1, 14);
    const atrNow = lastDefined(atrSeries);
    const atrPrev = atrSeries[atrSeries.length - 3] ?? null;
    if (atrNow === null || atrPrev === null) return noTrade(this.name, 'ATR warm-up incomplete');
    const bar = ctx.m1[ctx.m1.length - 1]!;
    const body = bar.close - bar.open;
    const range = Math.max(bar.high - bar.low, 1e-12);
    const closeLocation = (bar.close - bar.low) / range;
    const expanding = atrNow > atrPrev * 1.05;
    if (!expanding) return noTrade(this.name, 'volatility not expanding');
    if (body > 0 && closeLocation > 0.7) {
      return vote(this.name, 'BUY', Math.min(1, 0.4 + closeLocation / 3), [
        `ATR expanding (${pips(bar.pair, atrNow).toFixed(1)} pips)`,
        `close in the top ${Math.round((1 - closeLocation) * 100)}% of the bar`,
      ]);
    }
    if (body < 0 && closeLocation < 0.3) {
      return vote(this.name, 'SELL', Math.min(1, 0.4 + (1 - closeLocation) / 3), [
        `ATR expanding (${pips(bar.pair, atrNow).toFixed(1)} pips)`,
        `close in the bottom ${Math.round(closeLocation * 100)}% of the bar`,
      ]);
    }
    return noTrade(this.name, 'expansion without direction');
  },
};

export const priceAction: Strategy = {
  name: 'price_action',
  family: 'price_action',
  description: 'Higher-high/higher-low structure with pullback entries.',
  minCandles: 60,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    const swings = swingPoints(ctx.m1, 2);
    const highs = swings.highs.slice(-4).map((s) => s.price);
    const lows = swings.lows.slice(-4).map((s) => s.price);
    if (highs.length < 3 || lows.length < 3) return noTrade(this.name, 'not enough swing points');
    const risingHighs = highs[highs.length - 1]! > highs[highs.length - 2]! && highs[highs.length - 2]! > highs[highs.length - 3]!;
    const risingLows = lows[lows.length - 1]! > lows[lows.length - 2]! && lows[lows.length - 2]! > lows[lows.length - 3]!;
    const fallingHighs = highs[highs.length - 1]! < highs[highs.length - 2]! && highs[highs.length - 2]! < highs[highs.length - 3]!;
    const fallingLows = lows[lows.length - 1]! < lows[lows.length - 2]! && lows[lows.length - 2]! < lows[lows.length - 3]!;
    const bar = ctx.m1[ctx.m1.length - 1]!;
    if (risingHighs && risingLows) {
      const pullback = Math.min(1, pips(bar.pair, bar.close - (lows[lows.length - 1] as number)) / Math.max(1, ctx.regime.atrPips));
      return vote(this.name, 'BUY', 0.5 + pullback * 0.3, ['higher highs and higher lows intact']);
    }
    if (fallingHighs && fallingLows) {
      const pullback = Math.min(1, pips(bar.pair, (highs[highs.length - 1] as number) - bar.close) / Math.max(1, ctx.regime.atrPips));
      return vote(this.name, 'SELL', 0.5 + pullback * 0.3, ['lower highs and lower lows intact']);
    }
    return noTrade(this.name, 'no clean structural sequence');
  },
};

export const multiTimeframe: Strategy = {
  name: 'multi_timeframe',
  family: 'multi_timeframe',
  description: 'M3 trend governs, M1 provides the timing trigger.',
  minCandles: 45,
  evaluate(ctx) {
    const guard = precheck(this.name, ctx, this.minCandles);
    if (guard) return guard;
    if (ctx.m3.length < 12) return noTrade(this.name, `needs 12 M3 candles, has ${ctx.m3.length}`);
    const m3Slope = slope(ctx.m3.map((c) => c.close), 10);
    const m1EmaFast = lastDefined(ema(ctx.m1.map((c) => c.close), 9));
    const m1EmaSlow = lastDefined(ema(ctx.m1.map((c) => c.close), 21));
    if (m1EmaFast === null || m1EmaSlow === null) return noTrade(this.name, 'M1 EMA warm-up incomplete');
    const momentumUp = m1EmaFast > m1EmaSlow;
    const m3Up = m3Slope > 0.00005;
    const m3Down = m3Slope < -0.00005;
    if (m3Up && momentumUp) {
      return vote(this.name, 'BUY', Math.min(1, 0.5 + Math.abs(m3Slope) * 400), ['M3 slope up, M1 trigger aligned']);
    }
    if (m3Down && !momentumUp) {
      return vote(this.name, 'SELL', Math.min(1, 0.5 + Math.abs(m3Slope) * 400), ['M3 slope down, M1 trigger aligned']);
    }
    if (m3Up !== m3Down && m3Up !== momentumUp) {
      return noTrade(this.name, 'timeframes conflict', ['mtf_conflict']);
    }
    return noTrade(this.name, 'M3 flat — no directional bias');
  },
};

export const STRATEGIES: Strategy[] = [
  trendFollow,
  momentum,
  meanReversion,
  breakout,
  volatilityExpansion,
  priceAction,
  multiTimeframe,
];

export const STRATEGY_NAMES = STRATEGIES.map((s) => s.name);

export function runStrategies(ctx: StrategyContext, enabled: string[] = STRATEGY_NAMES): StrategyVote[] {
  const active = STRATEGIES.filter((s) => enabled.includes(s.name));
  return active.map((s) => {
    try {
      return s.evaluate(ctx);
    } catch (error) {
      return {
        strategy: s.name,
        direction: 'NO_TRADE' as Decision,
        strength: 0,
        reasons: [`strategy error: ${(error as Error).message}`],
        warnings: ['strategy_error'],
      };
    }
  });
}
