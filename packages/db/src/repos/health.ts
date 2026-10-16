/**
 * Health, alerts, audit trail and the structured log ring.
 *
 * The rule enforced here: a component's status is only ever written by
 * whoever actually observed it. Nothing infers "worker healthy" from an HTTP
 * response — worker liveness comes from the heartbeat table.
 */

import type { ServiceStatus } from '@vortex/core';
import type { SqlClient } from '../driver.js';
import { int, iso, isoRequired, json } from './rows.js';

export interface HealthRow {
  component: string;
  status: ServiceStatus;
  detail: string;
  metadata: Record<string, unknown>;
  observedAt: string;
}

export async function setComponentHealth(
  client: SqlClient,
  params: {
    component: string;
    status: ServiceStatus;
    detail: string;
    metadata?: Record<string, unknown>;
    observedAt?: string;
  },
): Promise<void> {
  await client.query(
    `insert into system_health (component, status, detail, metadata, observed_at)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
     on conflict (component) do update
       set status = excluded.status, detail = excluded.detail,
           metadata = excluded.metadata, observed_at = excluded.observed_at`,
    [params.component, params.status, params.detail, JSON.stringify(params.metadata ?? {}), params.observedAt ?? null],
  );
}

export async function listHealth(client: SqlClient): Promise<HealthRow[]> {
  const rows = await client.query<{
    component: string;
    status: string;
    detail: string | null;
    metadata: unknown;
    observed_at: string | Date;
  }>('select component, status, detail, metadata, observed_at from system_health order by component asc');
  return rows.rows.map((r) => ({
    component: r.component,
    status: r.status as ServiceStatus,
    detail: r.detail ?? '',
    metadata: json<Record<string, unknown>>(r.metadata, {}),
    observedAt: iso(r.observed_at) ?? new Date().toISOString(),
  }));
}

