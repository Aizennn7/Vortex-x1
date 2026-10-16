/**
 * Provider key repository. Plaintext keys exist only inside the server
 * process: the database stores ciphertext plus a display mask. Nothing here
 * ever returns a plaintext key.
 */

import type { ApiKeyStatus, KeyState } from '@vortex/core';
import { effectiveLimit } from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { bool, int, iso, num, numOrNull, text } from './rows.js';

export interface ProviderKeyRow {
  id: string;
  label: string;
  masked_key: string;
  ciphertext: string;
  key_fingerprint: string;
  account_id: string | null;
  enabled: boolean;
  status: string;
  minute_limit: number | null;
  day_limit: number | null;
  headroom_percent: string | number | null;
  cooldown_until: string | Date | null;
  consecutive_failures: number;
  last_error: string | null;
  last_used_at: string | Date | null;
  last_verified_at: string | Date | null;
  provider_usage_credits: number | null;
  created_at: string | Date;
  updated_at: string | Date;
  rotated_at: string | Date | null;
}

export interface StoredKey {
  id: string;
  label: string;
  maskedKey: string;
  fingerprint: string;
  accountId: string | null;
  enabled: boolean;
  status: ApiKeyStatus;
  minuteLimit: number;
  dayLimit: number;
  headroomPercent: number | null;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  providerUsageCredits: number | null;
  createdAt: string;
  updatedAt: string;
  rotatedAt: string | null;
}

export function rowToStoredKey(row: ProviderKeyRow, defaults: { rpm: number; rpd: number }): StoredKey {
  return {
    id: row.id,
    label: row.label,
    maskedKey: row.masked_key,
    fingerprint: row.key_fingerprint,
    accountId: row.account_id,
    enabled: bool(row.enabled, true),
    status: row.status as ApiKeyStatus,
    minuteLimit: row.minute_limit === null ? defaults.rpm : int(row.minute_limit, defaults.rpm),
    dayLimit: row.day_limit === null ? defaults.rpd : int(row.day_limit, defaults.rpd),
    headroomPercent: row.headroom_percent === null ? null : num(row.headroom_percent),
    cooldownUntil: iso(row.cooldown_until),
    consecutiveFailures: int(row.consecutive_failures, 0),
    lastError: row.last_error,
    lastUsedAt: iso(row.last_used_at),
    lastVerifiedAt: iso(row.last_verified_at),
    providerUsageCredits: row.provider_usage_credits === null ? null : int(row.provider_usage_credits),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
    rotatedAt: iso(row.rotated_at),
  };
}

export function toKeyState(key: StoredKey, usage?: { minuteUsed: number; dayUsed: number }): KeyState {
  return {
    id: key.id,
    label: key.label,
    accountId: key.accountId,
    enabled: key.enabled,
    status: key.status,
    minuteUsed: usage?.minuteUsed ?? 0,
    dayUsed: usage?.dayUsed ?? 0,
    minuteLimit: key.minuteLimit,
    dayLimit: key.dayLimit,
    headroomPercent: key.headroomPercent,
    cooldownUntil: key.cooldownUntil,
    consecutiveFailures: key.consecutiveFailures,
    lastUsedAt: key.lastUsedAt,
    lastError: key.lastError,
  };
}

export async function listKeys(client: SqlClient): Promise<StoredKey[]> {
  const rows = await client.query<ProviderKeyRow>(
    `select id, label, masked_key, ciphertext, key_fingerprint, account_id, enabled, status,
            minute_limit, day_limit, headroom_percent, cooldown_until, consecutive_failures,
            last_error, last_used_at, last_verified_at, provider_usage_credits,
            created_at, updated_at, rotated_at
       from provider_keys order by created_at asc`,
  );
  return rows.rows.map((r) => rowToStoredKey(r, { rpm: 8, rpd: 800 }));
}

/** Keys with decryptable ciphertext — server-side only. */
export async function listKeysWithCiphertext(
  client: SqlClient,
): Promise<{ stored: StoredKey; ciphertext: string }[]> {
  const rows = await client.query<ProviderKeyRow>(
    `select id, label, masked_key, ciphertext, key_fingerprint, account_id, enabled, status,
            minute_limit, day_limit, headroom_percent, cooldown_until, consecutive_failures,
            last_error, last_used_at, last_verified_at, provider_usage_credits,
            created_at, updated_at, rotated_at
       from provider_keys where enabled order by created_at asc`,
  );
  return rows.rows.map((r) => ({ stored: rowToStoredKey(r, { rpm: 8, rpd: 800 }), ciphertext: r.ciphertext }));
}

export async function insertKey(
  client: SqlClient,
  entry: {
    label: string;
    maskedKey: string;
    ciphertext: string;
    fingerprint: string;
    accountId?: string | null;
    minuteLimit?: number | null;
    dayLimit?: number | null;
    headroomPercent?: number | null;
  },
): Promise<StoredKey> {
  const rows = await client.query<ProviderKeyRow>(
    `insert into provider_keys
       (label, masked_key, ciphertext, key_fingerprint, account_id, minute_limit, day_limit, headroom_percent)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id, label, masked_key, ciphertext, key_fingerprint, account_id, enabled, status,
               minute_limit, day_limit, headroom_percent, cooldown_until, consecutive_failures,
               last_error, last_used_at, last_verified_at, provider_usage_credits,
               created_at, updated_at, rotated_at`,
    [
      entry.label,
      entry.maskedKey,
      entry.ciphertext,
      entry.fingerprint,
      entry.accountId ?? null,
      entry.minuteLimit ?? null,
      entry.dayLimit ?? null,
      entry.headroomPercent ?? null,
    ],
  );
  return rowToStoredKey(rows.rows[0] as ProviderKeyRow, { rpm: 8, rpd: 800 });
}

