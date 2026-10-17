/**
 * Database connection-string validation and resolution.
 *
 * Why this module exists
 * ----------------------
 * `pg` parses its `connectionString` option with `pg-connection-string`, which
 * does:
 *
 *     result = new URL(str, 'postgres://base')
 *
 * The second argument is a *base URL for relative input*. Any value that is
 * not an absolute URL — an empty string, a bare word such as `base`, a value
 * with surrounding quotes, a `${DATABASE_URL}` placeholder or a URL missing its
 * `postgresql://` scheme — silently resolves against `postgres://base` and DNS
 * then fails with:
 *
 *     getaddrinfo EAI_AGAIN base
 *
 * That error names `base`, not the operator's typo, so it hides the real
 * problem. We validate and normalise the connection string before `pg` sees
 * it, and we never pass the raw string to the driver: the pool is configured
 * with explicit fields. A misconfigured connection therefore fails closed with
 * an actionable message that says which variable is wrong — and never prints
 * the value or the password.
 *
 * Supabase endpoints
 * ------------------
 * Free-tier Supabase projects are reachable over IPv4 through the shared
 * Session Pooler (Supavisor):
 *
 *     postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres
 *
 * The pooler host (`aws-<index>-<region>.pooler.supabase.com`) must be copied
 * from the dashboard (Connect → Session pooler); it cannot be derived from the
 * region. The direct endpoint (`db.<project-ref>.supabase.co`) is IPv6-only on
 * the Free plan and therefore unusable from IPv4-only GitHub Actions runners.
 */

import type { PoolConfig } from 'pg';

export type DatabaseSource = 'DATABASE_URL' | 'DATABASE_URL_DIRECT' | 'explicit';

export type DatabaseEndpointKind =
  /** Supabase shared pooler, session mode (port 5432) — required here. */
  | 'session-pooler'
  /** Supabase shared pooler, transaction mode (port 6543) — unsupported. */
  | 'transaction-pooler'
  /** Supabase dedicated pooler (paid, port 6543). */
  | 'dedicated-pooler'
  /** Supabase direct endpoint (IPv6-only on the Free plan). */
  | 'direct'
  | 'localhost'
  | 'other';

export type DatabaseConfigIssue =
  | 'empty'
  | 'placeholder'
  | 'missing-scheme'
  | 'unsupported-scheme'
  | 'malformed'
  | 'missing-host'
  | 'dummy-host'
  | 'invalid-port'
  | 'missing-user'
  | 'ssl-disabled'
  | 'unknown-sslmode'
  | 'transaction-pooler'
  | 'direct-ipv6'
  | 'project-url'
  | 'pooler-user'
  | 'project-mismatch';

/**
 * A configuration error that is safe to print. It intentionally carries only
 * the variable name, a stable code and a message built from non-secret parts.
 * The offending value is never attached (no `cause`, no `input`).
 */
export class DatabaseConfigError extends Error {
  readonly code: DatabaseConfigIssue;
  readonly variable: DatabaseSource;

  constructor(code: DatabaseConfigIssue, variable: DatabaseSource, message: string) {
    super(message);
    this.name = 'DatabaseConfigError';
    this.code = code;
    this.variable = variable;
  }
}

export interface DatabaseTargetSummary {
  source: DatabaseSource;
  kind: DatabaseEndpointKind;
  scheme: 'postgres' | 'postgresql';
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  sslMode: string | null;
  projectRef: string | null;
}

export interface DatabaseTarget {
  readonly source: DatabaseSource;
  readonly kind: DatabaseEndpointKind;
  readonly scheme: 'postgres' | 'postgresql';
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly ssl: boolean;
  readonly sslMode: string | null;
  readonly projectRef: string | null;
  /** Non-secret notes produced while normalising (quotes stripped, etc.). */
  readonly notes: string[];
  /** Safe, loggable description. Never contains a password or the raw URL. */
  describe(): DatabaseTargetSummary;
  /** Explicit pg pool configuration. Contains the password: never log/serialize it. */
  toPgConfig(): Pick<PoolConfig, 'host' | 'port' | 'user' | 'password' | 'database' | 'ssl'>;
  /** Values that must be redacted from error messages. */
  secretValues(): string[];
}

