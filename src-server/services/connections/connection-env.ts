import { BOOT_INTERNAL_SECRET_ENV_KEYS } from '../../utils/child-process-environment.js';
import { expandTilde } from '../../utils/paths.js';

/**
 * station#2072: per-connection env + config-home overrides for the Claude
 * and Codex CLI adapters, so an agent connection can route through a local
 * model proxy (CLIProxyAPI/VibeProxy) the way T3 Code's provider instances
 * do. This module owns the ONE validation + expansion implementation used
 * by BOTH consumers: the write-time sanitizer
 * (`connection-service-helpers.ts`'s `sanitizeRuntimeConfig`) and the
 * spawn-time resolver (`station-runtime.ts`'s `getConnectionEnv` adapter
 * closures), so a value that persisted cannot drift from the value a spawn
 * applies — including hand-edited config files, which meet the same rules
 * here again.
 */

/** POSIX-flavored env names only — what `putenv`-style consumers accept. */
const CONNECTION_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Station always owns the engine spawn tmp dir (archive#1908: every engine
 * child must use the reaped engine-spawn directory). A configured TMPDIR
 * would be inert at both spawn seams regardless — the claude SDK env and
 * the codex `spawnCodexProcess` env both merge it last — so it is refused
 * up front rather than silently ignored. POSIX scoping: this invariant is
 * carried by `TMPDIR`; on Windows the spawn envs read `TEMP`/`TMP` via
 * `os.tmpdir()`, which stay ambient (never Station-owned) with or without
 * this refusal.
 */
const CONNECTION_ENV_REFUSED_KEYS = new Set<string>([
  ...BOOT_INTERNAL_SECRET_ENV_KEYS,
  'TMPDIR',
]);

const CONNECTION_ENV_MAX_ENTRIES = 64;
const CONNECTION_ENV_VALUE_MAX_LENGTH = 32 * 1024;

/**
 * Sanitizes `AgentConnectionSettings.config.env` into a plain string map.
 * Follows the module family's drop-never-throw convention (see
 * `sanitizeProvideSkills` / `useAppHome`): anything malformed is dropped,
 * never inferred, never fatal. Empty-string values are KEPT — masking an
 * inherited variable (e.g. `ANTHROPIC_API_KEY: ""` beside an
 * `ANTHROPIC_AUTH_TOKEN` proxy login) is a legitimate configuration.
 */
export function sanitizeConnectionEnvMap(
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const sanitized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      !CONNECTION_ENV_NAME_PATTERN.test(rawKey) ||
      CONNECTION_ENV_REFUSED_KEYS.has(rawKey)
    ) {
      continue;
    }
    if (typeof rawVal !== 'string') continue;
    if (rawVal.length > CONNECTION_ENV_VALUE_MAX_LENGTH) continue;
    if (rawVal.includes('\u0000')) continue;
    if (Object.keys(sanitized).length >= CONNECTION_ENV_MAX_ENTRIES) break;
    sanitized[rawKey] = rawVal;
  }
  return sanitized;
}

/**
 * Sanitizes `AgentConnectionSettings.config.configHome`. Returned
 * as-authored (tilde kept): expansion is a spawn-time concern, so a
 * persisted value never bakes in one machine's home directory. Non-empty
 * after trimming, no NUL — the byte a spawned env value cannot carry.
 */
export function sanitizeConnectionConfigHome(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\u0000')) return undefined;
  return trimmed;
}

/**
 * station#2072 precedence: an explicit `configHome` WINS over the
 * `useAppHome` opt-in — the connection env layer carries the home key and
 * the station-managed profile is neither ensured nor applied. A selected
 * credential profile still wins over both (its resolution order is
 * documented on `AgentExecutionConfig.credentialProfileRef` and unchanged);
 * an explicit configHome applies only when no profile was selected.
 */
export function appHomeActive(
  config: Record<string, unknown> | undefined,
): boolean {
  if (sanitizeConnectionConfigHome(config?.configHome)) return false;
  return config?.useAppHome === true;
}

export const CONNECTION_CONFIG_HOME_ENV_KEYS = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
} as const;

export type ConnectionEnvEngine = keyof typeof CONNECTION_CONFIG_HOME_ENV_KEYS;

/**
 * The full per-connection env layer for an engine spawn: the sanitized env
 * map plus the tilde-expanded config-home key (the dedicated field wins
 * over a same-named `env`-map entry — it is the validated, expanded one).
 * `undefined` when the connection configured neither — callers then keep
 * today's byte-identical spawn env.
 */
export function connectionSpawnEnv(
  config: Record<string, unknown> | undefined,
  engine: ConnectionEnvEngine,
): Record<string, string> | undefined {
  const env = sanitizeConnectionEnvMap(config?.env);
  const configHome = sanitizeConnectionConfigHome(config?.configHome);
  const homeKey = CONNECTION_CONFIG_HOME_ENV_KEYS[engine];
  if (configHome) {
    return { ...env, [homeKey]: expandTilde(configHome) };
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
