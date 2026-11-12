/**
 * #2494: execution confinement — what a started process can touch — as a
 * server-resolved dimension of a session, recorded from what the started
 * engine reports. A separate axis
 * from `ApprovalMode` (whether a tool call needs a click) and from
 * `WorkspaceIsolationMode` (which checkout the session runs in).
 *
 * Domain shapes, plus the boundary parser for the preflight a Station
 * reports (#4774). Resolution, providers and the derivation of a posture
 * live in the server (`src-server/security/confinement/`); callers never
 * supply any of these values.
 */

/**
 * How strongly a process is confined, weakest first:
 *
 * - `host`: no confinement; the process reaches whatever its user can.
 * - `os-profile`: an operating-system process sandbox (an engine's own, such
 *   as Codex's, or a Station-applied profile).
 * - `container`: one container per Project.
 * - `microvm`: a small virtual machine (hosted tenant work).
 */
export type ConfinementLevel = 'host' | 'os-profile' | 'container' | 'microvm';

/**
 * What the started process runs under, as the engine reported applying it
 * after the start. Derived from that report, never from the configuration
 * Station sent. It is the engine's own report, not a kernel observation:
 *
 * - `confined`: the engine reported the mechanism applied, no wider than
 *   the resolved workspace and Station-owned roots.
 * - `no-mechanism`: no confinement mechanism was engaged for this start.
 * - `configured-but-failed`: a mechanism was engaged, but the engine did
 *   not report it applied (it reported something weaker or wider, or
 *   nothing at all).
 */
export type ConfinementPosture =
  | 'confined'
  | 'no-mechanism'
  | 'configured-but-failed';

/**
 * How a confined process reaches its workspace:
 *
 * - `mounted`: it runs against the live checkout.
 * - `copied`: it has its own filesystem; code is synced in and commits are
 *   brought back out. Provenance differs: "the agent edited the checkout"
 *   versus "the agent's commits were replayed onto it".
 */
export type ConfinementWorkspaceAccess = 'mounted' | 'copied';

/**
 * Why the start resolved to the level it did:
 *
 * - `operator-policy`: the start was made by a caller that may grant full
 *   access (the operator in person, or a device holding
 *   `approval:full-access`), or the conversation recorded a concrete
 *   `never`. Its `host` level is a recorded policy choice, not an opt-out.
 * - `workspace-floor`: every other start (a Project member, a shared Agent,
 *   delegated or agent-originated work). Confinement is required where the
 *   floor's policy says so; otherwise the record says honestly that none
 *   applied.
 */
export type ConfinementPolicyBasis = 'operator-policy' | 'workspace-floor';

/** A confinement mechanism Station can engage and observe. */
export type ConfinementMechanism =
  /** Codex's own process sandbox, read back from Codex's thread response. */
  | 'codex-sandbox'
  /**
   * A macOS Seatbelt profile Station applies around the engine process
   * (`sandbox-exec`), observed once the engine answers its startup handshake
   * from inside it.
   */
  | 'seatbelt'
  /**
   * A bubblewrap (`bwrap`) sandbox Station applies around the engine process
   * on Linux, observed the same way: bubblewrap execs the engine only after
   * its mounts and namespaces are in place.
   */
  | 'bubblewrap';

/**
 * What a confinement profile lets the process write, by kind. Content-free:
 * the kinds, never the paths.
 *
 * - `workspace`: the resolved workspace.
 * - `git-worktree`: a linked worktree's own git directory.
 * - `git-objects`: the repository's shared object store.
 * - `git-branch-ref`: the worktree's own branch ref, its lock and its log.
 * - `station-temp`: a Station-owned temporary directory for this session.
 * - `station-config`: the Station-owned engine configuration directory.
 */
export type ConfinementWriteGrant =
  | 'workspace'
  | 'git-worktree'
  | 'git-objects'
  | 'git-branch-ref'
  | 'station-temp'
  | 'station-config';

/**
 * Why a start whose policy asked for confinement ran at a lower approval
 * mode instead, with no mechanism engaged. Each is derived from a check at
 * the start, never written as a label:
 *
 * - `confined-credential-unavailable`: no credential the confined engine
 *   can use without the operator's own state (an environment credential, or
 *   one enrolled in the Station-owned configuration directory) was found.
 * - `config-root-pinned`: the start continues a conversation pinned to the
 *   operator's global configuration root (adoption, or a source-affinity
 *   resume), which a confined engine may not write.
 * - `resume-bound-elsewhere`: the start resumes a conversation recorded
 *   under another configuration home.
 * - `workspace-too-broad`: the workspace is or contains the home folder or
 *   Station's data, or sits in a hidden folder or `~/Library`, so a write
 *   grant on it would confine nothing. Under bubblewrap (#4770), also a
 *   workspace inside or containing a path the sandbox hides.
 */
