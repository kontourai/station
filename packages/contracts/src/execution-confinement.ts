/**
 * #2494: execution confinement — what a started process can touch — as a
 * server-resolved dimension of a session, recorded from what the started
 * engine reports. A separate axis
 * from `ApprovalMode` (whether a tool call needs a click) and from
 * `WorkspaceIsolationMode` (which checkout the session runs in).
 *
 * Domain shapes only. Resolution, providers and the derivation of a posture
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
 *   provider and a shared live checkout).
 * - `confinement_not_observed`: the mechanism was engaged, but the started
 *   engine did not report it applied; the process was stopped.
 */
export const CONFINEMENT_REFUSAL_CODES = [
  'confinement_mechanism_unavailable',
  'confinement_workspace_incompatible',
  'confinement_not_observed',
] as const;
export type ConfinementRefusalCode = (typeof CONFINEMENT_REFUSAL_CODES)[number];
