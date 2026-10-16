/**
 * Relay client.
 *
 * The dashboard is a static site: it holds no secrets and never talks to a
 * database or a provider directly. It only reads the relay's public plane
 * (`/health`, `/api/*`), which is secret-free by construction.
 *
 * Base URL resolution:
 *   1. `VITE_RELAY_URL` at build time (a deployed relay on another origin), or
 *   2. the same origin the page was served from — which is what the reverse
 *      proxy / Vite dev proxy is for.
 *
 * There is deliberately no loopback default here: a `localhost` base baked into
 * a published bundle breaks every real deployment, and the bundle guard in
 * scripts/assert-no-secrets-in-bundle.mjs fails the build if one appears.
 */

const configuredBase = (import.meta.env.VITE_RELAY_URL as string | undefined)?.replace(/\/$/, '') ?? '';

export const RELAY_BASE = configuredBase;

export interface RelayResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

async function get<T>(path: string, init: RequestInit = {}): Promise<RelayResult<T>> {
  try {
    const response = await fetch(`${RELAY_BASE}${path}`, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });
    const text = await response.text();
    const body = text.length === 0 ? null : (JSON.parse(text) as { ok?: boolean; data?: T; error?: { message?: string } });
    if (!response.ok || body?.ok === false) {
      return { ok: false, status: response.status, data: null, error: body?.error?.message ?? `HTTP ${response.status}` };
    }
    return { ok: true, status: response.status, data: (body?.data ?? null) as T, error: null };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `relay unreachable from this browser: ${(error as Error).message}`,
    };
  }
}

export const relay = {
  health: () => get<HealthPayload>('/health'),
  summary: () => get<SummaryPayload>('/api/summary'),
  config: () => get<Record<string, unknown>>('/api/config'),
  signals: (limit = 25) => get<{ signals: SignalRow[]; count: number }>(`/api/signals?limit=${limit}`),
};

export interface HealthPayload {
  service: string;
  status: string;
  version: string;
  uptimeSeconds: number;
  database: { ok: boolean; detail: string };
  provider: { name: string; synthetic: boolean };
  ready: boolean;
  reasons: string[];
  note: string;
  timestamp: string;
}

export interface SignalRow {
  id: string;
  pair: string;
  decision: string;
  status: string;
  confidence: number;
  scheduledEntryAt: string;
  outcome: string | null;
  realizedPips: number | null;
  strategy: string;
}

export interface SummaryPayload {
  generatedAt?: string;
  marketOpen?: boolean;
  worker: { workerId: string; liveness: string; secondsSince: number; lastJob: string | null } | null;
  workerStatus?: string;
  marketData: { pair: string; status: string; ageSeconds: number | null; detail: string | null }[];
  providerBudget: {
    enabledKeys: number;
    usableKeys: number;
    dayCapacity: number;
    dayUsed: number;
    dayRemainingPercent: number;
    warnings: string[];
  } | null;
  signals: {
    inFlight: number;
    wins: number;
    losses: number;
    draws: number;
    unresolved: number;
    decisive: number;
    accuracy: number | null;
    note: string;
  } | null;
  telegram: { configuration: { status: string; detail: string }; sent: number; failed: number; unconfirmed: number };
  alerts: { severity: string; code: string; title: string; lastSeenAt: string }[];
  note?: string;
}
