export interface ACPConnectionConfig {
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
  cwd?: string;
  enabled: boolean;
  source?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
  /**
   * Explicit opt-in (docs/design/connections-onboarding.md §5): ids of
   * Station tool servers (`ToolDef.id`, kind 'mcp') to pass through to this
   * ACP-connected agent's sessions via `session/new`'s `mcpServers`. Absent
   * or empty means no passthrough — OFF by default; the hygiene rule is
   * "never silent" (§5), so this must always be a deliberate per-connection
   * choice, never inferred. Only stdio-transport tool servers can be
   * resolved today; others are skipped with a logged reason (http/sse
   * passthrough is a follow-up, see connections-onboarding.md §5/§6).
   */
  provideToolServers?: string[];
}

export interface ACPConnectionRegistryEntry {
  id: string;
  name: string;
  command: string;
  args?: string[];
  icon?: string;
  cwd?: string;
  description?: string;
  tags?: string[];
  source?: 'core' | 'plugin';
  sourceName?: string;
  /** The provider executable was found on this Station host. */
  detected?: boolean;
  /** A connection for this provider is configured in Station. */
  installed?: boolean;
  installedSource?: 'user' | 'plugin';
  interactive?: {
    args: string[];
  };
  /** How to install the engine's CLI, per host platform. Station never runs it. */
  install?: ACPEngineInstallRecipes;
  /**
   * Non-secret variables Station sets when it launches `command`. The
   * environment Station would otherwise launch with wins on a conflict.
   */
  launchEnv?: Record<string, string>;
  /** Descriptive sign-in facts. Nothing in Station derives sign-in state from them yet. */
  auth?: ACPEngineAuthDescriptor;
  homepageUrl?: string;
  /**
   * Server projection: `install` for the platform Station runs on. Not part
   * of a descriptor; producers leave it unset.
   */
  hostInstall?: ACPEngineInstallRecipe;
}

export const ACP_ENGINE_INSTALL_PLATFORMS = [
  'darwin',
  'linux',
  'win32',
] as const;
export type ACPEngineInstallPlatform =
  (typeof ACP_ENGINE_INSTALL_PLATFORMS)[number];

export interface ACPEngineInstallRecipe {
  /** One copyable shell command for that platform's default shell. */
  command?: string;
  docsUrl?: string;
  /** e.g. an unsupported architecture, or a prerequisite. */
  note?: string;
}

export type ACPEngineInstallRecipes = Partial<
  Record<ACPEngineInstallPlatform, ACPEngineInstallRecipe>
>;

export interface ACPEngineAuthDescriptor {
  /** A non-interactive command (argv) that reports the engine's sign-in status. */
  statusCommand?: string[];
  /** How to sign in, in one or two sentences. */
  signInHint?: string;
  /** Names of credential environment variables the engine accepts. Names only. */
  credentialEnvVars?: string[];
  /** ACP auth method ids Station should not offer. */
  hiddenAuthMethodIds?: string[];
}

const ACP_DESCRIPTOR_TEXT_MAX = 400;
const ACP_DESCRIPTOR_LIST_MAX = 16;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Name segments that mark a variable as credential-bearing. Matched per
 * `_`-separated segment so `GOOSE_DISABLE_KEYRING` is not mistaken for a key.
 */
const SECRET_ENV_SEGMENTS = new Set([
  'KEY',
  'APIKEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSWD',
  'CREDENTIAL',
  'CREDENTIALS',
  'AUTH',
  'COOKIE',
  'SESSION',
]);

function looksLikeSecretEnvName(name: string): boolean {
  return name
    .toUpperCase()
    .split('_')
    .some((segment) => SECRET_ENV_SEGMENTS.has(segment));
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= ACP_DESCRIPTOR_TEXT_MAX
  );
}

function isHttpsUrl(value: unknown): boolean {
  if (!isBoundedText(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedStringList(
  value: unknown,
  field: string,
  errors: string[],
  item: (entry: string) => boolean = isBoundedText,
): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > ACP_DESCRIPTOR_LIST_MAX
  ) {
    errors.push(
      `${field} must be a list of 1-${ACP_DESCRIPTOR_LIST_MAX} entries`,
    );
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !item(entry)) {
      errors.push(`${field}[${index}] is not valid`);
    }
  });
}

/**
 * Validates the descriptor fields of a registry entry (`install`,
 * `launchEnv`, `auth`, `homepageUrl`). Returns every problem found; an empty
 * list means the descriptor is usable. Fields that are absent are valid.
 */
