import type { RequestKeyClaimResult } from '../commands.js';
import type { KernelLimits } from '../port.js';
import type { RequestKeyRecord } from '../records.js';

/**
 * The request-key rule (station#3160):
 *
 * - the same key with the same digest returns the stored result;
 * - the same key with a different digest is a conflict;
 * - a stored claim with no result may have had its effect, so it is never
 *   answered as new: it is `unresolved`, carrying its recorded decision.
 *
 * Capacity: a caller over its quota first evicts ITS OWN oldest completed
 * rows; if every remaining row of that caller is unresolved, the caller is
 * refused. A store-wide backstop refuses rather than evicting another
 * caller's row.
 *
 * The inputs are counted after the TTL purge, which the transaction step runs
 * first on every claim. A row holds a quota slot if it has a result, or if it
 * is unresolved and no older than the TTL; the purge forgets only completed
 * rows, so an unresolved row past the TTL is kept but never counted.
 */
export interface RequestKeyClaimInputs {
  readonly existing: RequestKeyRecord | undefined;
  readonly digest: string;
  readonly callerRows: number;
  readonly callerCompletedRows: number;
  readonly allRows: number;
  readonly limits: Pick<
    KernelLimits,
    'requestKeyMaxRowsPerCaller' | 'requestKeyMaxRows'
  >;
}

export interface RequestKeyClaimDecision {
  /** How many of the caller's oldest completed rows to evict first. */
  readonly evict: number;
  readonly insert: boolean;
  readonly result: RequestKeyClaimResult;
}

export function decideRequestKeyClaim(
  inputs: RequestKeyClaimInputs,
): RequestKeyClaimDecision {
  const { existing } = inputs;
  if (existing) {
    if (existing.digest !== inputs.digest)
      return { evict: 0, insert: false, result: { kind: 'conflict' } };
    if (existing.result !== null)
      return {
        evict: 0,
        insert: false,
        result: { kind: 'replay', result: existing.result },
      };
    return {
      evict: 0,
      insert: false,
      result: {
        kind: 'unresolved',
        ...(existing.decision !== null ? { decision: existing.decision } : {}),
      },
    };
  }
  const cap = inputs.limits.requestKeyMaxRowsPerCaller;
  const excess = inputs.callerRows - cap + 1;
  const evict = excess > 0 ? excess : 0;
  if (evict > 0) {
    const left =
      inputs.callerRows - Math.min(evict, inputs.callerCompletedRows);
    if (left >= cap)
      return {
        evict,
        insert: false,
        result: { kind: 'capacity', scope: 'caller' },
      };
  }
  const allAfterEviction =
    inputs.allRows - Math.min(evict, inputs.callerCompletedRows);
  if (allAfterEviction >= inputs.limits.requestKeyMaxRows)
    return {
      evict,
      insert: false,
      result: { kind: 'capacity', scope: 'store' },
    };
  return { evict, insert: true, result: { kind: 'claimed' } };
}
