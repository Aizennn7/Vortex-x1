/**
 * Telegram destination configuration and the idempotent delivery ledger.
 *
 * The bot token is never stored here. Delivery rows are keyed by
 * `(signal_id, channel_label, kind)` so a retry after a restart cannot post the
 * same signal twice for the same channel and phase.
 */

import type { SqlClient } from '../driver.js';
import { bool, int, iso, isoRequired, text } from './rows.js';

export interface TelegramChannel {
  id: string;
  label: string;
  chatId: string;
  enabled: boolean;
  isPrimary: boolean;
  template: string | null;
  createdAt: string;
}

export async function listChannels(client: SqlClient): Promise<TelegramChannel[]> {
  const rows = await client.query<{
    id: string;
    label: string;
    chat_id: string;
    enabled: boolean;
    is_primary: boolean;
    template: string | null;
    created_at: string | Date;
  }>(
    `select id, label, chat_id, enabled, is_primary, template, created_at
       from telegram_channels order by is_primary desc, created_at asc`,
  );
  return rows.rows.map((r) => ({
    id: r.id,
    label: r.label,
    chatId: r.chat_id,
    enabled: bool(r.enabled, true),
    isPrimary: bool(r.is_primary),
    template: r.template,
    createdAt: isoRequired(r.created_at),
  }));
}

export async function upsertChannel(
  client: SqlClient,
  params: { label: string; chatId: string; enabled?: boolean; isPrimary?: boolean; template?: string | null },
): Promise<TelegramChannel> {
  const rows = await client.query<{
    id: string;
    label: string;
    chat_id: string;
    enabled: boolean;
    is_primary: boolean;
    template: string | null;
    created_at: string | Date;
  }>(
    `insert into telegram_channels (label, chat_id, enabled, is_primary, template)
     values ($1, $2, coalesce($3, true), coalesce($4, false), $5)
     on conflict (label) do update
       set chat_id = excluded.chat_id,
           enabled = excluded.enabled,
           is_primary = excluded.is_primary,
           template = excluded.template,
           updated_at = now()
     returning id, label, chat_id, enabled, is_primary, template, created_at`,
    [params.label, params.chatId, params.enabled ?? null, params.isPrimary ?? null, params.template ?? null],
  );
  const r = rows.rows[0]!;
  return {
    id: r.id,
    label: r.label,
    chatId: r.chat_id,
    enabled: bool(r.enabled, true),
    isPrimary: bool(r.is_primary),
    template: r.template,
    createdAt: isoRequired(r.created_at),
  };
}

export async function deleteChannel(client: SqlClient, label: string): Promise<boolean> {
  const result = await client.query('delete from telegram_channels where label = $1', [label]);
  return result.rowCount > 0;
}

export type DeliveryKind = 'PUBLISH' | 'SETTLEMENT';
export type DeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';

/**
 * Claim the right to deliver. Returns `shouldSend: false` when a row already
 * exists in a terminal state (SENT) — the duplicate-delivery guard.
 * A row in FAILED/PENDING state is retried while attempts remain.
 */