export type ConfinementFallbackReason =
  | 'confined-credential-unavailable'
  | 'config-root-pinned'
  | 'resume-bound-elsewhere'
  | 'workspace-too-broad';

/**
 * Content-free record of a session start's confinement: no host paths and
 * no credentials. It describes the START: a per-turn sandbox re-tightening
 * and a revoked full-access grant do not update it until the session's next
 * start writes a new one.
 *
 * - `level`: the level the engaged mechanism provides (also when it failed
 *   to apply); `host` when none was engaged.
 * - `required`: whether the start's policy required a level above `host`,
 *   from what Station sent or the approval policy the engine reported. A
 *   required start whose posture is not `confined` does not run.
 */
export interface ExecutionConfinementRecord {
  level: ConfinementLevel;
  required: boolean;
  posture: ConfinementPosture;
  /** Absent exactly when no mechanism was engaged (`no-mechanism`). */
  mechanism?: ConfinementMechanism;
  workspaceAccess: ConfinementWorkspaceAccess;
  policyBasis: ConfinementPolicyBasis;
  /**
   * What the applied profile lets the process write, when the mechanism is
   * one Station builds (a Seatbelt profile or a bubblewrap sandbox). Absent
   * for an engine's own
   * sandbox, whose grants Station reads back rather than writes.
   */
  writeGrants?: readonly ConfinementWriteGrant[];
  /**
   * Present when the policy asked for confinement and the start instead ran
   * at a lower approval mode (full access applied as `auto`) with no
   * mechanism engaged. Then `required` is false and the posture
   * `no-mechanism`.
   */
  fallback?: ConfinementFallbackReason;
  /**
   * #4769: `restricted` when the started process could reach only Station's
   * loopback egress broker, read from the profile it was spawned with.
   * Absent when its network was not restricted (the default policy, a start
   * with no Station-built mechanism, a fallback, or a record written before
   * #4769): the network was open.
   */
  network?: 'restricted';
}

/**
 * #4769: a confined start's restricted network. The process reaches only
 * Station's loopback egress broker, which admits the engine's own model
 * endpoint (derived from the resolved connection at spawn) and
 * `allowedHosts`, and refuses every other host.
 */
export interface ConfinementNetworkPlan {
  policy: 'restricted';
  /** Allowed-host entries as the policy lists them. */
  allowedHosts: readonly string[];
}

/**
 * #4769: a `CONNECT` target or an allowed-host entry's host: a lowercase
 * host name or an IP literal (IPv6 without brackets), and a port.
 */
export interface EgressTarget {
  host: string;
  port: number;
}

/**
 * #4769: one `allowedHosts` entry: an exact host (a name or an IP literal),
 * or every subdomain of a name (`*.example.com`, not `example.com` itself),
 * on one port.
 */
export type EgressHostRule =
  | { kind: 'exact'; host: string; port: number }
  | { kind: 'subdomains'; suffix: string; port: number };

/** The port an allowed-host entry without one means. */
const EGRESS_DEFAULT_PORT = 443;
/** The longest host name DNS can carry. */
const MAX_EGRESS_HOST_LENGTH = 253;

const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';
const IPV4_LITERAL = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

/** A dotted-quad IPv4 literal, without leading zeros. */
function isIpv4Literal(text: string): boolean {
  return IPV4_LITERAL.test(text);
}

/**
 * An IPv6 literal (no zone, no brackets): hexadecimal groups of one to four
 * digits, at most one `::`, optionally ending in a dotted IPv4 address.
 */
