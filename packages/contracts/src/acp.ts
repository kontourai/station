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

/**
 * A connection's arguments without empty strings. Station's custom-engine
 * form once saved blank arguments as `['']`, which launches the command with
 * one empty argument and makes an unchanged command compare as changed.
 */
export function normalizeACPArgs(args: readonly string[]): string[] {
  return args.filter((arg) => arg !== '');
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
  /** How Station checks and offers sign-in for this engine. */
  auth?: ACPEngineAuthDescriptor;
  /** Data only, not yet applied: nothing renders it today. */
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
  /**
   * A non-interactive command (argv, no shell) documented to report sign-in
   * status. Run only from built-in entries, and only together with
   * `statusRule`: without a rule there is no reading of its output.
   */
  statusCommand?: string[];
  /** How `statusCommand`'s result reads as signed in or signed out. */
  statusRule?: ACPEngineAuthStatusRule;
  /** How to sign in, in one or two sentences. */
  signInHint?: string;
  /**
   * Names of credential environment variables the engine accepts. A value is
   * kept in Station's engine credential store and given to that one
   * connection's processes; never in a descriptor or `acp.json`.
   */
  credentialEnvVars?: string[];
  /** Advertised sign-in method ids Station does not offer (e.g. one an API key field replaces). */
  hiddenAuthMethodIds?: string[];
  /** Sign-in routes whose provider's terms may restrict use in other tools. */
  subscriptionTermsNotices?: ACPEngineSubscriptionTermsNotice[];
}

/**
 * Reads a status command's result. Anything no field matches is `unknown`:
 * an exit code of 0 alone never means signed in unless the vendor documents
 * a non-zero exit when signed out (`exitZeroMeansSignedIn`).
 */
export interface ACPEngineAuthStatusRule {
  /**
   * A top-level boolean field of the command's JSON stdout: `false` is signed
   * out, `true` is signed in on exit 0. Read before the text fragments.
   */
  signedInJsonField?: string;
  /** Case-insensitive output fragments (stdout or stderr) that mean signed out. */
  signedOutText?: string[];
  /** Exit codes the vendor documents for "signed out". */
  signedOutExitCodes?: number[];
  /** Case-insensitive output fragments that mean signed in, read only on exit 0. */
  signedInText?: string[];
  /** The vendor documents a non-zero exit when signed out, so exit 0 is signed in. */
  exitZeroMeansSignedIn?: boolean;
}

/** A neutral note shown beside sign-in routes that use a subscription login. */
export interface ACPEngineSubscriptionTermsNotice {
  /** The provider whose subscription it is, e.g. `Anthropic`. */
  provider: string;
  /** The provider's page on using that subscription in other tools. */
  termsUrl: string;
  /** Advertised sign-in method ids it applies to; absent means every route. */
  authMethodIds?: string[];
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
  'AUGMENT_',
] as const;
/** C0/C1 controls (including line breaks) and bidi embedding/override/isolate marks. */
function hasUnsafeTextChar(value: string): boolean {
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

function validateStatusRule(
  rule: unknown,
  statusCommand: unknown,
  errors: string[],
): void {
  if (!isRecord(rule)) {
    errors.push('auth.statusRule must be an object');
    return;
  }
  if (statusCommand === undefined) {
    errors.push('auth.statusRule needs auth.statusCommand');
  }
  const {
    signedInJsonField,
    signedOutText,
    signedOutExitCodes,
    signedInText,
    exitZeroMeansSignedIn,
    ...rest
  } = rule;
  if (Object.keys(rest).length > 0) {
    errors.push(
      `auth.statusRule: unknown field ${Object.keys(rest).join(', ')}`,
    );
  }
  if (
    signedInJsonField !== undefined &&
    (typeof signedInJsonField !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(signedInJsonField))
  ) {
    errors.push('auth.statusRule.signedInJsonField must be a field name');
  }
  if (signedOutText !== undefined) {
    boundedStringList(signedOutText, 'auth.statusRule.signedOutText', errors);
  }
  if (signedInText !== undefined) {
    boundedStringList(signedInText, 'auth.statusRule.signedInText', errors);
  }
  if (signedOutExitCodes !== undefined) {
    if (
      !Array.isArray(signedOutExitCodes) ||
      signedOutExitCodes.length === 0 ||
      signedOutExitCodes.length > ACP_DESCRIPTOR_LIST_MAX ||
      !signedOutExitCodes.every(
        (code) => Number.isInteger(code) && code >= 1 && code <= 255,
      )
    ) {
      errors.push(
        'auth.statusRule.signedOutExitCodes must be exit codes 1-255',
      );
    }
  }
  if (
    exitZeroMeansSignedIn !== undefined &&
    typeof exitZeroMeansSignedIn !== 'boolean'
  ) {
    errors.push('auth.statusRule.exitZeroMeansSignedIn must be a boolean');
  }
  if (
    signedInJsonField === undefined &&
    signedInText === undefined &&
    exitZeroMeansSignedIn !== true &&
    signedOutText === undefined &&
    signedOutExitCodes === undefined
  ) {
    errors.push('auth.statusRule reads nothing');
  }
}

function validateTermsNotices(notices: unknown, errors: string[]): void {
  if (
    !Array.isArray(notices) ||
    notices.length === 0 ||
    notices.length > ACP_DESCRIPTOR_LIST_MAX
  ) {
    errors.push(
      `auth.subscriptionTermsNotices must be a list of 1-${ACP_DESCRIPTOR_LIST_MAX} entries`,
    );
    return;
  }
  notices.forEach((notice, index) => {
    const at = `auth.subscriptionTermsNotices[${index}]`;
    if (!isRecord(notice)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const { provider, termsUrl, authMethodIds, ...rest } = notice;
    if (Object.keys(rest).length > 0) {
      errors.push(`${at}: unknown field ${Object.keys(rest).join(', ')}`);
    }
    if (!isBoundedText(provider)) errors.push(`${at}.provider is not valid`);
    if (!isHttpsUrl(termsUrl))
      errors.push(`${at}.termsUrl must be an https URL`);
    if (authMethodIds !== undefined) {
      boundedStringList(authMethodIds, `${at}.authMethodIds`, errors);
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
      if (auth.statusRule !== undefined) {
        validateStatusRule(auth.statusRule, auth.statusCommand, errors);
      }
      if (auth.subscriptionTermsNotices !== undefined) {
        validateTermsNotices(auth.subscriptionTermsNotices, errors);
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