export async function claimDelivery(
  client: SqlClient,
  params: { signalId: string; channelLabel: string; kind: DeliveryKind; maxAttempts?: number },
): Promise<{ shouldSend: boolean; reason: string; deliveryId: string | null; attempts: number }> {
  return client.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `insert into signal_deliveries (signal_id, channel_label, kind, status, attempts)
       values ($1, $2, $3, 'PENDING', 0)
       on conflict (signal_id, channel_label, kind) do nothing
       returning id`,
      [params.signalId, params.channelLabel, params.kind],
    );
    const newId = inserted.rows[0]?.id;
    if (newId) return { shouldSend: true, reason: 'new delivery', deliveryId: newId, attempts: 0 };

    const existing = await tx.query<{ id: string; status: string; attempts: number }>(
      `select id, status, attempts from signal_deliveries
        where signal_id = $1 and channel_label = $2 and kind = $3 for update`,
      [params.signalId, params.channelLabel, params.kind],
    );
    const row = existing.rows[0];
    if (!row) return { shouldSend: false, reason: 'delivery row missing', deliveryId: null, attempts: 0 };
    const maxAttempts = params.maxAttempts ?? 3;
    if (row.status === 'SENT') return { shouldSend: false, reason: 'already delivered', deliveryId: row.id, attempts: int(row.attempts) };
    if (row.status === 'SKIPPED') return { shouldSend: false, reason: 'skipped by policy', deliveryId: row.id, attempts: int(row.attempts) };
    if (int(row.attempts) >= maxAttempts) {
      return { shouldSend: false, reason: `retry budget exhausted (${row.attempts}/${maxAttempts})`, deliveryId: row.id, attempts: int(row.attempts) };
    }
    // UNKNOWN means the previous attempt may or may not have reached Telegram.
    // We only retry those when explicitly allowed, because a blind retry risks
    // a duplicate post the provider cannot deduplicate.
    if (row.status === 'UNKNOWN') {
      return { shouldSend: false, reason: 'previous attempt unconfirmed — manual review required', deliveryId: row.id, attempts: int(row.attempts) };
    }
    await tx.query(`update signal_deliveries set status = 'PENDING', updated_at = now() where id = $1`, [row.id]);
    return { shouldSend: true, reason: 'retrying', deliveryId: row.id, attempts: int(row.attempts) };
  });
}

export async function completeDelivery(
  client: SqlClient,
  params: {
    deliveryId: string;
    status: DeliveryStatus;
    messageId?: string | null;
    error?: string | null;
    incrementAttempts?: boolean;
  },
): Promise<void> {
  await client.query(
    `update signal_deliveries set
       status = $2,
       attempts = attempts + $3,
       provider_message_id = coalesce($4, provider_message_id),
       last_error = $5,
       confirmed_at = case when $2 = 'SENT' then now() else confirmed_at end,
       updated_at = now()
     where id = $1`,
    [params.deliveryId, params.status, params.incrementAttempts === false ? 0 : 1, params.messageId ?? null, params.error ?? null],
  );
}

export interface DeliveryRow {
  id: string;
  signalId: string;
  channelLabel: string;
  kind: string;
  status: string;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  confirmedAt: string | null;
  createdAt: string;
  pair: string | null;
  direction: string | null;
  scheduledEntryAt: string | null;
  outcome: string | null;
}

export async function listDeliveries(client: SqlClient, limit = 100, status?: DeliveryStatus): Promise<DeliveryRow[]> {
  const rows = await client.query<{
    id: string;
    signal_id: string;
    channel_label: string;
    kind: string;
    status: string;
    attempts: number;
    provider_message_id: string | null;
    last_error: string | null;
    confirmed_at: string | Date | null;
    created_at: string | Date;
    pair: string | null;
    direction: string | null;
    scheduled_entry_at: string | Date | null;
    outcome: string | null;
  }>(
    `select d.id, d.signal_id, d.channel_label, d.kind, d.status, d.attempts, d.provider_message_id,
            d.last_error, d.confirmed_at, d.created_at,
            s.pair, s.direction, s.scheduled_entry_at, s.outcome
       from signal_deliveries d
       left join signals s on s.id = d.signal_id
      ${status ? 'where d.status = $2' : ''}
      order by d.created_at desc limit $1`,
    status ? [limit, status] : [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    signalId: r.signal_id,
    channelLabel: r.channel_label,
    kind: r.kind,
    status: r.status,
    attempts: int(r.attempts),
    providerMessageId: r.provider_message_id,
    lastError: text(r.last_error, '') || null,
    confirmedAt: iso(r.confirmed_at),
    createdAt: isoRequired(r.created_at),
    pair: r.pair,
    direction: r.direction,
    scheduledEntryAt: iso(r.scheduled_entry_at),
    outcome: r.outcome,
  }));
}

export async function deliveryStats(client: SqlClient): Promise<Record<string, number>> {
  const rows = await client.query<{ status: string; kind: string; count: string }>(
    'select status, kind, count(*)::text as count from signal_deliveries group by status, kind',
  );
  const out: Record<string, number> = {};
  for (const row of rows.rows) {
    out[`${row.kind}:${row.status}`] = int(row.count);
  }
  return out;
}
