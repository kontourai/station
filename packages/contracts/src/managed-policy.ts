/**
 * Managed policy (#4515): the machine administrator's outer bound on what
 * Station does. An administrator installs one policy document; the server
 * loads it once at startup and refuses to start when it cannot enforce it.
 *
 * This module owns the v1 document shape, its boundary parser, managed
 * settings and the fingerprint input. The value-free summary clients see,
 * its status parser and every limit slice are in the registry-free
 * `./managed-policy-status.js`, re-exported here. Reading a
 * policy from a source and hashing it belong to
 * `@kontourai/station-shared/managed-policy`, which needs Node.
 *
 * The parser accepts only what this build enforces. A key it does not know
 * may be a restriction from a newer release, and a key it knows but does not
 * yet enforce (a `limits` key whose enforcement slice has not landed) would
 * make the machine look managed when it is not. Both are rejected with a
 * problem that names the key. `settings` entries (#4517) are enforced: each
 * key is a registered Station setting and each value is checked against
 * that setting's registry definition (see {@link managedSettingsProblems}).
 * `maxApprovalMode` (#4518), the capability switches (`telemetry`,
 * `webhookAutomations`, `registries`; #4521), `clients` (#4519), `updates`
 * (#4522) and `engines` (#4520, in `./managed-policy-engines.js`) are
 * enforced; each enforced limit is one entry in `MANAGED_POLICY_LIMIT_SLICES`
 * below, and its client reader is one entry in
 * `MANAGED_POLICY_SUMMARY_LIMIT_READERS` (`./managed-policy-status.js`). A
 * managed `settings.defaultApprovalMode` broader than `maxApprovalMode` is
 * refused.
 *
 * `limits.updates` (#4522) also owns the update-source helpers every update
 * surface shares: the refusal sentence, and the mapping from a default
 * release download URL to the administrator's mirror.
 */
import { APP_CONFIG_SEED } from './config.js';
import { boundaryText, isRecord } from './contract-validation.js';
import { DEVICE_SETTINGS_REGISTRY } from './device-settings.js';
import { canonicalizeForDigest } from './fleet-routing-receipt.js';
import {
  engineLimitProblems,
  engineLimitsOf,
  summarizeManagedEngineLimits,
} from './managed-policy-engines.js';
import {
  approvalModeExceedsCeiling,
  MANAGED_POLICY_CAPABILITY_LIMIT_KEYS,
  MANAGED_POLICY_CLIENT_KINDS,
  type ManagedPolicyClientKind,
  type ManagedPolicyLimits,
  type ManagedPolicyRegistryLimits,
  type ManagedPolicySummary,
  type ManagedPolicySummaryLimits,
  type ManagedPolicyUpdatesLimit,
  type ManagedPolicyUpdatesSummary,
  normalizeManagedRegistryUrl,
} from './managed-policy-status.js';
import { isConcreteApprovalMode } from './provider.js';
import { ownMember } from './record-guard.js';
import {
  APP_SETTINGS_REGISTRY,
  INTERNAL_APP_CONFIG_FIELDS,
  type SettingDefinition,
  sanitizeAppConfigUpdate,
} from './settings-registry.js';

export * from './managed-policy-status.js';

export const MANAGED_POLICY_SCHEMA_VERSION = 1;

/**
 * The fail-closed startup marker. The server's fatal line starts with it, the
 * desktop sidecar treats an exit carrying it as unrecoverable (no retry), and
 * the CLI surfaces the line that carries it after a failed start.
 */
export const MANAGED_POLICY_INVALID_MARKER = 'STATION_MANAGED_POLICY_INVALID';

/** A managed setting: a default (`locked: false`) or a fixed value. */
export interface ManagedPolicySettingEntry {
  value: unknown;
  locked: boolean;
}

export interface ManagedPolicyDocument {
  schemaVersion: typeof MANAGED_POLICY_SCHEMA_VERSION;
  /** Shown to users as "Managed by <organization>". */
  organization: string;
  /** An https page users can visit for help with a managed control. */
  supportUrl?: string;
  /**
   * Keyed by setting path: a registered Station setting key, managed as a
   * whole. See {@link managedSettingsProblems} for what is refused.
   */
  settings?: Record<string, ManagedPolicySettingEntry>;
  limits?: ManagedPolicyLimits;
}

/**
 * Limit keys the managed-policy plan reserves for later releases. A reserved
 * key gets a "not supported by this version" problem instead of "unknown",
 * so an administrator learns to upgrade rather than to fix a typo. Every
 * planned limit is enforced now (#4515), so none is reserved.
 */
export const MANAGED_POLICY_RESERVED_LIMIT_KEYS: readonly string[] = [];

const DOCUMENT_KEYS = [
  'schemaVersion',
  'organization',
  'supportUrl',
  'settings',
  'limits',
] as const;
const ORGANIZATION_MAX_CHARS = 200;
const SUPPORT_URL_MAX_CHARS = 2048;
export type ManagedPolicyParseResult =
  | { ok: true; document: ManagedPolicyDocument }
  | { ok: false; problems: ManagedPolicyProblem[] };

type JsonContainerFrame =
  | { object: true; path: string; seen: Set<string> }
  | { object: false; path: string; index: number };

const JSON_LITERAL =
  /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * The path of the first member name repeated within one JSON object, or
 * null when every object's names are distinct. Names are compared after
 * unescaping, so `"limits"` and `"limits"` are the same name.
 *
 * `JSON.parse` keeps the last of two equal names, which would let a second
 * `"limits": {}` erase the first one's restrictions; a policy must say each
 * thing once. Expects text `JSON.parse` already accepted and throws a
 * `SyntaxError` on anything else. Iterative, so nesting depth is bounded
 * only by the input size.
 */
