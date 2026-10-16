/**
 * Telegram delivery.
 *
 * Two rules matter more than the happy path:
 *   1. A signal built from the simulated feed must never reach a real audience
 *      unless it was explicitly allowed (and the refusal is recorded).
 *   2. A response we never received is UNKNOWN — never "sent", never silently
 *      retried, because a duplicate post to subscribers is unrecoverable.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { listDeliveries, listSignals } from '@vortex/db';
import type { SignalRecord } from '@vortex/core';
import { createHarness, type WorkerHarness } from './helpers.js';
import { buildTemplateVars, renderTemplate, DEFAULT_TEMPLATE, SETTLEMENT_TEMPLATE } from '../src/services/telegram.js';

const NOW = '2026-03-03T10:04:00.000Z';

function signal(overrides: Partial<SignalRecord> = {}): SignalRecord {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    idempotencyKey: 'sig|EUR/USD|2026-03-03T10:05:00.000Z|BUY|test',
    pair: 'EUR/USD',
    direction: 'BUY',
    decision: 'BUY',
    status: 'PLANNED',
    strategy: 'trend_follow',
    timeframe: 'M1',
    confidence: 0.71,
    regime: 'TREND_UP',
    scheduledEntryAt: '2026-03-03T10:05:00.000Z',
    publishAt: NOW,
    publishedAt: null,
    horizonSeconds: 60,
    referencePrice: 1.0865,
    stopPips: 10,
    targetPips: 14,
    rewardRisk: 1.4,
    spreadPips: 0.8,
    reasons: ['trend aligned'],
    warnings: [],
    context: { session: 'LONDON', spreadPips: 0.8, spreadSource: 'modelled', synthetic: false } as never,
    modelVersionId: null,
    modelProbability: null,
    engineVersion: 'test',
    outcome: null,
    settledAt: null,
    entryPrice: null,
    exitPrice: null,
    realizedPips: null,
    mfePips: null,
    maePips: null,
    outcomeRule: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Insert the signal row so deliveries have a parent to join to. */