const POSTGRES_SCHEMES = new Set(['postgres', 'postgresql']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
const VALID_SSL_MODES = new Set(['disable', 'prefer', 'require', 'verify-ca', 'verify-full', 'no-verify']);

const PLACEHOLDER_PATTERN =
  /(\$\{\{?[^}]*\}?\})|(\[[^\]]*(?:password|pass|host|region|ref|project)[^\]]*\])|(<[^>]*(?:password|host|region|ref|project)[^>]*>)|(\byour[-_ ]?password\b)/i;

const SUPABASE_POOLER_HOST = /^[a-z0-9-]+\.pooler\.supabase\.com$/i;
const SUPABASE_POOLER_HOST_STRICT = /^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/i;
const SUPABASE_DIRECT_HOST = /^db\.([a-z0-9]{16,32})\.supabase\.co$/i;
const SUPABASE_PROJECT_HOST = /^([a-z0-9]{16,32})\.supabase\.co$/i;
const POOLER_USER = /^postgres\.([a-z0-9]{16,32})$/i;
const PROJECT_REF = /^[a-z0-9]{16,32}$/i;

function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host.toLowerCase());
}

function boolish(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function decode(value: string, variable: DatabaseSource): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DatabaseConfigError(
      'malformed',
      variable,
      'The connection string contains an invalid percent-escape. Re-copy the URI from Supabase rather than typing the password by hand.',
    );
  }
}

export interface ParseDatabaseUrlOptions {
  /** Environment variable the value came from (used in error messages only). */
  variable?: DatabaseSource;
  /** Environment consulted for GITHUB_ACTIONS / SUPABASE_PROJECT_REF. */
  env?: NodeJS.ProcessEnv;
  /** Purpose changes two checks: migrations/runtime reject unsupported modes. */
  purpose?: 'runtime' | 'migration' | 'diagnostic';
  /** Allow the IPv6-only direct endpoint on GitHub Actions (owner opt-in). */
  allowDirect?: boolean;
  /** Allow the transaction pooler (not recommended: no session state). */
  allowTransactionPooler?: boolean;
  /**
   * Fail instead of correcting a Supabase transaction-pooler port (6543) to
   * the session-pooler port (5432) on the same shared host. The correction is
   * safe and deterministic, but it changes the configured port; opt out with
   * VORTEX_DB_STRICT_POOLER_PORT=true.
   */
  strictPoolerPort?: boolean;
}

/**
 * Parse and validate a PostgreSQL connection string.
 *
 * Throws `DatabaseConfigError` for anything that `pg` would otherwise turn
 * into a bogus host (notably the `base` fallback).
 */