export function duplicateJsonMemberPath(text: string): string | null {
  let i = 0;
  let path = '';
  const stack: JsonContainerFrame[] = [];
  const fail = (): never => {
    throw new SyntaxError(`unexpected JSON input at offset ${i}`);
  };
  const skipSpace = () => {
    while (
      text[i] === ' ' ||
      text[i] === '\t' ||
      text[i] === '\n' ||
      text[i] === '\r'
    )
      i++;
  };
  const readString = (): string => {
    const start = i;
    let escaped = false;
    for (i++; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        escaped = true;
        i++;
      } else if (c === '"') {
        i++;
        return escaped
          ? (JSON.parse(text.slice(start, i)) as string)
          : text.slice(start + 1, i - 1);
      }
    }
    return fail();
  };
  /** Reads `"name":` in `frame`; returns its path if the name repeats. */
  const readMemberName = (
    frame: Extract<JsonContainerFrame, { object: true }>,
  ): string | null => {
    skipSpace();
    if (text[i] !== '"') fail();
    const name = readString();
    const memberPath = describeKey(frame.path, name);
    if (frame.seen.has(name)) return memberPath;
    frame.seen.add(name);
    skipSpace();
    if (text[i++] !== ':') fail();
    path = memberPath;
    return null;
  };

  for (;;) {
    // A value starts here, at `path`.
    skipSpace();
    const c = text[i];
    if (c === '{' || c === '[') {
      i++;
      skipSpace();
      if (text[i] === (c === '{' ? '}' : ']')) {
        i++;
      } else if (c === '{') {
        const frame = { object: true as const, path, seen: new Set<string>() };
        stack.push(frame);
        const duplicate = readMemberName(frame);
        if (duplicate !== null) return duplicate;
        continue;
      } else {
        stack.push({ object: false, path, index: 0 });
        path = `${path}[0]`;
        continue;
      }
    } else if (c === '"') {
      readString();
    } else {
      JSON_LITERAL.lastIndex = i;
      if (!JSON_LITERAL.test(text)) fail();
      i = JSON_LITERAL.lastIndex;
    }
    // A value ended: close finished containers, then move to the next entry.
    for (;;) {
      const frame = stack[stack.length - 1];
      skipSpace();
      if (!frame) {
        if (i !== text.length) fail();
        return null;
      }
      const separator = text[i++];
      if (separator === ',') {
        if (frame.object) {
          const duplicate = readMemberName(frame);
          if (duplicate !== null) return duplicate;
        } else {
          frame.index++;
          path = `${frame.path}[${frame.index}]`;
        }
        break;
      }
      if (separator !== (frame.object ? '}' : ']')) fail();
      stack.pop();
    }
  }
}

function unknownKeyProblems(
  record: Record<string, unknown>,
): ManagedPolicyProblem[] {
  return Reflect.ownKeys(record)
    .filter(
      (key) =>
        typeof key !== 'string' ||
        !(DOCUMENT_KEYS as readonly string[]).includes(key),
    )
    .map((key) => ({
      path: describeKey('', String(key)),
      message:
        'unknown key; this version of Station refuses keys it cannot enforce',
    }));
}

function schemaVersionProblem(version: unknown): string | null {
  if (version === undefined) return 'is required';
  if (version === MANAGED_POLICY_SCHEMA_VERSION) return null;
  return typeof version === 'number' &&
    Number.isInteger(version) &&
    version > MANAGED_POLICY_SCHEMA_VERSION
    ? `${version} is newer than this version of Station supports (${MANAGED_POLICY_SCHEMA_VERSION}); upgrade Station`
    : `must be ${MANAGED_POLICY_SCHEMA_VERSION}`;
}

function organizationProblem(organization: unknown): string | null {
  if (organization === undefined) return 'is required';
  return boundaryText(organization, ORGANIZATION_MAX_CHARS)
    ? null
    : `must be a non-empty single line of at most ${ORGANIZATION_MAX_CHARS} characters without leading or trailing spaces`;
}

/** Every entry of a reserved map, each with the message `entryMessage` gives. */
function reservedMapProblems(
  name: 'settings' | 'limits',
  value: unknown,
  entryMessage: (key: string) => string | null,
): ManagedPolicyProblem[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [{ path: name, message: 'must be an object' }];
  return Reflect.ownKeys(value).flatMap((key) => {
    const message = entryMessage(String(key));
    return message ? [{ path: describeKey(name, String(key)), message }] : [];
  });
}

function limitProblem(name: string): string | null {
  if (MANAGED_POLICY_ENFORCED_LIMIT_KEYS.includes(name)) return null;
  return MANAGED_POLICY_RESERVED_LIMIT_KEYS.includes(name)
    ? 'this limit is not supported by this version of Station'
    : 'unknown limit; this version of Station refuses keys it cannot enforce';
}

const DEVICE_SETTING_KEYS: ReadonlySet<string> = new Set(
  DEVICE_SETTINGS_REGISTRY.map((definition) => definition.key as string),
);
const RUNTIME_DERIVED_KEYS: ReadonlySet<string> = new Set(
  INTERNAL_APP_CONFIG_FIELDS,
);

/**
 * Registered settings this version cannot manage, with the reason the
 * refusal gives (#4517). Each one has a reader that does not see the managed
 * overlay, so accepting it would report a managed value that is not the one
 * in effect.
 *
 * The telemetry settings are read by the OpenTelemetry bootstrap before the
 * policy loads (`telemetry-bootstrap-config.ts` reads `config/app.json`
 * itself) and resolved against environment variables, Do Not Track and the
 * operator policy outside the settings registry. Telemetry is managed through
 * `limits` instead, which #4521 owns.
 */
export const MANAGED_POLICY_UNMANAGEABLE_SETTINGS: Readonly<
  Record<string, string>
