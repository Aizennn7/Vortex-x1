/**
 * Secret handling.
 *
 * The core module only defines the *contract*: encryption/decryption is
 * performed by the relay/worker with a 32-byte master key from
 * `VORTEX_SECRET_KEY`. This file owns the redaction rules so every log line
 * and every HTTP payload passes through the same filter.
 */

const REDACT_KEYS = /(token|secret|password|api[-_]?key|authorization|bearer|database_url|dsn|apikey)/i;

const VALUE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'twelve_data_key', pattern: /\b[0-9a-f]{32}\b/gi },
  { name: 'telegram_bot_token', pattern: /\b\d{8,12}:[A-Za-z0-9_-]{30,40}\b/g },
  { name: 'postgres_url', pattern: /postgres(?:ql)?:\/\/[^\s"']+/gi },
  { name: 'supabase_key', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
];

const MASK = '[redacted]';

export function redactString(input: string, extraSecrets: string[] = []): string {
  let out = input;
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 8) {
      out = out.split(secret).join(MASK);
    }
  }
  for (const { pattern } of VALUE_PATTERNS) {
    out = out.replace(pattern, MASK);
  }
  return out;
}

/** Deep-redact an object for logging or transport. */
export function redact<T>(value: T, extraSecrets: string[] = []): T {
  const walk = (v: unknown, depth = 0): unknown => {
    if (depth > 8) return '[depth-limit]';
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') return redactString(v, extraSecrets);
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
    if (v instanceof Error) return { name: v.name, message: redactString(v.message, extraSecrets) };
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(v as Record<string, unknown>)) {
        out[key] = REDACT_KEYS.test(key) ? MASK : walk(val, depth + 1);
      }
      return out;
    }
    return String(v);
  };
  return walk(value) as T;
}

/** True when a string looks like it carries a provider key or token. */
export function looksSecret(value: string): boolean {
  return VALUE_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export const REDACTION_MASK = MASK;
export { REDACT_KEYS };
