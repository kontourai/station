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
  /**
   * Set when the connection was added from the public agent registry: which
   * listing it came from, so a later listing change can be reported rather
   * than applied.
   */
  publicRegistry?: ACPPublicRegistryProvenance;
}

export interface ACPPublicRegistryProvenance {
  id: string;
  version: string;
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
  /** `registry`: listed by the public agent registry, never a built-in. */
  source?: 'core' | 'plugin' | 'registry';
  sourceName?: string;
  /**
   * The public agent registry's listing. On a `registry` entry it is where
   * the entry came from; on a built-in it is display-only enrichment and
   * never changes the built-in's command, arguments or environment.
   */
  publicRegistry?: ACPPublicRegistryListing;
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
   * Non-secret variables Station sets when it launches a connection whose
   * executable has this entry's `command` name. Applied only from built-in
   * entries; a plugin entry that carries any is refused. The environment
   * Station would otherwise launch with wins on a conflict.
   */
  launchEnv?: Record<string, string>;
  /**
   * The host platforms this entry launches on; absent means all. On any other
   * platform the server reports the entry as not detected.
   */
  platforms?: ACPEngineInstallPlatform[];
  /** Data only, not yet applied: read by the sign-in work, not by Station today. */
  auth?: ACPEngineAuthDescriptor;
  /** Data only, not yet applied: nothing renders it today. */
  homepageUrl?: string;
  /**
   * Server projection: `install` for the platform Station runs on. Not part
   * of a descriptor; producers leave it unset.
   */
  hostInstall?: ACPEngineInstallRecipe;
}

export const ACP_PUBLIC_REGISTRY_DISTRIBUTIONS = [
  'binary',
  'npx',
  'uvx',
] as const;
export type ACPPublicRegistryDistributionKind =
  (typeof ACP_PUBLIC_REGISTRY_DISTRIBUTIONS)[number];

/** One public agent registry listing, as Station read it. */
export interface ACPPublicRegistryListing {
  /** The registry's own id for the agent. */
  id: string;
  version: string;
  /** The registry's `authors`, in its order. */
  publishers: string[];
  license?: string;
  websiteUrl?: string;
  repositoryUrl?: string;
  /** The distribution kinds the registry lists, supported or not. */
  distributions: ACPPublicRegistryDistributionKind[];
  /** The `os-arch` keys (e.g. `darwin-aarch64`) the binary distribution lists. */
  binaryPlatforms: string[];
  /** Packages the registry runs through a package runner. Shown, never run. */
  packages?: Array<{
    kind: Exclude<ACPPublicRegistryDistributionKind, 'binary'>;
    package: string;
    args: string[];
  }>;
  /**
   * What connecting runs on this host: the program found by name on the
   * host's PATH, with the registry's arguments. Absent when this host cannot
   * connect it; `unavailableReason` then says why.
   */
  hostLaunch?: { command: string; args: string[] };
  unavailableReason?: string;
  /**
   * Environment the registry lists for this host's distribution. Station
   * never applies it; it is shown as a recommended setting.
   */
  recommendedEnv?: Record<string, string>;
  /**
   * On an added connection whose saved command, or the version it was added
   * at, no longer matches the listing. Information only: the saved
   * connection is never changed.
   */
  update?: { version: string; command?: string; args?: string[] };
}

/** Where the public agent registry listing currently comes from. */
export interface ACPPublicRegistrySourceStatus {
  /** False when this Station does not read the public registry. */
  enabled: boolean;
  /**
   * `network`: fetched by this Station process. `cache`: the copy saved on
   * disk by an earlier fetch. `none`: no usable listing yet.
   */
  origin: 'network' | 'cache' | 'none';
  /** When the listing in use was downloaded. */
  fetchedAt: string | null;
  /** When Station last tried to download it. */
  checkedAt: string | null;
  /** Why the last attempt failed or its index was refused, when it was. */
  lastError: string | null;
  refreshing: boolean;
  /** Listings refused one by one, with every reason. */
  refused: Array<{ id: string; reasons: string[] }>;
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

/** Data only, not yet applied: nothing in Station runs or reads these yet. */
export interface ACPEngineAuthDescriptor {
  /** A non-interactive command (argv) documented to report sign-in status. Never run today. */
  statusCommand?: string[];
  /** How to sign in, in one or two sentences. */
  signInHint?: string;
  /** Names of credential environment variables the engine accepts. Names only. */
  credentialEnvVars?: string[];
  /** ACP auth method ids meant to be hidden; nothing hides them yet. */
  hiddenAuthMethodIds?: string[];
}

const ACP_DESCRIPTOR_TEXT_MAX = 400;
const ACP_DESCRIPTOR_LIST_MAX = 16;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * The only prefixes a `launchEnv` name may carry: engine-scoped vendor
 * settings the built-in catalogue actually sets. Anything else (a loader,
 * PATH, proxy, TLS or language-runtime variable) can change what the launched
 * process runs or trusts, so it is refused rather than reviewed case by case.
 * Add a prefix only alongside the built-in entry that needs it.
 */
export const ACP_LAUNCH_ENV_PREFIXES = [
  'GOOSE_',
  'DROID_',
  'FACTORY_',
] as const;
/** C0/C1 controls (including line breaks) and bidi embedding/override/isolate marks. */
export function hasUnsafeTextChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true;
  }
  return false;
}
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
    !hasUnsafeTextChar(value) &&
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
 * Validates what a registry entry shows and how it launches: its `name`,
 * `description` and `sourceName` text and the descriptor fields (`install`,
 * `launchEnv`, `platforms`, `auth`, `homepageUrl`). Returns every problem
 * found; an empty list means the entry is usable. Fields that are absent are
 * valid.
 */
export function validateACPEngineDescriptor(
  entry: Partial<
    Pick<
      ACPConnectionRegistryEntry,
      | 'name'
      | 'description'
      | 'sourceName'
      | 'install'
      | 'launchEnv'
      | 'platforms'
      | 'auth'
      | 'homepageUrl'
    >
  >,
): string[] {
  const errors: string[] = [];
  for (const field of ['name', 'description', 'sourceName'] as const) {
    if (entry[field] !== undefined && !isBoundedText(entry[field])) {
      errors.push(`${field} is not valid`);
    }
  }
  if (entry.platforms !== undefined) {
    if (!Array.isArray(entry.platforms) || entry.platforms.length === 0) {
      errors.push('platforms must be a non-empty list');
    } else {
      entry.platforms.forEach((platform, index) => {
        if (
          !(ACP_ENGINE_INSTALL_PLATFORMS as readonly string[]).includes(
            platform,
          )
        ) {
          errors.push(`platforms[${index}]: unknown platform`);
        }
      });
    }
  }
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
        } else if (
          !ACP_LAUNCH_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
        ) {
          errors.push(
            `launchEnv.${name}: not an engine-scoped launch variable`,
          );
        }
        if (
          typeof value !== 'string' ||
          hasUnsafeTextChar(value) ||
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

/** Whether an entry launches on a host platform (`process.platform` value). */
export function engineSupportsPlatform(
  entry: Pick<ACPConnectionRegistryEntry, 'platforms'>,
  platform: string,
): boolean {
  return (
    !entry.platforms ||
    (entry.platforms as readonly string[]).includes(platform)
  );
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