> = Object.freeze({
  telemetryTier:
    'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
  productTelemetryEndpoint:
    'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
  productTelemetryKeyRef:
    'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
  otelTelemetryEndpoint:
    'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
  otelTelemetryKeyRef:
    'telemetry settings are not manageable; a policy turns telemetry off with `limits.telemetry`',
});

/**
 * The project record fields a lock on each setting hides from readers and
 * refuses writes to (#4517). A lock outranks a project's choice, and a
 * project's choice of these settings is more than the one field:
 *
 * - the model and provider are one pair, and New Chat fills a model from
 *   the provider alone, so locking either one takes both, together with the
 *   `last-used` model selection that would pick a model past the lock;
 * - the approval default is the fixed mode and its `last-used` selection,
 *   either of which decides a session's starting posture over the Station
 *   default.
 */
export const MANAGED_SETTING_PROJECT_FIELDS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  defaultModel: ['defaultModel', 'defaultProviderId', 'defaultModelSelection'],
  defaultLLMProvider: [
    'defaultModel',
    'defaultProviderId',
    'defaultModelSelection',
  ],
  defaultWorkspaceIsolation: ['defaultWorkspaceIsolation'],
  defaultApprovalMode: ['defaultApprovalMode', 'defaultApprovalModeSelection'],
});

/**
 * What a lock does NOT cover (#4517 round 2, a decided scope): a lock fixes
 * the Station-level value and the project overrides
 * (`MANAGED_SETTING_PROJECT_FIELDS`), and these narrower values still decide
 * past it. Each sentence was traced to the resolver that applies it.
 * `station policy check` prints it under the setting, and the managed policy
 * guide lists the same sentences.
 */
export const MANAGED_SETTING_NARROWER_SCOPES: Readonly<Record<string, string>> =
  Object.freeze({
    defaultApprovalMode:
      "A mode a person picks for a conversation, an Agent's own approval default and a person's per-engine default still apply. The hard approval bound is `limits.maxApprovalMode` (#4518).",
    region:
      "An Agent's own region, then a model connection's region, still apply before this one.",
    defaultModel:
      "An Agent's own model, the model a person picks for a chat, and a model connection's own default model still apply before this one.",
    defaultLLMProvider:
      "An Agent's own model connection and the connection a person picks for a chat still apply.",
    invokeModel: 'An invoke request that names its own model still uses it.',
    structureModel:
      "`approvalGuardian`'s own model, `reviewGuideModel` for review guides, and an invoke request that names a structure model still apply first.",
    defaultMaxTurns:
      "An Agent's own step limit (`maxSteps` or `guardrails.maxSteps`) still applies first.",
    defaultMaxOutputTokens:
      "An Agent's own `guardrails.maxTokens` still applies first.",
    defaultWorkspaceIsolation:
      'Task runs, Station delegations and adopted attached sessions always use the shared checkout, and a continued conversation keeps the isolation it started in.',
    defaultChatFontSize:
      "A person's own Chat font size (an account setting) still applies first.",
    usageLimitAutoResume:
      'A person\'s "Resume" or "Don\'t resume" choice on one usage-limit stop decides that stop.',
  });

/** The project fields hidden while `lockedKeys` are locked. */
export function projectFieldsMaskedByLocks(
  lockedKeys: Iterable<string>,
): Map<string, string> {
  const masked = new Map<string, string>();
  for (const key of lockedKeys)
    for (const field of MANAGED_SETTING_PROJECT_FIELDS[key] ?? [])
      if (!masked.has(field)) masked.set(field, key);
  return masked;
}

/**
 * `project` as readers see it while `lockedKeys` are locked: every field a
 * lock hides is removed. Returns `project` itself when nothing is hidden.
 */
export function withoutLockedProjectFields<P extends object>(
  project: P,
  lockedKeys: Iterable<string>,
): P {
  let masked: P | undefined;
  for (const field of projectFieldsMaskedByLocks(lockedKeys).keys()) {
    if (Reflect.get(project, field) === undefined) continue;
    masked ??= { ...project };
    Reflect.deleteProperty(masked, field);
  }
  return masked ?? project;
}

/**
 * Why the policy may not manage `path`, or null when it may.
 *
 * A setting is managed as a whole, at its registry key. Registry keys are
 * top-level `AppConfig` fields, so a dotted path names a field inside one:
 * refused, because a composite setting's fields are validated and resolved
 * together and a partial lock would leave the rest to whoever writes next.
 *
 * Device settings are refused because they live on each client, not on the
 * server that loads the policy; the server could not enforce them. Internal
 * and runtime-derived fields are not choices a person makes, and a `secret`
 * setting cannot go in a document every user on the machine can read.
 * Environment variables are not settings: an administrator who names one is
 * told which setting reads it.
 */
function managedSettingPathProblem(
  path: string,
  registry: readonly SettingDefinition[],
): string | null {
  const definition = registry.find((entry) => entry.key === path);
  if (definition) {
    if (definition.secret)
      return 'secret settings cannot be managed; every user on the machine can read the policy';
    if (definition.userFacing === false)
      return 'this is an internal field, not a setting a policy can manage';
    if (hasOwnKey(MANAGED_POLICY_UNMANAGEABLE_SETTINGS, path))
      return MANAGED_POLICY_UNMANAGEABLE_SETTINGS[path] as string;
    return null;
  }
  const dot = path.indexOf('.');
  if (dot > 0) {
    const head = path.slice(0, dot);
    const parent = registry.find((entry) => entry.key === head);
    if (parent)
      return parent.descriptor.kind === 'composite'
        ? `"${head}" is managed as a whole; manage "${head}" instead of one field inside it`
        : `"${head}" has no fields; manage "${head}" itself`;
  }
  if (RUNTIME_DERIVED_KEYS.has(path))
    return 'this value is derived at runtime and is not a stored setting';
  if (DEVICE_SETTING_KEYS.has(path))
    return 'this is a device setting, stored on each client; the server cannot enforce it';
  const reader = registry.find(
    (entry) => entry.envFallback === path || entry.envAliases?.includes(path),
  );
  if (reader)
    return `this is an environment variable, not a setting; manage "${reader.key}" instead`;
  return 'unknown setting; this version of Station refuses keys it cannot enforce';
}

