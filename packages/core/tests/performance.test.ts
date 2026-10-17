import { describe, expect, it } from 'vitest';
import {
  byPair,
  byStrategy,
  confidenceCalibration,
  groupBy,
  outcomeCounts,
  paperTradingPerformance,
  summarize,
} from '../src/performance.js';
import { redact, redactString, looksSecret } from '../src/secrets.js';
import { assertNoSecrets, loadConfig, publicRuntimeConfig, secretValues, validateConfig } from '../src/config.js';
import type { SignalRecord } from '../src/types.js';

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: Math.random().toString(36).slice(2),
    idempotencyKey: 'k',
    pair: 'EUR/USD',
    direction: 'BUY',
    decision: 'BUY',
    status: 'SETTLED',
    strategy: 'trend_follow',
    timeframe: 'M1',
    confidence: 0.7,
    regime: 'TREND_UP',
    scheduledEntryAt: '2026-01-05T10:05:00.000Z',
    publishAt: '2026-01-05T10:04:00.000Z',
    publishedAt: '2026-01-05T10:04:00.000Z',
    horizonSeconds: 60,
    referencePrice: 1.1,
    stopPips: 10,
    targetPips: 14,
    rewardRisk: 1.4,
    reasons: [],
    warnings: [],
    context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled' } as never,
    modelVersionId: null,
    modelProbability: null,
    engineVersion: 'test',
    outcome: 'WIN',
    settledAt: '2026-01-05T10:06:00.000Z',
    entryPrice: 1.1,
    exitPrice: 1.1012,
    realizedPips: 10,
    mfePips: 11,
    maePips: -2,
    outcomeRule: 'net_after_costs_v1',
    createdAt: '2026-01-05T10:04:00.000Z',
    updatedAt: '2026-01-05T10:06:00.000Z',
    ...overrides,
  };
}

