import { describe, expect, it } from 'vitest';
import {
  DatabaseConfigError,
  parseDatabaseUrl,
  resolveDatabaseConnection,
  resolvesToDummyHost,
} from '../src/connection.js';
import { PostgresClient } from '../src/postgres.js';

const REF = 'nohewrljcqimotoaemyg';
const PASSWORD = 'p@ss:word/with#chars';
const ENCODED = encodeURIComponent(PASSWORD);
const POOLER =
  `postgresql://postgres.${REF}:${ENCODED}@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`;
const DIRECT = `postgresql://postgres:${ENCODED}@db.${REF}.supabase.co:5432/postgres`;

function expectConfigError(fn: () => unknown, code?: string): DatabaseConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    const configError = error as DatabaseConfigError;
    if (code) expect(configError.code).toBe(code);
    return configError;
  }
  throw new Error('expected a DatabaseConfigError');
}

describe('database connection-string validation', () => {
  it('recognises the pg-connection-string dummy host', () => {
    // These are exactly the values that pg parses against `postgres://base`.
    for (const value of ['', '   ', 'base', 'postgres', '?sslmode=require', '${DATABASE_URL}']) {
      expect(resolvesToDummyHost(value)).toBe(true);
    }
    expect(resolvesToDummyHost(POOLER)).toBe(false);
    expect(resolvesToDummyHost('postgresql://aws-0-us-east-1.pooler.supabase.com:5432/postgres')).toBe(false);
  });

  it('rejects empty and relative values instead of resolving them to `base`', () => {
    for (const value of ['', '   ', 'base', 'postgres', '?sslmode=require']) {
      const error = expectConfigError(() => parseDatabaseUrl(value, { env: {} }));
      expect(error.message.toLowerCase()).toContain('base');
      // Guidance may show the `<password>` placeholder, but never a value.
      expect(error.message).not.toContain('super-secret-password');
    }
  });

  it('rejects placeholder values without echoing them', () => {
    for (const value of [
      '${{ secrets.DATABASE_URL }}',
      '${DATABASE_URL}',
      `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`,
      `postgresql://postgres.${REF}:secret@<pooler-host>:5432/postgres`,
    ]) {
      const error = expectConfigError(() => parseDatabaseUrl(value, { env: {} }));
      expect(error.message).not.toContain('secret@');
      expect(error.message).not.toContain('${{');
    }
  });

  it('rejects a missing scheme and an unsupported scheme', () => {
    expectConfigError(
      () => parseDatabaseUrl(`postgres.${REF}:pw@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`, { env: {} }),
      'missing-scheme',
    );
    expectConfigError(() => parseDatabaseUrl(`https://${REF}.supabase.co`, { env: {} }), 'unsupported-scheme');
  });

  it('rejects the Supabase project URL used as a database URL', () => {
    const error = expectConfigError(
      () => parseDatabaseUrl(`postgresql://postgres:pw@${REF}.supabase.co:5432/postgres`, { env: {} }),
      'project-url',
    );
    expect(error.message).toContain('Session Pooler');
  });

  it('parses a Session Pooler URL and keeps the password out of descriptions', () => {
    const target = parseDatabaseUrl(POOLER, { env: {} });
    expect(target.kind).toBe('session-pooler');
    expect(target.host).toBe('aws-1-ap-south-1.pooler.supabase.com');
    expect(target.port).toBe(5432);
    expect(target.user).toBe(`postgres.${REF}`);
    expect(target.database).toBe('postgres');
    expect(target.projectRef).toBe(REF);
    expect(target.ssl).toBe(true);

    const summary = target.describe();
    expect(summary).not.toHaveProperty('password');
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
    expect(JSON.stringify(summary)).not.toContain(ENCODED);

    const pgConfig = target.toPgConfig();
    expect(pgConfig).not.toHaveProperty('connectionString');
    expect(pgConfig.host).toBe('aws-1-ap-south-1.pooler.supabase.com');
    expect(pgConfig.password).toBe(PASSWORD);
    expect(target.secretValues()).toContain(PASSWORD);
  });

  it('decodes percent-encoded and unencoded special characters in the password', () => {
    const encoded = parseDatabaseUrl(POOLER, { env: {} });
    expect(encoded.toPgConfig().password).toBe(PASSWORD);

    const literalAt = `postgresql://postgres.${REF}:pa@ss@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`;
    const target = parseDatabaseUrl(literalAt, { env: {} });
    expect(target.toPgConfig().password).toBe('pa@ss');
  });

  it('accepts surrounding quotes but records the normalisation', () => {
    const target = parseDatabaseUrl(`"${POOLER}"`, { env: {} });
    expect(target.kind).toBe('session-pooler');
    expect(target.notes.join(' ')).toMatch(/quotes/i);
  });

  it('requires the pooler username to carry the project ref', () => {
    expectConfigError(
      () => parseDatabaseUrl(`postgresql://postgres:${ENCODED}@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`, { env: {} }),
      'pooler-user',
    );
    expectConfigError(
      () => parseDatabaseUrl(`postgresql://postgres.${REF}:${ENCODED}@db.${REF}.supabase.co:5432/postgres`, { env: {} }),
      'pooler-user',
    );
  });

  it('corrects the shared transaction-pooler port to Session Pooler port 5432', () => {
    const transaction = POOLER.replace(':5432/', ':6543/');
    const corrected = parseDatabaseUrl(transaction, { env: {}, purpose: 'migration' });
    expect(corrected.kind).toBe('session-pooler');
    // The host, user and password are preserved; only the port changes.
    expect(corrected.host).toBe('aws-1-ap-south-1.pooler.supabase.com');
    expect(corrected.toPgConfig().port).toBe(5432);
    expect(corrected.toPgConfig().password).toBe(PASSWORD);
    expect(corrected.notes.join(' ')).toMatch(/6543/);
    expect(corrected.notes.join(' ')).toMatch(/session/i);

    // Strict mode fails instead of correcting.
    expectConfigError(
      () => parseDatabaseUrl(transaction, { env: { VORTEX_DB_STRICT_POOLER_PORT: 'true' }, purpose: 'migration' }),
      'transaction-pooler',
    );
    // Non-Supabase endpoints are never rewritten.
    const other = parseDatabaseUrl('postgresql://user:pw@db.example.com:6543/postgres', { env: {}, purpose: 'migration' });
    expect(other.kind).toBe('other');
    expect(other.port).toBe(6543);
  });

  it('rejects the IPv6-only direct endpoint on GitHub Actions unless explicitly allowed', () => {
    const error = expectConfigError(
      () => parseDatabaseUrl(DIRECT, { env: { GITHUB_ACTIONS: 'true' } }),
      'direct-ipv6',
    );
    expect(error.message).toContain('IPv6');

    const allowed = parseDatabaseUrl(DIRECT, {
      env: { GITHUB_ACTIONS: 'true', VORTEX_DB_ALLOW_DIRECT_CONNECTION: 'true' },
    });
    expect(allowed.kind).toBe('direct');
    expect(allowed.projectRef).toBe(REF);
    expect(parseDatabaseUrl(DIRECT, { env: {} }).kind).toBe('direct');
  });

  it('rejects sslmode=disable for remote hosts and accepts require', () => {
    expectConfigError(() => parseDatabaseUrl(`${POOLER}?sslmode=disable`, { env: {} }), 'ssl-disabled');
    const target = parseDatabaseUrl(`${POOLER}?sslmode=require`, { env: {} });
    expect(target.sslMode).toBe('require');
    expect(target.toPgConfig().ssl).toEqual({ rejectUnauthorized: false });
    const strict = parseDatabaseUrl(`${POOLER}?sslmode=verify-full`, { env: {} });
    expect(strict.toPgConfig().ssl).toEqual({ rejectUnauthorized: true });
  });

  it('verifies the pooler username against SUPABASE_PROJECT_REF when configured', () => {
    expect(() => parseDatabaseUrl(POOLER, { env: { SUPABASE_PROJECT_REF: REF } })).not.toThrow();
    const error = expectConfigError(
      () => parseDatabaseUrl(POOLER, { env: { SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst' } }),
      'project-mismatch',
    );
    expect(error.message).toContain(REF);
  });

  it('builds a client only from a validated target (no DNS for `base`)', () => {
    expect(() => new PostgresClient({ connectionString: 'base' })).toThrow(DatabaseConfigError);
    expect(() => new PostgresClient({ connectionString: '' })).toThrow(DatabaseConfigError);
    // The safe message mentions the dummy host and the expected format, but
    // never the offending value or a credential.
    try {
      new PostgresClient({ connectionString: 'base' });
    } catch (error) {
      expect((error as Error).message).toContain('base');
      expect((error as Error).message).toContain('Session Pooler');
      expect((error as Error).message).not.toContain('DATABASE_URL=base');
    }
  });

  it('never includes a password in a malformed-URL error', () => {
    const error = expectConfigError(() =>
      parseDatabaseUrl('postgresql://postgres.ref:super-secret-password@', { env: {} }),
    );
    expect(error.message).not.toContain('super-secret-password');
  });

  it('fails closed on an empty password segment (silent 28P01 otherwise)', () => {
    const error = expectConfigError(
      () =>
        parseDatabaseUrl(
          `postgresql://postgres.${REF}:@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`,
          { env: {} },
        ),
      'missing-password',
    );
    expect(error.message.toLowerCase()).toContain('password');
    expect(error.message).not.toContain('@aws');
    // A local/embedded endpoint may legitimately have no password.
    expect(() => parseDatabaseUrl('postgresql://postgres:@localhost:5432/postgres', { env: {} })).not.toThrow();
  });

  it('warns when the password appears double-encoded', () => {
    const target = parseDatabaseUrl(
      `postgresql://postgres.${REF}:p%2540ss@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`,
      { env: {} },
    );
    // Decoded once: the sent password is the literal string "p%40ss".
    expect(target.toPgConfig().password).toBe('p%40ss');
    expect(target.notes.join(' ')).toMatch(/double-encoded/i);
    // A single-encoded password must not trigger the warning.
    const single = parseDatabaseUrl(POOLER, { env: {} });
    expect(single.notes.join(' ')).not.toMatch(/double-encoded/i);
  });

  it('flags unexpected query keys and fragments (raw ? or # in the password)', () => {
    const withFragment = parseDatabaseUrl(`${POOLER}#stale`, { env: {} });
    expect(withFragment.notes.join(' ')).toMatch(/fragment/i);
  });

  it('reports password presence without exposing the password', () => {
    const summary = parseDatabaseUrl(POOLER, { env: {} }).describe();
    expect(summary.passwordPresent).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(PASSWORD);
    expect(JSON.stringify(summary)).not.toContain(ENCODED);

    const empty = parseDatabaseUrl(
      `postgresql://postgres.${REF}:@localhost:5432/postgres`,
      { env: {} },
    ).describe();
    expect(empty.passwordPresent).toBe(false);
  });
});

describe('database connection resolution', () => {
  it('prefers DATABASE_URL (Session Pooler) and ignores a broken direct secret', () => {
    const resolved = resolveDatabaseConnection({
      env: { DATABASE_URL: POOLER, DATABASE_URL_DIRECT: 'base' },
      purpose: 'migration',
    });
    expect(resolved.target?.source).toBe('DATABASE_URL');
    expect(resolved.target?.kind).toBe('session-pooler');
    expect(resolved.warnings.join(' ')).toContain('DATABASE_URL_DIRECT');
    expect(resolved.warnings.join(' ')).toContain('base');
  });

  it('surfaces the transaction-pooler port correction as a warning', () => {
    const resolved = resolveDatabaseConnection({
      env: { DATABASE_URL: POOLER.replace(':5432/', ':6543/') },
      purpose: 'migration',
    });
    expect(resolved.target?.toPgConfig().port).toBe(5432);
    expect(resolved.warnings.join(' ')).toMatch(/6543/);
  });

  it('reports a valid but unused DATABASE_URL_DIRECT as ignored', () => {
    const resolved = resolveDatabaseConnection({
      env: { DATABASE_URL: POOLER, DATABASE_URL_DIRECT: DIRECT },
      purpose: 'migration',
    });
    expect(resolved.target?.source).toBe('DATABASE_URL');
    expect(resolved.warnings.join(' ')).toMatch(/ignored/i);
  });

  it('uses DATABASE_URL_DIRECT only when DATABASE_URL is absent', () => {
    const resolved = resolveDatabaseConnection({
      env: { DATABASE_URL_DIRECT: DIRECT },
      purpose: 'diagnostic',
    });
    expect(resolved.target?.source).toBe('DATABASE_URL_DIRECT');
    expect(resolved.target?.kind).toBe('direct');
    expect(resolved.warnings.join(' ')).toMatch(/Session Pooler/i);
  });

  it('does not mask an invalid DATABASE_URL with a valid DATABASE_URL_DIRECT', () => {
    expect(() =>
      resolveDatabaseConnection({
        env: { DATABASE_URL: 'base', DATABASE_URL_DIRECT: DIRECT },
        purpose: 'migration',
      }),
    ).toThrow(DatabaseConfigError);
  });

  it('returns no target when no database is configured', () => {
    const resolved = resolveDatabaseConnection({ env: {}, purpose: 'diagnostic' });
    expect(resolved.target).toBeNull();
    expect(resolved.warnings).toHaveLength(0);
  });
});
