/**
 * The browser-facing half of the managed policy contract (#4515): the limit
 * and summary types, the value-free summary's status envelope and boundary
 * parser with one reader per limit (`MANAGED_POLICY_SUMMARY_LIMIT_READERS`),
 * the denial and "Managed by" text helpers, the refusal codes, and the
 * predicates clients use. Nothing here imports the settings registries or
 * the document checks the policy parser needs, so the UI's first-load bundle
 * does not carry them.
 * `@kontourai/station-contracts/managed-policy` re-exports all of it.
 */
import {
  type ManagedPolicyEngineLimits,
  type ManagedPolicyEngineSummary,
  parseManagedEngineSummary,
} from './managed-policy-engines.js';
import { isRecord, ownMember } from './record-guard.js';

export * from './managed-policy-codes.js';

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
  /** #4520: which engines may run, and how the ones Station launches start. */
  engines?: ManagedPolicyEngineLimits;
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
  /** Every limit except `engines`, whose launch values are withheld. */
  limits: ManagedPolicySummaryLimits;
  /** #4520: `limits.engines` without values; absent when the policy sets none. */
  engines?: ManagedPolicyEngineSummary;
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
  'updates' | 'engines'
> & {
  updates?: ManagedPolicyUpdatesSummary;
};

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
    // #4520: engines are summarized beside `limits`, never inside it.
    ownMember(summary.limits, 'engines') !== undefined
  ) {
    return null;
  }
  const limits = managedPolicySummaryLimitsOf(summary.limits);
  if (limits === null) return null;
  const engineSummary = ownMember(summary, 'engines');
  const engines =
    engineSummary === undefined
      ? undefined
      : parseManagedEngineSummary(engineSummary);
  if (engines === null) return null;
  return {
    state: 'loaded',
    source: { kind: source.kind, location: source.location },
    digest,
    summary: {
      organization: summary.organization,
      supportUrl: summary.supportUrl,
      lockedSettings: [...summary.lockedSettings],
      limits,
      ...(engines ? { engines } : {}),
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

/**
 * Reads one limit from a summary a server sent: `undefined` when absent,
 * `null` when malformed, which refuses the whole status so a client never
 * acts on half of it. Each checks the value's shape, not every document
 * rule: the server validated the policy before it published the summary,
 * and a newer server may enforce values this build refuses in a document.
 */
type SummaryLimitReader<V> = (value: unknown) => V | undefined | null;

function offOnlyReader(value: unknown): false | undefined | null {
  if (value === undefined) return undefined;
  return value === false ? false : null;
}

function registriesSummaryReader(
  value: unknown,
): ManagedPolicyRegistryLimits | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const result: ManagedPolicyRegistryLimits = {};
  const allowedUrls = ownMember(value, 'allowedUrls');
  if (allowedUrls !== undefined) {
    // Each entry must still read as an https URL: a client compares
    // locations against it, and an http registry can be altered in transit.
    if (
      !Array.isArray(allowedUrls) ||
      !allowedUrls.every(
        (url) =>
          typeof url === 'string' &&
          normalizeManagedRegistryUrl(url)?.startsWith('https://') === true,
      )
    )
      return null;
    result.allowedUrls = [...allowedUrls];
  }
  for (const key of [
    'unsignedPackages',
    'defaultSkillRegistries',
    'acpRegistryInstalls',
  ] as const) {
    const off = offOnlyReader(ownMember(value, key));
    if (off === null) return null;
    if (off === false) result[key] = false;
  }
  return result;
}

function clientsSummaryReader(
  value: unknown,
): ManagedPolicyClientKind[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    new Set(value).size !== value.length ||
    !value.every((kind) =>
      (MANAGED_POLICY_CLIENT_KINDS as readonly unknown[]).includes(kind),
    )
  )
    return null;
  return MANAGED_POLICY_CLIENT_KINDS.filter((kind) => value.includes(kind));
}

/**
 * One reader per limit a summary can carry. The mapped type makes every key
 * of {@link ManagedPolicySummaryLimits} required here, so a slice that adds a
 * limit without a reader does not compile; the document side of each slice
 * is `MANAGED_POLICY_LIMIT_SLICES` in `./managed-policy.js`.
 */
export const MANAGED_POLICY_SUMMARY_LIMIT_READERS: {
  readonly [K in keyof Required<ManagedPolicySummaryLimits>]: SummaryLimitReader<
    ManagedPolicySummaryLimits[K]
  >;
} = {
  telemetry: offOnlyReader,
  webhookAutomations: offOnlyReader,
  registries: registriesSummaryReader,
  clients: clientsSummaryReader,
  updates: parseUpdatesSummary,
};

/** The limits of a summary read from a server, or null when one is malformed. */
function managedPolicySummaryLimitsOf(
  limits: Record<string, unknown>,
): ManagedPolicySummaryLimits | null {
  const result: Record<string, unknown> = {};
  for (const [key, read] of Object.entries(
    MANAGED_POLICY_SUMMARY_LIMIT_READERS,
  ) as Array<[string, SummaryLimitReader<unknown>]>) {
    const value = read(ownMember(limits, key));
    if (value === null) return null;
    if (value !== undefined) result[key] = value;
  }
  return result as ManagedPolicySummaryLimits;
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
