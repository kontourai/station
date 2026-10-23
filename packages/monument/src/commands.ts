import type { OwnerIdentity, OwnerLivenessVerdict } from './owner.js';
import type {
  InboxEntryKind,
  InboxEntryRecord,
  InvocationTerminalFact,
  PreparedDedupSnapshot,
  PreparedTurnIntent,
  PreparedTurnSettlement,
  RequestKeyId,
  TurnBoundaryPurpose,
  TurnBoundaryRecord,
  TurnBoundarySnapshot,
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
  readonly inputDigest?: string;
}
export type TurnDedupClaimResult =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'claimed'; readonly reclaimed: boolean }
  | { readonly kind: 'resolved'; readonly value: string }
  | { readonly kind: 'contended' }
  /** Retained input needs explicit guarded resume, never an ordinary claim. */
  | { readonly kind: 'prepared'; readonly invocationId: string }
  | {
      readonly kind: 'settled';
      readonly disposition: PreparedTurnSettlement['disposition'];
      readonly invocationId: string;
      readonly settlementId: string;
    }
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
  readonly state: 'lifecycle' | 'reserved' | 'prepared';
  readonly purpose: TurnBoundaryPurpose;
  readonly owner: OwnerIdentity;
  readonly now: string;
}
export type TurnBoundaryCreateResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'busy' };

export interface TurnBoundaryPrepareCommand {
  readonly type: 'turnBoundary.prepare';
  readonly boundaryId: string;
  readonly ownerId: string;
  readonly intent: PreparedTurnIntent;
  /** The linked claim's private token, independent of the boundary token. */
  readonly dedupOwnerId?: string;
  readonly now: string;
}
export type TurnBoundaryPrepareResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'stale' };

export interface TurnBoundaryBeginInvocationCommand {
  readonly type: 'turnBoundary.beginInvocation';
  readonly boundaryId: string;
  readonly ownerId: string;
  readonly intent: PreparedTurnIntent;
  readonly dedupOwnerId?: string;
  readonly now: string;
}
/** An applied retry acknowledges the same begin; it never authorizes a second effect. */
export type TurnBoundaryBeginInvocationResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'refused' };

export interface TurnBoundaryResumePreparedCommand {
  readonly type: 'turnBoundary.resumePrepared';
  readonly boundaryId: string;
  readonly intent: PreparedTurnIntent;
  readonly observed: Omit<TurnBoundaryReconcileObservation, 'boundaryId'>;
  readonly owner: OwnerIdentity;
  readonly dedup?: {
    readonly previousOwner: OwnerIdentity;
    readonly createdAt: number;
    readonly updatedAt: string;
    readonly owner: OwnerIdentity;
  };
  readonly now: string;
}
export type TurnBoundaryResumePreparedResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'refused' };

export interface PreparedSettlementInput {
  readonly boundaryId: string;
  readonly intent: PreparedTurnIntent;
  readonly boundary: TurnBoundarySnapshot;
  readonly dedup?: PreparedDedupSnapshot;
  readonly settlementId: string;
  readonly now: string;
}

/** Explicit host-authorized cancellation of a never-begun prepared intent. */
export interface TurnBoundaryCancelPreparedCommand
  extends PreparedSettlementInput {
  readonly type: 'turnBoundary.cancelPrepared';
}

/** The host asserts a definitive refusal; errors/timeouts alone never imply it. */
export interface TurnBoundaryRecordDefinitiveRefusalCommand
  extends PreparedSettlementInput {
  readonly type: 'turnBoundary.recordDefinitiveRefusal';
}

export type PreparedSettlementResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'refused' };

/** Latched owned acceptance; neither acknowledgement authorizes another effect. */
export interface TurnBoundaryAcceptInvocationCommand {
  readonly type: 'turnBoundary.acceptInvocation';
  readonly expected: TurnBoundaryRecord;
  readonly expectedDedup?: TurnDedupRecord;
  readonly providerTurnId: string;
  readonly now: string;
}
export type TurnBoundaryAcceptInvocationResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'terminal'; readonly terminal: InvocationTerminalFact }
  | { readonly kind: 'ambiguous' }
  | { readonly kind: 'stale' };

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
  readonly invocationId?: string;
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
  /**
   * Rows whose id starts with one of `boundaryIdPrefixes` AND whose state is
   * one of `states` are kept; the rest retire as usual. A session terminal
   * that ends some rows but not others: Station's own shutdown keeps a turn
   * that may have reached its engine for the next boot's recovery.
   */
  readonly retain?: {
    readonly boundaryIdPrefixes: readonly string[];
    readonly states: readonly TurnBoundaryState[];
  };
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
  /** Retained candidates, not permission to invoke; resume checks both fences. */
  readonly resumable: readonly TurnBoundaryRecord[];
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
// Inbox (station#3568)
// ---------------------------------------------------------------------------

