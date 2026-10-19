import type {
  TurnDedupBeginInvocationCommand,
  TurnDedupBeginInvocationResult,
  TurnDedupClaimCommand,
  TurnDedupClaimResult,
  TurnDedupReleaseCommand,
  TurnDedupResolveCommand,
  TurnDedupSettleResult,
} from '../commands.js';
import { type OwnerLiveness, ownerFields } from '../owner.js';
import type { TurnDedupRecord } from '../records.js';

/**
 * A decision names the one write it wants (`put`, `delete`, or none) and the
 * answer. It reads nothing but its arguments, and is the whole rule: the
 * transaction step around it only fetches, applies and prunes.
 */
export type TurnDedupWrite =
  | { readonly kind: 'none' }
  | { readonly kind: 'put'; readonly record: TurnDedupRecord }
  | { readonly kind: 'delete' };

export interface TurnDedupDecision<Result> {
  readonly write: TurnDedupWrite;
  readonly result: Result;
}

const NO_WRITE: TurnDedupWrite = Object.freeze({ kind: 'none' });

/**
 * station#3559: a dead owner's claim may be taken over only when that owner
 * provably never began its effect. `begun` and unknown (absent) are not
 * reclaimable.
 */
export function turnClaimIsReclaimable(record: TurnDedupRecord): boolean {
  return record.invocation === 'pending' || record.invocation === 'untracked';
}

/**
 * `tombstoned` says the key's resolved row was evicted by retention. It is
 * consulted only when no row exists: a row always answers for itself.
 */
export function decideTurnDedupClaim(
  current: TurnDedupRecord | undefined,
  command: TurnDedupClaimCommand,
  liveness: OwnerLiveness,
  tombstoned = false,
): TurnDedupDecision<TurnDedupClaimResult> {
  const owned: TurnDedupRecord = {
    key: command.key,
    value: null,
    createdAt: command.now,
    owner: ownerFields(command.owner),
    invocation: command.tracking === 'tracked' ? 'pending' : 'untracked',
    ...(command.inputDigest !== undefined
      ? { inputDigest: command.inputDigest }
      : {}),
  };
  if (!current) {
    // The effect ran and its result is gone: never claim the key afresh.
    if (tombstoned) return { write: NO_WRITE, result: { kind: 'expired' } };
    return {
      write: { kind: 'put', record: owned },
      result: { kind: 'claimed', reclaimed: false },
    };
  }
  if (
    current.inputDigest !== undefined &&
    command.inputDigest !== undefined &&
    current.inputDigest !== command.inputDigest
  )
    return { write: NO_WRITE, result: { kind: 'conflict' } };
  if (current.value !== null)
    return {
      write: NO_WRITE,
      result: { kind: 'resolved', value: current.value },
    };
  // Liveness is consulted only for an unresolved claim with an owner, and
  // only `dead` frees it: `unknown` must not.
  if (current.owner && liveness(current.owner) === 'dead') {
    if (!turnClaimIsReclaimable(current))
      return { write: NO_WRITE, result: { kind: 'indeterminate' } };
    return {
      write: {
        kind: 'put',
        record: {
          key: owned.key,
          value: owned.value,
          createdAt: owned.createdAt,
          owner: owned.owner,
          invocation: owned.invocation,
          ...(current.inputDigest !== undefined
            ? { inputDigest: current.inputDigest }
            : {}),
        },
      },
      result: { kind: 'claimed', reclaimed: true },
    };
  }
  return { write: NO_WRITE, result: { kind: 'contended' } };
}

function ownsUnresolved(
  current: TurnDedupRecord | undefined,
  ownerId: string,
): current is TurnDedupRecord {
  return (
    current !== undefined &&
    current.value === null &&
    current.owner?.id === ownerId
  );
}

/**
 * Durably record that the owner may now start its effect. Idempotent for the
 * owner; refuses anything that is not the owner's `pending` or `begun` claim.
 */
export function decideTurnDedupBeginInvocation(
  current: TurnDedupRecord | undefined,
  command: TurnDedupBeginInvocationCommand,
): TurnDedupDecision<TurnDedupBeginInvocationResult> {
  if (
    !ownsUnresolved(current, command.ownerId) ||
    (current.invocation !== 'pending' && current.invocation !== 'begun')
  )
    return { write: NO_WRITE, result: { kind: 'refused' } };
  return {
    write: { kind: 'put', record: { ...current, invocation: 'begun' } },
    result: { kind: 'applied' },
  };
}

export function decideTurnDedupResolve(
  current: TurnDedupRecord | undefined,
  command: TurnDedupResolveCommand,
): TurnDedupDecision<TurnDedupSettleResult> {
  // A retry after a lost acknowledgement finds its own value already there.
  if (current?.owner?.id === command.ownerId && current.value === command.value)
    return { write: NO_WRITE, result: { kind: 'applied' } };
  if (!ownsUnresolved(current, command.ownerId))
    return { write: NO_WRITE, result: { kind: 'stale' } };
  return {
    write: { kind: 'put', record: { ...current, value: command.value } },
    result: { kind: 'applied' },
  };
}

export function decideTurnDedupRelease(
  current: TurnDedupRecord | undefined,
  command: TurnDedupReleaseCommand,
): TurnDedupDecision<TurnDedupSettleResult> {
  if (!ownsUnresolved(current, command.ownerId))
    return { write: NO_WRITE, result: { kind: 'stale' } };
  return { write: { kind: 'delete' }, result: { kind: 'applied' } };
}