function isIpv6Literal(text: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(text) || !text.includes(':')) return false;
  let body = text;
  const dotted = /^(.*:)([^:]*\.[^:]*)$/.exec(text);
  if (dotted) {
    if (!isIpv4Literal(dotted[2]!)) return false;
    body = `${dotted[1]}0:0`;
  }
  const halves = body.split('::');
  if (halves.length > 2) return false;
  const groups = (half: string) => (half === '' ? [] : half.split(':'));
  const left = groups(halves[0]!);
  const right = halves.length === 2 ? groups(halves[1]!) : [];
  if (![...left, ...right].every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group)))
    return false;
  const count = left.length + right.length;
  return halves.length === 2 ? count <= 7 : count === 8;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * `raw` as the broker compares hosts: lowercase, one trailing dot removed,
 * an IPv6 literal without brackets. `undefined` for anything else: an empty
 * or over-long name, a label DNS cannot carry, a non-ASCII name (it must
 * arrive in its `xn--` form) or a bracketed literal that is not IPv6.
 */
export function normalizeEgressHost(raw: string): string | undefined {
  // An IPv6 zone names an interface of this host, not a destination.
  if (raw.includes('%')) return undefined;
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const literal = raw.slice(1, -1).toLowerCase();
    return isIpv6Literal(literal) ? literal : undefined;
  }
  if (isIpv4Literal(raw)) return raw;
  if (isIpv6Literal(raw)) return raw.toLowerCase();
  const host = (raw.endsWith('.') ? raw.slice(0, -1) : raw).toLowerCase();
  if (host.length === 0 || host.length > MAX_EGRESS_HOST_LENGTH)
    return undefined;
  return host.split('.').every((label) => LABEL.test(label)) ? host : undefined;
}

function parsePort(text: string): number | undefined {
  if (!/^[0-9]{1,5}$/.test(text)) return undefined;
  const port = Number(text);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

/** `host:port` or `[v6]:port`, the port required. */
function splitAuthority(
  text: string,
): { host: string; port: string | undefined } | undefined {
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close < 0) return undefined;
    const rest = text.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) return undefined;
    return {
      host: text.slice(0, close + 1),
      port: rest === '' ? undefined : rest.slice(1),
    };
  }
  const colon = text.lastIndexOf(':');
  // A bare IPv6 literal has colons of its own.
  if (colon < 0 || text.indexOf(':') !== colon)
    return { host: text, port: undefined };
  return { host: text.slice(0, colon), port: text.slice(colon + 1) };
}

/** A `CONNECT` request target (`host:port`), or `undefined` when malformed. */
export function parseConnectAuthority(text: string): EgressTarget | undefined {
  const parts = splitAuthority(text);
  if (!parts || parts.port === undefined) return undefined;
  const host = normalizeEgressHost(parts.host);
  const port = parsePort(parts.port);
  return host && port ? { host, port } : undefined;
}

/**
 * One allowed-host entry as written in the policy: `host`, `host:port`,
 * `*.domain`, `*.domain:port`, an IPv4 literal or a bracketed IPv6 literal,
 * each optionally with a port ({@link EGRESS_DEFAULT_PORT} otherwise).
 * `undefined` for anything else; a policy holding one is refused whole.
 */
export function parseEgressHostRule(text: string): EgressHostRule | undefined {
  if (typeof text !== 'string' || text.length > MAX_EGRESS_HOST_LENGTH + 8)
    return undefined;
  const wildcard = text.startsWith('*.');
  const parts = splitAuthority(wildcard ? text.slice(2) : text);
  if (!parts) return undefined;
  const port =
    parts.port === undefined ? EGRESS_DEFAULT_PORT : parsePort(parts.port);
  const host = normalizeEgressHost(parts.host);
  if (!host || !port || (parts.host.endsWith('.') && wildcard))
    return undefined;
  if (!wildcard) return { kind: 'exact', host, port };
  // A wildcard names DNS subdomains: never of an IP literal or a single label.
  return !isIpv4Literal(host) && !isIpv6Literal(host) && host.includes('.')
    ? { kind: 'subdomains', suffix: host, port }
    : undefined;
}

/**
 * #4769: the Station setting `confinedNetwork`. Absent, or `full`, leaves a
 * confined start's network open, as before. `restricted` limits every start
 * that requires confinement (`os-profile` or stronger) to the egress
 * broker; the operator's own `host` starts are not confined and are
 * unaffected.
 *
 * Each `allowedHosts` entry is `host`, `host:port`, `*.domain` (every
 * subdomain, not the domain itself) or an IP literal (IPv6 in brackets),
 * with port 443 unless one is named.
 */
export type ConfinedNetworkSetting =
  | { mode: 'full' }
  | { mode: 'restricted'; allowedHosts: readonly string[] };