/** Why `value` is not a valid managed value for `definition`, or null. */
function managedSettingValueProblem(
  definition: SettingDefinition,
  value: unknown,
): string | null {
  if (value === null) {
    // `null` in a settings update means "clear"; only a nullable setting
    // stores it as a value. A policy must name a value.
    return definition.nullable ? null : 'value must not be null';
  }
  if (typeof value === 'string' && value.trim().length === 0)
    // Station reads a blank string as "not set", so a blank managed value
    // would claim to manage the setting while every reader fell through it.
    return 'value must not be blank';
  // The registry's own sanitizer: the same type, range, pattern and
  // template-variable checks a settings write runs. A composite value's
  // structure is checked against the settings file schema when the server
  // starts, because that schema lives with the server.
  const { violations } = sanitizeAppConfigUpdate({
    [definition.key]: value,
  });
  return violations.length > 0
    ? violations.map((violation) => violation.message).join('; ')
    : null;
}

const SETTING_ENTRY_KEYS = ['value', 'locked'] as const;

/**
 * Problems with the `settings` map, every one of them. `registry` defaults
 * to this build's {@link APP_SETTINGS_REGISTRY}; tests pass another to reach
 * a rule no registered setting triggers yet (no setting is `secret` today).
 */
export function managedSettingsProblems(
  settings: unknown,
  registry: readonly SettingDefinition[] = APP_SETTINGS_REGISTRY,
): ManagedPolicyProblem[] {
  if (settings === undefined) return [];
  if (!isRecord(settings))
    return [{ path: 'settings', message: 'must be an object' }];
  const problems: ManagedPolicyProblem[] = [];
  for (const key of Reflect.ownKeys(settings)) {
    const path = describeKey('settings', String(key));
    const pathProblem =
      typeof key === 'string'
        ? managedSettingPathProblem(key, registry)
        : 'unknown setting';
    if (pathProblem) {
      problems.push({ path, message: pathProblem });
      continue;
    }
    const entry = settings[key as string];
    if (!isRecord(entry)) {
      problems.push({
        path,
        message: 'must be an object with "value" and "locked"',
      });
      continue;
    }
    for (const entryKey of Reflect.ownKeys(entry)) {
      if (!(SETTING_ENTRY_KEYS as readonly unknown[]).includes(entryKey))
        problems.push({
          path: describeKey(path, String(entryKey)),
          message:
            'unknown key; this version of Station refuses keys it cannot enforce',
        });
    }
    if (typeof entry.locked !== 'boolean')
      problems.push({
        path: `${path}.locked`,
        message:
          'must be true (a fixed value) or false (a default users can change)',
      });
    if (!hasOwnKey(entry, 'value')) {
      problems.push({ path: `${path}.value`, message: 'is required' });
      continue;
    }
    const definition = registry.find((entry) => entry.key === key);
    const valueProblem = managedSettingValueProblem(
      definition as SettingDefinition,
      entry.value,
    );
    if (valueProblem)
      problems.push({ path: `${path}.value`, message: valueProblem });
  }
  return problems;
}

/**
 * What the policy parser cannot see: a composite value's structure and the
 * cross-field rules live in the settings file schema (`schemas/app.schema.json`
 * plus `appConfigSemanticError`), which the caller compiles. Every managed
 * value goes into one probe on top of the loader's seed, which supplies the
 * schema's required fields, so only a managed value can fail it.
 *
 * Server startup and `station policy check` both call this with a validator
 * built from the same schema file, so `check` reports exactly what startup
 * would refuse. Returns the validator's message, or undefined when valid.
 */
export function managedSettingsSchemaError(
  settings: Readonly<Record<string, ManagedPolicySettingEntry>> | undefined,
  validateAppConfig: (config: unknown) => void,
): string | undefined {
  if (!settings || Object.keys(settings).length === 0) return undefined;
  const probe: Record<string, unknown> = structuredClone({
    ...APP_CONFIG_SEED,
  });
  for (const [key, entry] of Object.entries(settings)) probe[key] = entry.value;
  try {
    validateAppConfig(probe);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The validated `settings` map, copied so the document owns its values. */
function managedSettingsOf(
  settings: Record<string, unknown>,
): Record<string, ManagedPolicySettingEntry> {
  const result: Record<string, ManagedPolicySettingEntry> = {};
  for (const [key, entry] of Object.entries(settings)) {
    const { value, locked } = entry as ManagedPolicySettingEntry;
    result[key] = { value: structuredClone(value), locked };
  }
  return result;
}

/**
 * Parse an already-decoded JSON value as a v1 policy document. Every problem
 * is reported, not only the first, so `station policy check` can list them.
 */
export function parseManagedPolicyDocument(
  value: unknown,
): ManagedPolicyParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      problems: [{ path: '', message: 'the policy must be a JSON object' }],
    };
  }
  const { organization, supportUrl, settings, limits } = value;
  const problems: ManagedPolicyProblem[] = unknownKeyProblems(value);
  const fieldProblems: Array<[string, string | null]> = [
    ['schemaVersion', schemaVersionProblem(value.schemaVersion)],
    ['organization', organizationProblem(organization)],
    [
      'supportUrl',
      supportUrl === undefined ? null : supportUrlProblem(supportUrl),
    ],
  ];
  for (const [path, message] of fieldProblems)
    if (message) problems.push({ path, message });
  problems.push(
    ...managedSettingsProblems(settings),
    ...reservedMapProblems('limits', limits, limitProblem),
    ...managedPolicyLimitProblems(limits),
    ...managedDefaultAboveCeilingProblems(settings, limits),
  );

  if (problems.length > 0) return { ok: false, problems };
  const document: ManagedPolicyDocument = {
    schemaVersion: MANAGED_POLICY_SCHEMA_VERSION,
    organization: organization as string,
  };
  if (supportUrl !== undefined) document.supportUrl = supportUrl as string;
  if (settings !== undefined)
    document.settings = managedSettingsOf(settings as Record<string, unknown>);
  if (limits !== undefined)
    document.limits = acceptedManagedPolicyLimits(limits);
  return { ok: true, document };
}

function supportUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0)
    return 'must be an https URL';
  if (value.length > SUPPORT_URL_MAX_CHARS)
    return `must be at most ${SUPPORT_URL_MAX_CHARS} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL';
  // Every user on the machine can read the policy, and clients show this
  // link; a credential in it would be disclosed to all of them.
  if (url.username || url.password)
    return 'must not contain a user name or password';
  return null;
}

/** Problems as one line each, e.g. for an error message or `policy check`. */
export function formatManagedPolicyProblems(
  problems: readonly ManagedPolicyProblem[],
): string {
  return problems
    .map((problem) =>
      problem.path ? `${problem.path}: ${problem.message}` : problem.message,
    )
    .join('; ');
}

/**
 * The bytes the fingerprint covers: the parsed document with object keys
 * sorted and no whitespace. Reformatting the file does not change it;
 * changing any value does.
 */
export function canonicalManagedPolicyJson(
  document: ManagedPolicyDocument,
): string {
  return JSON.stringify(canonicalizeForDigest(document));
}

export function summarizeManagedPolicy(
  document: ManagedPolicyDocument,
): ManagedPolicySummary {
  return {
    organization: document.organization,
    supportUrl: document.supportUrl ?? null,
    lockedSettings: Object.entries(document.settings ?? {})
      .filter(([, entry]) => entry.locked)
      .map(([path]) => path)
      .sort(),
    limits: summarizeManagedPolicyLimits(document.limits),
    // #4520: beside `limits`, without a single launch value.
    ...(document.limits?.engines
      ? { engines: summarizeManagedEngineLimits(document.limits.engines) }
      : {}),
  };
}

/** SDK consumers compile contracts for ES2020, which lacks `Object.hasOwn`. */
function hasOwnKey(value: object, key: string): boolean {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: SDK consumers target ES2020, which lacks Object.hasOwn.
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Station's default release download location: every desktop feed, signed
 * server manifest and server archive is `<base><release tag>/<asset name>`.
 * Mirrors `PUBLIC_RELEASE_BASE_URL` in scripts/lib/public-release-locations.mjs
 * (a test pins the two together).
 */
export const STATION_RELEASE_DOWNLOAD_BASE =
  'https://github.com/kontourai/station/releases/download/';

/**
 * #4522: the mirror's copy of a default release URL. A mirror reproduces the
 * release download tree, so `<base><tag>/<asset>` becomes
 * `<feedUrl>/<tag>/<asset>`. Returns null for a URL outside the release
 * download tree: the mirror cannot serve it, and the caller must refuse
 * rather than fall back to the default.
 */
export function managedUpdateMirrorUrl(
  defaultUrl: string,
  feedUrl: string,
): string | null {
  if (!defaultUrl.startsWith(STATION_RELEASE_DOWNLOAD_BASE)) return null;
  const rest = defaultUrl.slice(STATION_RELEASE_DOWNLOAD_BASE.length);
  if (rest.length === 0 || rest.includes('?') || rest.includes('#'))
    return null;
  return `${feedUrl.endsWith('/') ? feedUrl : `${feedUrl}/`}${rest}`;
}

/** The release channels the policy can make unavailable. */
const NIGHTLY_CHANNEL = 'nightly';

/**
 * #4522: why the policy forbids updating a Station on `channel`, or null
 * when it does not. `off` forbids every update; `allowNightly: false`
 * forbids updating anything on the nightly channel. The sentence names no
 * feed URL.
 */
export function managedUpdatesRefusal(
  updates: ManagedPolicyUpdatesLimit | null | undefined,
  channel: string | null | undefined,
): string | null {
  if (!updates) return null;
  if (updates.mode === 'off')
    return "This machine's managed policy turns off Station updates";
  if (updates.allowNightly === false && channel === NIGHTLY_CHANNEL)
    return "This machine's managed policy makes the nightly channel unavailable";
  return null;
}

/**
 * #4522: the signed server manifest a ring's update check reads from the
 * mirror: the mirror's copy of the ring's rolling pointer release
 * (`portable-<ring>/station-portable-<ring>-manifest.json`, the names
 * `PUBLIC_MANIFEST_POINTERS` in scripts/lib/public-release-locations.mjs
 * publishes; a test pins the two together).
 */
export function managedUpdateServerManifestUrl(
  feedUrl: string,
  ring: string,
): string | null {
  if (!/^[a-z]+$/.test(ring)) return null;
  return managedUpdateMirrorUrl(
    `${STATION_RELEASE_DOWNLOAD_BASE}portable-${ring}/station-portable-${ring}-manifest.json`,
    feedUrl,
  );
}

/** Limit keys this build enforces. */
export const MANAGED_POLICY_ENFORCED_LIMIT_KEYS: readonly string[] = [
  'maxApprovalMode',
  ...MANAGED_POLICY_CAPABILITY_LIMIT_KEYS,
  'clients',
  'updates',
  'engines',
];

const UPDATES_KEYS = ['mode', 'feedUrl', 'allowNightly'] as const;

/** One reason a document is refused; `path` is a dotted document path. */
export interface ManagedPolicyProblem {
  path: string;
  message: string;
}

/**
 * Longest key name quoted in a problem path. Key names come from the policy
 * file, and the paths end up in the server's one-line fatal message, so an
 * enormous key must not make that line enormous.
 */
export const MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS = 64;

function describeKey(parent: string, key: string): string {
  if (key.length > MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS) {
    const shown = JSON.stringify(
      key.slice(0, MANAGED_POLICY_KEY_DISPLAY_MAX_CHARS),
    );
    return `${parent}[${shown}… (${key.length} characters)]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key)
    ? parent
      ? `${parent}.${key}`
      : key
    : `${parent}[${JSON.stringify(key)}]`;
}

