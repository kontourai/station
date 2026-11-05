/**
 * Managed policy (#4515): the machine administrator's outer bound on what
 * Station does. An administrator installs one policy document; the server
 * loads it once at startup and refuses to start when it cannot enforce it.
 *
 * This module owns the v1 document shape, its boundary parser, the
 * value-free summary that clients see, and the fingerprint input. Reading a
 * policy from a source and hashing it belong to
 * `@kontourai/station-shared/managed-policy`, which needs Node.
 *
 * The parser accepts only what this build enforces. A key it does not know
 * may be a restriction from a newer release, and a key it knows but does not
 * yet enforce (any `settings` entry and every `limits` key, until each
 * enforcement slice lands) would make the machine look managed when it is
 * not. Both are rejected with a problem that names the key. The capability
 * switches (`telemetry`, `webhookAutomations`, `registries`; #4521) are
 * enforced.
 */
import { boundaryText, isRecord } from './contract-validation.js';
import { canonicalizeForDigest } from './fleet-routing-receipt.js';

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

/**
 * Limits sit outside settings. Each enforcement slice adds its key here and
 * to {@link MANAGED_POLICY_ENFORCED_LIMIT_KEYS} together.
 */
export interface ManagedPolicyLimits {
  /** #4521: `false` turns off usage data and OTel export. */
  telemetry?: false;
  /** #4521: `false` stops inbound webhook automations from running. */
  webhookAutomations?: false;
  /** #4521: narrows where plugins and skills may be acquired from. */
  registries?: ManagedPolicyRegistryLimits;
}

export interface ManagedPolicyDocument {
  schemaVersion: typeof MANAGED_POLICY_SCHEMA_VERSION;
  /** Shown to users as "Managed by <organization>". */
  organization: string;
  /** An https page users can visit for help with a managed control. */
  supportUrl?: string;
  /** Keyed by setting path. Empty in this build: see the module comment. */
  settings?: Record<string, ManagedPolicySettingEntry>;
  limits?: ManagedPolicyLimits;
}

/**
 * #4521: the capability switches. Each one can only take something away, so a
 * policy can turn a capability off but never force it on.
 */
export const MANAGED_POLICY_CAPABILITY_LIMIT_KEYS = [
  'telemetry',
  'webhookAutomations',
  'registries',
] as const;

/**
 * #4521: `limits.registries`. Each key narrows the host's own registry trust
 * (`registryTrust`, the configured marketplaces); none adds a trust anchor.
 */
export interface ManagedPolicyRegistryLimits {
  /**
   * The only registry locations plugins and skills may be acquired from,
   * as https URLs (an http entry is refused at load). Station's bundled catalog is always allowed; any other
   * catalog, a local folder included, must be listed. Empty allows none.
   */
  allowedUrls?: string[];
  /**
   * `false`: a plugin from a registry must carry a signature from a key the
   * host's `registryTrust` already trusts, and skills (which cannot be
   * signed) are not acquired from registries.
   */
  unsignedPackages?: false;
  /** `false`: Station's built-in skill registries are not registered. */
  defaultSkillRegistries?: false;
  /** `false`: engines cannot be installed from the public ACP registry. */
  acpRegistryInstalls?: false;
}

/** Limit keys this build enforces. */
export const MANAGED_POLICY_ENFORCED_LIMIT_KEYS: readonly string[] = [
  ...MANAGED_POLICY_CAPABILITY_LIMIT_KEYS,
];

/**
 * Limit keys the managed-policy plan reserves for later releases. A reserved
 * key gets a "not supported by this version" problem instead of "unknown",
 * so an administrator learns to upgrade rather than to fix a typo.
 */
export const MANAGED_POLICY_RESERVED_LIMIT_KEYS: readonly string[] = [
  'maxApprovalMode',
  'clients',
  'engines',
  'updates',
];

const DOCUMENT_KEYS = [
  'schemaVersion',
  'organization',
  'supportUrl',
  'settings',
  'limits',
] as const;
const ORGANIZATION_MAX_CHARS = 200;
const SUPPORT_URL_MAX_CHARS = 2048;

/** One reason a document is refused; `path` is a dotted document path. */
export interface ManagedPolicyProblem {
  path: string;
  message: string;
}

export type ManagedPolicyParseResult =
  | { ok: true; document: ManagedPolicyDocument }
  | { ok: false; problems: ManagedPolicyProblem[] };

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
    ...reservedMapProblems(
      'settings',
      settings,
      () => 'managed settings are not supported by this version of Station',
    ),
    ...reservedMapProblems('limits', limits, limitProblem),
    ...managedPolicyLimitProblems(limits),
  );

  if (problems.length > 0) return { ok: false, problems };
  const document: ManagedPolicyDocument = {
    schemaVersion: MANAGED_POLICY_SCHEMA_VERSION,
    organization: organization as string,
  };
  if (supportUrl !== undefined) document.supportUrl = supportUrl as string;
  if (settings !== undefined) document.settings = {};
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

