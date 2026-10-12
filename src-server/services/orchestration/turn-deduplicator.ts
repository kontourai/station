import {
  awaitTurnResolution,
  type TurnIdempotencyStore,
} from '../turn-idempotency.js';

/**
 * Owns exactly one client turn per (threadId, clientTurnId). Claims are
 * idempotent per pair: an unresolved claim is contended, a resolved claim is
 * replayable, and only the winning claim's opaque handle may resolve or
 * release it. SQLite updates are
 * atomic and persist across process restart; release returns the pair to the
 * unclaimed state so a failed or aborted request may retry.
 *
 * #3559: a claim whose owner process died is taken over only if that owner
 * never called `beginInvocation`. Otherwise the provider may already have the
 * turn, so the claim answers `indeterminate` and is never replayed.
 */
export interface TurnClaim {
  /**
   * Durably records that the provider may now receive this turn. Call it
   * before invoking the provider and do not invoke if it throws. Once it has
   * returned, a crash of this process can no longer make the turn claimable.
   */
  beginInvocation(): void;
  /**
   * Permanently records the provider turn for this owned claim. May throw on
   * durable failure; retry only this exact turnId on the same handle. After a
   * successful settlement, both transition methods reject.
   */
  resolve(turnId: string): void;
  /**
   * Returns an unresolved owned claim to the retryable state. May throw on
   * durable failure; retry only release on the same handle. After a successful
   * settlement, both transition methods reject.
   */
  release(): void;
}

export interface TurnDeduplicator {
  claim(input: { threadId: string; clientTurnId: string }):
    | { kind: 'owner'; claim: TurnClaim }
    | { kind: 'contended'; turnId?: string }
    /** The dead owner may have invoked the provider. Never send this turn. */
    | { kind: 'indeterminate' };
  awaitResolution(input: {
    threadId: string;
    clientTurnId: string;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<string | undefined>;
}

export function createTurnDeduplicator(options: {
  store: TurnIdempotencyStore;
  keyFor: (threadId: string, clientTurnId: string) => string;
}): TurnDeduplicator {
  return {
    claim: ({ threadId, clientTurnId }) => {
      const claim = options.store.claim(
        options.keyFor(threadId, clientTurnId),
        Date.now(),
        'tracked',
      );
      if (!claim.claimed)
        return claim.indeterminate
          ? { kind: 'indeterminate' }
          : { kind: 'contended', turnId: claim.value };
      let settled = false;
      let intent:
        | { kind: 'resolve'; turnId: string }
        | { kind: 'release' }
        | undefined;
      const key = options.keyFor(threadId, clientTurnId);
      const settle = (
        nextIntent: { kind: 'resolve'; turnId: string } | { kind: 'release' },
        operation: () => void,
      ) => {
        if (settled) throw new Error('Turn claim has already settled.');
        if (
          intent &&
          (intent.kind !== nextIntent.kind ||
            (intent.kind === 'resolve' &&
              nextIntent.kind === 'resolve' &&
              intent.turnId !== nextIntent.turnId))
        )
          throw new Error('Turn claim settlement intent cannot change.');
        intent = nextIntent;
        operation();
        // A SQLite transaction can throw after rollback. Preserve this owner
        // handle in that case so the caller can safely retry its transition.
        settled = true;
      };
      return {
        kind: 'owner',
        claim: {
          beginInvocation: () => {
            if (settled) throw new Error('Turn claim has already settled.');
            options.store.beginInvocation(key);
          },
          resolve: (turnId) =>
            settle({ kind: 'resolve', turnId }, () =>
              options.store.resolve(key, turnId),
            ),
          release: () =>
            settle({ kind: 'release' }, () => options.store.release(key)),
        },
      };
    },
    awaitResolution: ({ threadId, clientTurnId, timeoutMs, intervalMs }) =>
      awaitTurnResolution(
        options.store,
        options.keyFor(threadId, clientTurnId),
        timeoutMs,
        intervalMs,
      ),
  };
}