/**
 * Accept one entry into an inbox, durable once this commits. Idempotent by
 * `key`: the same key with the same digest answers the entry already stored,
 * a different digest is a conflict and writes nothing.
 */
export interface InboxSubmitCommand {
  readonly type: 'inbox.submit';
  readonly inboxId: string;
  readonly key: string;
  readonly kind: InboxEntryKind;
  readonly digest: string;
  readonly payload: string;
  readonly now: number;
}
export type InboxSubmitResult =
  /**
   * Stored at the inbox's tail. `requeued` when the key's earlier entry had
   * been refused or cancelled, so nothing of it ran: it is queued again.
   */
  | {
      readonly kind: 'accepted';
      readonly entry: InboxEntryRecord;
      readonly requeued: boolean;
    }
  /** The same submission again: the entry as it stands now. */
  | { readonly kind: 'existing'; readonly entry: InboxEntryRecord }
  /** The key names a different input. Nothing was written. */
  | { readonly kind: 'conflict' }
  /** The inbox holds its limit of unsettled entries. Nothing was written. */
  | { readonly kind: 'capacity'; readonly limit: number };

/**
 * Take the inbox's head for placement, recording `placement` before the
 * effect. A head that kept the placement of an earlier attempt keeps it: the
 * host must use the entry's, not its own.
 */
export interface InboxClaimNextCommand {
  readonly type: 'inbox.claimNext';
  readonly inboxId: string;
  readonly placement: string;
  readonly now: number;
}
export type InboxClaimNextResult =
  | { readonly kind: 'claimed'; readonly entry: InboxEntryRecord }
  /** The head is already being placed (or was, before a crash). */
  | { readonly kind: 'in-flight'; readonly entry: InboxEntryRecord }
  /** The head is unconfirmed; nothing behind it is placed until it is cancelled. */
  | { readonly kind: 'blocked'; readonly entry: InboxEntryRecord }
  | { readonly kind: 'empty' };

/** Settle a `placing` entry with what its effect did. */
export interface InboxSettleCommand {
  readonly type: 'inbox.settle';
  readonly inboxId: string;
  readonly key: string;
  readonly to: 'placed' | 'unconfirmed' | 'refused';
  readonly outcome: string | null;
  readonly now: number;
}
export type InboxWriteResult =
  | { readonly kind: 'applied'; readonly entry: InboxEntryRecord }
  /** The entry is missing or not `placing`. Nothing was written. */
  | { readonly kind: 'stale' };

/**
 * Return a `placing` entry to the queue: its effect was refused before it
 * ran, for a reason that passes (the target was busy). `keepPlacement` keeps
 * the pinned target, for a refusal that cannot rule out an earlier attempt's
 * effect landing on it.
 */
export interface InboxReleaseCommand {
  readonly type: 'inbox.release';
  readonly inboxId: string;
  readonly key: string;
  readonly keepPlacement: boolean;
  readonly now: number;
}

/**
 * Resolve an `unconfirmed` entry once the host can prove what its effect did
 * (station#3568): `placed` when the effect is known to have happened, or back
 * to `queued` when it is known not to have (its placement cleared). Only an
 * `unconfirmed` entry moves; the host owns the proof.
 */
export interface InboxResolveUnconfirmedCommand {
  readonly type: 'inbox.resolveUnconfirmed';
  readonly inboxId: string;
  readonly key: string;
  readonly to: 'placed' | 'queued';
  readonly outcome: string | null;
  readonly now: number;
}

/**
 * Withdraw a queued entry, or dismiss an unconfirmed or refused one. A
 * `placing` entry cannot be withdrawn: its effect may be under way.
 */
export interface InboxCancelCommand {
  readonly type: 'inbox.cancel';
  readonly inboxId: string;
  readonly key: string;
  readonly now: number;
}
export type InboxCancelResult =
  | { readonly kind: 'cancelled'; readonly entry: InboxEntryRecord }
  | { readonly kind: 'in-flight'; readonly entry: InboxEntryRecord }
  | { readonly kind: 'placed'; readonly entry: InboxEntryRecord }
  | { readonly kind: 'missing' };

