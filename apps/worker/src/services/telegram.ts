/**
 * Telegram delivery.
 *
 * Honesty rules implemented here:
 *   - The bot token is read from the server environment and never logged,
 *     echoed or stored in the database.
 *   - A message is reported SENT only when the Bot API returns `ok: true` and
 *     a `message_id`. A network failure after the request was accepted is
 *     recorded as UNKNOWN (retry would risk a duplicate post) rather than
 *     being reported as delivered or silently retried.
 *   - Delivery is idempotent per (signal, channel, phase) via signal_deliveries.
 *   - Retries are bounded; failures raise alerts.
 */

import type { SignalRecord } from '@vortex/core';
import { claimDelivery, completeDelivery, listChannels, type DeliveryKind, type TelegramChannel } from '@vortex/db';
import type { WorkerRuntime } from '../runtime.js';

export interface DeliveryOutcome {
  channelLabel: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';
  detail: string;
  messageId?: string;
}

export interface TelegramSendResult {
  ok: boolean;
  messageId?: string;
  status: number;
  description?: string;
  /** True when the request may have been accepted but the response was lost. */
  uncertain?: boolean;
}

export const DEFAULT_TEMPLATE = [
  '🛰️ *VORTEX SI* — {{side}} {{pair}}',
  '━━━━━━━━━━━━━━━',
  '⏱ Entry (UTC): `{{entry}}`',
  '💠 Reference: `{{reference}}`',
  '🎯 Target: `{{target}}`  ·  🛑 Stop: `{{stop}}`',
  '📊 Confidence: `{{confidence}}`  ·  R:R `{{rr}}`',
  '🌐 Regime: `{{regime}}`  ·  {{strategy}}',
  '💵 Spread: `{{spread}}` pips ({{spreadSource}})',
  '🧠 {{reason}}',
  '',
  '_Signal only — no real-money execution. Not financial advice._',
].join('\n');

export const SETTLEMENT_TEMPLATE = [
  '{{emoji}} *VORTEX SI* — {{pair}} {{side}} settled: *{{outcome}}*',
  '⏱ Entry (UTC): `{{entry}}`',
  '📥 In: `{{entryPrice}}`  ·  📤 Out: `{{exitPrice}}`',
  '📈 Net: `{{pips}}` pips ({{rule}})',
  '🧾 {{detail}}',
  '_Paper/simulation accounting — verify independently before acting._',
].join('\n');

export class TelegramClient {
  constructor(private readonly runtime: WorkerRuntime) {}

  get enabled(): boolean {
    return this.runtime.config.telegramEnabled && this.runtime.config.telegramBotToken.length > 0;
  }

  /** Configuration state, reported honestly by the control centre. */
  configuration(): { status: 'CONNECTED' | 'CONFIGURATION REQUIRED' | 'DISCONNECTED'; detail: string } {
    if (!this.runtime.config.telegramEnabled) {
      return { status: 'DISCONNECTED', detail: 'Telegram delivery is disabled in configuration.' };
    }
    if (this.runtime.config.telegramBotToken.length === 0) {
      return { status: 'CONFIGURATION REQUIRED', detail: 'TELEGRAM_BOT_TOKEN is not set on the server.' };
    }
    if (this.runtime.config.telegramChannels.length === 0) {
      return { status: 'CONFIGURATION REQUIRED', detail: 'No destination channel is configured.' };
    }
    return { status: 'CONNECTED', detail: `${this.runtime.config.telegramChannels.length} destination(s) configured.` };
  }

  /** Live verification against the Bot API — used by the control centre "Test" button. */
  async verify(): Promise<{ ok: boolean; detail: string; username?: string }> {
    if (!this.enabled) return { ok: false, detail: this.configuration().detail };
    const result = await this.request('getMe', {});
    if (!result.ok) return { ok: false, detail: result.description ?? `HTTP ${result.status}` };
    const body = result.raw as { result?: { username?: string; first_name?: string } };
    return { ok: true, detail: `bot @${body.result?.username ?? 'unknown'} reachable`, username: body.result?.username };
  }