export function parseDatabaseUrl(raw: string, options: ParseDatabaseUrlOptions = {}): DatabaseTarget {
  const variable = options.variable ?? 'DATABASE_URL';
  const env = options.env ?? process.env;
  const purpose = options.purpose ?? 'runtime';
  const allowDirect =
    options.allowDirect ??
    (boolish(env.VORTEX_DB_ALLOW_DIRECT_CONNECTION) || boolish(env.ALLOW_DIRECT_DB_CONNECTION));
  const allowTransactionPooler = options.allowTransactionPooler ?? false;
  const strictPoolerPort = options.strictPoolerPort ?? boolish(env.VORTEX_DB_STRICT_POOLER_PORT);

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new DatabaseConfigError(
      'empty',
      variable,
      `${variable} is empty. Set it to the full Supabase Session Pooler URI ` +
        '(Dashboard → Connect → Session pooler), for example ' +
        '`postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres`. ' +
        'An empty value makes pg fall back to its internal dummy host `base`.',
    );
  }

  let value = raw.trim();
  const notes: string[] = [];

  // Strip matched surrounding quotes. Pasting `"postgresql://..."` into a
  // secret is common and makes the value relative (URL base host `base`).
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1).trim();
      if (/^postgres(ql)?:\/\//i.test(inner)) {
        value = inner;
        notes.push('Removed surrounding quotes from the connection string.');
      }
    }
  }

  if (PLACEHOLDER_PATTERN.test(value)) {
    throw new DatabaseConfigError(
      'placeholder',
      variable,
      `${variable} still contains a placeholder (for example \`[YOUR-PASSWORD]\`, ` +
        '`<pooler-host>` or `${DATABASE_URL}`). Replace every placeholder with the real value: ' +
        'copy the whole Session Pooler URI from Supabase Dashboard → Connect → Session pooler. ' +
        'A value with a placeholder is parsed as a relative URL and resolves to the dummy host `base`.',
    );
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (!schemeMatch) {
    throw new DatabaseConfigError(
      'missing-scheme',
      variable,
      `${variable} is not an absolute PostgreSQL URI (the \`postgresql://\` scheme is missing). ` +
        'pg parses a relative value against its internal base URL `postgres://base`, which is why ' +
        'the previous failure reported the hostname `base`. Use the full Session Pooler URI: ' +
        '`postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres`.',
    );
  }

  const scheme = schemeMatch[1]!.toLowerCase();
  if (!POSTGRES_SCHEMES.has(scheme)) {
    throw new DatabaseConfigError(
      'unsupported-scheme',
      variable,
      `${variable} uses the unsupported scheme \`${scheme}\`. Use \`postgresql://\` (or \`postgres://\`).`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Do not attach the URL/error: Node's ERR_INVALID_URL includes the input.
    throw new DatabaseConfigError(
      'malformed',
      variable,
      `${variable} is not a valid URL. Re-copy the Session Pooler URI from the Supabase dashboard ` +
        'and, if the password contains @, :, /, ? or #, let the dashboard percent-encode it.',
    );
  }

  const host = (url.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0) {
    throw new DatabaseConfigError(
      'missing-host',
      variable,
      `${variable} has no host. Use the Session Pooler host from Supabase Dashboard → Connect → ` +
        'Session pooler (the `aws-<index>-<region>.pooler.supabase.com` value).',
    );
  }
  if (host === 'base') {
    throw new DatabaseConfigError(
      'dummy-host',
      variable,
      `${variable} resolves to the placeholder host \`base\`. That host is pg-connection-string's ` +
        'internal base URL for relative input; it means the configured value is empty, a bare word, ' +
        'quoted or missing the `postgresql://` scheme. Set the full Supabase Session Pooler URI: ' +
        '`postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres`.',
    );
  }
  if (/[${}<>[\]]/.test(host)) {
    throw new DatabaseConfigError(
      'placeholder',
      variable,
      `${variable} contains a placeholder in its host. Copy the concrete pooler hostname from the ` +
        'Supabase dashboard; it looks like "aws-<index>-<region>.pooler.supabase.com".',
    );
  }

  const portText = url.port;
  const port = portText ? Number(portText) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DatabaseConfigError('invalid-port', variable, `${variable} contains an invalid port.`);
  }

  const user = decode(url.username, variable);
  const password = decode(url.password, variable);
  const database = decode(url.pathname.replace(/^\//, ''), variable) || 'postgres';

  if (user.length === 0 && !isLocalHost(host)) {
    throw new DatabaseConfigError(
      'missing-user',
      variable,
      `${variable} has no user. The Supabase Session Pooler user is \`postgres.<project-ref>\` ` +
        '(the project ref from the host, not a plain `postgres`).',
    );
  }

  const sslMode = url.searchParams.get('sslmode')?.toLowerCase() ?? null;
  if (sslMode && !VALID_SSL_MODES.has(sslMode)) {
    throw new DatabaseConfigError(
      'unknown-sslmode',
      variable,
      `${variable} specifies an unknown sslmode \`${sslMode}\`. Use require or verify-full for Supabase.`,
    );
  }

  const local = isLocalHost(host);
  const looksSupabase = /\.supabase\.(?:co|com)$/i.test(host);
  if (!local && sslMode === 'disable' && looksSupabase) {
    throw new DatabaseConfigError(
      'ssl-disabled',
      variable,
      `${variable} sets sslmode=disable for a Supabase host. Supabase requires TLS; remove the parameter ` +
        'or set sslmode=require.',
    );
  }

  // Remote hosts use TLS unless the operator explicitly disabled it for a
  // self-hosted endpoint (Supabase hosts cannot disable it — see above).
  const ssl = !local && sslMode !== 'disable';
  const sslModeForSummary = sslMode ?? (ssl ? 'require (driver default)' : null);

  // ---- Supabase endpoint classification -----------------------------------
  let kind: DatabaseEndpointKind = local ? 'localhost' : 'other';
  let projectRef: string | null = null;
  let poolerUserRef: string | null = null;
  let effectivePort = port;

  if (SUPABASE_POOLER_HOST.test(host)) {
    if (!SUPABASE_POOLER_HOST_STRICT.test(host)) {
      throw new DatabaseConfigError(
        'malformed',
        variable,
        `${variable} uses the pooler host \`${host}\`, which is missing the documented ` +
          '`aws-<index>-<region>` prefix. Copy the exact Session Pooler host from the Supabase dashboard; ' +
          'the index and region cannot be derived from the project ref.',
      );
    }
    if (port !== 5432 && port !== 6543) {
      throw new DatabaseConfigError(
        'transaction-pooler',
        variable,
        `${variable} points at the Supabase pooler on port ${port}. Session mode is port 5432; ` +
          'transaction mode is 6543.',
      );
    }
    const match = POOLER_USER.exec(user);
    if (!match) {
      throw new DatabaseConfigError(
        'pooler-user',
        variable,
        `${variable} uses user \`${user}\` with the Session Pooler. The pooler identifies the project ` +
          'from the username and requires `postgres.<project-ref>` (plain `postgres` only works on the ' +
          'direct endpoint).',
      );
    }
    poolerUserRef = match[1]!.toLowerCase();
    projectRef = poolerUserRef;
    if (port === 6543) {
      if (strictPoolerPort) {
        throw new DatabaseConfigError(
          'transaction-pooler',
          variable,
          `${variable} points at the transaction pooler (port 6543). VORTEX SI uses session-level ` +
            'advisory locks and multi-statement transactions, so it must use the Session Pooler on port 5432. ' +
            'In the Supabase dashboard choose Connect → Session pooler, or unset VORTEX_DB_STRICT_POOLER_PORT ' +
            'to let the worker correct the shared-pooler port automatically.',
        );
      }
      if (!allowTransactionPooler) {
        // The shared Supabase pooler serves session mode on 5432 and transaction
        // mode on 6543 on the SAME host. Correcting the port keeps the existing
        // secret (username/password/host) intact and produces the endpoint this
        // application requires. The note is surfaced as a warning everywhere.
        effectivePort = 5432;
        kind = 'session-pooler';
        notes.push(
          'Configured port 6543 (transaction pooler) was corrected to 5432 (session pooler) ' +
            'on the same Supabase pooler host; VORTEX SI requires session mode. Update the secret to the ' +
            'Session pooler string (port 5432) when convenient, or set VORTEX_DB_STRICT_POOLER_PORT=true ' +
            'to fail instead of correcting.',
        );
      } else {
        kind = 'transaction-pooler';
        if (purpose !== 'diagnostic') {
          throw new DatabaseConfigError(
            'transaction-pooler',
            variable,
            `${variable} points at the transaction pooler (port 6543), which is not supported. ` +
              'Use the Session Pooler on port 5432.',
          );
        }
      }
    } else {
      kind = 'session-pooler';
    }
  } else if (SUPABASE_DIRECT_HOST.test(host)) {
    projectRef = SUPABASE_DIRECT_HOST.exec(host)![1]!.toLowerCase();
    kind = port === 6543 ? 'dedicated-pooler' : 'direct';
    if (POOLER_USER.test(user)) {
      throw new DatabaseConfigError(
        'pooler-user',
        variable,
        `${variable} uses the pooler username \`${user}\` on the direct host \`${host}\`. ` +
          'Use plain `postgres` with the direct endpoint, or switch to the Session Pooler URI.',
      );
    }
    if (kind !== 'dedicated-pooler' && env.GITHUB_ACTIONS === 'true' && !allowDirect) {
      throw new DatabaseConfigError(
        'direct-ipv6',
        variable,
        `${variable} points at \`db.${projectRef}.supabase.co\`, which is IPv6-only on the Supabase ` +
          'Free plan. GitHub Actions runners are IPv4-only, so this can never connect here. Use the ' +
          'Session Pooler URI (`postgresql://postgres.<project-ref>:<password>@<pooler-host>:5432/postgres`) ' +
          'or set VORTEX_DB_ALLOW_DIRECT_CONNECTION=true on an IPv6-capable runner.',
      );
    }
  } else if (SUPABASE_PROJECT_HOST.test(host)) {
    throw new DatabaseConfigError(
      'project-url',
      variable,
      `${variable} points at the Supabase project URL \`${host}\`, not the database endpoint. ` +
        'Use the Session Pooler host from Dashboard → Connect → Session pooler.',
    );
  }

  const expectedRef = (env.SUPABASE_PROJECT_REF ?? '').trim().toLowerCase();
  if (expectedRef) {
    if (!PROJECT_REF.test(expectedRef)) {
      throw new DatabaseConfigError(
        'project-mismatch',
        variable,
        'SUPABASE_PROJECT_REF is not a valid Supabase project reference (lowercase alphanumeric).',
      );
    }
    if (projectRef && projectRef !== expectedRef) {
      throw new DatabaseConfigError(
        'project-mismatch',
        variable,
        `${variable} belongs to project \`${projectRef}\`, but SUPABASE_PROJECT_REF is ` +
          `\`${expectedRef}\`. Check that the secret was copied for the right Supabase project.`,
      );
    }
  }

  // pg treats `verify-ca` as verify-full when no CA file is supplied; be
  // explicit about it. The default for remote hosts matches the driver's
  // historical behaviour ({ rejectUnauthorized: false }) to avoid changing how
  // trusted certificates are handled in this fix.
  const rejectUnauthorized = sslMode === 'verify-full' || sslMode === 'verify-ca';

  const target: DatabaseTarget = {
    source: variable,
    kind,
    scheme: scheme as 'postgres' | 'postgresql',
    host,
    port,
    database,
    user,
    ssl,
    sslMode,
    projectRef,
    notes,
    describe(): DatabaseTargetSummary {
      return {
        source: variable,
        kind,
        scheme: scheme as 'postgres' | 'postgresql',
        host,
        port: effectivePort,
        database,
        user,
        ssl,
        sslMode: sslModeForSummary,
        projectRef,
      };
    },
    toPgConfig() {
      const config: Pick<PoolConfig, 'host' | 'port' | 'user' | 'password' | 'database' | 'ssl'> = {
        host,
        port: effectivePort,
        database,
        user: user || undefined,
        password: password || undefined,
        ssl: ssl ? { rejectUnauthorized } : undefined,
      };
      return config;
    },
    secretValues() {
      const secrets = [password, url.password, raw];
      return secrets.filter((value) => typeof value === 'string' && value.length >= 4);
    },
  };

  return target;
}

export interface ResolveDatabaseOptions {
  env?: NodeJS.ProcessEnv;
  purpose?: 'runtime' | 'migration' | 'diagnostic';
  allowDirect?: boolean;
  allowTransactionPooler?: boolean;
  strictPoolerPort?: boolean;
}

export interface ResolvedDatabase {
  /** null means no database is configured (embedded/local mode). */
  target: DatabaseTarget | null;
  /** Non-fatal advice, safe to log (no values). */
  warnings: string[];
}

/**
 * Choose the connection string the way a production deployment should:
 *
 *   1. `DATABASE_URL` — the Supabase Session Pooler URI — is authoritative.
 *   2. `DATABASE_URL_DIRECT` is only a fallback when `DATABASE_URL` is unset.
 *   3. An invalid `DATABASE_URL` never silently falls through to the direct
 *      secret: that would hide a configuration error behind a different host.
 *
 * The previous behaviour (`DATABASE_URL_DIRECT || DATABASE_URL`) let an
 * optional, often-stale direct secret override the working pooler secret; it
 * also handed unvalidated values to `pg`, producing `getaddrinfo EAI_AGAIN base`.
 */
export function resolveDatabaseConnection(options: ResolveDatabaseOptions = {}): ResolvedDatabase {
  const env = options.env ?? process.env;
  const purpose = options.purpose ?? 'runtime';
  const allowDirect = options.allowDirect ?? boolish(env.VORTEX_DB_ALLOW_DIRECT_CONNECTION);
  const allowTransactionPooler = options.allowTransactionPooler ?? false;
  const strictPoolerPort = options.strictPoolerPort ?? boolish(env.VORTEX_DB_STRICT_POOLER_PORT);
  const warnings: string[] = [];

  const primary = (env.DATABASE_URL ?? '').trim();
  const direct = (env.DATABASE_URL_DIRECT ?? '').trim();

  if (primary.length > 0) {
    const target = parseDatabaseUrl(primary, {
      variable: 'DATABASE_URL',
      env,
      purpose,
      allowDirect,
      allowTransactionPooler,
      strictPoolerPort,
    });

    for (const note of target.notes) warnings.push(`${target.source}: ${note}`);

    if (direct.length > 0) {
      try {
        parseDatabaseUrl(direct, {
          variable: 'DATABASE_URL_DIRECT',
          env: { ...env, GITHUB_ACTIONS: 'false' },
          purpose: 'diagnostic',
          allowDirect: true,
          allowTransactionPooler: true,
          strictPoolerPort: false,
        });
        warnings.push(
          'DATABASE_URL_DIRECT is configured but ignored: DATABASE_URL (Session Pooler) is authoritative. ' +
            'Remove the direct secret unless it is needed as a fallback.',
        );
      } catch (error) {
        warnings.push(
          'DATABASE_URL_DIRECT is configured but invalid and was ignored (DATABASE_URL is authoritative): ' +
            (error instanceof Error ? error.message : 'unknown error'),
        );
      }
    }

    return { target, warnings };
  }

  if (direct.length > 0) {
    const target = parseDatabaseUrl(direct, {
      variable: 'DATABASE_URL_DIRECT',
      env,
      purpose,
      allowDirect,
      allowTransactionPooler,
      strictPoolerPort,
    });
    for (const note of target.notes) warnings.push(`${target.source}: ${note}`);
    warnings.push(
      'DATABASE_URL is not configured; using the optional DATABASE_URL_DIRECT fallback. ' +
        'GitHub Actions runners are IPv4-only, so the Supabase direct endpoint cannot be reached there — ' +
        'set DATABASE_URL to the Session Pooler URI.',
    );
    return { target, warnings };
  }

  return { target: null, warnings };
}

/** True when a value would be parsed by pg as the dummy host `base`. */
export function resolvesToDummyHost(raw: string): boolean {
  const trimmed = raw.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (trimmed.length === 0) return true;
  try {
    return new URL(trimmed, 'postgres://base').hostname === 'base';
  } catch {
    return false;
  }
}
