import type { KernelCommand, KernelResult } from './commands.js';
import { turnClaimIsReclaimable } from './decisions/turn-dedup.js';
import {
  type OwnerIdentity,
  type OwnerLiveness,
  ownerFields,
} from './owner.js';

/** Host-owned identity, custody and observability dependencies. */
export interface TurnDedupHost {
  readonly owner: OwnerIdentity;
  readonly liveness: OwnerLiveness;
  readonly conflictError: () => Error;
  readonly bindPreparedClaim: (
    claim: object,
    custody: { key: string; owner: OwnerIdentity; createdAt: number },
  ) => void;
  readonly recordClaim?: (
    outcome:
      | 'claimed'
      | 'reclaimed'
      | 'contended'
      | 'indeterminate'
      | 'expired',
  ) => void;
}

/**
 * Where the claims live. Each call is one Monument command, run as one atomic
 * transaction: the rules for claiming, resolving and retaining a key belong to
 * `@kontourai/monument`, and this seam only says where its rows are kept.
 */
export interface TurnIdempotencyPersistence {
  execute<C extends KernelCommand>(
    command: C,
    liveness: OwnerLiveness,
  ): KernelResult<C>;
}

type TurnIdempotencyClaim =
  | {
      claimed: false;
      conflict: true;
      value?: undefined;
      indeterminate?: undefined;
      expired?: undefined;
    }
  | { claimed: true }
  | {
      claimed: false;
      conflict?: undefined;
      value?: string;
      indeterminate?: undefined;
      expired?: undefined;
    }
  /**
   * The owner is dead but may already have started the effect: never
   * reclaimed, never replayed, and never resolvable by this caller.
   */
  | {
      claimed: false;
      conflict?: undefined;
      indeterminate: true;
      value?: undefined;
      expired?: undefined;
    }
  /**
   * #3559: the key's resolved row was evicted. The effect ran, but its result
   * is gone; the key is never claimable again.
   */
  | {
      claimed: false;
      conflict?: undefined;
      expired: true;
      value?: undefined;
      indeterminate?: undefined;
    };

/**
 * How long an unresolved claim whose owner is not proven dead still reads as
 * in flight. A provider accepts a turn in seconds; past this, the owner is
 * treated as one that may have started the effect and stopped
 * (`indeterminate`), never as safe to resend.
 */
const TURN_CLAIM_UNPROVABLE_IN_FLIGHT_MS = 15 * 60 * 1000;
/** Bound on this owner's remembered abandoned claims (oldest dropped first). */
const TURN_CLAIM_RETAINED_MAX = 4096;

export class TurnIdempotencySettledError extends Error {
  readonly code = 'client_turn_settled';
  constructor(readonly disposition: 'cancelled' | 'definitively-refused') {
    super(
      `This turn was ${disposition === 'cancelled' ? 'cancelled' : 'definitively refused'}. A new request requires a new turn key.`,
    );
    this.name = 'TurnIdempotencySettledError';
  }
}

/** {@link TurnIdempotencyStore.inspect}'s answer; see there. */
export type TurnClaimInspection =
  | { state: 'absent' }
  | { state: 'resolved'; value: string }
  | { state: 'in-flight' }
  | { state: 'reclaimable' }
  /**
   * `ageOnly`: unresolved past the in-flight bound while its owner is alive
   * or unknown. Nothing proves it may have been sent, and a live owner may
   * still resolve it (#3660), so a resend may still join it; the delivery
   * lookup still answers it `indeterminate`. Without it: this owner gave the
   * key up after a possible effect, or a dead owner may have invoked.
   */
  | { state: 'indeterminate'; ageOnly?: true }
  | { state: 'expired' };

export class TurnIdempotencyStore {
  private readonly owner: OwnerIdentity;
  private readonly liveness: OwnerLiveness;
  /**
   * Keys this owner stopped working on with a possible effect: the provider
   * call failed after invocation began, so the claim stays unresolved (never
   * reclaimed or replayed) while this process lives. Process memory, because
   * the owner dying turns the same claim `indeterminate` durably.
   */
  private readonly retained = new Set<string>();