  /** Send a plain message. Returns the honest outcome, never a guess. */
  async sendMessage(chatId: string, text: string, options: { disablePreview?: boolean } = {}): Promise<TelegramSendResult> {
    if (!this.enabled) {
      return { ok: false, status: 0, description: 'Telegram delivery is not configured' };
    }
    return this.request('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: options.disablePreview ?? true,
    });
  }

  /** Deliver a signal to every enabled channel, idempotently. */
  async deliverSignal(signal: SignalRecord, kind: DeliveryKind, extra: Record<string, unknown> = {}): Promise<DeliveryOutcome[]> {
    // Nothing was attempted, so nothing failed: an unconfigured integration
    // reports SKIPPED with the reason, never FAILED.
    if (!this.enabled) {
      return [{ channelLabel: 'none', status: 'SKIPPED', detail: this.configuration().detail }];
    }
    const channels = await this.resolveChannels();
    if (channels.length === 0) {
      return [{ channelLabel: 'none', status: 'SKIPPED', detail: this.configuration().detail }];
    }
    // Synthetic-source guard: candles produced by the simulated provider must
    // never be delivered to a real audience by accident. The refusal is written
    // to the delivery ledger so it is visible rather than silent.
    if (isSynthetic(signal) && !this.runtime.config.allowSyntheticSignals) {
      const detail =
        'signal derived from the SIMULATED data feed — delivery disabled. Set VORTEX_ALLOW_SYNTHETIC_SIGNALS=true only for a labelled demo.';
      const outcomes: DeliveryOutcome[] = [];
      for (const channel of channels) {
        const claim = await claimDelivery(this.runtime.db.client, {
          signalId: signal.id,
          channelLabel: channel.label,
          kind,
          maxAttempts: 1,
        });
        if (claim.shouldSend && claim.deliveryId) {
          await completeDelivery(this.runtime.db.client, {
            deliveryId: claim.deliveryId,
            status: 'SKIPPED',
            error: detail,
          });
        }
        outcomes.push({ channelLabel: channel.label, status: 'SKIPPED', detail });
      }
      this.runtime.logger.warn('synthetic signal delivery blocked', {
        component: 'telegram',
        signalId: signal.id,
        pair: signal.pair,
      });
      return outcomes;
    }
    const outcomes: DeliveryOutcome[] = [];
    for (const channel of channels) {
      const claim = await claimDelivery(this.runtime.db.client, {
        signalId: signal.id,
        channelLabel: channel.label,
        kind,
        maxAttempts: 3,
      });
      if (!claim.shouldSend || !claim.deliveryId) {
        outcomes.push({ channelLabel: channel.label, status: 'SKIPPED', detail: claim.reason });
        continue;
      }
      const template = channel.template ?? (kind === 'PUBLISH' ? DEFAULT_TEMPLATE : SETTLEMENT_TEMPLATE);
      const text = renderTemplate(template, buildTemplateVars(signal, kind, extra));
      const result = await this.sendMessage(channel.chatId, text);
      if (result.ok && result.messageId) {
        await completeDelivery(this.runtime.db.client, {
          deliveryId: claim.deliveryId,
          status: 'SENT',
          messageId: result.messageId,
        });
        this.runtime.bump('telegramSent');
        outcomes.push({ channelLabel: channel.label, status: 'SENT', detail: 'confirmed by Bot API', messageId: result.messageId });
        continue;
      }
      const status = result.uncertain ? 'UNKNOWN' : 'FAILED';
      await completeDelivery(this.runtime.db.client, {
        deliveryId: claim.deliveryId,
        status,
        error: result.description ?? `HTTP ${result.status}`,
      });
      this.runtime.bump('telegramFailed');
      outcomes.push({
        channelLabel: channel.label,
        status,
        detail:
          status === 'UNKNOWN'
            ? 'request outcome unconfirmed — not retried automatically to avoid duplicate delivery'
            : result.description ?? `HTTP ${result.status}`,
      });
    }
    return outcomes;
  }

  async resolveChannels(): Promise<TelegramChannel[]> {
    const rows = await listChannels(this.runtime.db.client);
    const enabled = rows.filter((c) => c.enabled);
    if (enabled.length > 0) return enabled;
    // Fall back to environment-configured destinations so a fresh install
    // works before anyone opens the control centre.
    return this.runtime.config.telegramChannels.map((chatId, index) => ({
      id: `env-${index}`,
      label: `env:${chatId}`,
      chatId,
      enabled: true,
      isPrimary: index === 0,
      template: null,
      createdAt: new Date().toISOString(),
    }));
  }

  private async request(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<TelegramSendResult & { raw?: unknown }> {
    const url = `https://api.telegram.org/bot${this.runtime.config.telegramBotToken}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; result?: { message_id?: number }; description?: string }
        | null;
      clearTimeout(timer);
      if (!response.ok || !body?.ok) {
        return {
          ok: false,
          status: response.status,
          description: body?.description ?? `Telegram API HTTP ${response.status}`,
          raw: body,
        };
      }
      return {
        ok: true,
        status: response.status,
        messageId: body.result?.message_id === undefined ? undefined : String(body.result.message_id),
        raw: body,
      };
    } catch (error) {
      clearTimeout(timer);
      const aborted = (error as Error).name === 'AbortError';
      return {
        ok: false,
        status: 0,
        description: aborted ? 'Telegram request timed out' : `Telegram request failed: ${(error as Error).message}`,
        uncertain: !aborted,
      };
    }
  }
}

/** True when a signal's provenance is the synthetic feed. */
export function isSynthetic(signal: SignalRecord): boolean {
  const warnings = Array.isArray(signal.warnings) ? signal.warnings : [];
  const context = (signal.context ?? {}) as unknown as Record<string, unknown>;
  return warnings.some((w) => /synthetic|simulated/i.test(String(w))) || context.synthetic === true;
}

export function buildTemplateVars(
  signal: SignalRecord,
  kind: DeliveryKind,
  extra: Record<string, unknown> = {},
): Record<string, string> {
  const side = signal.direction === 'BUY' ? 'BUY 🟢' : 'SELL 🔴';
  const outcome = signal.outcome ?? 'PENDING';
  const emoji = outcome === 'WIN' ? '✅' : outcome === 'LOSS' ? '❌' : outcome === 'DRAW' ? '➖' : '⏳';
  return {
    pair: signal.pair,
    side,
    direction: signal.direction,
    entry: formatUtc(signal.scheduledEntryAt),
    reference: formatPrice(signal.referencePrice),
    entryPrice: formatPrice((extra.entryPrice as number) ?? null),
    exitPrice: formatPrice(signal.exitPrice ?? (extra.exitPrice as number) ?? null),
    target: `${signal.targetPips.toFixed(1)} pips`,
    stop: `${signal.stopPips.toFixed(1)} pips`,
    confidence: `${(signal.confidence * 100).toFixed(0)}%`,
    rr: signal.rewardRisk.toFixed(2),
    regime: signal.regime,
    strategy: signal.strategy,
    spread: (signal.context?.spreadPips ?? 0).toFixed(2),
    spreadSource: signal.context?.spreadSource ?? 'modelled',
    reason: (signal.reasons ?? []).slice(0, 2).join(' · ') || 'ensemble consensus',
    outcome,
    emoji,
    pips: signal.realizedPips === null || signal.realizedPips === undefined ? 'n/a' : signal.realizedPips.toFixed(2),
    rule: signal.outcomeRule ?? 'net_after_costs_v1',
    detail: (extra.detail as string) ?? '',
    horizon: `${signal.horizonSeconds}s`,
    phase: kind,
    id: signal.id.slice(0, 8),
  };
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => vars[key] ?? '—');
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toFixed(5).replace(/(\.\d{3})\d+$/, '$1');
}
