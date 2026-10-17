#!/usr/bin/env node
/**
 * Read-only database diagnostic.
 *
 *   npm run db:diagnose                 # validate + DNS + connect + migration status
 *   npm run db:diagnose -- --config-only
 *   npm run db:diagnose -- --dns-only
 *   npm run db:diagnose -- --require-configured
 *
 * Guarantees:
 *  - Never prints the connection string or the password; only a parsed summary.
 *  - Never applies migrations, creates tables, or changes policies/data.
 *  - Validates the URI before `pg` sees it, so a typo cannot surface as the
 *    confusing `getaddrinfo EAI_AGAIN base` from pg-connection-string.
 *
 * Exit codes: 0 healthy/not configured, 1 unreachable/drift, 2 configuration error.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  authenticationFailureGuidance,
  DatabaseConfigError,
  resolveDatabaseConnection,
  type DatabaseTarget,
} from '../connection.js';
import { status } from '../migrate.js';
import { createPostgresClientFromTarget } from '../postgres.js';

const args = new Set(process.argv.slice(2));
const configOnly = args.has('--config-only');
const dnsOnly = args.has('--dns-only');
const requireConfigured = args.has('--require-configured');
// `--read-only` is accepted as an explicit assertion of intent. The command
// never writes regardless, so it has no behavioural effect.
const _readOnly = args.has('--read-only');

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * GitHub Actions annotations are visible in `gh run view` even when the raw job
 * log cannot be downloaded. They carry only the safe summary (host/port/user),
 * never the connection string or password.
 */
function annotate(level: 'notice' | 'warning' | 'error', title: string, message: string): void {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const safe = message.replace(/\r?\n/g, ' ').replace(/::/g, ':').slice(0, 900);
  process.stdout.write(`::${level} title=${title}::${safe}\n`);
}