export async function getComponentHealth(client: SqlClient, component: string): Promise<HealthRow | null> {
  const rows = await client.query<{
    component: string;
    status: string;
    detail: string | null;
    metadata: unknown;
    observed_at: string | Date;
  }>('select component, status, detail, metadata, observed_at from system_health where component = $1', [component]);
  const row = rows.rows[0];
  if (!row) return null;
  return {
    component: row.component,
    status: row.status as ServiceStatus,
    detail: row.detail ?? '',
    metadata: json<Record<string, unknown>>(row.metadata, {}),
    observedAt: iso(row.observed_at) ?? new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ alerts */

export type AlertSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export interface AlertRow {
  id: string;
  severity: AlertSeverity;
  code: string;
  title: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
}

/** Raise (or bump) an alert. Deduplicated by `code` while unresolved. */
export async function raiseAlert(
  client: SqlClient,
  params: { severity: AlertSeverity; code: string; title: string; detail?: string; metadata?: Record<string, unknown> },
): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `insert into alerts (severity, code, title, detail, metadata)
     values ($1, $2, $3, $4, $5)
     on conflict (code) where resolved_at is null do update
       set occurrences = alerts.occurrences + 1,
           last_seen_at = now(),
           severity = excluded.severity,
           title = excluded.title,
           detail = excluded.detail,
           metadata = excluded.metadata
     returning id`,
    [
      params.severity,
      params.code,
      params.title,
      params.detail ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
  return rows.rows[0]?.id ?? '';
}

export async function resolveAlert(client: SqlClient, code: string): Promise<boolean> {
  const result = await client.query(
    'update alerts set resolved_at = now() where code = $1 and resolved_at is null',
    [code],
  );
  return result.rowCount > 0;
}

export async function acknowledgeAlert(client: SqlClient, id: string, actor: string): Promise<boolean> {
  const result = await client.query(
    'update alerts set acknowledged_at = now(), acknowledged_by = $2 where id = $1 and acknowledged_at is null',
    [id, actor],
  );
  return result.rowCount > 0;
}

export async function listAlerts(client: SqlClient, includeResolved = false, limit = 100): Promise<AlertRow[]> {
  const rows = await client.query<{
    id: string;
    severity: string;
    code: string;
    title: string;
    detail: string | null;
    metadata: unknown;
    occurrences: number;
    first_seen_at: string | Date;
    last_seen_at: string | Date;
    acknowledged_at: string | Date | null;
    resolved_at: string | Date | null;
  }>(
    `select id, severity, code, title, detail, metadata, occurrences, first_seen_at, last_seen_at,
            acknowledged_at, resolved_at
       from alerts
      ${includeResolved ? '' : 'where resolved_at is null'}
      order by severity desc, last_seen_at desc
      limit $1`,
    [limit],
  );
  return rows.rows.map((r) => ({
    id: r.id,
    severity: r.severity as AlertSeverity,
    code: r.code,
    title: r.title,
    detail: r.detail,
    metadata: json<Record<string, unknown>>(r.metadata, {}),
    occurrences: int(r.occurrences, 1),
    firstSeenAt: isoRequired(r.first_seen_at),
    lastSeenAt: isoRequired(r.last_seen_at),
    acknowledgedAt: iso(r.acknowledged_at),
    resolvedAt: iso(r.resolved_at),
  }));
}

/* ------------------------------------------------------------------- audit */

export async function recordAudit(
  client: SqlClient,
  params: { actor: string; action: string; target?: string; detail?: Record<string, unknown> },
): Promise<void> {
  await client.query(
    `insert into audit_log (actor, action, target, detail) values ($1, $2, $3, $4)`,
    [params.actor, params.action, params.target ?? null, JSON.stringify(params.detail ?? {})],
  );
}

export async function listAudit(client: SqlClient, limit = 100): Promise<
  { id: number; actor: string; action: string; target: string | null; detail: Record<string, unknown>; createdAt: string }[]
> {
  const rows = await client.query<{
    id: string;
    actor: string;
    action: string;
    target: string | null;
    detail: unknown;
    created_at: string | Date;
  }>('select id, actor, action, target, detail, created_at from audit_log order by created_at desc limit $1', [limit]);
  return rows.rows.map((r) => ({
    id: int(r.id),
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: json<Record<string, unknown>>(r.detail, {}),
    createdAt: isoRequired(r.created_at),
  }));
}

/* -------------------------------------------------------------- log events */

export async function recordLogEvent(
  client: SqlClient,
  params: {
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    component: string;
    event: string;
    message?: string;
    fields?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `insert into log_events (level, component, event, message, fields) values ($1, $2, $3, $4, $5)`,
    [params.level, params.component, params.event, params.message ?? null, JSON.stringify(params.fields ?? {})],
  );
}

export async function listLogEvents(
  client: SqlClient,
  params: { level?: string; component?: string; limit?: number } = {},
): Promise<
  { id: number; level: string; component: string; event: string; message: string | null; fields: Record<string, unknown>; createdAt: string }[]
> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (params.level) {
    values.push(params.level);
    conditions.push(`level = $${values.length}`);
  }
  if (params.component) {
    values.push(params.component);
    conditions.push(`component = $${values.length}`);
  }
  values.push(Math.min(params.limit ?? 200, 1000));
  const rows = await client.query<{
    id: string;
    level: string;
    component: string;
    event: string;
    message: string | null;
    fields: unknown;
    created_at: string | Date;
  }>(
    `select id, level, component, event, message, fields, created_at from log_events
      ${conditions.length > 0 ? `where ${conditions.join(' and ')}` : ''}
      order by created_at desc limit $${values.length}`,
    values,
  );
  return rows.rows.map((r) => ({
    id: int(r.id),
    level: r.level,
    component: r.component,
    event: r.event,
    message: r.message,
    fields: json<Record<string, unknown>>(r.fields, {}),
    createdAt: isoRequired(r.created_at),
  }));
}

export async function pruneLogEvents(client: SqlClient, retentionDays = 7): Promise<number> {
  const result = await client.query(`delete from log_events where created_at < now() - ($1 || ' days')::interval`, [
    String(Math.max(1, retentionDays)),
  ]);
  return result.rowCount;
}