/**
 * What clients learn about the policy: who manages the machine, where to get
 * help, which setting paths are locked, and the effective limits. It never
 * carries a setting value, because a value may be sensitive to someone, and
 * clients need only to explain why a control is locked.
 */
export interface ManagedPolicySummary {
  organization: string;
  supportUrl: string | null;
  lockedSettings: string[];
  limits: ManagedPolicyLimits;
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
    limits: acceptedManagedPolicyLimits(document.limits),
  };
}

/**
 * Where a loaded policy came from: the policy file, a macOS configuration
 * profile (#4523), the Windows Policies registry key (#4524), or the
 * test-only override.
 */
export type ManagedPolicySourceKind =
  | 'file'
  | 'macos-profile'
  | 'windows-registry'
  | 'test-override';

export const MANAGED_POLICY_SOURCE_KINDS: readonly ManagedPolicySourceKind[] = [
  'file',
  'macos-profile',
  'windows-registry',
  'test-override',
];

function isManagedPolicySourceKind(
  value: unknown,
): value is ManagedPolicySourceKind {
  return (MANAGED_POLICY_SOURCE_KINDS as readonly unknown[]).includes(value);
}

export interface ManagedPolicySourceDescriptor {
  kind: ManagedPolicySourceKind;
  /** A path, or a later source's identifier (a profile domain, a key). */
  location: string;
}

/** A `sha256:<64 hex>` fingerprint of {@link canonicalManagedPolicyJson}. */
export type ManagedPolicyDigest = `sha256:${string}`;

/**
 * `GET /api/settings/managed-policy`: what the running server loaded at
 * startup. A server never runs with a policy it could not load, so there is
 * no error state here.
 */
export type ManagedPolicyStatus =
  | { state: 'none' }
  | {
      state: 'loaded';
      source: ManagedPolicySourceDescriptor;
      digest: ManagedPolicyDigest;
      summary: ManagedPolicySummary;
    };

export function isManagedPolicyDigest(
  value: unknown,
): value is ManagedPolicyDigest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

/** Boundary parser for a {@link ManagedPolicyStatus} read from a server. */
export function parseManagedPolicyStatus(
  value: unknown,
): ManagedPolicyStatus | null {
  if (!isRecord(value)) return null;
  if (value.state === 'none') return { state: 'none' };
  if (value.state !== 'loaded') return null;
  const { source, digest, summary } = value;
  if (
    !isRecord(source) ||
    !isManagedPolicySourceKind(source.kind) ||
    typeof source.location !== 'string' ||
    !isManagedPolicyDigest(digest) ||
    !isRecord(summary) ||
    typeof summary.organization !== 'string' ||
    (summary.supportUrl !== null && typeof summary.supportUrl !== 'string') ||
    !Array.isArray(summary.lockedSettings) ||
    !summary.lockedSettings.every((path) => typeof path === 'string') ||
    !isRecord(summary.limits) ||
    managedPolicyLimitProblems(summary.limits).length > 0
  ) {
    return null;
  }
  return {
    state: 'loaded',
    source: { kind: source.kind, location: source.location },
    digest,
    summary: {
      organization: summary.organization,
      supportUrl: summary.supportUrl,
      lockedSettings: [...summary.lockedSettings],
      limits: acceptedManagedPolicyLimits(summary.limits),
    },
  };
}

/** "Managed by <organization>", the label beside a managed control. */
export function managedByLabel(summary: ManagedPolicySummary): string {
  return `Managed by ${summary.organization}`;
}

/**
 * The one sentence every surface uses to refuse a change the policy forbids,
 * e.g. `managedPolicyDenial(summary, 'this setting')` gives "Acme's policy
 * manages this setting. For help, visit https://…".
 */
export function managedPolicyDenial(
  summary: ManagedPolicySummary,
  subject: string,
): string {
  const help = summary.supportUrl
    ? ` For help, visit ${summary.supportUrl}`
    : ' Contact your administrator for help.';
  return `${summary.organization}'s policy manages ${subject}.${help}`;
}

// ---------------------------------------------------------------------------
// #4521: capability switches (`limits.telemetry`, `limits.webhookAutomations`,
// `limits.registries`). A switch can only turn a capability off: `false`
// restricts and any other value is refused, so a policy can never force
// telemetry, webhooks or a registry on.
// ---------------------------------------------------------------------------

/**
 * The refusal code every surface uses for a capability the managed policy
 * turned off. Clients key on it to show the managed message instead of
 * offering a retry.
 */
export const MANAGED_POLICY_CAPABILITY_DISABLED_CODE =
  'managed-policy-capability-disabled' as const;

const REGISTRY_LIMIT_KEYS = [
  'allowedUrls',
  'unsignedPackages',
  'defaultSkillRegistries',
  'acpRegistryInstalls',
] as const;
const REGISTRY_ALLOWED_URLS_MAX = 64;
const REGISTRY_URL_MAX_CHARS = 2048;