describe('summary denominators', () => {
  it('uses decisive outcomes for accuracy and keeps unresolved visible', () => {
    const signals = [
      signal({ outcome: 'WIN' }),
      signal({ outcome: 'WIN' }),
      signal({ outcome: 'LOSS' }),
      signal({ outcome: 'DRAW' }),
      signal({ outcome: 'UNRESOLVED', realizedPips: null, status: 'UNRESOLVED' }),
    ];
    const summary = summarize(signals);
    expect(summary.decisive).toBe(3);
    expect(summary.settled).toBe(4);
    expect(summary.cohort).toBe(5);
    expect(summary.accuracy).toBeCloseTo(2 / 3, 6);
    // Unresolved records are charged against the cohort, never dropped.
    expect(summary.accuracyConservative).toBeCloseTo(2 / 5, 6);
    expect(summary.unresolved).toBe(1);
  });

  it('reports null accuracy when nothing decisive has happened', () => {
    const summary = summarize([signal({ outcome: null, status: 'PUBLISHED', realizedPips: null })]);
    expect(summary.accuracy).toBeNull();
    expect(summary.pending).toBe(1);
    expect(summary.cohort).toBe(0);
  });

  it('excludes unresolved rows from the pips statistics', () => {
    const summary = summarize([
      signal({ outcome: 'WIN', realizedPips: 5 }),
      signal({ outcome: 'UNRESOLVED', realizedPips: null }),
    ]);
    expect(summary.totalPips).toBe(5);
    expect(summary.avgPips).toBe(5);
  });

  it('computes expectancy and profit factor from settled rows only', () => {
    const summary = summarize([
      signal({ outcome: 'WIN', realizedPips: 10 }),
      signal({ outcome: 'WIN', realizedPips: 10 }),
      signal({ outcome: 'LOSS', realizedPips: -5 }),
    ]);
    expect(summary.expectancyPips).toBeCloseTo(5, 4);
    expect(summary.profitFactor).toBeCloseTo(4, 4);
  });

  it('reports a Wilson interval so small samples are not oversold', () => {
    const summary = summarize([signal({ outcome: 'WIN' }), signal({ outcome: 'LOSS' })]);
    expect(summary.accuracyInterval?.lower).toBeLessThan(0.5);
    expect(summary.accuracyInterval?.upper).toBeGreaterThan(0.5);
  });

  it('keeps unresolved rows out of both sides of the calibration gap', () => {
    const decisive = [
      signal({ outcome: 'WIN', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
    ];
    const withUnresolved = summarize([
      ...decisive,
      // A noisy high-confidence row that never produced a verdict must not
      // move the gap: it belongs to neither numerator nor denominator.
      signal({ outcome: 'UNRESOLVED', confidence: 0.1, realizedPips: null }),
    ]);
    const withoutUnresolved = summarize(decisive);
    expect(withUnresolved.avgConfidence).toBeCloseTo(withoutUnresolved.avgConfidence ?? 0, 6);
    expect(withUnresolved.calibrationGap).toBeCloseTo(withoutUnresolved.calibrationGap ?? 0, 6);
  });

  it('measures the confidence calibration gap', () => {
    const summary = summarize([
      signal({ outcome: 'WIN', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
      signal({ outcome: 'LOSS', confidence: 0.9 }),
    ]);
    expect(summary.avgConfidence).toBeCloseTo(0.9, 5);
    expect(summary.calibrationGap).toBeCloseTo(0.25 - 0.9, 4);
  });
});

describe('breakdowns', () => {
  it('groups by pair and strategy with honest denominators', () => {
    const signals = [
      signal({ pair: 'EUR/USD', outcome: 'WIN', realizedPips: 8 }),
      signal({ pair: 'EUR/USD', outcome: 'LOSS', realizedPips: -6 }),
      signal({ pair: 'GBP/USD', outcome: 'WIN', realizedPips: 4 }),
      signal({ pair: 'GBP/USD', outcome: 'UNRESOLVED', realizedPips: null }),
    ];
    const pairs = byPair(signals);
    const eur = pairs.find((p) => p.key === 'EUR/USD');
    const gbp = pairs.find((p) => p.key === 'GBP/USD');
    expect(eur?.accuracy).toBe(0.5);
    expect(gbp?.accuracy).toBe(1);
    expect(gbp?.accuracyConservative).toBe(0.5);
    expect(gbp?.unresolved).toBe(1);
  });

  it('groups by an arbitrary key and sorts by activity', () => {
    const rows = groupBy([signal(), signal({ strategy: 'momentum' }), signal({ strategy: 'momentum' })], (s) => s.strategy);
    expect(rows[0]?.key).toBe('momentum');
    expect(rows[0]?.settled).toBe(2);
    const strategies = byStrategy([signal()]);
    expect(strategies[0]?.key).toBe('trend_follow');
  });

  it('counts outcomes including pending', () => {
    const counts = outcomeCounts([
      signal({ outcome: 'WIN' }),
      signal({ outcome: 'LOSS' }),
      signal({ outcome: null, status: 'PLANNED' }),
    ]);
    expect(counts.WIN).toBe(1);
    expect(counts.LOSS).toBe(1);
    expect(counts.PENDING).toBe(1);
  });
});

describe('calibration curve', () => {
  it('bins confidence and reports the observed win rate per bin', () => {
    const signals = [
      signal({ confidence: 0.62, outcome: 'WIN' }),
      signal({ confidence: 0.65, outcome: 'LOSS' }),
      signal({ confidence: 0.95, outcome: 'WIN' }),
      signal({ confidence: 0.98, outcome: 'WIN' }),
    ];
    const bins = confidenceCalibration(signals, 5);
    const highBin = bins[bins.length - 1];
    expect(highBin?.observedWinRate).toBe(1);
    // `count` is the denominator behind the rate; `sampleSize` is everything.
    expect(bins.reduce((acc, b) => acc + b.count, 0)).toBe(4);
    expect(bins.reduce((acc, b) => acc + b.sampleSize, 0)).toBe(4);
  });

  it('reports null rather than 0% for a band with no decisive outcome', () => {
    const bins = confidenceCalibration(
      [
        signal({ confidence: 0.95, outcome: 'UNRESOLVED' }),
        signal({ confidence: 0.97, outcome: 'DRAW' }),
        signal({ confidence: 0.66, outcome: 'LOSS' }),
      ],
      5,
    );
    const top = bins[bins.length - 1];
    expect(top?.count).toBe(0);
    expect(top?.sampleSize).toBe(2);
    expect(top?.observedWinRate).toBeNull();
    const second = bins[3];
    expect(second?.observedWinRate).toBe(0);
    expect(second?.count).toBe(1);
  });
});

describe('paper trading', () => {
  it('charges costs and labels itself as a simulation', () => {
    const result = paperTradingPerformance(
      [
        signal({ outcome: 'WIN', realizedPips: 10, stopPips: 10 }),
        signal({ outcome: 'LOSS', realizedPips: -10, stopPips: 10 }),
      ],
      { startingBalance: 10_000, riskPercent: 0.5, slippagePips: 0.2 },
    );
    expect(result.simulated).toBe(true);
    expect(result.trades).toBe(2);
    // Risk is a fixed fraction of the *current* balance, so the second trade
    // risks 0.5% of 10,050 = 50.25 and the ledger ends 0.25 below the start.
    expect(result.endingBalance).toBeCloseTo(9999.75, 2);
    expect(result.netProfit).toBeCloseTo(-0.25, 2);
    expect(result.assumptions.join(' ')).toContain('slippage');
  });

  it('grows the ledger on wins and reports drawdown', () => {
    const result = paperTradingPerformance(
      [
        signal({ outcome: 'WIN', realizedPips: 14, stopPips: 10 }),
        signal({ outcome: 'WIN', realizedPips: 14, stopPips: 10 }),
        signal({ outcome: 'LOSS', realizedPips: -10, stopPips: 10 }),
      ],
      { startingBalance: 1_000, riskPercent: 1, slippagePips: 0 },
    );
    expect(result.netProfit).toBeGreaterThan(0);
    expect(result.maxDrawdownPercent).toBeGreaterThan(0);
  });
});

describe('secret redaction', () => {
  it('redacts values that look like provider keys and tokens', () => {
    const twelveDataKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const telegramToken = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    expect(redactString(`key=${twelveDataKey}`)).not.toContain(twelveDataKey);
    expect(redactString(`token ${telegramToken}`)).not.toContain(telegramToken);
    expect(redactString('postgresql://user:pass@host:5432/db')).toContain('[redacted]');
    expect(looksSecret(twelveDataKey)).toBe(true);
    expect(looksSecret('EUR/USD')).toBe(false);
  });

  it('redacts by field name as well as by value', () => {
    const redacted = redact({ apiKey: 'anything', nested: { bot_token: 'x', pair: 'EUR/USD' } });
    expect((redacted as { apiKey: string }).apiKey).toBe('[redacted]');
    expect((redacted as { nested: { bot_token: string } }).nested.bot_token).toBe('[redacted]');
    expect((redacted as { nested: { pair: string } }).nested.pair).toBe('EUR/USD');
  });

  it('refuses to serialise a payload containing a configured secret', () => {
    expect(() => assertNoSecrets({ ok: true, url: 'x-secret-token-value' }, ['x-secret-token-value'])).toThrow(/secret/);
    expect(() => assertNoSecrets({ ok: true }, ['x-secret-token-value'])).not.toThrow();
  });
});

describe('configuration', () => {
  it('applies safe defaults and derives the public view', () => {
    const cfg = loadConfig({}, { pairs: ['EUR/USD', 'GBP/USD'] } as never);
    expect(cfg.scanCadenceMinutes).toBe(5);
    expect(cfg.publishLeadSeconds).toBe(60);
    expect(cfg.signalHorizonSeconds).toBe(60);
    const publicCfg = publicRuntimeConfig(cfg);
    expect(publicCfg).not.toHaveProperty('adminToken');
    expect(publicCfg).not.toHaveProperty('telegramBotToken');
    expect(publicCfg).not.toHaveProperty('databaseUrl');
  });

  it('reports configuration problems instead of pretending to be ready', () => {
    const cfg = loadConfig({}, { nodeEnv: 'production', databaseUrl: '', adminToken: '', secretKey: '' } as never);
    const issues = validateConfig(cfg);
    const keys = issues.map((i) => i.key);
    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('VORTEX_ADMIN_TOKEN');
    expect(keys).toContain('VORTEX_SECRET_KEY');
  });

  it('never exposes secrets through the public config or the secret list helper', () => {
    const env = {
      VORTEX_ADMIN_TOKEN: 'admin-token-value-1234567890',
      VORTEX_SECRET_KEY: 'c2VjcmV0LWtleS12YWx1ZS0zMi1ieXRlcy1sb25nISE=',
      TELEGRAM_BOT_TOKEN: '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
      DATABASE_URL: 'postgresql://u:p@h:5432/db',
    } as NodeJS.ProcessEnv;
    const cfg = loadConfig(env);
    const publicCfg = JSON.stringify(publicRuntimeConfig(cfg));
    for (const secret of secretValues(cfg)) {
      expect(publicCfg).not.toContain(secret);
    }
  });
});
