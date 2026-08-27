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
export interface TurnIdempotencyRecord {
  value: string | null;
  createdAt: number;
  owner?: TurnClaimOwner;
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
export type TurnIdempotencyClaim =
  | { claimed: true }
  | { claimed: false; value?: string };

/**
 * A claim may be RECLAIMED only when its owner cannot still be executing it.
 *
 * This is the claim path's predicate. Capacity pruning deliberately does NOT
 * consult it: pruning evicts resolved rows only and never inspects owner
 * liveness, because probing every unresolved candidate under the write
 * transaction could block for minutes and could not converge. A live
 * unresolved turn is therefore never discarded for being old -- it is never
 * a pruning candidate at all.
 */
export function ownerIsProvablyDead(
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
  claim(key: string, now = Date.now()): TurnIdempotencyClaim {
    let metric: 'claimed' | 'reclaimed' | 'contended' | undefined;
    const result = this.persistence.update<TurnIdempotencyClaim>(key, (raw) => {
      const current = copy(raw);
      if (!current) {
        metric = 'claimed';
        return {
          record: { value: null, createdAt: now, owner: this.owner },
          result: { claimed: true },
        };
      }
      if (current.value !== null)
        return {
          record: current,
          result: { claimed: false, value: current.value },
        };
      if (ownerIsProvablyDead(current.owner, this.processIdentity.probe)) {
        metric = 'reclaimed';
        return {
          record: { value: null, createdAt: now, owner: this.owner },
          result: { claimed: true },
        };
      }
      metric = 'contended';
      return { record: current, result: { claimed: false } };
    });
    if (metric) turnDedupClaims.add(1, { outcome: metric });
    return result;
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
