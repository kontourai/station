import type { OwnerIdentity, OwnerLivenessVerdict } from './owner.js';
import type {
  RequestKeyId,
  TurnBoundaryPurpose,
  TurnBoundaryRecord,
  TurnBoundaryState,
  TurnDedupRecord,
} from './records.js';

/**
 * Every kernel operation is one command. An adapter executes one command as
 * one atomic transaction: all of its writes land, or none do.
 */

// ---------------------------------------------------------------------------
// Turn dedup
// ---------------------------------------------------------------------------

export interface TurnDedupClaimCommand {
  readonly type: 'turnDedup.claim';
  readonly key: string;
  readonly owner: OwnerIdentity;
  readonly now: number;
  /**
   * `tracked` promises the claimant calls `turnDedup.beginInvocation` before
   * its effect. Only that promise lets a later claimant reclaim the key after
   * this owner dies before that point.
   */
  readonly tracking: 'tracked' | 'untracked';
}
export type TurnDedupClaimResult =
  | { readonly kind: 'claimed'; readonly reclaimed: boolean }
  | { readonly kind: 'resolved'; readonly value: string }
  | { readonly kind: 'contended' }
  /** The dead owner may have started the effect. Never replay it. */
  | { readonly kind: 'indeterminate' }
  /**
   * The key's resolved row was evicted by retention. Its effect ran and the
   * result can no longer be replayed. The key is never claimable again until
   * its tombstone is forgotten.
   */
  | { readonly kind: 'expired' };

export interface TurnDedupBeginInvocationCommand {
  readonly type: 'turnDedup.beginInvocation';
  readonly key: string;
  readonly ownerId: string;
  /** Stamps any tombstone the write's retention leaves. */
  readonly now: number;
}
export type TurnDedupBeginInvocationResult =
  | { readonly kind: 'applied' }
  /** Not this owner's pending or begun claim. Do not start the effect. */
  | { readonly kind: 'refused' };

export interface TurnDedupResolveCommand {
  readonly type: 'turnDedup.resolve';
  readonly key: string;
  readonly ownerId: string;
  readonly value: string;
  /** Stamps any tombstone the write's retention leaves. */
  readonly now: number;
}
export interface TurnDedupReleaseCommand {
  readonly type: 'turnDedup.release';
  readonly key: string;
  readonly ownerId: string;
  /** Stamps any tombstone the write's retention leaves. */
  readonly now: number;
}
export type TurnDedupSettleResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'stale' };

export interface TurnDedupReadCommand {
  readonly type: 'turnDedup.read';
  readonly key: string;
}
export type TurnDedupReadResult =
  | { readonly kind: 'found'; readonly record: TurnDedupRecord }
  /** The resolved row was evicted; only the tombstone is left. */
  | { readonly kind: 'expired'; readonly expiredAt: number }
  | { readonly kind: 'absent' };

export interface TurnDedupForgetPrefixCommand {
  readonly type: 'turnDedup.forgetPrefix';
  /** Exact string prefix; no wildcard semantics. Tombstones go with the rows. */
  readonly prefix: string;
}
export type TurnDedupForgetPrefixResult = {
  readonly kind: 'applied';
  /** Rows and tombstones forgotten. */
  readonly removed: number;
};

// ---------------------------------------------------------------------------
// Turn boundary
// ---------------------------------------------------------------------------

export interface TurnBoundaryCreateCommand {
  readonly type: 'turnBoundary.create';
  readonly boundaryId: string;
  readonly threadId: string;
  readonly state: 'lifecycle' | 'prepared';
  readonly purpose: TurnBoundaryPurpose;
  readonly owner: OwnerIdentity;
  readonly now: string;
}
export type TurnBoundaryCreateResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'busy' };

