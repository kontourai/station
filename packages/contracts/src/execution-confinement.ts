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
  | 'seatbelt';

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
 *   grant on it would confine nothing.
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
   * one Station builds (a Seatbelt profile). Absent for an engine's own
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
export const CONFINEMENT_PREFLIGHT_ENGINE_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PREFLIGHT_MECHANISMS = new Set<string>(['codex-sandbox', 'seatbelt']);
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
      !confinedAuthentication
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
    });
  }
  return { engines, decidedAtStart };
}
