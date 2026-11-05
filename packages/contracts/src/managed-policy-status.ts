/**
 * The browser-facing half of the managed policy contract (#4515): the
 * value-free summary a server publishes, its status envelope and boundary
 * parser, the denial and "Managed by" text helpers, and every enforced
 * limit's slice. The status decode re-checks a summary through the same
 * slices the document parser uses (`MANAGED_POLICY_LIMIT_SLICES`), so each
 * slice's document and summary checks live here together. Nothing here
 * imports the settings registries the document parser needs, so the UI's
 * first-load bundle does not carry them.
 * `@kontourai/station-contracts/managed-policy` re-exports all of it.
 */
import { isRecord } from './contract-validation.js';

/** #4522: the longest `limits.updates.feedUrl` accepted, like `supportUrl`. */
const UPDATE_FEED_URL_MAX_CHARS = 2048;

/**
 * #4522: how Station on this machine updates itself. Every key is optional;
 * an absent key keeps Station's own behavior.
 */
export interface ManagedPolicyUpdatesLimit {
  /** `off` stops every update check, download and install. */
  mode?: 'auto' | 'off';
  /**
   * An https mirror of approved releases that replaces Station's default
   * release download location on every update surface. It may carry an
   * access token in its path, so it never reaches the client summary.
   */
  feedUrl?: string;
  /** `false` makes the nightly channel unavailable. */
  allowNightly?: boolean;
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
  /** #4519: the client kinds that may reach this machine's servers. */
  clients?: ManagedPolicyClientKind[];
  /** #4522: how Station on this machine updates itself. */
  updates?: ManagedPolicyUpdatesLimit;
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
  'clients',
  'updates',
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

export function describeManagedPolicyKey(parent: string, key: string): string {
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
      path: describeManagedPolicyKey('limits.updates', String(key)),
      message:
        'unknown key; this version of Station refuses keys it cannot enforce',
    }));
  const mode = ownLimitValue(updates, 'mode');
  if (mode !== undefined && mode !== 'auto' && mode !== 'off')
    problems.push({
      path: 'limits.updates.mode',
      message: 'must be "auto" or "off"',
    });
  const feedUrl = ownLimitValue(updates, 'feedUrl');
  const feedProblem =
    feedUrl === undefined ? null : updateFeedUrlProblem(feedUrl);
  if (feedProblem)
    problems.push({ path: 'limits.updates.feedUrl', message: feedProblem });
  const allowNightly = ownLimitValue(updates, 'allowNightly');
  if (allowNightly !== undefined && typeof allowNightly !== 'boolean')
    problems.push({
      path: 'limits.updates.allowNightly',
      message: 'must be true or false',
    });
  return problems;
}

/**
 * #4522: the `limits.updates` slice. A document carries the policy's own
 * keys; a summary carries {@link ManagedPolicyUpdatesSummary}, which replaces
 * `feedUrl` with `mirror` and fills in every default. A malformed summary
 * refuses the whole status, so a client never acts on half of it.
 */
function updatesSliceProblems(
  limits: Record<string, unknown>,
  shape: ManagedPolicyLimitsShape,
): ManagedPolicyProblem[] {
  const updates = ownLimitValue(limits, 'updates');
  if (shape === 'document') return updatesLimitProblems(updates);
  return parseUpdatesSummary(updates) === null
    ? [
        {
          path: 'limits.updates',
          message: 'must be a summary with "mode", "mirror" and "allowNightly"',
        },
      ]
    : [];
}

/** #4522: `{ updates }` from limits that passed {@link updatesSliceProblems}. */
function updatesSliceAccepted(
  limits: Record<string, unknown>,
  shape: ManagedPolicyLimitsShape,
): ManagedPolicyLimitSliceValue {
  const updates = ownLimitValue(limits, 'updates');
  if (shape === 'summary') {
    const summary = parseUpdatesSummary(updates);
    return summary ? { updates: summary } : {};
  }
  return isRecord(updates) ? { updates: parsedUpdatesLimit(updates) } : {};
}

/** #4522: what clients see of `limits.updates`: never the feed URL. */
function updatesSliceSummary(
  limits: ManagedPolicyLimits,
): ManagedPolicyLimitSliceValue {
  return limits.updates
    ? { updates: summarizeUpdatesLimit(limits.updates) }
    : {};
}

/** #4522: the accepted `limits.updates`, from a value already checked. */
function parsedUpdatesLimit(
  updates: Record<string, unknown>,
): ManagedPolicyUpdatesLimit {
  const parsed: ManagedPolicyUpdatesLimit = {};
  const mode = ownLimitValue(updates, 'mode');
  if (mode === 'auto' || mode === 'off') parsed.mode = mode;
  const feedUrl = ownLimitValue(updates, 'feedUrl');
  if (typeof feedUrl === 'string') parsed.feedUrl = feedUrl;
  const allowNightly = ownLimitValue(updates, 'allowNightly');
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
  if (value.length > UPDATE_FEED_URL_MAX_CHARS)
    return `must be at most ${UPDATE_FEED_URL_MAX_CHARS} characters`;
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
  limits: ManagedPolicySummaryLimits;
}