function fail(text: string, code: number): never {
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

function presence(name: string, value: string | undefined): string {
  return `${name}: ${value && value.trim().length > 0 ? 'set' : 'missing'}`;
}

function describe(target: DatabaseTarget): string {
  const summary = target.describe();
  return [
    `source=${summary.source}`,
    `endpoint=${summary.kind}`,
    `host=${summary.host}`,
    `port=${summary.port}`,
    `database=${summary.database}`,
    `user=${summary.user || '(default)'}`,
    `password_present=${summary.passwordPresent ? 'yes' : 'no'}`,
    `ssl=${summary.ssl ? (summary.sslMode ?? 'required') : 'off'}`,
    `project_ref=${summary.projectRef ?? '(not a Supabase endpoint)'}`,
  ].join(' ');
}

async function checkDns(target: DatabaseTarget): Promise<{ ok: boolean; ipv4: number }> {
  if (isIP(target.host)) {
    line(`dns: ${target.host} is an IP literal`);
    return { ok: true, ipv4: target.host.includes('.') ? 1 : 0 };
  }
  try {
    const addresses = await lookup(target.host, { all: true, verbatim: true });
    const ipv4 = addresses.filter((entry) => entry.family === 4).length;
    const ipv6 = addresses.filter((entry) => entry.family === 6).length;
    line(`dns: ${target.host} -> ${addresses.map((entry) => `${entry.address} (IPv${entry.family})`).join(', ')}`);
    if (target.kind === 'session-pooler' || target.kind === 'transaction-pooler') {
      if (ipv4 === 0) {
        line(
          'warning: the pooler host has no IPv4 address. GitHub Actions runners are IPv4-only; ' +
            're-copy the pooler host from the Supabase dashboard (it must be an IPv4-proxied host).',
        );
        return { ok: false, ipv4 };
      }
      line(`dns: IPv4 available (${ipv4}) — compatible with IPv4-only GitHub Actions runners`);
    }
    if (target.kind === 'direct' && ipv6 > 0 && ipv4 === 0) {
      line(
        'warning: the direct Supabase endpoint is IPv6-only. Use the Session Pooler URI for GitHub Actions.',
      );
    }
    return { ok: true, ipv4 };
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'unknown';
    line(`dns: FAILED for ${target.host} (${code})`);
    return { ok: false, ipv4: 0 };
  }
}

async function main(): Promise<void> {
  line('VORTEX SI — read-only database diagnostic');
  const hasPrimary = Boolean((process.env.DATABASE_URL ?? '').trim());
  const hasDirect = Boolean((process.env.DATABASE_URL_DIRECT ?? '').trim());
  line(presence('DATABASE_URL', process.env.DATABASE_URL));
  line(presence('DATABASE_URL_DIRECT', process.env.DATABASE_URL_DIRECT));
  annotate(
    'notice',
    'Database env',
    `DATABASE_URL=${hasPrimary ? 'set' : 'missing'}; DATABASE_URL_DIRECT=${hasDirect ? 'set' : 'missing'}`,
  );

  let resolved;
  try {
    resolved = resolveDatabaseConnection({ purpose: 'diagnostic' });
  } catch (error) {
    if (error instanceof DatabaseConfigError) {
      line('');
      line(`configuration: INVALID (${error.code} in ${error.variable})`);
      line(error.message);
      line('');
      line('No connection was attempted. Nothing was created, applied or changed.');
      annotate('error', 'Database configuration', `${error.code} in ${error.variable}: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }

  for (const warning of resolved.warnings) {
    line(`warning: ${warning}`);
    annotate('warning', 'Database warning', warning);
  }

  const target = resolved.target;
  if (!target) {
    line('');
    line('configuration: no database configured (embedded/local mode is available with VORTEX_USE_EMBEDDED_DB=true).');
    line('read-only: no connection attempted, nothing changed.');
    if (requireConfigured) {
      annotate('error', 'Database configuration', 'DATABASE_URL is not configured (--require-configured).');
      fail('::error::DATABASE_URL is not configured (--require-configured).', 2);
    }
    return;
  }

  line(`configuration: OK — ${describe(target)}`);
  annotate('notice', 'Database configuration', describe(target));
  for (const note of target.notes) line(`note: ${note}`);

  if (target.kind === 'transaction-pooler' || target.kind === 'dedicated-pooler') {
    line('');
    line(
      `configuration: UNSUPPORTED — endpoint=${target.kind} (port ${target.port}). ` +
        'VORTEX SI requires the Session Pooler on port 5432: it uses session-level advisory locks ' +
        'and multi-statement transactions.',
    );
    line('No connection was attempted. Nothing was created, applied or changed.');
    annotate(
      'error',
      'Database configuration',
      `${target.source}: unsupported endpoint ${target.kind} (port ${target.port}); use Session Pooler port 5432`,
    );
    process.exit(2);
  }

  if (!configOnly) {
    const dns = await checkDns(target);
    if (!dns.ok && !dnsOnly) {
      fail(
        'Database unreachable: DNS lookup did not produce a usable address. ' +
          'Nothing was created, applied or changed.',
        1,
      );
    }
    if (dnsOnly) {
      line('read-only: DNS check complete; no connection attempted, nothing changed.');
      return;
    }
  } else {
    line('read-only: configuration check complete; no connection attempted, nothing changed.');
    return;
  }

  const client = createPostgresClientFromTarget(target, {
    applicationName: 'vortex-si-diagnose',
    max: 1,
  });

  try {
    const probe = await client.query<{ ok: number }>('select 1 as ok');
    if (probe.rows[0]?.ok !== 1) {
      fail('Database unreachable: the read-only probe returned an unexpected result.', 1);
    }
    line('connection: OK (read-only `select 1`)');

    const rows = await status(client);
    const applied = rows.filter((row) => row.appliedAt !== null).length;
    const pending = rows.length - applied;
    const drift = rows.filter((row) => row.drift).length;
    line(`migrations: ${applied} applied, ${pending} pending, ${drift} checksum drift`);
    if (applied === 0) {
      line('migrations: schema_migrations is absent — reported as pending without creating it.');
    }
    for (const row of rows.filter((entry) => entry.drift)) {
      line(`drift: ${row.version}_${row.name}`);
    }
    line('read-only: no migration was applied, no table was created, no data was changed.');
    annotate(
      drift > 0 ? 'error' : 'notice',
      'Database diagnostic',
      `configuration OK; connection OK; migrations ${applied} applied / ${pending} pending / ${drift} drift (read-only)`,
    );
    if (drift > 0) process.exitCode = 1;
  } catch (error) {
    // PostgresClient sanitises driver messages (password/URI redacted).
    const failure = error as Error & { code?: string | number };
    process.stderr.write(`Database unreachable: ${failure.message}\n`);
    if (failure.code === '28P01' || /password authentication failed/i.test(failure.message)) {
      process.stderr.write(`\n${authenticationFailureGuidance(target.projectRef)}\n`);
      annotate(
        'error',
        'Database authentication failed',
        'Password rejected (28P01). The route, host, port, database and user are ' +
          'correct; the repository secret DATABASE_URL holds the wrong password. ' +
          'See the checklist in the log. The password and URI are never printed.',
      );
    }
    process.stderr.write('Nothing was created, applied or changed.\n');
    annotate('error', 'Database unreachable', failure.message);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