export interface TurnBoundaryTransitionCommand {
  readonly type: 'turnBoundary.transition';
  readonly boundaryId: string;
  readonly ownerId: string;
  readonly from: readonly TurnBoundaryState[];
  readonly to: 'invoking' | 'accepted' | 'indeterminate';
  readonly now: string;
  readonly providerTurnId?: string;
}
export type TurnBoundaryTransitionResult =
  | { readonly kind: 'applied' }
  /**
   * The provider turn id was already terminal on this thread, or another
   * accepted boundary holds it: the row was moved to `indeterminate`.
   */
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'stale' };

export interface TurnBoundaryRemoveCommand {
  readonly type: 'turnBoundary.remove';
  readonly boundaryId: string;
  readonly ownerId: string;
  readonly from: readonly TurnBoundaryState[];
  /** Remove only if the row still carries this `updatedAt`. */
  readonly ifUpdatedAt?: string;
  /** Remove only if the row's owner is dead; otherwise answer `busy`. */
  readonly onlyIfOwnerDead?: boolean;
}
export type TurnBoundaryRemoveResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'busy' };

export interface TurnBoundaryRecordAcceptedCommand {
  readonly type: 'turnBoundary.recordAccepted';
  readonly boundaryId: string;
  readonly threadId: string;
  readonly providerTurnId: string;
  readonly owner: OwnerIdentity;
  readonly now: string;
}

export interface TurnBoundaryObserveTerminalCommand {
  readonly type: 'turnBoundary.observeTerminal';
  readonly threadId: string;
  readonly providerTurnId?: string;
  /** A session-level terminal retires every turn row on the thread. */
  readonly sessionTerminal: boolean;
  readonly terminalCreatedAt: string;
  /** Identifies the host's persisted terminal, resolved inside the transaction. */
  readonly terminalEventId?: string;
  /**
   * `false` records the terminal fact without retiring any row (for a
   * terminal that must not close its boundary, such as a recovery's own
   * synthesized abort). Defaults to true.
   */
  readonly retire?: boolean;
}
export type TurnBoundaryAppliedResult = { readonly kind: 'applied' };

export interface TurnBoundaryHasPossibleEffectCommand {
  readonly type: 'turnBoundary.hasPossibleEffect';
  readonly threadId: string;
}
export type TurnBoundaryHasPossibleEffectResult = {
  readonly kind: 'available';
  readonly active: boolean;
};

export interface TurnBoundaryListCommand {
  readonly type: 'turnBoundary.list';
}
export type TurnBoundaryListResult = {
  readonly kind: 'records';
  readonly records: readonly TurnBoundaryRecord[];
};

/**
 * One liveness verdict, taken outside the transaction for the row as it was
 * listed. Inside, the verdict applies only if the row still has this exact
 * owner, `createdAt` and `updatedAt`; a row that moved on, or was recreated,
 * since is left alone.
 *
 * The kernel trusts these verdicts: a caller that builds the command by hand
 * instead of with `planTurnBoundaryReconcile` decides who is dead.
 */
export interface TurnBoundaryReconcileObservation {
  readonly boundaryId: string;
  /** The whole owner: id, pid, identity kind and birth. */
  readonly owner: OwnerIdentity;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verdict: OwnerLivenessVerdict;
}

/** Build it with `planTurnBoundaryReconcile`. */
export interface TurnBoundaryReconcileCommand {
  readonly type: 'turnBoundary.reconcile';
  readonly now: string;
  readonly observed: readonly TurnBoundaryReconcileObservation[];
}
export type TurnBoundaryReconcileResult = {
  readonly kind: 'reconciled';
  /**
   * Every row whose owner died while a turn may have been in flight:
   * `invoking` rows (now `indeterminate`), and `accepted` or `indeterminate`
   * rows (unchanged). The caller retires each once it has reported it.
   */
  readonly interrupted: readonly TurnBoundaryRecord[];
};

export interface TurnBoundaryForgetThreadCommand {
  readonly type: 'turnBoundary.forgetThread';
  readonly threadId: string;
}

// ---------------------------------------------------------------------------
// Request keys
// ---------------------------------------------------------------------------