export async function updateKey(
  client: SqlClient,
  id: string,
  patch: {
    label?: string;
    enabled?: boolean;
    status?: ApiKeyStatus;
    cooldownUntil?: string | null;
    consecutiveFailures?: number;
    lastError?: string | null;
    lastUsedAt?: string | null;
    lastVerifiedAt?: string | null;
    providerUsageCredits?: number | null;
    ciphertext?: string;
    maskedKey?: string;
    fingerprint?: string;
    accountId?: string | null;
    minuteLimit?: number | null;
    dayLimit?: number | null;
  },
): Promise<StoredKey | null> {
  const rows = await client.query<ProviderKeyRow>(
    `update provider_keys set
       label = coalesce($2, label),
       enabled = coalesce($3, enabled),
       status = coalesce($4, status),
       cooldown_until = $5,
       consecutive_failures = coalesce($6, consecutive_failures),
       last_error = coalesce($7, last_error),
       last_used_at = coalesce($8, last_used_at),
       last_verified_at = coalesce($9, last_verified_at),
       provider_usage_credits = coalesce($10, provider_usage_credits),
       ciphertext = coalesce($11, ciphertext),
       masked_key = coalesce($12, masked_key),
       key_fingerprint = coalesce($13, key_fingerprint),
       account_id = coalesce($14, account_id),
       minute_limit = coalesce($15, minute_limit),
       day_limit = coalesce($16, day_limit),
       rotated_at = case when $11 is not null then now() else rotated_at end,
       updated_at = now()
     where id = $1
     returning id, label, masked_key, ciphertext, key_fingerprint, account_id, enabled, status,
               minute_limit, day_limit, headroom_percent, cooldown_until, consecutive_failures,
               last_error, last_used_at, last_verified_at, provider_usage_credits,
               created_at, updated_at, rotated_at`,
    [
      id,
      patch.label ?? null,
      patch.enabled ?? null,
      patch.status ?? null,
      patch.cooldownUntil === undefined ? null : patch.cooldownUntil,
      patch.consecutiveFailures ?? null,
      patch.lastError ?? null,
      patch.lastUsedAt ?? null,
      patch.lastVerifiedAt ?? null,
      patch.providerUsageCredits ?? null,
      patch.ciphertext ?? null,
      patch.maskedKey ?? null,
      patch.fingerprint ?? null,
      patch.accountId ?? null,
      patch.minuteLimit ?? null,
      patch.dayLimit ?? null,
    ],
  );
  const row = rows.rows[0];
  return row ? rowToStoredKey(row, { rpm: 8, rpd: 800 }) : null;
}

export async function deleteKey(client: SqlClient, id: string): Promise<boolean> {
  const result = await client.query('delete from provider_keys where id = $1', [id]);
  return result.rowCount > 0;
}

export async function markFailure(
  client: SqlClient,
  id: string,
  params: { status: ApiKeyStatus | null; error: string; cooldownUntil?: string | null },
): Promise<void> {
  await client.query(
    `update provider_keys set
       consecutive_failures = consecutive_failures + 1,
       last_error = $2,
       status = coalesce($3, status),
       cooldown_until = case when $3 = 'INVALID' then null else coalesce($4, cooldown_until) end,
       updated_at = now()
     where id = $1`,
    [id, params.error, params.status, params.cooldownUntil ?? null],
  );
}

export async function markSuccess(client: SqlClient, id: string): Promise<void> {
  await client.query(
    `update provider_keys set
       consecutive_failures = 0,
       last_error = null,
       status = case when status in ('INVALID','DISABLED') then status else 'ACTIVE' end,
       cooldown_until = case when status = 'INVALID' then cooldown_until else null end,
       last_used_at = now(),
       updated_at = now()
     where id = $1`,
    [id],
  );
}

/** Keys flagged EXHAUSTED — never used again until an operator resets them. */
export async function markDisabled(client: SqlClient, id: string): Promise<void> {
  await client.query(
    `update provider_keys set enabled = false, status = 'DISABLED', cooldown_until = null, updated_at = now() where id = $1`,
    [id],
  );
}

export function usableLimits(key: StoredKey, defaults: { rpm: number; rpd: number; headroom: number }): {
  minute: number;
  day: number;
} {
  const headroom = key.headroomPercent ?? defaults.headroom;
  return {
    minute: effectiveLimit(key.minuteLimit || defaults.rpm, headroom),
    day: effectiveLimit(key.dayLimit || defaults.rpd, headroom),
  };
}

export function publicKeyView(key: StoredKey): Record<string, unknown> {
  return {
    id: key.id,
    label: key.label,
    maskedKey: key.maskedKey,
    accountId: key.accountId,
    enabled: key.enabled,
    status: key.status,
    minuteLimit: key.minuteLimit,
    dayLimit: key.dayLimit,
    headroomPercent: key.headroomPercent,
    cooldownUntil: key.cooldownUntil,
    consecutiveFailures: key.consecutiveFailures,
    lastError: key.lastError ? text(key.lastError) : null,
    lastUsedAt: key.lastUsedAt,
    lastVerifiedAt: key.lastVerifiedAt,
    providerUsageCredits: numOrNull(key.providerUsageCredits),
    createdAt: key.createdAt,
    rotatedAt: key.rotatedAt,
  };
}

export { num };