/**
 * #4522: what clients learn about `limits.updates`. `mirror` says whether a
 * feed is set; the feed URL itself is never sent, because it may carry an
 * access token.
 */
export interface ManagedPolicyUpdatesSummary {
  mode: 'auto' | 'off';
  mirror: boolean;
  allowNightly: boolean;
}

/** The effective limits a client sees: {@link ManagedPolicyLimits} without secrets. */
export type ManagedPolicySummaryLimits = Omit<
  ManagedPolicyLimits,
  'updates'
> & {
  updates?: ManagedPolicyUpdatesSummary;
};

function summarizeUpdatesLimit(
  updates: ManagedPolicyUpdatesLimit,
): ManagedPolicyUpdatesSummary {
  return {
    mode: updates.mode ?? 'auto',
    mirror: updates.feedUrl !== undefined,
    allowNightly: updates.allowNightly ?? true,
  };
}

/** Where a loaded policy came from. More kinds arrive with later sources. */
export type ManagedPolicySourceKind = 'file' | 'test-override';

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
    (source.kind !== 'file' && source.kind !== 'test-override') ||
    typeof source.location !== 'string' ||
    !isManagedPolicyDigest(digest) ||
    !isRecord(summary) ||
    typeof summary.organization !== 'string' ||
    (summary.supportUrl !== null && typeof summary.supportUrl !== 'string') ||
    !Array.isArray(summary.lockedSettings) ||
    !summary.lockedSettings.every((path) => typeof path === 'string') ||
    !isRecord(summary.limits) ||
    managedPolicyLimitProblems(summary.limits, 'summary').length > 0
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
      limits: acceptedManagedPolicySummaryLimits(summary.limits),
    },
  };
}

/** `undefined` when absent, `null` when malformed. */
function parseUpdatesSummary(
  value: unknown,
): ManagedPolicyUpdatesSummary | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { mode, mirror, allowNightly } = value;
  if (
    (mode !== 'auto' && mode !== 'off') ||
    typeof mirror !== 'boolean' ||
    typeof allowNightly !== 'boolean'
  )
    return null;
  return { mode, mirror, allowNightly };
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
      path: describeManagedPolicyKey('limits.registries', String(key)),
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
 * Which `limits` a slice reads: a policy document's, or the client summary's
 * projection of them (the status decode re-checks a summary read from a
 * server). Most slices read both alike; a slice whose summary differs from
 * its document shape, or that is lenient toward a newer server's summary,
 * branches on it.
 */
export type ManagedPolicyLimitsShape = 'document' | 'summary';

/** One slice's own keys, in either shape. */
type ManagedPolicyLimitSliceValue =
  | ManagedPolicyLimits
  | ManagedPolicySummaryLimits;

/**
 * One limit slice: the problems with its keys in a `limits` object, and its
 * accepted value copied out of one that passed (in the same shape). Each
 * returns only its own keys; the readers merge them. `summary` projects the
 * slice's keys of a parsed document's limits to what clients see; without
 * it the summary carries the document value, copied. Every slice is listed
 * in {@link MANAGED_POLICY_LIMIT_SLICES}.
 */
interface ManagedPolicyLimitSlice {
  problems(
    limits: Record<string, unknown>,
    shape: ManagedPolicyLimitsShape,
  ): ManagedPolicyProblem[];
  accepted(
    limits: Record<string, unknown>,
    shape: ManagedPolicyLimitsShape,
  ): ManagedPolicyLimitSliceValue;
  summary?(limits: ManagedPolicyLimits): ManagedPolicyLimitSliceValue;
}

/**
 * Every limit slice this build enforces. The parsed document, the summary and
 * the status decode all rebuild limits from this list, so a slice added here
 * reaches all three; a site that rebuilt limits from one slice's own fields
 * would silently drop every other slice's restriction.
 */
const MANAGED_POLICY_LIMIT_SLICES: readonly ManagedPolicyLimitSlice[] = [
  { problems: capabilityLimitProblems, accepted: capabilityLimitsOf },
  { problems: clientsLimitProblems, accepted: acceptedClientsLimit },
  {
    problems: updatesSliceProblems,
    accepted: updatesSliceAccepted,
    summary: updatesSliceSummary,
  },
];

/** Problems with every enforced limit in `limits`, from every slice. */
export function managedPolicyLimitProblems(
  limits: unknown,
  shape: ManagedPolicyLimitsShape,
): ManagedPolicyProblem[] {
  if (!isRecord(limits)) return [];
  return MANAGED_POLICY_LIMIT_SLICES.flatMap((slice) =>
    slice.problems(limits, shape),
  );
}

function mergedSliceValues(
  values: Iterable<ManagedPolicyLimitSliceValue>,
): ManagedPolicyLimitSliceValue {
  let result: ManagedPolicyLimitSliceValue = {};
  for (const value of values) result = { ...result, ...value };
  return result;
}

