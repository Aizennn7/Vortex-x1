/**
 * Process roles.
 *
 * One codebase, two deployed services:
 *
 *   relay  — the public API. Safe to restart, scale and expose: it never
 *            schedules a cycle, so a redeploy cannot interrupt ingestion.
 *   worker — the always-on scheduler. Binds no port, publishes its own
 *            heartbeat, and holds a singleton lease so a second instance
 *            stays in standby instead of duplicating work.
 *   all    — both, in one process. The default, for local development.
 *
 * Kept in its own module so the mapping can be tested without booting a server.
 */

export const ROLES = ['all', 'relay', 'worker'] as const;

export type Role = (typeof ROLES)[number];

export interface RolePlan {
  /** Bind and serve the HTTP relay. */
  relay: boolean;
  /** Run the tick scheduler (ingestion, signals, settlement, training). */
  scheduler: boolean;
}

export function isRole(value: string | undefined | null): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * `--role=worker` on the command line overrides `VORTEX_ROLE`; anything
 * unrecognised is ignored so a typo falls back to the configured value rather
 * than silently running the wrong half of the system.
 */
export function roleFromArgv(argv: string[] = process.argv.slice(2)): Role | undefined {
  const flag = argv.find((arg) => arg.startsWith('--role='))?.slice('--role='.length)?.trim();
  return isRole(flag) ? flag : undefined;
}

export function planForRole(role: Role): RolePlan {
  return {
    relay: role === 'all' || role === 'relay',
    scheduler: role === 'all' || role === 'worker',
  };
}