/** `record[key]` when it is the record's own member (no `Object.hasOwn`: ES2020). */
function ownLimitValue(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function offOnlyProblem(value: unknown, subject: string): string | null {
  if (value === undefined || value === false) return null;
  return `must be false; a policy can turn ${subject} off but never on, so omit the key to leave it to each user`;
}

/**
 * A registry location as the allow list compares it: an http(s) URL with no
 * credentials, query or fragment, without a trailing slash. `github:o/r`
 * (the key Station gives a GitHub skill catalog) reads as
 * `https://github.com/o/r`. Anything else, such as a local path, is null.
 */
export function normalizeManagedRegistryUrl(value: string): string | null {
  const github = /^github:([^/\s]+\/[^/\s]+)$/.exec(value);
  let url: URL;
  try {
    url = new URL(github ? `https://github.com/${github[1]}` : value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
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
  const allowedUrls = ownLimitValue(value, 'allowedUrls');
  if (allowedUrls !== undefined)
    problems.push(...allowedUrlsProblems(allowedUrls));
  const switches: Array<[string, string]> = [
    ['unsignedPackages', 'unsigned packages'],
    ['defaultSkillRegistries', 'the default skill registries'],
    ['acpRegistryInstalls', 'ACP registry installs'],
  ];
  for (const [key, subject] of switches) {
    const message = offOnlyProblem(ownLimitValue(value, key), subject);
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
    const message = offOnlyProblem(ownLimitValue(limits, key), subject);
    if (message) problems.push({ path: `limits.${key}`, message });
  }
  problems.push(...registryLimitProblems(ownLimitValue(limits, 'registries')));
  return problems;
}

/**
 * The capability switches of a `limits` value that passed
 * {@link capabilityLimitProblems}, copied. URLs are kept as written.
 */
export function capabilityLimitsOf(limits: unknown): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  const result: ManagedPolicyLimits = {};
  if (ownLimitValue(limits, 'telemetry') === false) result.telemetry = false;
  if (ownLimitValue(limits, 'webhookAutomations') === false)
    result.webhookAutomations = false;
  const registries = ownLimitValue(limits, 'registries');
  if (isRecord(registries)) {
    const copy: ManagedPolicyRegistryLimits = {};
    const allowedUrls = ownLimitValue(registries, 'allowedUrls');
    if (Array.isArray(allowedUrls))
      copy.allowedUrls = allowedUrls.filter(
        (url): url is string => typeof url === 'string',
      );
    if (ownLimitValue(registries, 'unsignedPackages') === false)
      copy.unsignedPackages = false;
    if (ownLimitValue(registries, 'defaultSkillRegistries') === false)
      copy.defaultSkillRegistries = false;
    if (ownLimitValue(registries, 'acpRegistryInstalls') === false)
      copy.acpRegistryInstalls = false;
    result.registries = copy;
  }
  return result;
}

/**
 * One limit slice: the problems with its keys in a `limits` object, and its
 * accepted value copied out of one that passed. Every slice is listed in
 * {@link MANAGED_POLICY_LIMIT_SLICES}.
 */
interface ManagedPolicyLimitSlice {
  problems(limits: Record<string, unknown>): ManagedPolicyProblem[];
  accepted(limits: Record<string, unknown>): ManagedPolicyLimits;
}

/**
 * Every limit slice this build enforces. The parsed document, the summary and
 * the status decode all rebuild limits from this list, so a slice added here
 * reaches all three; a site that rebuilt limits from one slice's own fields
 * would silently drop every other slice's restriction.
 */
const MANAGED_POLICY_LIMIT_SLICES: readonly ManagedPolicyLimitSlice[] = [
  { problems: capabilityLimitProblems, accepted: capabilityLimitsOf },
];

/** Problems with every enforced limit in `limits`, from every slice. */
export function managedPolicyLimitProblems(
  limits: unknown,
): ManagedPolicyProblem[] {
  if (!isRecord(limits)) return [];
  return MANAGED_POLICY_LIMIT_SLICES.flatMap((slice) => slice.problems(limits));
}

/**
 * The accepted limits of a value that passed
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

/** Whether the limits leave telemetry to each user (no `telemetry: false`). */
export function managedTelemetryAllowed(
  limits: ManagedPolicyLimits | undefined,
): boolean {
  return limits?.telemetry !== false;
}

/** Whether the limits leave inbound webhook automations running. */
export function managedWebhookAutomationsAllowed(
  limits: ManagedPolicyLimits | undefined,
): boolean {
  return limits?.webhookAutomations !== false;
}

/**
 * Whether a registry at `location` may supply plugins or skills. `bundled`
 * is Station's own catalog, shipped in the install, which the allow list
 * never removes. Without `allowedUrls` every location is allowed; with it, a
 * location must normalize to a listed URL, so a local folder is refused.
 */
export function managedRegistryLocationAllowed(
  registries: ManagedPolicyRegistryLimits | undefined,
  location: string | undefined,
  bundled = false,
): boolean {
  const allowed = registries?.allowedUrls;
  if (!allowed || bundled) return true;
  const normalized =
    location === undefined ? null : normalizeManagedRegistryUrl(location);
  if (normalized === null) return false;
  return allowed.some((url) => normalizeManagedRegistryUrl(url) === normalized);
}