/**
 * The accepted limits of a document's `limits` that passed
 * {@link managedPolicyLimitProblems} (`'document'`): every slice's result,
 * merged.
 */
export function acceptedManagedPolicyLimits(
  limits: unknown,
): ManagedPolicyLimits {
  if (!isRecord(limits)) return {};
  return mergedSliceValues(
    MANAGED_POLICY_LIMIT_SLICES.map((slice) =>
      slice.accepted(limits, 'document'),
    ),
  ) as ManagedPolicyLimits;
}

/**
 * The accepted limits of a summary read from a server that passed
 * {@link managedPolicyLimitProblems} (`'summary'`): every slice's result,
 * merged.
 */
export function acceptedManagedPolicySummaryLimits(
  limits: unknown,
): ManagedPolicySummaryLimits {
  if (!isRecord(limits)) return {};
  return mergedSliceValues(
    MANAGED_POLICY_LIMIT_SLICES.map((slice) =>
      slice.accepted(limits, 'summary'),
    ),
  ) as ManagedPolicySummaryLimits;
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
  return mergedSliceValues(
    MANAGED_POLICY_LIMIT_SLICES.map((slice) =>
      slice.summary
        ? slice.summary(limits)
        : slice.accepted(record, 'document'),
    ),
  ) as ManagedPolicySummaryLimits;
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

/**
 * #4519: how a client reaches the server. `desktop` is the desktop app's own
 * server, `local-browser` a browser on this machine, and `remote` anything
 * off the machine: paired phones and computers, the relay, LAN discovery and
 * Tailscale Serve.
 */
export type ManagedPolicyClientKind = 'desktop' | 'local-browser' | 'remote';

export const MANAGED_POLICY_CLIENT_KINDS: readonly ManagedPolicyClientKind[] = [
  'desktop',
  'local-browser',
  'remote',
];

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
 * Why `value` is not an accepted `limits.clients`, or null. A status read
 * from a server skips the required-kinds rule (`shape: 'summary'`): a newer
 * server may enforce lists this build refuses in a policy.
 */
function clientsValueProblem(
  value: unknown,
  shape: ManagedPolicyLimitsShape,
): string | null {
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
  if (shape === 'summary') return null;
  const missing = REQUIRED_CLIENT_KINDS.filter((kind) => !value.includes(kind));
  return missing.length > 0
    ? `must include ${missing.map((kind) => `"${kind}"`).join(' and ')}; this version of Station can only leave out "remote"`
    : null;
}

/** #4519: problems with `limits.clients`. */
function clientsLimitProblems(
  limits: Record<string, unknown>,
  shape: ManagedPolicyLimitsShape,
): ManagedPolicyProblem[] {
  const message = clientsValueProblem(ownLimitValue(limits, 'clients'), shape);
  return message ? [{ path: 'limits.clients', message }] : [];
}

/**
 * #4519: `{ clients }` from limits that passed {@link clientsLimitProblems},
 * else `{}`. The kinds are put in canonical order; the summary is the same.
 */
function acceptedClientsLimit(
  limits: Record<string, unknown>,
): ManagedPolicyLimits {
  const clients = ownLimitValue(limits, 'clients');
  return Array.isArray(clients)
    ? {
        clients: MANAGED_POLICY_CLIENT_KINDS.filter((kind) =>
          clients.includes(kind),
        ),
      }
    : {};
}

/**
 * #4519: whether clients off this machine may reach the server. True without
 * a policy, without `limits.clients`, or when it lists `remote`.
 */
export function managedPolicyAllowsRemoteClients(
  summary: Pick<ManagedPolicySummary, 'limits'> | null | undefined,
): boolean {
  const clients = summary?.limits.clients;
  return clients === undefined || clients.includes('remote');
}

/**
 * #4519: the refusal code for remote access the managed policy forbids: a
 * pairing offer, a relay invitation, LAN discovery, or a credential of a
 * device paired before the policy. Clients key on it to show the managed
 * message instead of offering a retry.
 */
export const MANAGED_POLICY_REMOTE_CLIENTS_CODE =
  'managed-policy-remote-clients' as const;

/**
 * #4519: the refusal without its help tail, for a surface that renders the
 * policy's support link itself ("Get help").
 */
export function managedRemoteClientsStatement(
  summary: ManagedPolicySummary,
): string {
  return `${summary.organization}'s policy manages remote access: only this computer can connect to Station.`;
}

/** The sentence every surface uses to refuse remote access under the limit. */
export function managedRemoteClientsDenial(
  summary: ManagedPolicySummary,
): string {
  return managedPolicyDenial(
    summary,
    'remote access: only this computer can connect to Station',
  );
}

/**
 * #4522: the refusal code every update surface answers with when the
 * managed policy forbids an update check, download or install. Clients key
 * on it to show the policy sentence instead of offering a retry.
 */
export const MANAGED_POLICY_UPDATES_REFUSED_CODE =
  'managed-policy-updates-refused' as const;
