/** Durable, cross-process turn ownership. */
import { randomUUID } from 'node:crypto';
import {
  type KernelCommand,
  type KernelResult,
  type OwnerIdentity,
  type OwnerLiveness,
  ownerLivenessFromProbe,
  type ProcessIdentityProbe,
  turnClaimIsReclaimable,
} from '@kontourai/monument';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { ClientTurnInputConflictError } from '../providers/adapter-shape.js';
import { turnDedupClaims } from '../telemetry/metrics.js';

export interface TurnIdempotencyProcessIdentity {
  exact(pid: number): { pid: number; start: string } | null;
  probe: ProcessIdentityProbe;
}
const defaultProcessIdentity: TurnIdempotencyProcessIdentity = {
  exact: exactProcessIdentity,
  probe: probeExactProcessIdentity,
};

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

const preparedClaimCustody = new WeakMap<
  object,
  { key: string; owner: OwnerIdentity; createdAt: number }
>();

/** Internal host composition only; no token is attached to the public claim. */
export function readPreparedClaimCustody(claim: object) {
  return preparedClaimCustody.get(claim);
}

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
    preparedClaimCustody.set(claim, {
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
    processIdentity: TurnIdempotencyProcessIdentity = defaultProcessIdentity,
  ) {
    const identity = processIdentity.exact(process.pid);
    this.owner = identity
      ? {
          id: randomUUID(),
          pid: process.pid,
          identityKind: 'exact',
          birth: identity.start,
        }
      : { id: randomUUID(), pid: process.pid, identityKind: 'unverified' };
    // A claim may be RECLAIMED only when its owner cannot still be executing
    // it, and (#3559) only when that owner provably never began its effect.
    // Capacity pruning never asks: it evicts resolved rows only, so a live
    // unresolved turn is never a candidate however old it is.
    this.liveness = ownerLivenessFromProbe(processIdentity.probe);
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
        turnDedupClaims.add(1, {
          outcome: result.reclaimed ? 'reclaimed' : 'claimed',
        });
        return { claimed: true };
      case 'resolved':
        return { claimed: false, value: result.value };
      case 'contended':
        // A claim this owner retained after a possible effect stays
        // unresolved in the row, so the kernel calls it contended, but no
        // owner will ever resolve it. Answer it as {@link inspect} does, so a
        // same-key resend is refused at once instead of waiting it out.
        if (this.givenUp(key)) {
          turnDedupClaims.add(1, { outcome: 'indeterminate' });
          return { claimed: false, indeterminate: true };
        }
        turnDedupClaims.add(1, { outcome: 'contended' });
        return { claimed: false };
      case 'prepared':
      case 'indeterminate':
        turnDedupClaims.add(1, { outcome: 'indeterminate' });
        return { claimed: false, indeterminate: true };
      case 'expired':
        turnDedupClaims.add(1, { outcome: 'expired' });
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
      throw new ClientTurnInputConflictError();
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
      throw new ClientTurnInputConflictError();
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
