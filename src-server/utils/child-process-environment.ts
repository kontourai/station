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

export function scrubBootInternalSecrets(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of BOOT_INTERNAL_SECRET_ENV_KEYS) {
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
