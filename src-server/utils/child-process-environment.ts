import { SERVICE_LAUNCHER_ENV } from '@kontourai/station-shared/service-launcher-protocol';
import { SUPERVISOR_ENV } from '@kontourai/station-supervisor/protocol';
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
 * stdout log (#2327). The supervision markers say "a supervisor restarts
 * THIS process": inherited by a terminal or engine child, a Station started
 * from there would read itself as supervised and refuse its own core update
 * (#2674), or arm a parent watchdog against a process that is not its parent.
 * The service launcher's context (#2675 D) names the install whose update
 * requests only the launcher-supervised server may queue.
 */
const SUPERVISOR_CHANNEL_ENV_KEYS = [
  'STATION_STDOUT_LOGS',
  // Desktop's compile cache belongs to the server, never user Node programs.
  'NODE_COMPILE_CACHE',
  SUPERVISOR_ENV.pid,
  'STATION_SUPERVISOR_BIRTH',
  // The process supervisor's generation markers. A Station started from a
  // terminal or engine that inherited them would believe it was a forked
  // generation, and refuse to start without the IPC channel it never had.
  SUPERVISOR_ENV.ipc,
  SUPERVISOR_ENV.generation,
  'STATION_SERVICE_MANAGED',
  SERVICE_LAUNCHER_ENV,
] as const;

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
 * `base` with `extra` layered over it. On Windows a variable's name is
 * case-insensitive and a child gets only one of `HTTPS_PROXY` and
 * `https_proxy` (Node keeps the first in its sorted, case-insensitive order),
 * so there a name in `extra` also removes every case-variant of it from
 * `base`. Without that, an inherited `HTTPS_PROXY` would beat an
 * `https_proxy` a managed policy locked (#4515).
 */
function layerEnvironment(
  base: NodeJS.ProcessEnv,
  extra: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!extra || platform !== 'win32') return { ...base, ...extra };
  const overridden = new Set(
    Object.keys(extra).map((name) => name.toUpperCase()),
  );
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base))
    if (!overridden.has(name.toUpperCase())) kept[name] = value;
  return { ...kept, ...extra };
}

/**
 * Environment for a spawned child. Copies `process.env`, layers `extra`
 * (on Windows a name in `extra` replaces every case-variant, see
 * {@link layerEnvironment}), then deletes boot-internal secrets. Callers
 * that already built a full env object should use
 * {@link scrubBootInternalSecrets} instead of spreading `process.env` again.
 */
export function childProcessEnvironment(
  extra?: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return scrubBootInternalSecrets(
    layerEnvironment(process.env, extra, platform),
  );
}
