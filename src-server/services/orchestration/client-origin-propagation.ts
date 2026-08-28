import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/** One propagation rule for durable command receipts and the turn event they cause. */
export function withClientOrigin<T extends { clientOrigin?: ClientOrigin }>(
  record: T,
  clientOrigin: ClientOrigin | undefined,
): T {
  return clientOrigin && record.clientOrigin === undefined
    ? { ...record, clientOrigin }
    : record;
}

/**
 * archive#4075 stage 2: the same propagation rule as {@link withClientOrigin},
 * generalized to a second server-authenticated fact — the dispatching or
 * steering principal. Kept as a sibling function rather than folded into
 * `withClientOrigin` so a caller that only carries one of the two facts
 * (still the common case for `clientOrigin` alone) is not forced to reason
 * about the other.
 */
export function withPrincipal<T extends { principal?: PrincipalRef }>(
  record: T,
  principal: PrincipalRef | undefined,
): T {
  return principal && record.principal === undefined
    ? { ...record, principal }
    : record;
}

/** What a turn-start reserves for its eventual `turn.started` event. */
export interface TurnAttribution {
  clientOrigin?: ClientOrigin;
  principal?: PrincipalRef;
}

function hasAttribution(attribution: TurnAttribution): boolean {
  return (
    attribution.clientOrigin !== undefined ||
    attribution.principal !== undefined
  );
}

/**
 * Private exact correlation between an accepted provider turn and its event.
 *
 * archive#4075 stage 2: generalized from client-origin-only to also carry
 * the dispatching/steering `PrincipalRef` through the SAME begin/settle/apply
 * lifecycle — the mechanism the stage-2 probe verified and asked to be
 * reused rather than duplicated. Every internal map now stores a
 * {@link TurnAttribution} pair instead of a bare `ClientOrigin`; every public
 * method grows an optional trailing `principal` parameter alongside its
 * existing `clientOrigin` one. A caller that never passes `principal` (every
 * call site before stage 2 threaded it through) observes byte-identical
 * behavior — `principal` is simply always `undefined` on the stored
 * attribution, and {@link withPrincipal} is a no-op when its input is
 * `undefined`.
 */
export class ClientOriginTurnPropagation {
  /** One serialized turn-start may reserve one origin per live thread. */
  static readonly MAX_PENDING = 128;
  readonly #inFlight = new Map<string, TurnAttribution>();
  readonly #accepted = new Map<string, TurnAttribution>();
  readonly #early = new Map<string, CanonicalRuntimeEvent>();

  begin(
    threadId: string,
    clientOrigin: ClientOrigin | undefined,
    principal?: PrincipalRef,
  ): boolean {
    const attribution: TurnAttribution = { clientOrigin, principal };
    if (!hasAttribution(attribution) || this.#inFlight.has(threadId)) {
      return false;
    }
    if (this.#inFlight.size >= ClientOriginTurnPropagation.MAX_PENDING)
      return false;
    this.#inFlight.set(threadId, attribution);
    return true;
  }

  settle(
    threadId: string,
    turnId: string,
    clientOrigin: ClientOrigin | undefined,
    principal?: PrincipalRef,
  ): CanonicalRuntimeEvent | undefined {
    const reserved = this.#inFlight.get(threadId);
    const attribution: TurnAttribution = {
      clientOrigin: clientOrigin ?? reserved?.clientOrigin,
      principal: principal ?? reserved?.principal,
    };
    this.#inFlight.delete(threadId);
    if (!hasAttribution(attribution)) return undefined;
    const key = this.#key(threadId, turnId);
    const early = this.#early.get(key);
    if (early) {
      this.#early.delete(key);
      return withPrincipal(
        withClientOrigin(early, attribution.clientOrigin),
        attribution.principal,
      );
    }
    if (this.#accepted.size < ClientOriginTurnPropagation.MAX_PENDING) {
      this.#accepted.set(key, attribution);
    }
    return undefined;
  }

  apply(event: CanonicalRuntimeEvent): CanonicalRuntimeEvent | undefined {
    if (event.method !== 'turn.started') return event;
    if (event.clientOrigin !== undefined && event.principal !== undefined) {
      return event;
    }
    if (!event.turnId) return event;
    const key = this.#key(event.threadId, event.turnId);
    const attribution = this.#accepted.get(key);
    if (attribution) {
      this.#accepted.delete(key);
      return withPrincipal(
        withClientOrigin(event, attribution.clientOrigin),
        attribution.principal,
      );
    }
    if (this.#inFlight.has(event.threadId)) {
      if (this.#early.size < ClientOriginTurnPropagation.MAX_PENDING) {
        this.#early.set(key, event);
        return undefined;
      }
      return event;
    }
    return event;
  }

  clearThread(threadId: string): void {
    this.#inFlight.delete(threadId);
    for (const key of [...this.#accepted.keys(), ...this.#early.keys()]) {
      if (
        key.startsWith(`${threadId.length}:`) &&
        key.includes(`:${threadId}:`)
      ) {
        this.#accepted.delete(key);
        this.#early.delete(key);
      }
    }
  }

  retire(threadId: string, turnId: string | undefined): void {
    if (!turnId) {
      this.#inFlight.delete(threadId);
      return;
    }
    const key = this.#key(threadId, turnId);
    this.#accepted.delete(key);
    this.#early.delete(key);
  }

  cancel(threadId: string): void {
    this.#inFlight.delete(threadId);
  }

  #key(threadId: string, turnId: string): string {
    return `${threadId.length}:${threadId}:${turnId.length}:${turnId}`;
  }
}