export interface RequestKeyClaimCommand {
  readonly type: 'requestKeys.claim';
  readonly id: RequestKeyId;
  readonly digest: string;
  readonly now: number;
}
export type RequestKeyClaimResult =
  | { readonly kind: 'claimed' }
  /**
   * A stored attempt left no result: it may have had its effect. Re-drive it
   * with its recorded decision; never treat it as new.
   */
  | { readonly kind: 'unresolved'; readonly decision?: string }
  | { readonly kind: 'replay'; readonly result: string }
  /** The key names a different request. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'capacity'; readonly scope: 'caller' | 'store' };

export interface RequestKeyRecordDecisionCommand {
  readonly type: 'requestKeys.recordDecision';
  readonly id: RequestKeyId;
  readonly decision: string;
}
export interface RequestKeyCompleteCommand {
  readonly type: 'requestKeys.complete';
  readonly id: RequestKeyId;
  readonly result: string;
}
export type RequestKeyWriteResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'missing' };

export interface RequestKeyReleaseCommand {
  readonly type: 'requestKeys.release';
  readonly id: RequestKeyId;
}
export type RequestKeyReleaseResult =
  | { readonly kind: 'released' }
  /** The key already has a result; it stays for replays. */
  | { readonly kind: 'kept' }
  | { readonly kind: 'missing' };

// ---------------------------------------------------------------------------

export interface KernelResults {
  'turnDedup.claim': TurnDedupClaimResult;
  'turnDedup.beginInvocation': TurnDedupBeginInvocationResult;
  'turnDedup.resolve': TurnDedupSettleResult;
  'turnDedup.release': TurnDedupSettleResult;
  'turnDedup.read': TurnDedupReadResult;
  'turnDedup.forgetPrefix': TurnDedupForgetPrefixResult;
  'turnBoundary.create': TurnBoundaryCreateResult;
  'turnBoundary.transition': TurnBoundaryTransitionResult;
  'turnBoundary.remove': TurnBoundaryRemoveResult;
  'turnBoundary.recordAccepted': TurnBoundaryCreateResult;
  'turnBoundary.observeTerminal': TurnBoundaryAppliedResult;
  'turnBoundary.hasPossibleEffect': TurnBoundaryHasPossibleEffectResult;
  'turnBoundary.list': TurnBoundaryListResult;
  'turnBoundary.reconcile': TurnBoundaryReconcileResult;
  'turnBoundary.forgetThread': TurnBoundaryAppliedResult;
  'requestKeys.claim': RequestKeyClaimResult;
  'requestKeys.recordDecision': RequestKeyWriteResult;
  'requestKeys.complete': RequestKeyWriteResult;
  'requestKeys.release': RequestKeyReleaseResult;
}

export type KernelCommand =
  | TurnDedupClaimCommand
  | TurnDedupBeginInvocationCommand
  | TurnDedupResolveCommand
  | TurnDedupReleaseCommand
  | TurnDedupReadCommand
  | TurnDedupForgetPrefixCommand
  | TurnBoundaryCreateCommand
  | TurnBoundaryTransitionCommand
  | TurnBoundaryRemoveCommand
  | TurnBoundaryRecordAcceptedCommand
  | TurnBoundaryObserveTerminalCommand
  | TurnBoundaryHasPossibleEffectCommand
  | TurnBoundaryListCommand
  | TurnBoundaryReconcileCommand
  | TurnBoundaryForgetThreadCommand
  | RequestKeyClaimCommand
  | RequestKeyRecordDecisionCommand
  | RequestKeyCompleteCommand
  | RequestKeyReleaseCommand;

/** A participant refused the command before any write. Nothing changed. */
export interface ParticipantRefusal {
  readonly kind: 'refused';
  readonly participant: string;
  readonly reason: string;
}

export type KernelResult<C extends KernelCommand> =
  | KernelResults[C['type']]
  | ParticipantRefusal;