async function seedSignal(h: WorkerHarness, overrides: Partial<SignalRecord> = {}): Promise<SignalRecord> {
  const record = signal(overrides);
  await h.client.query(
    `insert into signals (id, idempotency_key, pair, direction, decision, strategy, timeframe, confidence,
                          regime, scheduled_entry_at, publish_at, horizon_seconds, reference_price,
                          stop_pips, target_pips, reward_risk, spread_pips, reasons, warnings, context,
                          features, engine_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
    [
      record.id,
      record.idempotencyKey,
      record.pair,
      record.direction,
      record.decision,
      record.strategy,
      record.timeframe,
      record.confidence,
      record.regime,
      record.scheduledEntryAt,
      record.publishAt,
      record.horizonSeconds,
      record.referencePrice,
      record.stopPips,
      record.targetPips,
      record.rewardRisk,
      record.spreadPips,
      JSON.stringify(record.reasons),
      JSON.stringify(record.warnings),
      JSON.stringify(record.context),
      JSON.stringify([1, 0.5]),
      record.engineVersion,
    ],
  );
  return record;
}

async function telegramHarness(extraEnv: NodeJS.ProcessEnv = {}): Promise<WorkerHarness> {
  return createHarness({
    env: {
      VORTEX_TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: '123456:TEST-BOT-TOKEN',
      TELEGRAM_CHANNELS: '@vortex_test,@vortex_backup',
      ...extraEnv,
    },
  });
}

function okFetch(messageId = 42) {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telegram delivery', () => {
  it('sends only when the Bot API confirms a message id', async () => {
    const h = await telegramHarness();
    try {
      const fetchMock = okFetch(7);
      vi.stubGlobal('fetch', fetchMock);
      const outcomes = await h.runtime.telegram.deliverSignal(await seedSignal(h), 'PUBLISH');
      expect(outcomes).toHaveLength(2);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('SENT');
        expect(outcome.messageId).toBe('7');
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const ledger = await listDeliveries(h.client, 10);
      expect(ledger.filter((d) => d.status === 'SENT')).toHaveLength(2);
      expect(h.runtime.counters.telegramSent).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('never sends a simulated signal unless it is explicitly allowed', async () => {
    const h = await telegramHarness();
    try {
      const fetchMock = okFetch();
      vi.stubGlobal('fetch', fetchMock);
      const outcomes = await h.runtime.telegram.deliverSignal(
        await seedSignal(h, { warnings: ['synthetic_data_feed'] }),
        'PUBLISH',
      );
      expect(fetchMock).not.toHaveBeenCalled();
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('SKIPPED');
        expect(outcome.detail).toContain('SIMULATED');
      }
      const ledger = await listDeliveries(h.client, 10);
      expect(ledger.map((d) => d.status)).toEqual(['SKIPPED', 'SKIPPED']);
    } finally {
      await h.close();
    }
  });

  it('sends a simulated signal only when the demo switch is on', async () => {
    const h = await telegramHarness({ VORTEX_ALLOW_SYNTHETIC_SIGNALS: 'true' });
    try {
      vi.stubGlobal('fetch', okFetch());
      const outcomes = await h.runtime.telegram.deliverSignal(
        await seedSignal(h, { warnings: ['synthetic_data_feed'] }),
        'PUBLISH',
      );
      expect(outcomes.every((o) => o.status === 'SENT')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('records UNKNOWN — never SENT — when the response is lost', async () => {
    const h = await telegramHarness();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      );
      const outcomes = await h.runtime.telegram.deliverSignal(await seedSignal(h), 'PUBLISH');
      expect(outcomes.every((o) => o.status === 'UNKNOWN')).toBe(true);
      const ledger = await listDeliveries(h.client, 10);
      expect(ledger.every((d) => d.status === 'UNKNOWN')).toBe(true);
      expect(h.runtime.counters.telegramFailed).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('marks a rejected request FAILED and does not retry it inside the same call', async () => {
    const h = await telegramHarness();
    try {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const outcomes = await h.runtime.telegram.deliverSignal(await seedSignal(h), 'PUBLISH');
      expect(outcomes.every((o) => o.status === 'FAILED')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const ledger = await listDeliveries(h.client, 10);
      expect(ledger.every((d) => d.status === 'FAILED')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('is idempotent per signal, channel and phase', async () => {
    const h = await telegramHarness();
    try {
      const fetchMock = okFetch();
      vi.stubGlobal('fetch', fetchMock);
      const record = await seedSignal(h);
      const first = await h.runtime.telegram.deliverSignal(record, 'PUBLISH');
      expect(first.every((o) => o.status === 'SENT')).toBe(true);
      const replay = await h.runtime.telegram.deliverSignal(record, 'PUBLISH');
      expect(replay.every((o) => o.status === 'SKIPPED')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // A settlement message is a different phase and must still be allowed.
      const settlement = await h.runtime.telegram.deliverSignal(record, 'SETTLEMENT', { detail: 'win' });
      expect(settlement.every((o) => o.status === 'SENT')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('reports configuration state honestly when delivery is off', async () => {
    const h = await telegramHarness({ VORTEX_TELEGRAM_ENABLED: 'false' });
    try {
      const config = h.runtime.telegram.configuration();
      expect(config.status).toBe('DISCONNECTED');
      const outcomes = await h.runtime.telegram.deliverSignal(await seedSignal(h), 'PUBLISH');
      expect(outcomes).toEqual([{ channelLabel: 'none', status: 'SKIPPED', detail: config.detail }]);
      expect(await listDeliveries(h.client, 10)).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('requires a destination when delivery is enabled', async () => {
    const h = await telegramHarness({ TELEGRAM_CHANNELS: '' });
    try {
      expect(h.runtime.telegram.configuration().status).toBe('CONFIGURATION REQUIRED');
      expect(h.runtime.telegram.configuration().detail).toContain('No destination channel');
    } finally {
      await h.close();
    }
  });
});

describe('telegram templates', () => {
  it('renders the publish template with every field filled in', () => {
    const text = renderTemplate(DEFAULT_TEMPLATE, buildTemplateVars(signal(), 'PUBLISH'));
    expect(text).toContain('BUY 🟢 EUR/USD');
    expect(text).toContain('`1.086`');
    expect(text).toContain('71%');
    expect(text).toContain('`0.80` pips (modelled)');
    expect(text).toContain('2026-03-03 10:05Z');
    expect(text).toContain('no real-money execution');
    expect(text).not.toMatch(/\{\{[a-zA-Z]+\}\}/);
  });

  it('renders the settlement template with the honest paper-trading note', () => {
    const text = renderTemplate(
      SETTLEMENT_TEMPLATE,
      buildTemplateVars(
        signal({ outcome: 'WIN', realizedPips: 11.2, entryPrice: 1.0865, exitPrice: 1.0877 }),
        'SETTLEMENT',
        { detail: 'stop not touched', entryPrice: 1.0865 },
      ),
    );
    expect(text).toContain('WIN');
    expect(text).toContain('11.2');
    expect(text).toContain('verify independently');
  });

  it('renders a missing placeholder as a dash rather than inventing a value', () => {
    expect(renderTemplate('x {{missing}} y', {})).toBe('x — y');
    expect(renderTemplate('x {{ spaced }} y', { spaced: 'ok' })).toBe('x ok y');
  });
});

describe('delivery ledger integrity', () => {
  it('keeps the ledger joined to real signals', async () => {
    const h = await telegramHarness();
    try {
      vi.stubGlobal('fetch', okFetch());
      await seedSignal(h);
      const outcomes = await h.runtime.telegram.deliverSignal(signal(), 'PUBLISH');
      expect(outcomes.every((o) => o.status === 'SENT')).toBe(true);
      const ledger = await listDeliveries(h.client, 10);
      expect(ledger).toHaveLength(2);
      for (const entry of ledger) {
        expect(entry.signalId).toBe('11111111-1111-1111-1111-111111111111');
        expect(entry.kind).toBe('PUBLISH');
      }
      const stored = await listSignals(h.client, { limit: 1 });
      expect(stored).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
