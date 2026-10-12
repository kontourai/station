/** Durable, cross-process turn ownership. */
import { randomUUID } from 'node:crypto';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { turnDedupClaims } from '../telemetry/metrics.js';

export type TurnClaimOwner =
  | { pid: number; birth: string; token: string; identityKind: 'exact' }
  | { pid: number; token: string; identityKind: 'unverified' };
export type ProcessIdentityProbe = (
  pid: number,
) =>
  | { state: 'dead' }
  | { state: 'unavailable' }
  | { state: 'exact'; identity: { pid: number; start: string } };
export interface TurnIdempotencyProcessIdentity {
  exact(pid: number): { pid: number; start: string } | null;
  probe: ProcessIdentityProbe;
}
const defaultProcessIdentity: TurnIdempotencyProcessIdentity = {
  exact: exactProcessIdentity,
  probe: probeExactProcessIdentity,
};
/**
 * #3559: how far an unresolved claim's owner got toward its external effect.
 *
 * - `pending`: the claimant records invocation and has not begun it, so the
 *   effect provably has not run.
 * - `begun`: the claimant durably recorded, before calling out, that the
 *   effect may have started.
 * - `untracked`: the claimant records no invocation boundary (the `/chat`
 *   facade). Its dead-owner claims keep the pre-#3559 reclaim rule.
 *
 * Absent means unknown: a thread row written before #3559, or one whose owner
 * was replaced by a writer that does not record invocation (an older peer or
 * a downgraded runtime). Nothing proves such an owner never invoked, so a dead
 * owner's unknown row is never reclaimed. The persistence keeps this value
 * bound to the owner it describes, and reads an unmarked `/chat` row as
 * `untracked`, since only the `/chat` facade writes those.
 */
export type TurnClaimInvocation = 'pending' | 'begun' | 'untracked';
export interface TurnIdempotencyRecord {
  value: string | null;
  createdAt: number;
  owner?: TurnClaimOwner;
  invocation?: TurnClaimInvocation;
}
export interface TurnIdempotencyPersistence {
  read(key: string): TurnIdempotencyRecord | undefined;
  /** One serializable read-decide-write transaction. */
  update<T>(
    key: string,
    updater: (current: TurnIdempotencyRecord | undefined) => {
      record?: TurnIdempotencyRecord;
      result: T;
    },
  ): T;
}
type TurnIdempotencyClaim =
  | { claimed: true }
  | { claimed: false; value?: string; indeterminate?: undefined }
  /**
   * The owner is dead but may already have started the effect: never
   * reclaimed, never replayed, and never resolvable by this caller.
   */
  | { claimed: false; indeterminate: true; value?: undefined };

/**
 * A claim may be RECLAIMED only when its owner cannot still be executing it,
 * and (#3559) only when that owner provably never began its effect: see
 * `reclaimable` below.
 *
 * This is the claim path's predicate. Capacity pruning deliberately does NOT
 * consult it: pruning evicts resolved rows only and never inspects owner
 * liveness, because probing every unresolved candidate under the write
 * transaction could block for minutes and could not converge. A live
 * unresolved turn is therefore never discarded for being old -- it is never
 * a pruning candidate at all.
 */
function ownerIsProvablyDead(
  owner: TurnClaimOwner | undefined,
  probe: ProcessIdentityProbe = probeExactProcessIdentity,
): boolean {
  if (!owner) return false;
  const observed = probe(owner.pid);
  return (
    observed.state === 'dead' ||
    (owner.identityKind === 'exact' &&
      observed.state === 'exact' &&
      observed.identity.start !== owner.birth)
  );
}
/** #3559: a dead owner's claim is reclaimable only before its effect began. */
function reclaimable(record: TurnIdempotencyRecord): boolean {
  return record.invocation === 'pending' || record.invocation === 'untracked';
}
function copy(
  record: TurnIdempotencyRecord | undefined,
): TurnIdempotencyRecord | undefined {
  return (
    record && {
      ...record,
      ...(record.owner ? { owner: { ...record.owner } } : {}),
    }
  );
}

export class TurnIdempotencyStore {
  private readonly owner: TurnClaimOwner;
  constructor(
    private readonly persistence: TurnIdempotencyPersistence,
    private readonly processIdentity: TurnIdempotencyProcessIdentity = defaultProcessIdentity,
  ) {
    const identity = processIdentity.exact(process.pid);
    this.owner = identity
      ? {
          pid: process.pid,
          birth: identity.start,
          token: randomUUID(),
          identityKind: 'exact',
        }
      : { pid: process.pid, token: randomUUID(), identityKind: 'unverified' };
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
    let metric:
      | 'claimed'
      | 'reclaimed'
      | 'contended'
      | 'indeterminate'
      | undefined;
    const owned: TurnIdempotencyRecord = {
      value: null,
      createdAt: now,
      owner: this.owner,
      invocation: tracking === 'tracked' ? 'pending' : 'untracked',
    };
    const result = this.persistence.update<TurnIdempotencyClaim>(key, (raw) => {
      const current = copy(raw);
      if (!current) {
        metric = 'claimed';
        return { record: owned, result: { claimed: true } };
      }
      if (current.value !== null)
        return {
          record: current,
          result: { claimed: false, value: current.value },
        };
      if (ownerIsProvablyDead(current.owner, this.processIdentity.probe)) {
        if (!reclaimable(current)) {
          metric = 'indeterminate';
          return {
            record: current,
            result: { claimed: false, indeterminate: true },
          };
        }
        metric = 'reclaimed';
        return { record: owned, result: { claimed: true } };
      }
      metric = 'contended';
      return { record: current, result: { claimed: false } };
    });
    if (metric) turnDedupClaims.add(1, { outcome: metric });
    return result;
  }
  /**
   * #3559: durably records that this owner may now start its effect. Call it
   * before the effect and do not start the effect if it throws. Idempotent
   * for the owner; refuses any claim this store does not own as `pending`.
   */
  beginInvocation(key: string): void {
    this.persistence.update(key, (raw) => {
      const current = copy(raw);
      if (
        !current ||
        current.value !== null ||
        current.owner?.token !== this.owner.token ||
        (current.invocation !== 'pending' && current.invocation !== 'begun')
      )
        throw new Error(
          'Turn claim is not owned and pending; its invocation cannot begin.',
        );
      return {
        record: { ...current, invocation: 'begun' },
        result: undefined,
      };
    });
  }
  resolve(key: string, value: string): void {
    this.persistence.update(key, (raw) => {
      const current = copy(raw);
      return !current ||
        current.value !== null ||
        current.owner?.token !== this.owner.token
        ? { record: current, result: undefined }
        : { record: { ...current, value }, result: undefined };
    });
  }
  release(key: string): void {
    this.persistence.update(key, (raw) => {
      const current = copy(raw);
      return !current ||
        current.value !== null ||
        current.owner?.token !== this.owner.token
        ? { record: current, result: undefined }
        : { result: undefined };
    });
  }
  read(key: string): string | undefined {
    return this.persistence.read(key)?.value ?? undefined;
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