export function validateACPEngineDescriptor(
  entry: Pick<
    ACPConnectionRegistryEntry,
    'install' | 'launchEnv' | 'auth' | 'homepageUrl'
  >,
): string[] {
  const errors: string[] = [];
  if (entry.homepageUrl !== undefined && !isHttpsUrl(entry.homepageUrl)) {
    errors.push('homepageUrl must be an https URL');
  }

  if (entry.install !== undefined) {
    if (!isRecord(entry.install)) {
      errors.push('install must be an object keyed by platform');
    } else {
      for (const [platform, recipe] of Object.entries(entry.install)) {
        const at = `install.${platform}`;
        if (
          !(ACP_ENGINE_INSTALL_PLATFORMS as readonly string[]).includes(
            platform,
          )
        ) {
          errors.push(`${at}: unknown platform`);
          continue;
        }
        if (!isRecord(recipe)) {
          errors.push(`${at} must be an object`);
          continue;
        }
        const { command, docsUrl, note, ...rest } = recipe;
        if (Object.keys(rest).length > 0) {
          errors.push(`${at}: unknown field ${Object.keys(rest).join(', ')}`);
        }
        if (
          command === undefined &&
          docsUrl === undefined &&
          note === undefined
        ) {
          errors.push(`${at} needs a command, docsUrl or note`);
        }
        if (command !== undefined && !isBoundedText(command)) {
          errors.push(`${at}.command is not valid`);
        }
        if (docsUrl !== undefined && !isHttpsUrl(docsUrl)) {
          errors.push(`${at}.docsUrl must be an https URL`);
        }
        if (note !== undefined && !isBoundedText(note)) {
          errors.push(`${at}.note is not valid`);
        }
      }
    }
  }

  const credentialEnvVars = new Set(entry.auth?.credentialEnvVars ?? []);
  if (entry.launchEnv !== undefined) {
    if (!isRecord(entry.launchEnv)) {
      errors.push('launchEnv must be an object');
    } else {
      const names = Object.keys(entry.launchEnv);
      if (names.length > ACP_DESCRIPTOR_LIST_MAX) {
        errors.push(
          `launchEnv may set at most ${ACP_DESCRIPTOR_LIST_MAX} variables`,
        );
      }
      for (const [name, value] of Object.entries(entry.launchEnv)) {
        if (!ENV_NAME_PATTERN.test(name)) {
          errors.push(`launchEnv.${name}: not a variable name`);
        } else if (
          looksLikeSecretEnvName(name) ||
          credentialEnvVars.has(name)
        ) {
          errors.push(`launchEnv.${name}: credentials never go in launchEnv`);
        }
        if (
          typeof value !== 'string' ||
          value.length > ACP_DESCRIPTOR_TEXT_MAX
        ) {
          errors.push(`launchEnv.${name}: value must be a short string`);
        }
      }
    }
  }

  if (entry.auth !== undefined) {
    if (!isRecord(entry.auth)) {
      errors.push('auth must be an object');
    } else {
      const auth = entry.auth;
      if (auth.statusCommand !== undefined) {
        boundedStringList(auth.statusCommand, 'auth.statusCommand', errors);
      }
      if (auth.signInHint !== undefined && !isBoundedText(auth.signInHint)) {
        errors.push('auth.signInHint is not valid');
      }
      if (auth.credentialEnvVars !== undefined) {
        boundedStringList(
          auth.credentialEnvVars,
          'auth.credentialEnvVars',
          errors,
          (name) => ENV_NAME_PATTERN.test(name),
        );
      }
      if (auth.hiddenAuthMethodIds !== undefined) {
        boundedStringList(
          auth.hiddenAuthMethodIds,
          'auth.hiddenAuthMethodIds',
          errors,
        );
      }
    }
  }
  return errors;
}

/** The install recipe for one host platform (`process.platform` values). */
export function installRecipeForPlatform(
  install: ACPEngineInstallRecipes | undefined,
  platform: string,
): ACPEngineInstallRecipe | undefined {
  if (!install) return undefined;
  return (ACP_ENGINE_INSTALL_PLATFORMS as readonly string[]).includes(platform)
    ? install[platform as ACPEngineInstallPlatform]
    : undefined;
}

export interface ACPConfig {
  connections: ACPConnectionConfig[];
}

/** ACP protocol identifier, preserved losslessly for unstable/future values. */
export type ACPLlmProtocol = string;

/** Non-secret provider routing state observed from `providers/list`. */
export interface ACPProviderInfo {
  providerId: string;
  supported: ACPLlmProtocol[];
  required: boolean;
  current?: { apiType: ACPLlmProtocol; baseUrl: string } | null;
}

/**
 * Declared-vs-observed provider evidence, parallel to RuntimeCatalogStatus.
 * `source: 'none'` plus its reason distinguishes no observation from an
 * observed initialize handshake that advertised no provider capability.
 */
export interface ACPProviderRoutingStatus {
  source: 'live' | 'stale' | 'none';
  fetchedAt?: string | null;
  reason?: string | null;
  providers: ACPProviderInfo[];
}

/** Write-only API shape; binding ids are metadata, never secret values. */
export interface ACPSetProviderRequest {
  providerId: string;
  apiType: ACPLlmProtocol;
  baseUrl: string;
  /** Every header value crosses Station's secret boundary; literal values are not accepted. */
  secretHeaderRefs?: Record<string, string>;
}

export const ACPStatus = {
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  PROBING: 'probing',
} as const;

export type ACPStatusValue = (typeof ACPStatus)[keyof typeof ACPStatus];
