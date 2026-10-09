import { BOOT_INTERNAL_SECRET_ENV_KEYS } from '../../utils/child-process-environment.js';
import { expandTilde } from '../../utils/paths.js';

/**
 * station#2072: per-connection env + config-home overrides for the Claude
 * and Codex CLI adapters, so an agent connection can route through a local
 * model proxy (CLIProxyAPI/VibeProxy) configured per connection. This
 * module owns the ONE validation + expansion implementation used by BOTH
 * consumers: the write-time sanitizer
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

const CONNECTION_CONFIG_HOME_ENV_KEYS = {
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

/**
 * A credential profile's env overlay is meant to carry no credential values:
 * the profile's own app home owns them. This is a heuristic, not a secret
 * detector. A non-empty value is refused when its NAME looks like a
 * credential, or when the VALUE carries one in a recognisable shape (URL
 * userinfo, an authorization header, a bearer/basic scheme). The empty string
 * stays legal under any name because masking an inherited credential (e.g.
 * `ANTHROPIC_API_KEY: ""` beside a proxy base URL) is the overlay's main use.
 * Deliberately over-inclusive: a refused non-secret value can live in the
 * connection `env` instead.
 */
const CREDENTIAL_SHAPED_ENV_NAME_PATTERNS: readonly RegExp[] = [
  /(KEYS?|TOKENS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?|AUTH|HEADERS?)$/i,
  // `PAT` only as its own word: `GITHUB_PAT`, not `COMPAT`.
  /(^|_)PAT$/i,
];

const CREDENTIAL_SHAPED_ENV_VALUE_PATTERNS: readonly RegExp[] = [
  // scheme://user[:password]@host — credentials embedded in a URL. Only the
  // scheme's last character is matched: an unbounded scheme run rescans the
  // rest of the value from every start position, which is quadratic (tens
  // of seconds for a full-cap overlay of letters), and any scheme, however
  // long or oddly spelled, still ends in one of these characters.
  /[a-z0-9+.-]:\/\/[^/?#\s@]+@/i,
  // An HTTP authorization header or an API-key header, anywhere in the value.
  /\b(proxy-)?authorization\s*:/i,
  /\b(x-)?api[-_]?key\s*:/i,
  // A bearer or basic credential scheme followed by material.
  /\bbearer\s+\S/i,
  /\bbasic\s+[A-Za-z0-9+/=]{8,}/i,
];

function looksLikeCredential(name: string, value: string): boolean {
  if (value === '') return false;
  return (
    CREDENTIAL_SHAPED_ENV_NAME_PATTERNS.some((pattern) => pattern.test(name)) ||
    CREDENTIAL_SHAPED_ENV_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  );
}

/**
 * The profile overlay additionally refuses both engines' config-home keys:
 * the selected profile's app home is the one value those keys may hold.
 */
const CREDENTIAL_PROFILE_ENV_REFUSED_KEYS = new Set<string>([
  ...CONNECTION_ENV_REFUSED_KEYS,
  ...Object.values(CONNECTION_CONFIG_HOME_ENV_KEYS),
]);

export type CredentialProfileEnvValidation =
  | { ok: true; env: Record<string, string> }
  | {
      ok: false;
      violations: string[];
      /**
       * Offending variable names, for diagnostics and projections. Only
       * well-formed names appear: a malformed "name" could itself be pasted
       * secret text, so it is counted in `violations` but never echoed.
       */
      names: string[];
    };

/**
 * Strict, all-or-nothing validation of a credential profile's env overlay.
 * Unlike the connection env's drop-never-throw sanitizer, a profile overlay
 * is either applied whole or refused: silently dropping an entry (say the
 * `ANTHROPIC_API_KEY: ""` mask) would route a session with credentials it
 * was configured to hide. Violation text names the offending variable but
 * never echoes a value, which may be a pasted secret. `null` and `undefined`
 * both mean "no overlay".
 */
export function validateCredentialProfileEnv(
  value: unknown,
): CredentialProfileEnvValidation {
  if (value === undefined || value === null) return { ok: true, env: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      violations: ['env must be an object of strings'],
      names: [],
    };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const violations: string[] = [];
  const names: string[] = [];
  if (entries.length > CONNECTION_ENV_MAX_ENTRIES) {
    violations.push(
      `env has ${entries.length} entries; at most ${CONNECTION_ENV_MAX_ENTRIES} are allowed`,
    );
  }
  const env: Record<string, string> = {};
  const refuse = (name: string, violation: string) => {
    names.push(name);
    violations.push(violation);
  };
  for (const [name, raw] of entries) {
    if (!CONNECTION_ENV_NAME_PATTERN.test(name)) {
      violations.push('env contains an invalid variable name');
      continue;
    }
    if (CREDENTIAL_PROFILE_ENV_REFUSED_KEYS.has(name)) {
      refuse(name, `${name} is owned by Station and cannot be set`);
      continue;
    }
    if (typeof raw !== 'string') {
      refuse(name, `${name} must be a string`);
      continue;
    }
    if (raw.length > CONNECTION_ENV_VALUE_MAX_LENGTH) {
      refuse(
        name,
        `${name} is longer than ${CONNECTION_ENV_VALUE_MAX_LENGTH} characters`,
      );
      continue;
    }
    if (raw.includes('\u0000')) {
      refuse(name, `${name} contains a NUL character`);
      continue;
    }
    if (looksLikeCredential(name, raw)) {
      refuse(
        name,
        `${name} looks like a credential (name or value); a profile env may only mask it with an empty value`,
      );
      continue;
    }
    env[name] = raw;
  }
  return violations.length > 0
    ? { ok: false, violations, names }
    : { ok: true, env };
}

/**
 * Longest variable name an invalid-overlay marker records. A well-formed
 * but very long "name" is more likely pasted text than a variable, so it is
 * dropped from the marker rather than echoed.
 */
const CREDENTIAL_PROFILE_ENV_INVALID_NAME_MAX_LENGTH = 128;

/**
 * The name list of a credential profile's value-free invalid-overlay marker
 * (`envInvalid.names`), from validation output or an untrusted persisted
 * marker: well-formed, bounded, de-duplicated names only, at most
 * {@link CONNECTION_ENV_MAX_ENTRIES}. Anything else is dropped, never echoed.
 */
export function sanitizeCredentialProfileEnvInvalidNames(
  value: unknown,
): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const name of value) {
    if (
      typeof name !== 'string' ||
      name.length > CREDENTIAL_PROFILE_ENV_INVALID_NAME_MAX_LENGTH ||
      !CONNECTION_ENV_NAME_PATTERN.test(name) ||
      names.includes(name)
    ) {
      continue;
    }
    names.push(name);
    if (names.length >= CONNECTION_ENV_MAX_ENTRIES) break;
  }
  return names;
}

/**
 * The registry's form of {@link validateCredentialProfileEnv}: the whole
 * overlay, or `undefined` when any entry is invalid (never a partial map).
 */
export function sanitizeCredentialProfileEnv(
  value: unknown,
): Record<string, string> | undefined {
  const result = validateCredentialProfileEnv(value);
  return result.ok ? result.env : undefined;
}
