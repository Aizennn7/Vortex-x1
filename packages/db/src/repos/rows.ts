/**
 * Row mapping helpers. Postgres returns `numeric` as string and timestamps as
 * Date; the domain layer wants numbers and ISO strings. All conversions live
 * here so a schema change cannot silently produce `NaN` in the engine.
 */

export function num(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function int(value: unknown, fallback = 0): number {
  return Math.trunc(num(value, fallback));
}

export function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function isoRequired(value: unknown): string {
  return iso(value) ?? new Date(0).toISOString();
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['t', 'true', '1', 'yes'].includes(value.toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

export function json<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

export function text(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}