export interface InboxReadCommand {
  readonly type: 'inbox.read';
  readonly inboxId: string;
  readonly key: string;
}
export type InboxReadResult =
  | { readonly kind: 'found'; readonly entry: InboxEntryRecord }
  | { readonly kind: 'absent' };

/** Every retained entry of one inbox, in placement order. */
export interface InboxListCommand {
  readonly type: 'inbox.list';
  readonly inboxId: string;
}
/** Every `queued`, `placing` or `unconfirmed` entry of every inbox (recovery). */
export interface InboxListOpenCommand {
  readonly type: 'inbox.listOpen';
}
/** Forget every entry of one inbox, settled or not (its conversation is gone). */
export interface InboxForgetCommand {
  readonly type: 'inbox.forget';
  readonly inboxId: string;
}
export type InboxForgetResult = {
  readonly kind: 'applied';
  readonly removed: number;
};

export type InboxListResult = {
  readonly kind: 'entries';
  readonly entries: readonly InboxEntryRecord[];
};

// ---------------------------------------------------------------------------

export interface KernelResults {
  'turnDedup.claim': TurnDedupClaimResult;
  'turnDedup.beginInvocation': TurnDedupBeginInvocationResult;
  'turnDedup.resolve': TurnDedupSettleResult;
  'turnDedup.release': TurnDedupSettleResult;
  'turnDedup.read': TurnDedupReadResult;
  'turnDedup.forgetPrefix': TurnDedupForgetPrefixResult;
  'turnBoundary.create': TurnBoundaryCreateResult;
  'turnBoundary.prepare': TurnBoundaryPrepareResult;
  'turnBoundary.beginInvocation': TurnBoundaryBeginInvocationResult;
  'turnBoundary.resumePrepared': TurnBoundaryResumePreparedResult;
  'turnBoundary.cancelPrepared': PreparedSettlementResult;
  'turnBoundary.recordDefinitiveRefusal': PreparedSettlementResult;
  'turnBoundary.acceptInvocation': TurnBoundaryAcceptInvocationResult;
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
  'inbox.submit': InboxSubmitResult;
  'inbox.claimNext': InboxClaimNextResult;
  'inbox.settle': InboxWriteResult;
  'inbox.release': InboxWriteResult;
  'inbox.cancel': InboxCancelResult;
  'inbox.read': InboxReadResult;
  'inbox.list': InboxListResult;
  'inbox.listOpen': InboxListResult;
  'inbox.forget': InboxForgetResult;
  'inbox.resolveUnconfirmed': InboxWriteResult;
}

export type KernelCommand =
  | TurnDedupClaimCommand
  | TurnDedupBeginInvocationCommand
  | TurnDedupResolveCommand
  | TurnDedupReleaseCommand
  | TurnDedupReadCommand
  | TurnDedupForgetPrefixCommand
  | TurnBoundaryCreateCommand
  | TurnBoundaryPrepareCommand
  | TurnBoundaryBeginInvocationCommand
  | TurnBoundaryResumePreparedCommand
  | TurnBoundaryCancelPreparedCommand
  | TurnBoundaryRecordDefinitiveRefusalCommand
  | TurnBoundaryAcceptInvocationCommand
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
  | RequestKeyReleaseCommand
  | InboxSubmitCommand
  | InboxClaimNextCommand
  | InboxSettleCommand
  | InboxReleaseCommand
  | InboxCancelCommand
  | InboxReadCommand
  | InboxListCommand
  | InboxListOpenCommand
  | InboxForgetCommand
  | InboxResolveUnconfirmedCommand;

/** A participant refused the command before any write. Nothing changed. */
export interface ParticipantRefusal {
  readonly kind: 'refused';
  readonly participant: string;
  readonly reason: string;
}

/** Command/result map shared with the public atomic testing port. */
export type KernelAtomicProtocol = {
  readonly [K in KernelCommand['type']]: {
    readonly command: Extract<KernelCommand, { readonly type: K }>;
    readonly result: KernelResults[K] | ParticipantRefusal;
  };
};

export type KernelResult<C extends KernelCommand> =
  KernelAtomicProtocol[C['type']]['result'];