/** The most `allowedHosts` entries the setting may list. */
export const MAX_CONFINED_NETWORK_ALLOWED_HOSTS = 256;
/** The longest `allowedHosts` entry the setting may hold. */
export const MAX_CONFINED_NETWORK_HOST_ENTRY_LENGTH = 261;

/**
 * The `confinedNetwork` setting read from a stored value, or `undefined`
 * when the value is not one: its shape, and every `allowedHosts` entry
 * parsed exactly as the broker that enforces it parses it
 * ({@link parseEgressHostRule}). The settings write path refuses a value
 * this does not accept (`appConfigSemanticError`), and a start whose stored
 * policy it does not accept is refused.
 */
export function parseConfinedNetworkSetting(
  value: unknown,
): ConfinedNetworkSetting | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const setting = value as Record<string, unknown>;
  const keys = Object.keys(setting);
  if (setting.mode === 'full')
    return keys.length === 1 ? { mode: 'full' } : undefined;
  if (setting.mode !== 'restricted') return undefined;
  const hosts = setting.allowedHosts;
  if (
    keys.some((key) => key !== 'mode' && key !== 'allowedHosts') ||
    !Array.isArray(hosts) ||
    hosts.length > MAX_CONFINED_NETWORK_ALLOWED_HOSTS ||
    !hosts.every(
      (host) =>
        typeof host === 'string' &&
        host.length > 0 &&
        host.length <= MAX_CONFINED_NETWORK_HOST_ENTRY_LENGTH &&
        parseEgressHostRule(host) !== undefined,
    )
  )
    return undefined;
  return { mode: 'restricted', allowedHosts: [...(hosts as string[])] };
}

/**
 * The confinement a start resolved to before its process exists: the level
 * its policy requires and the mechanism chosen to meet it. Server-only on a
 * provider start input; the adapter that engages the mechanism observes the
 * started process and records the posture.
 */
export interface ConfinementPlan {
  requiredLevel: ConfinementLevel;
  policyBasis: ConfinementPolicyBasis;
  mechanism: ConfinementMechanism;
  /** The level `mechanism` provides. */
  level: Exclude<ConfinementLevel, 'host'>;
  workspaceAccess: ConfinementWorkspaceAccess;
  /**
   * #4769: present when the start's policy restricts the network; only a
   * provider that can restrict it resolves such a plan.
   */
  network?: ConfinementNetworkPlan;
}

/**
 * The confinement record on a session's `session.started` metadata. Reserved:
 * a caller-supplied value is stripped before the server's own is written,
 * and a respawn re-derives it from the new process rather than copying it.
 */
export const STATION_CONFINEMENT_RECORD_METADATA_KEY =
  'stationConfinementRecord';

/**
 * Typed refusal codes for a start whose required confinement cannot be met.
 * Nothing started.
 *
 * - `confinement_mechanism_unavailable`: no mechanism for the required level
 *   is available to this start on this host (the message names it).
 * - `confinement_workspace_incompatible`: the only mechanisms for the level
 *   cannot work with the start's workspace isolation (for example a copied
 *   provider and a shared live checkout), or the workspace holds engine
 *   configuration its repository does not account for, which would run
 *   outside any confinement (#3800; refused whether or not the start
 *   requires confinement).
 * - `confinement_not_observed`: the mechanism was engaged, but the started
 *   engine did not report it applied; the process was stopped.
 */
export const CONFINEMENT_REFUSAL_CODES = [
  'confinement_mechanism_unavailable',
  'confinement_workspace_incompatible',
  'confinement_not_observed',
] as const;
export type ConfinementRefusalCode = (typeof CONFINEMENT_REFUSAL_CODES)[number];

/**
 * #4774: what a host can say, before any start, about a confined start of
 * one engine. Content-free: states and the provider's own reason text, never
 * a path, an environment value or a credential.
 *
 * - `available` / `unavailable`: the provider's own availability check on
 *   this host, for a provider Station applies around the engine spawn.
 * - `engine-reported`: the engine applies the mechanism itself, so only its
 *   report after a start says whether it applied.
 */
export type ConfinementPreflightMechanismState =
  | 'available'
  | 'unavailable'
  | 'engine-reported';

/**
 * Which starts a checked credential answer covers.
 * `starts-without-own-credential-profile`: starts that name no credential
 * profile of their own, so the connection's active profile (or its app-home
 * opt-in) applies. A start that names one (an Agent with its own
 * `execution.credentialProfileRef`, a credential-recovery restart) uses
 * that profile's confined home, and is decided when it starts.
 */
