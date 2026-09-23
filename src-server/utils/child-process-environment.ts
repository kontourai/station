import { INTERNAL_API_TOKEN_ENV } from './internal-api-token.js';

/**
 * Per-boot secrets the launcher injects into the Station server process
 * (`packages/cli/src/commands/lifecycle.ts`). They prove home-possession
 * for unredacted log reads and must never ride a paired-device PTY or a
 * generic engine subprocess. The built-in station-control MCP child is
 * the one exception: `withStationControlRuntimeEnv` re-attaches
 * {@link INTERNAL_API_TOKEN_ENV} after this scrub, only for that exact
 * binary.
 */
export const BOOT_INTERNAL_SECRET_ENV_KEYS = [
  INTERNAL_API_TOKEN_ENV,
  'STATION_UI_BOOTSTRAP_TOKEN',
] as const;

/**
 * Settings addressed to this process by its own supervisor, never to the
 * processes it spawns. `STATION_STDOUT_LOGS=0` inherited by a `station start`
 * or test run inside a desktop terminal would silently empty that process's
 * stdout log (#2327).
 */
export const SUPERVISOR_CHANNEL_ENV_KEYS = ['STATION_STDOUT_LOGS'] as const;

/** Removes the boot-internal secrets and, despite the name, the
 * supervisor-channel settings above: every caller that must not leak one
 * must not leak the other. */
export function scrubBootInternalSecrets(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of [
    ...BOOT_INTERNAL_SECRET_ENV_KEYS,
    ...SUPERVISOR_CHANNEL_ENV_KEYS,
  ]) {
    delete next[key];
  }
  return next;
}

/**
 * Environment for a spawned child. Copies `process.env`, layers `extra`,
 * then deletes boot-internal secrets. Callers that already built a full
 * env object should use {@link scrubBootInternalSecrets} instead of
 * spreading `process.env` again.
 */
export function childProcessEnvironment(
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return scrubBootInternalSecrets({ ...process.env, ...extra });
}
