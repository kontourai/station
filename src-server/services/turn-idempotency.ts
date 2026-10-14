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
  | { claimed: true }
  | {
      claimed: false;
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
      expired: true;
      value?: undefined;
      indeterminate?: undefined;
    };

/**
 * How long an unresolved claim whose owner's liveness cannot be proven either
 * way still reads as in flight. A provider accepts a turn in seconds; past
 * this, an owner nobody can see is treated as one that may have started the
 * effect and stopped (`indeterminate`), never as safe to resend.
 */
export const TURN_CLAIM_UNPROVABLE_IN_FLIGHT_MS = 15 * 60 * 1000;
/** Bound on this owner's remembered abandoned claims (oldest dropped first). */
export const TURN_CLAIM_RETAINED_MAX = 4096;

/** {@link TurnIdempotencyStore.inspect}'s answer; see there. */
export type TurnClaimInspection =
  | { state: 'absent' }
  | { state: 'resolved'; value: string }
  | { state: 'in-flight' }
  | { state: 'reclaimable' }
  | { state: 'indeterminate' }
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
  ): TurnIdempotencyClaim {
    const result = this.persistence.execute(
      { type: 'turnDedup.claim', key, owner: this.owner, now, tracking },
      this.liveness,
    );
    switch (result.kind) {
      case 'claimed':
        turnDedupClaims.add(1, {
          outcome: result.reclaimed ? 'reclaimed' : 'claimed',
        });
        return { claimed: true };
      case 'resolved':
        return { claimed: false, value: result.value };
      case 'contended':
        turnDedupClaims.add(1, { outcome: 'contended' });
        return { claimed: false };
      case 'indeterminate':
        turnDedupClaims.add(1, { outcome: 'indeterminate' });
        return { claimed: false, indeterminate: true };
      case 'expired':
        turnDedupClaims.add(1, { outcome: 'expired' });
        return { claimed: false, expired: true };
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
  inspect(key: string, now = Date.now()): TurnClaimInspection {
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
    if (record.value !== null)
      return { state: 'resolved', value: record.value };
    if (record.owner?.id === this.owner.id && this.retained.has(key))
      return { state: 'indeterminate' };
    const liveness = record.owner ? this.liveness(record.owner) : 'unknown';
    if (liveness === 'dead')
      return turnClaimIsReclaimable(record)
        ? { state: 'reclaimable' }
        : { state: 'indeterminate' };
    if (
      liveness === 'unknown' &&
      now - record.createdAt > TURN_CLAIM_UNPROVABLE_IN_FLIGHT_MS
    )
      return { state: 'indeterminate' };
    return { state: 'in-flight' };
  }
  /**
   * Records that this owner abandoned its unresolved claim of `key` after it
   * may have started the effect. Writes nothing durable: the claim stays
   * exactly as it is; only {@link inspect} answers it `indeterminate` instead
   * of `in-flight`.
   */
  retain(key: string): void {
    this.retained.delete(key);
    this.retained.add(key);
    if (this.retained.size > TURN_CLAIM_RETAINED_MAX) {
      const oldest = this.retained.values().next().value;
      if (oldest !== undefined) this.retained.delete(oldest);
    }
  }
  read(key: string): string | undefined {
    const result = this.persistence.execute(
      { type: 'turnDedup.read', key },
      this.liveness,
    );
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
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const resolved = store.read(key);
    if (resolved) return resolved;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return store.read(key);
}