export type ConfinementPreflightCredentialScope =
  'starts-without-own-credential-profile';

/**
 * Whether a confined start of the engine would find a credential it can use
 * inside the confinement, for the starts `appliesTo` names:
 *
 * - `available`: the start's own credential check passes (`source` names
 *   where it found one, never what).
 * - `unavailable`: the check fails, so a start that asks for confinement
 *   falls back for `fallback`.
 * - `unverified`: the inputs the check needs could not be resolved (the
 *   reason says which); the start decides.
 * - `not-applicable`: no confined-credential check applies to this engine's
 *   starts.
 */
export type ConfinementPreflightCredential =
  | {
      state: 'available';
      source: 'environment' | 'config-dir';
      appliesTo: ConfinementPreflightCredentialScope;
    }
  | {
      state: 'unavailable';
      fallback: 'confined-credential-unavailable';
      remedy: string;
      appliesTo: ConfinementPreflightCredentialScope;
    }
  | {
      state: 'unverified';
      reason: string;
      appliesTo: ConfinementPreflightCredentialScope;
    }
  | { state: 'not-applicable'; reason: string };

/**
 * #4769: whether this mechanism can restrict a confined start's network to
 * Station's egress broker on this host. `available` only when the mechanism
 * can and is available here; the reason says why not otherwise. Whether the
 * start's model endpoint can be derived is decided at start.
 */
export interface ConfinementPreflightRestrictedNetwork {
  state: 'available' | 'unavailable';
  reason: string;
}

/** One engine's host-level confinement facts, for one mechanism. */
export interface EngineConfinementPreflight {
  /** An engine id: see {@link CONFINEMENT_PREFLIGHT_ENGINE_PATTERN}. */
  engine: string;
  mechanism: ConfinementMechanism;
  level: Exclude<ConfinementLevel, 'host'>;
  mechanismState: ConfinementPreflightMechanismState;
  /** The provider's own availability reason, without paths. */
  mechanismReason: string;
  /**
   * Not named `...Credential`: Station's diagnostic redaction blanks every
   * value under a key with a credential segment, which would hide this
   * content-free state from `station doctor --json`.
   */
  confinedAuthentication: ConfinementPreflightCredential;
  /** #4769: absent from a Station that predates restricted networks. */
  restrictedNetwork?: ConfinementPreflightRestrictedNetwork;
}

/**
 * #4774: the host-level confinement facts a running Station reports before
 * any start (`GET /api/diagnostics/confinement-preflight`). `decidedAtStart`
 * lists the fallback reasons this report cannot decide, because they depend
 * on the start's workspace or conversation.
 */
export interface ConfinementPreflight {
  engines: EngineConfinementPreflight[];
  decidedAtStart: ConfinementFallbackReason[];
}

/** The longest reason text a preflight entry may carry. */
export const MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH = 1_024;
/** The most engine entries a preflight may carry. */
export const MAX_CONFINEMENT_PREFLIGHT_ENGINES = 16;
/**
 * The engine ids a preflight may name: lowercase letters, digits, `.`, `_`
 * and `-`, starting with a letter or digit, at most 64 characters. Anything
 * else (a path, a control sequence) refuses the whole answer.
 */
const CONFINEMENT_PREFLIGHT_ENGINE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PREFLIGHT_MECHANISMS = new Set<string>([
  'codex-sandbox',
  'seatbelt',
  'bubblewrap',
]);
const PREFLIGHT_LEVELS = new Set<string>([
  'os-profile',
  'container',
  'microvm',
]);
const PREFLIGHT_MECHANISM_STATES = new Set<string>([
  'available',
  'unavailable',
  'engine-reported',
]);
const PREFLIGHT_FALLBACKS = new Set<string>([
  'confined-credential-unavailable',
  'config-root-pinned',
  'resume-bound-elsewhere',
  'workspace-too-broad',
]);
const PREFLIGHT_CREDENTIAL_SCOPES = new Set<string>([
  'starts-without-own-credential-profile',
]);

