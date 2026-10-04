/**
 * #2875 slice 1: version-matched execution on a checkout the receiving
 * Station already has. The caller names an owner-qualified version of one
 * portable resource; the receiver refuses to start work unless its own
 * admitted checkout is at that version when checked. Nothing is
 * transferred, set up or applied back. See
 * docs/design/remote-execution-preparation.md.
 *
 * The contract carries no adapter-specific fields: `version.scheme` names
 * the owner's version scheme (`git-commit` for a Git resource) and the
 * receiver chooses an adapter by the admitted resource's kind.
 */

export const EXECUTION_PREPARATION_PROTOCOL =
  'station.execution-preparation/v1' as const;

/** An owner-qualified version. `value` is interpreted only by `scheme`'s owner. */
export interface ResourceVersion {
  readonly scheme: string;
  readonly value: string;
}

/**
 * What the caller requires before execution starts. `mode`, `scheme` and
 * each guarantee are open strings on the wire on purpose: a receiver
 * refuses a value it does not support with a typed refusal naming the
 * dimension, never a generic validation error and never a silent
 * downgrade. The resource is the enclosing workspace target's `resourceId`.
 */
export interface ExecutionPreparationRequirement {
  readonly protocol: string;
  readonly mode: string;
  readonly version: ResourceVersion;
  readonly guarantees: readonly string[];
}

/**
 * Typed refusals, each raised before any session or provider effect. A
 * receiver records every refusal it raises after reserving the #485 claim
 * on that claim; `execution_preparation_attempt_required` (no attempt to
 * record on) and a sender's `execution_preparation_unsupported` (nothing
 * was sent) are never on a claim.
 */
export type ExecutionPreparationRefusalCode =
  /** No capability: an older receiver, or an unknown protocol version. */
  | 'execution_preparation_unsupported'
  /** A prepared intent must ride a #485 attempt. */
  | 'execution_preparation_attempt_required'
  | 'execution_preparation_mode_unsupported'
  /** `remote-reference` is a known mode this build does not support yet. */
  | 'execution_preparation_remote_reference_unsupported'
  | 'execution_preparation_scheme_unsupported'
  | 'execution_preparation_guarantee_unsupported'
  /** No adapter is registered for the admitted resource's kind. */
  | 'execution_preparation_kind_unsupported'
  /** `protected-during-execution` was required; nothing can fence writers yet. */
  | 'execution_preparation_protection_unavailable'
  /** The receiver would run in a worktree, not the checked checkout. */
  | 'execution_preparation_isolation_unsupported'
  /** A tracked file or a submodule commit differs from HEAD. */
  | 'execution_preparation_tracked_changes'
  /** Index entries are assume-unchanged or skip-worktree: changes are hidden. */
  | 'execution_preparation_tracked_state_unverifiable'
  | 'execution_preparation_version_mismatch'
  /** The checkout could not be read; not a policy denial. */
  | 'execution_preparation_unavailable';

/**
 * Evidence of the check, carried on the execution resolution receipt. It is
 * path-free and it is not a capability: nothing accepts it back as input.
 * `version-matched-when-checked` is all it claims — a local writer can
 * change the checkout after `checkedAt`.
 */
export interface ExecutionPreparationReceipt {
  readonly protocol: typeof EXECUTION_PREPARATION_PROTOCOL;
  readonly mode: 'existing-realization';
  readonly resourceId: string;
  readonly requested: ResourceVersion;
  readonly observed: ResourceVersion;
  readonly guarantee: 'version-matched-when-checked';
  readonly checkedAt: string;
  readonly trackedChanges: 'none';
  /** Untracked files are allowed in slice 1 and only counted, never named. */
  readonly untrackedFiles: number;
  readonly setup: 'not-performed';
}