/** #4522: every problem with `limits.updates`, its keys and its values. */
function updatesLimitProblems(updates: unknown): ManagedPolicyProblem[] {
  if (updates === undefined) return [];
  if (!isRecord(updates))
    return [{ path: 'limits.updates', message: 'must be an object' }];
  const problems: ManagedPolicyProblem[] = Reflect.ownKeys(updates)
    .filter(
      (key) =>
        typeof key !== 'string' ||
        !(UPDATES_KEYS as readonly string[]).includes(key),
    )
    .map((key) => ({
      path: describeKey('limits.updates', String(key)),
      message:
        'unknown key; this version of Station refuses keys it cannot enforce',
    }));
  const mode = ownMember(updates, 'mode');
  if (mode !== undefined && mode !== 'auto' && mode !== 'off')
    problems.push({
      path: 'limits.updates.mode',
      message: 'must be "auto" or "off"',
    });
  const feedUrl = ownMember(updates, 'feedUrl');
  const feedProblem =
    feedUrl === undefined ? null : updateFeedUrlProblem(feedUrl);
  if (feedProblem)
    problems.push({ path: 'limits.updates.feedUrl', message: feedProblem });
  const allowNightly = ownMember(updates, 'allowNightly');
  if (allowNightly !== undefined && typeof allowNightly !== 'boolean')
    problems.push({
      path: 'limits.updates.allowNightly',
      message: 'must be true or false',
    });
  return problems;
}

/** #4522: the accepted `limits.updates`, from a value already checked. */
function parsedUpdatesLimit(
  updates: Record<string, unknown>,
): ManagedPolicyUpdatesLimit {
  const parsed: ManagedPolicyUpdatesLimit = {};
  const mode = ownMember(updates, 'mode');
  if (mode === 'auto' || mode === 'off') parsed.mode = mode;
  const feedUrl = ownMember(updates, 'feedUrl');
  if (typeof feedUrl === 'string') parsed.feedUrl = feedUrl;
  const allowNightly = ownMember(updates, 'allowNightly');
  if (typeof allowNightly === 'boolean') parsed.allowNightly = allowNightly;
  return parsed;
}

/**
 * #4522: an update feed is an https base URL that release paths are appended
 * to, so it has no query or fragment, and no user name or password (every
 * user on the machine can read the policy).
 */
function updateFeedUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0)
    return 'must be an https URL';
  if (value.length > SUPPORT_URL_MAX_CHARS)
    return `must be at most ${SUPPORT_URL_MAX_CHARS} characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be an https URL';
  }
  if (url.protocol !== 'https:') return 'must be an https URL';
  if (url.username || url.password)
    return 'must not contain a user name or password';
  if (value.includes('?') || value.includes('#'))
    return 'must not contain a query or fragment; release paths are appended to it';
  // Release paths are appended to the parsed form, so the text must be that
  // form: `new URL` silently drops tabs and newlines and resolves `..`.
  if (url.href !== value && url.href !== `${value}/`)
    return 'must be a plain URL in canonical form';
  return null;
}

function summarizeUpdatesLimit(
  updates: ManagedPolicyUpdatesLimit,
): ManagedPolicyUpdatesSummary {
  return {
    mode: updates.mode ?? 'auto',
    mirror: updates.feedUrl !== undefined,
    allowNightly: updates.allowNightly ?? true,
  };
}

const REGISTRY_LIMIT_KEYS = [
  'allowedUrls',
  'unsignedPackages',
  'defaultSkillRegistries',
  'acpRegistryInstalls',
] as const;
const REGISTRY_ALLOWED_URLS_MAX = 64;
const REGISTRY_URL_MAX_CHARS = 2048;

function offOnlyProblem(value: unknown, subject: string): string | null {
  if (value === undefined || value === false) return null;
  return `must be false; a policy can turn ${subject} off but never on, so omit the key to leave it to each user`;
}

function allowedUrlsProblems(value: unknown): ManagedPolicyProblem[] {
  const path = 'limits.registries.allowedUrls';
  if (!Array.isArray(value))
    return [{ path, message: 'must be an array of https URLs' }];
  if (value.length > REGISTRY_ALLOWED_URLS_MAX)
    return [
      {
        path,
        message: `must list at most ${REGISTRY_ALLOWED_URLS_MAX} URLs`,
      },
    ];
  const seen = new Set<string>();
  const problems: ManagedPolicyProblem[] = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > REGISTRY_URL_MAX_CHARS ||
      entry.startsWith('github:')
    ) {
      problems.push({
        path: at,
        message: `must be an https URL of at most ${REGISTRY_URL_MAX_CHARS} characters`,
      });
      return;
    }
    const normalized = normalizeManagedRegistryUrl(entry);
    if (normalized === null) {
      problems.push({
        path: at,
        message:
          'must be an https URL without a user name, password, query or fragment',
      });
      return;
    }
    // A registry read over plain http can be altered in transit, so a policy
    // cannot vouch for one (the update mirror is https-only for the same
    // reason). Comparison still normalizes http, so an http location simply
    // matches no entry.
    if (!normalized.startsWith('https://')) {
      problems.push({
        path: at,
        message:
          'must use https; a registry read over http can be altered in transit',
      });
      return;
    }
    if (seen.has(normalized))
      problems.push({ path: at, message: 'repeats an earlier URL' });
    seen.add(normalized);
  });
  return problems;
}

function registryLimitProblems(value: unknown): ManagedPolicyProblem[] {
  if (value === undefined) return [];
  if (!isRecord(value))
    return [{ path: 'limits.registries', message: 'must be an object' }];
  const problems: ManagedPolicyProblem[] = Reflect.ownKeys(value)
    .filter(
      (key) =>
        typeof key !== 'string' ||
        !(REGISTRY_LIMIT_KEYS as readonly string[]).includes(key),
    )
    .map((key) => ({
      path: describeKey('limits.registries', String(key)),
      message:
        'unknown key; this version of Station refuses keys it cannot enforce',
    }));
  const allowedUrls = ownMember(value, 'allowedUrls');
  if (allowedUrls !== undefined)
    problems.push(...allowedUrlsProblems(allowedUrls));
  const switches: Array<[string, string]> = [
    ['unsignedPackages', 'unsigned packages'],
    ['defaultSkillRegistries', 'the default skill registries'],
    ['acpRegistryInstalls', 'ACP registry installs'],
  ];
  for (const [key, subject] of switches) {
    const message = offOnlyProblem(ownMember(value, key), subject);
    if (message) problems.push({ path: `limits.registries.${key}`, message });
  }
  return problems;
}

/** Problems with the capability switches in `limits`; other keys are not checked. */
export function capabilityLimitProblems(
  limits: unknown,
): ManagedPolicyProblem[] {
  if (!isRecord(limits)) return [];
  const problems: ManagedPolicyProblem[] = [];
  for (const [key, subject] of [
    ['telemetry', 'telemetry'],
    ['webhookAutomations', 'webhook automations'],
  ] as const) {
    const message = offOnlyProblem(ownMember(limits, key), subject);
    if (message) problems.push({ path: `limits.${key}`, message });
  }
  problems.push(...registryLimitProblems(ownMember(limits, 'registries')));
  return problems;
}

/**
 * The capability switches of a `limits` value that passed
 * {@link capabilityLimitProblems}, copied. URLs are kept as written.
 */
export function capabilityLimitsOf(limits: unknown): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  const result: ManagedPolicyLimits = {};
  if (ownMember(limits, 'telemetry') === false) result.telemetry = false;
  if (ownMember(limits, 'webhookAutomations') === false)
    result.webhookAutomations = false;
  const registries = ownMember(limits, 'registries');
  if (isRecord(registries)) {
    const copy: ManagedPolicyRegistryLimits = {};
    const allowedUrls = ownMember(registries, 'allowedUrls');
    if (Array.isArray(allowedUrls))
      copy.allowedUrls = allowedUrls.filter(
        (url): url is string => typeof url === 'string',
      );
    if (ownMember(registries, 'unsignedPackages') === false)
      copy.unsignedPackages = false;
    if (ownMember(registries, 'defaultSkillRegistries') === false)
      copy.defaultSkillRegistries = false;
    if (ownMember(registries, 'acpRegistryInstalls') === false)
      copy.acpRegistryInstalls = false;
    result.registries = copy;
  }
  return result;
}

/**
 * The kinds every accepted `limits.clients` must keep. This build enforces
 * only the absence of `remote`; it cannot keep the desktop app or a local
 * browser out, so a list without one of them is refused rather than accepted
 * and ignored.
 */
const REQUIRED_CLIENT_KINDS: readonly ManagedPolicyClientKind[] = [
  'desktop',
  'local-browser',
];

/**
 * Why `value` is not an accepted `limits.clients` in a document, or null.
 * The summary reader (`MANAGED_POLICY_SUMMARY_LIMIT_READERS`) skips the
 * required-kinds rule: a newer server may enforce lists this build refuses
 * in a policy.
 */
function clientsValueProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    !value.every(
      (kind) =>
        typeof kind === 'string' &&
        (MANAGED_POLICY_CLIENT_KINDS as readonly string[]).includes(kind),
    )
  )
    return 'must be a list of "desktop", "local-browser" and "remote"';
  if (new Set(value).size !== value.length)
    return 'must not list a client kind twice';
  const missing = REQUIRED_CLIENT_KINDS.filter((kind) => !value.includes(kind));
  return missing.length > 0
    ? `must include ${missing.map((kind) => `"${kind}"`).join(' and ')}; this version of Station can only leave out "remote"`
    : null;
}

/** #4519: problems with `limits.clients`. */
function clientsLimitProblems(
  limits: Record<string, unknown>,
): ManagedPolicyProblem[] {
  const message = clientsValueProblem(ownMember(limits, 'clients'));
  return message ? [{ path: 'limits.clients', message }] : [];
}

/**
 * #4519: `{ clients }` from limits that passed {@link clientsLimitProblems},
 * else `{}`. The kinds are put in canonical order; the summary is the same.
 */
function acceptedClientsLimit(
  limits: Record<string, unknown>,
): ManagedPolicyLimits {
  const clients = ownMember(limits, 'clients');
  return Array.isArray(clients)
    ? {
        clients: MANAGED_POLICY_CLIENT_KINDS.filter((kind) =>
          clients.includes(kind),
        ),
      }
    : {};
}

/**
 * #4522: `limits.updates` in a document: its problems and its value. The
 * client projection (`feedUrl` to `mirror`) is {@link summarizeUpdatesLimit}.
 */
function updatesSliceProblems(
  limits: Record<string, unknown>,
): ManagedPolicyProblem[] {
  return updatesLimitProblems(ownMember(limits, 'updates'));
}

function updatesSliceAccepted(
  limits: Record<string, unknown>,
): ManagedPolicyLimits {
  const updates = ownMember(limits, 'updates');
  return isRecord(updates) ? { updates: parsedUpdatesLimit(updates) } : {};
}

function updatesSliceSummary(
  limits: ManagedPolicyLimits,
): ManagedPolicySummaryLimits {
  return limits.updates
    ? { updates: summarizeUpdatesLimit(limits.updates) }
    : {};
}

/**
 * #4518: `limits.maxApprovalMode` in a document: a concrete posture only.
 */
function maxApprovalModeSliceProblems(
  limits: Record<string, unknown>,
): ManagedPolicyProblem[] {
  const ceiling = ownMember(limits, 'maxApprovalMode');
  if (ceiling === undefined || isConcreteApprovalMode(ceiling)) return [];
  return [
    {
      path: 'limits.maxApprovalMode',
      message:
        ceiling === 'connection-default'
          ? 'must be a posture ("ask", "auto" or "never"); "connection-default" depends on each engine\'s own settings'
          : 'must be "ask", "auto" or "never"',
    },
  ];
}

function maxApprovalModeSliceAccepted(
  limits: Record<string, unknown>,
): ManagedPolicyLimits {
  const ceiling = ownMember(limits, 'maxApprovalMode');
  return isConcreteApprovalMode(ceiling) ? { maxApprovalMode: ceiling } : {};
}

/**
 * #4518: a managed default approval mode (`settings.defaultApprovalMode`,
 * the setting #4517 manages) broader than `limits.maxApprovalMode` is
 * refused at load: it could never apply, and Station would have to pick
 * between the administrator's two answers. Read from the raw document, so
 * the check holds whatever the settings parser accepts. A
 * `connection-default` value is not refused: under a ceiling it resolves to
 * Ask (see the managed policy decision record).
 */
function managedDefaultAboveCeilingProblems(
  settings: unknown,
  limits: unknown,
): ManagedPolicyProblem[] {
  if (!isRecord(settings) || !isRecord(limits)) return [];
  const ceiling = ownMember(limits, 'maxApprovalMode');
  const entry = ownMember(settings, 'defaultApprovalMode');
  if (!isConcreteApprovalMode(ceiling) || !isRecord(entry)) return [];
  const value = ownMember(entry, 'value');
  if (!isConcreteApprovalMode(value)) return [];
  return approvalModeExceedsCeiling(value, ceiling)
    ? [
        {
          path: 'settings.defaultApprovalMode.value',
          message: `"${value}" is broader than limits.maxApprovalMode ("${ceiling}")`,
        },
      ]
    : [];
}

/**
 * One limit slice in a policy document: the problems with its keys, its
 * accepted value copied out of a `limits` object that passed, and, when
 * clients see something else, its projection for the summary (without it
 * the summary carries the accepted value). Each returns only its own keys;
 * the readers merge them. The summary a client decodes is read by
 * `MANAGED_POLICY_SUMMARY_LIMIT_READERS` in `./managed-policy-status.js`,
 * kept apart so the browser does not carry the document checks.
 */
interface ManagedPolicyLimitSlice {
  problems(limits: Record<string, unknown>): ManagedPolicyProblem[];
  accepted(limits: Record<string, unknown>): ManagedPolicyLimits;
  summary?(limits: ManagedPolicyLimits): ManagedPolicySummaryLimits;
}

/**
 * Every limit slice this build enforces. The parsed document and the summary
 * both rebuild limits from this list, so a slice added here reaches both; a
 * site that rebuilt limits from one slice's own fields would silently drop
 * every other slice's restriction.
 */
const MANAGED_POLICY_LIMIT_SLICES: readonly ManagedPolicyLimitSlice[] = [
  {
    problems: maxApprovalModeSliceProblems,
    accepted: maxApprovalModeSliceAccepted,
  },
  { problems: capabilityLimitProblems, accepted: capabilityLimitsOf },
  { problems: clientsLimitProblems, accepted: acceptedClientsLimit },
  {
    problems: updatesSliceProblems,
    accepted: updatesSliceAccepted,
    summary: updatesSliceSummary,
  },
  {
    problems: engineLimitProblems,
    accepted: engineLimitsOf,
    // #4520: clients see engines as `summary.engines` (value-free), never
    // in `summary.limits`; `summarizeManagedPolicy` adds it.
    summary: () => ({}),
  },
];

/** Problems with every enforced limit in a document's `limits`. */
export function managedPolicyLimitProblems(
  limits: unknown,
): ManagedPolicyProblem[] {
  if (!isRecord(limits)) return [];
  return MANAGED_POLICY_LIMIT_SLICES.flatMap((slice) => slice.problems(limits));
}

/**
 * The accepted limits of a document's `limits` that passed
 * {@link managedPolicyLimitProblems}: every slice's result, merged.
 */
export function acceptedManagedPolicyLimits(
  limits: unknown,
): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  let result: ManagedPolicyLimits = {};
  for (const slice of MANAGED_POLICY_LIMIT_SLICES)
    result = { ...result, ...slice.accepted(limits) };
  return result;
}

/**
 * What clients see of a parsed document's limits: each slice's projection
 * (or its value, copied), merged. A secret such as the update feed URL is
 * dropped here and nowhere else.
 */
export function summarizeManagedPolicyLimits(
  limits: ManagedPolicyLimits | undefined,
): ManagedPolicySummaryLimits {
  if (!limits) return {};
  const record = limits as Record<string, unknown>;
  let result: ManagedPolicySummaryLimits = {};
  for (const slice of MANAGED_POLICY_LIMIT_SLICES)
    result = {
      ...result,
      // A slice without a projection shows clients its document value.
      ...(slice.summary
        ? slice.summary(limits)
        : (slice.accepted(record) as ManagedPolicySummaryLimits)),
    };
  return result;
}
