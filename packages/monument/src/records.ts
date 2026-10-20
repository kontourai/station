import type { OwnerIdentity } from './owner.js';

/**
 * How far an unresolved dedup claim's owner got toward its external effect
 * (station#3559).
 *
 * - `pending`: the claimant records invocation and has not begun it, so the
 *   effect provably has not run.
 * - `begun`: the claimant durably recorded, before calling out, that the
 *   effect may have started.
 * - `untracked`: the claimant records no invocation boundary. A dead owner's
 *   untracked claim keeps the older reclaim rule.
 *
 * Absent means unknown, and a dead owner's unknown claim is never reclaimed.
 * Adapters decode any value other than these three as absent.
 */
export type TurnClaimInvocation = 'pending' | 'begun' | 'untracked';

export interface TurnDedupRecord {
  readonly key: string;
  /** The resolved value (a provider turn id), or null while unresolved. */
  readonly value: string | null;
  readonly createdAt: number;
  readonly owner?: OwnerIdentity;
  readonly invocation?: TurnClaimInvocation;
  /** Versioned submission digest; absent means the original input is unknown. */
  readonly inputDigest?: string;
}

export type TurnBoundaryState =
  | 'lifecycle'
  | 'prepared'
  | 'invoking'
  | 'accepted'
  | 'indeterminate';

export type TurnBoundaryPurpose = 'turn' | 'task-dispatch';

export interface TurnBoundaryRecord {
  readonly boundaryId: string;
  readonly threadId: string;
  readonly state: TurnBoundaryState;
  readonly purpose: TurnBoundaryPurpose;
  readonly providerTurnId?: string;
  readonly owner: OwnerIdentity;
  /** ISO-8601 timestamps, compared as strings like the store compares them. */
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Host event-sequence fence; absent/NULL rows retain timestamp ordering. */
  readonly createdSequence?: number | null;
}

export interface RequestKeyId {
  readonly callerSessionId: string;
  readonly tool: string;
  readonly key: string;
}

export interface RequestKeyRecord {
  readonly id: RequestKeyId;
  readonly digest: string;
  /** What the attempt decided to do, recorded before doing it. */
  readonly decision: string | null;
  /** The serialized final result; null while unresolved. */
  readonly result: string | null;
  readonly createdAt: number;
}

/** The inbox's entry kinds. Steer and display-only entries come later. */
export type InboxEntryKind = 'follow-up';

/**
 * Where one inbox entry stands (station#3568).
 *
 * - `queued`: accepted and waiting for its turn boundary.
 * - `placing`: the host recorded its placement and may have started the
 *   effect. Never placed afresh: the host re-drives it under the same key, and
 *   the effect's own idempotency decides what happened.
 * - `placed`: the effect is known to have happened.
 * - `unconfirmed`: the effect may have happened and nothing can prove which
 *   way. Surfaced, never placed again, and later entries wait behind it until
 *   it is cancelled.
 * - `refused`: the effect was refused before it ran. Nothing happened.
 * - `cancelled`: withdrawn before it was placed, or an unconfirmed or refused
 *   entry dismissed.
 */
export type InboxEntryState =
  | 'queued'
  | 'placing'
  | 'placed'
  | 'unconfirmed'
  | 'refused'
  | 'cancelled';

export interface InboxEntryRecord {
  /** The queue this entry belongs to (for a host, one conversation). */
  readonly inboxId: string;
  /** The submission's idempotency key, unique within the inbox. */
  readonly key: string;
  /** FIFO order within the inbox; a larger sequence is placed later. */
  readonly sequence: number;
  readonly kind: InboxEntryKind;
  /** The host's digest of the input; a reused key must match it. */
  readonly digest: string;
  /** The host's input, opaque to the kernel. */
  readonly payload: string;
  readonly state: InboxEntryState;
  /** The placement the host recorded before its effect (its pinned target). */
  readonly placement: string | null;
  /** The host's settlement detail (a turn id, a refusal reason). */
  readonly outcome: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