  bindPreparedClaim(key: string, claim: object): void {
    const read = this.persistence.execute(
      { type: 'turnDedup.read', key },
      this.liveness,
    );
    const owner = read.kind === 'found' ? read.record.owner : undefined;
    if (
      read.kind !== 'found' ||
      !owner ||
      owner.id !== this.owner.id ||
      owner.pid !== this.owner.pid ||
      owner.identityKind !== this.owner.identityKind ||
      (owner.identityKind === 'exact' &&
        (this.owner.identityKind !== 'exact' ||
          owner.birth !== this.owner.birth))
    )
      throw new Error('Prepared claim owner is unavailable.');
    this.options.bindPreparedClaim(claim, {
      key,
      owner: this.owner,
      createdAt: read.record.createdAt,
    });
  }
  composePreparedClaims<T>(
    compose: (binding: { owner: OwnerIdentity; liveness: OwnerLiveness }) => T,
  ): T {
    return compose({ owner: this.owner, liveness: this.liveness });
  }
  constructor(
    private readonly persistence: TurnIdempotencyPersistence,
    private readonly options: TurnDedupHost,
  ) {
    this.owner = ownerFields(options.owner);
    this.liveness = options.liveness;
  }
  /**
   * `tracking: 'tracked'` promises that this claimant calls
   * {@link beginInvocation} before its effect, which is what lets a later
   * claimant reclaim the key after this owner dies before that point.
   */
  claim(
    key: string,
    now = Date.now(),
    tracking: 'tracked' | 'untracked' = 'untracked',
    inputDigest?: string,
  ): TurnIdempotencyClaim {
    const result = this.persistence.execute(
      {
        type: 'turnDedup.claim',
        key,
        owner: this.owner,
        now,
        tracking,
        ...(inputDigest !== undefined ? { inputDigest } : {}),
      },
      this.liveness,
    );
    switch (result.kind) {
      case 'conflict':
        return { claimed: false, conflict: true };
      case 'claimed':
        // A fresh claim is a new attempt: a retained marker left from an
        // earlier row of this key (one its thread's deletion removed) must not
        // make the new, genuinely in-flight claim read as given up.
        this.retained.delete(key);
        this.options.recordClaim?.(result.reclaimed ? 'reclaimed' : 'claimed');
        return { claimed: true };
      case 'resolved':
        return { claimed: false, value: result.value };
      case 'contended':
        // A claim this owner retained after a possible effect stays
        // unresolved in the row, so the kernel calls it contended, but no
        // owner will ever resolve it. Answer it as {@link inspect} does, so a
        // same-key resend is refused at once instead of waiting it out.
        if (this.givenUp(key)) {
          this.options.recordClaim?.('indeterminate');
          return { claimed: false, indeterminate: true };
        }
        this.options.recordClaim?.('contended');
        return { claimed: false };
      case 'prepared':
      case 'indeterminate':
        this.options.recordClaim?.('indeterminate');
        return { claimed: false, indeterminate: true };
      case 'expired':
        this.options.recordClaim?.('expired');
        return { claimed: false, expired: true };
      case 'settled':
        throw new TurnIdempotencySettledError(result.disposition);
      case 'refused':
        throw new Error(
          `Turn claim refused by ${result.participant}: ${result.reason}`,
        );
    }
  }
  /**
   * #3559: durably records that this owner may now start its effect. Call it
   * before the effect and do not start the effect if it throws. Idempotent
   * for the owner; refuses any claim this store does not own as `pending`.
   */
  beginInvocation(key: string): void {
    const result = this.persistence.execute(
      {
        type: 'turnDedup.beginInvocation',
        key,
        ownerId: this.owner.id,
        now: Date.now(),
      },
      this.liveness,
    );
    if (result.kind !== 'applied')
      throw new Error(
        'Turn claim is not owned and pending; its invocation cannot begin.',
      );
  }
  resolve(key: string, value: string): void {
    this.persistence.execute(
      {
        type: 'turnDedup.resolve',
        key,
        ownerId: this.owner.id,
        value,
        now: Date.now(),
      },
      this.liveness,
    );
  }
  release(key: string): void {
    this.persistence.execute(
      {
        type: 'turnDedup.release',
        key,
        ownerId: this.owner.id,
        now: Date.now(),
      },
      this.liveness,
    );
  }
  /**
   * Read-only: what a claim of `key` would meet, decided by the same rules
   * {@link claim} applies, without writing anything (no claim, no reclaim, no
   * retention pass). `in-flight` is an unresolved claim whose owner is live or
   * cannot be proven dead; `reclaimable` is one whose owner died before it
   * began its effect, which the next claim of the key takes over.
   */
  inspect(
    key: string,
    now = Date.now(),
    inputDigest?: string,
  ): TurnClaimInspection {
    const result = this.persistence.execute(
      { type: 'turnDedup.read', key },
      this.liveness,
    );
    if (result.kind === 'absent') return { state: 'absent' };
    if (result.kind === 'expired') return { state: 'expired' };
    if (result.kind === 'refused')
      throw new Error(
        `Turn claim read refused by ${result.participant}: ${result.reason}`,
      );
    const record = result.record;
    if (record.settlement)
      throw new TurnIdempotencySettledError(record.settlement.disposition);
    if (
      inputDigest !== undefined &&
      record.inputDigest !== undefined &&
      inputDigest !== record.inputDigest
    )
      throw this.options.conflictError();
    if (record.value !== null)
      return { state: 'resolved', value: record.value };
    if (record.owner?.id === this.owner.id && this.retained.has(key))
      return { state: 'indeterminate' };
    const liveness = record.owner ? this.liveness(record.owner) : 'unknown';
    if (liveness === 'dead')
      return turnClaimIsReclaimable(record)
        ? { state: 'reclaimable' }
        : { state: 'indeterminate' };
    // A provider accepts a turn in seconds: an unresolved claim this old is
    // not a send in flight, whoever owns it (and an abandoned claim the
    // bounded `retained` memory has forgotten still lands here).
    if (now - record.createdAt > TURN_CLAIM_UNPROVABLE_IN_FLIGHT_MS)
      return { state: 'indeterminate', ageOnly: true };
    return { state: 'in-flight' };
  }
  /**
   * Records that this owner abandoned its unresolved claim of `key` after it
   * may have started the effect. Writes nothing durable: the claim stays
   * exactly as it is; only this owner's {@link inspect} and {@link claim}
   * answer it `indeterminate` instead of `in-flight` and `contended`.
   */
  retain(key: string): void {
    this.retained.delete(key);
    this.retained.add(key);
    if (this.retained.size > TURN_CLAIM_RETAINED_MAX) {
      const oldest = this.retained.values().next().value;
      if (oldest !== undefined) this.retained.delete(oldest);
    }
  }
  /**
   * Whether this owner retained its still-unresolved claim of `key` after a
   * possible effect, so no owner will ever resolve it: the row is unresolved,
   * owned by this owner, and marked retained. Never true for another owner's
   * claim, however old, and it probes no process.
   */
  givenUp(key: string): boolean {
    if (!this.retained.has(key)) return false;
    const result = this.persistence.execute(
      { type: 'turnDedup.read', key },
      this.liveness,
    );
    if (result.kind === 'refused')
      throw new Error(
        `Turn claim read refused by ${result.participant}: ${result.reason}`,
      );
    return (
      result.kind === 'found' &&
      result.record.value === null &&
      result.record.owner?.id === this.owner.id
    );
  }
  /** Whether any row (pending or resolved) still holds the key. */
  held(key: string): boolean {
    return (
      this.persistence.execute({ type: 'turnDedup.read', key }, this.liveness)
        .kind === 'found'
    );
  }
  read(key: string, inputDigest?: string): string | undefined {
    const result = this.persistence.execute(
      { type: 'turnDedup.read', key },
      this.liveness,
    );
    if (
      result.kind === 'found' &&
      inputDigest !== undefined &&
      result.record.inputDigest !== undefined &&
      inputDigest !== result.record.inputDigest
    )
      throw this.options.conflictError();
    return result.kind === 'found'
      ? (result.record.value ?? undefined)
      : undefined;
  }
}
export async function awaitTurnResolution(
  store: TurnIdempotencyStore,
  key: string,
  timeoutMs = 5 * 60_000,
  intervalMs = 200,
  inputDigest?: string,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resolved = store.read(key, inputDigest);
    if (resolved) return resolved;
    // Released without a result (its owner refused before any effect):
    // nothing will resolve it, so stop waiting rather than run out the clock.
    if (!store.held(key)) return undefined;
    // Given up by its owner in this process after a possible effect: it will
    // never resolve either. The caller tells this apart with `givenUp`.
    if (store.givenUp(key)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return store.read(key, inputDigest);
}

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
