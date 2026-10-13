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