/** Known fallback reasons, each at most once: no longer than the known set. */
function preflightDecidedAtStart(
  value: unknown,
): ConfinementFallbackReason[] | undefined {
  if (!Array.isArray(value) || value.length > PREFLIGHT_FALLBACKS.size)
    return undefined;
  const seen = new Set<string>();
  for (const reason of value) {
    if (
      typeof reason !== 'string' ||
      !PREFLIGHT_FALLBACKS.has(reason) ||
      seen.has(reason)
    )
      return undefined;
    seen.add(reason);
  }
  return [...seen] as ConfinementFallbackReason[];
}

function preflightText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CONFINEMENT_PREFLIGHT_REASON_LENGTH
  );
}

function parsePreflightCredential(
  value: unknown,
): ConfinementPreflightCredential | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const credential = value as Record<string, unknown>;
  const appliesTo =
    typeof credential.appliesTo === 'string' &&
    PREFLIGHT_CREDENTIAL_SCOPES.has(credential.appliesTo)
      ? (credential.appliesTo as ConfinementPreflightCredentialScope)
      : undefined;
  switch (credential.state) {
    case 'available':
      return appliesTo &&
        (credential.source === 'environment' ||
          credential.source === 'config-dir')
        ? { state: 'available', source: credential.source, appliesTo }
        : undefined;
    case 'unavailable':
      return appliesTo &&
        credential.fallback === 'confined-credential-unavailable' &&
        preflightText(credential.remedy)
        ? {
            state: 'unavailable',
            fallback: credential.fallback,
            remedy: credential.remedy,
            appliesTo,
          }
        : undefined;
    case 'unverified':
      return appliesTo && preflightText(credential.reason)
        ? { state: 'unverified', reason: credential.reason, appliesTo }
        : undefined;
    case 'not-applicable':
      return preflightText(credential.reason)
        ? { state: 'not-applicable', reason: credential.reason }
        : undefined;
    default:
      return undefined;
  }
}

/** `undefined` when absent, `null` when present but not one. */
function parsePreflightRestrictedNetwork(
  value: unknown,
): ConfinementPreflightRestrictedNetwork | undefined | null {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  return (entry.state === 'available' || entry.state === 'unavailable') &&
    preflightText(entry.reason)
    ? { state: entry.state, reason: entry.reason }
    : null;
}

/**
 * A confinement preflight read back from a Station, or `undefined` when the
 * value is not one (an unknown state, an over-long reason, too many
 * entries, an engine id outside {@link CONFINEMENT_PREFLIGHT_ENGINE_PATTERN},
 * a `decidedAtStart` with an unknown or repeated reason). Unknown extra keys
 * are dropped. Reason text is length-checked only; a caller that displays it
 * sanitizes it.
 */
export function parseConfinementPreflight(
  value: unknown,
): ConfinementPreflight | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const preflight = value as Record<string, unknown>;
  const decidedAtStart = preflightDecidedAtStart(preflight.decidedAtStart);
  if (
    !Array.isArray(preflight.engines) ||
    preflight.engines.length > MAX_CONFINEMENT_PREFLIGHT_ENGINES ||
    !decidedAtStart
  )
    return undefined;
  const engines: EngineConfinementPreflight[] = [];
  for (const entry of preflight.engines) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return undefined;
    const engine = entry as Record<string, unknown>;
    const confinedAuthentication = parsePreflightCredential(
      engine.confinedAuthentication,
    );
    const restrictedNetwork = parsePreflightRestrictedNetwork(
      engine.restrictedNetwork,
    );
    if (
      typeof engine.engine !== 'string' ||
      !CONFINEMENT_PREFLIGHT_ENGINE_PATTERN.test(engine.engine) ||
      typeof engine.mechanism !== 'string' ||
      !PREFLIGHT_MECHANISMS.has(engine.mechanism) ||
      typeof engine.level !== 'string' ||
      !PREFLIGHT_LEVELS.has(engine.level) ||
      typeof engine.mechanismState !== 'string' ||
      !PREFLIGHT_MECHANISM_STATES.has(engine.mechanismState) ||
      !preflightText(engine.mechanismReason) ||
      !confinedAuthentication ||
      restrictedNetwork === null
    )
      return undefined;
    engines.push({
      engine: engine.engine,
      mechanism: engine.mechanism as ConfinementMechanism,
      level: engine.level as EngineConfinementPreflight['level'],
      mechanismState:
        engine.mechanismState as ConfinementPreflightMechanismState,
      mechanismReason: engine.mechanismReason,
      confinedAuthentication,
      ...(restrictedNetwork ? { restrictedNetwork } : {}),
    });
  }
  return { engines, decidedAtStart };
}
