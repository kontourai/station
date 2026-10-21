import {
  awaitTurnResolution,
  type TurnClaimInspection,
  type TurnIdempotencyStore,
} from '../turn-idempotency.js';

/**
 * Owns exactly one client turn per (threadId, clientTurnId). Claims are
 * idempotent per pair: known input digest mismatches conflict before any
 * replay or reclaim. Legacy input stays unknown. An unresolved claim is contended, a resolved claim is
 * replayable, and only the winning claim's opaque handle may resolve or
 * release it. SQLite updates are
 * atomic and persist across process restart; release returns the pair to the
 * unclaimed state so a failed or aborted request may retry.
 *
 * #3559: a claim whose owner process died is taken over only if that owner
 * never called `beginInvocation`. Otherwise the provider may already have the
 * turn, so the claim answers `indeterminate` and is never replayed. A key
 * whose resolved row retention evicted answers `expired`, never a new claim.
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
  /**
   * Gives up an owned claim that may have reached the provider: it stays
   * unresolved and is never released, and both the delivery lookup and a
   * same-key claim in this process answer it `indeterminate` rather than in
   * flight or contended. Settles the handle.
   */
  retain(): void;
}

export interface TurnDeduplicator {
  claim(input: {
    threadId: string;
    clientTurnId: string;
    inputDigest?: string;
  }):
    | { kind: 'conflict' }
    | { kind: 'owner'; claim: TurnClaim }
    | { kind: 'contended'; turnId?: string }
    /**
     * The owner may have invoked the provider and will never resolve the
     * claim: it died, or (in this process) retained it. Never send this turn.
     */
    | { kind: 'indeterminate' }
    /**
     * #3559: the key's resolved row was evicted. The turn was sent, and its
     * id can no longer be replayed. Never send this turn again.
     */
    | { kind: 'expired' };
  /**
   * Waits (bounded) for the pair's turn id. Returns nothing early when the
   * claim is released, or when its owner in this process retained it after a
   * possible effect; {@link givenUp} tells the two apart.
   */
  awaitResolution(input: {
    threadId: string;
    clientTurnId: string;
    inputDigest?: string;
    timeoutMs?: number;
    intervalMs?: number;
  }): Promise<string | undefined>;
  /**
   * Whether this process's own owner retained the pair's unresolved claim
   * after a possible effect, so nothing will ever resolve it. False for any
   * other process's claim, however old.
   */
  givenUp(input: { threadId: string; clientTurnId: string }): boolean;
  /**
   * Read-only: what {@link claim} would meet for this pair, without claiming,
   * reclaiming or touching retention. A supplied digest throws the typed input
   * conflict only when the row retains different original proof. For the delivery lookup a client uses
   * to decide whether resending the same key is safe.
   */
  inspect(input: {
    threadId: string;
    clientTurnId: string;
    inputDigest?: string;
  }): TurnClaimInspection;
}

/** Host-only factory; activate this capability only after guarded transfer succeeds. */
export function createPreparedTurnClaim(
  store: TurnIdempotencyStore,
  key: string,
): TurnClaim {
  let settled = false;
  let intent:
    | { kind: 'resolve'; turnId: string }
    | { kind: 'release' }
    | undefined;
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
  const owned: TurnClaim = {
    beginInvocation: () => {
      if (settled) throw new Error('Turn claim has already settled.');
      store.beginInvocation(key);
    },
    resolve: (turnId) =>
      settle({ kind: 'resolve', turnId }, () => store.resolve(key, turnId)),
    release: () => settle({ kind: 'release' }, () => store.release(key)),
    retain: () => {
      if (settled) throw new Error('Turn claim has already settled.');
      settled = true;
      store.retain(key);
    },
  };
  store.bindPreparedClaim(key, owned);
  return owned;
}

export function createTurnDeduplicator(options: {
  store: TurnIdempotencyStore;
  keyFor: (threadId: string, clientTurnId: string) => string;
}): TurnDeduplicator {
  return {
    claim: ({ threadId, clientTurnId, inputDigest }) => {
      const claim = options.store.claim(
        options.keyFor(threadId, clientTurnId),
        Date.now(),
        'tracked',
        inputDigest,
      );
      if (!claim.claimed) {
        if (claim.conflict) return { kind: 'conflict' };
        if (claim.indeterminate) return { kind: 'indeterminate' };
        if (claim.expired) return { kind: 'expired' };
        return { kind: 'contended', turnId: claim.value };
      }
      return {
        kind: 'owner',
        claim: createPreparedTurnClaim(
          options.store,
          options.keyFor(threadId, clientTurnId),
        ),
      };
    },
    givenUp: ({ threadId, clientTurnId }) =>
      options.store.givenUp(options.keyFor(threadId, clientTurnId)),
    inspect: ({ threadId, clientTurnId, inputDigest }) =>
      options.store.inspect(
        options.keyFor(threadId, clientTurnId),
        Date.now(),
        inputDigest,
      ),
    awaitResolution: ({
      threadId,
      clientTurnId,
      timeoutMs,
      intervalMs,
      inputDigest,
    }) =>
      awaitTurnResolution(
        options.store,
        options.keyFor(threadId, clientTurnId),
        timeoutMs,
        intervalMs,
        inputDigest,
      ),
  };
}
