/**
 * Runtime settings stored in the database (non-secret only). Secrets are never
 * written here — they live in the server environment.
 */

import type { SqlClient } from '../driver.js';
import { isoRequired, json } from './rows.js';

export async function getSetting<T>(client: SqlClient, key: string): Promise<T | null> {
  const rows = await client.query<{ value: unknown }>('select value from system_settings where key = $1', [key]);
  const row = rows.rows[0];
  if (!row) return null;
  return json<T>(row.value, null as unknown as T);
}

export async function setSetting(
  client: SqlClient,
  key: string,
  value: unknown,
  updatedBy = 'system',
): Promise<void> {
  await client.query(
    `insert into system_settings (key, value, updated_at, updated_by)
     values ($1, $2, now(), $3)
     on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), updatedBy],
  );
}

export async function listSettings(client: SqlClient): Promise<{ key: string; value: unknown; updatedAt: string; updatedBy: string | null }[]> {
  const rows = await client.query<{ key: string; value: unknown; updated_at: string | Date; updated_by: string | null }>(
    'select key, value, updated_at, updated_by from system_settings order by key asc',
  );
  return rows.rows.map((r) => ({
    key: r.key,
    value: json<unknown>(r.value, null),
    updatedAt: isoRequired(r.updated_at),
    updatedBy: r.updated_by,
  }));
}

export const SETTING_KEYS = {
  scanCadenceMinutes: 'engine.scan_cadence_minutes',
  publishLeadSeconds: 'engine.publish_lead_seconds',
  signalHorizonSeconds: 'engine.signal_horizon_seconds',
  minConfidence: 'engine.min_confidence',
  minRewardRisk: 'engine.min_reward_risk',
  maxSpreadPips: 'engine.max_spread_pips',
  telegramEnabled: 'delivery.telegram_enabled',
  telegramTemplate: 'delivery.telegram_template',
  learningEnabled: 'learning.enabled',
  learningSchedule: 'learning.schedule',
  themeDefaults: 'ui.theme_defaults',
  introEnabled: 'ui.intro_enabled',
} as const;

/** Settings that the browser is allowed to read (whitelist, not blacklist). */
export const PUBLIC_SETTING_KEYS: string[] = [
  SETTING_KEYS.scanCadenceMinutes,
  SETTING_KEYS.publishLeadSeconds,
  SETTING_KEYS.signalHorizonSeconds,
  SETTING_KEYS.minConfidence,
  SETTING_KEYS.minRewardRisk,
  SETTING_KEYS.maxSpreadPips,
  SETTING_KEYS.telegramEnabled,
  SETTING_KEYS.learningEnabled,
  SETTING_KEYS.learningSchedule,
  SETTING_KEYS.themeDefaults,
  SETTING_KEYS.introEnabled,
];
