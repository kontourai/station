import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import { SKILL_EXPERIENCE_METADATA_KEY } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  isProviderTriggeredTurn,
  type TurnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';
import type { SkillExperienceInvocationReferenceV1 } from '@kontourai/station-contracts/skill-experience';

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
function withPrincipal<T extends { principal?: PrincipalRef }>(
  record: T,
  principal: PrincipalRef | undefined,
): T {
  return principal && record.principal === undefined
    ? { ...record, principal }
    : record;
}

/**
 * Stamps the send's idempotency key on the `turn.started` that send produced.
 * Only Station sets it: an adapter-supplied value is replaced, because the
 * client trusts this field to say which of its messages became the turn.
 */
function withClientTurnId(
  event: CanonicalRuntimeEvent,
  clientTurnId: string | undefined,
): CanonicalRuntimeEvent {
  if (event.method !== 'turn.started' || clientTurnId === undefined)
    return event;
  return { ...event, clientTurnId };
}

/**
 * #4512: stamps the origin Station classified at admission on the
 * `turn.started` that send produced. Only Station sets it; `apply` drops an
 * adapter-supplied value before this runs.
 */
/**
 * #4827: stamps that the turn's prompt is a server-verified MCP prompt
 * expansion rather than what the sender typed. Only Station sets it; `apply`
 * drops an adapter-supplied value before this runs.
 */
function withPromptSource(
  event: CanonicalRuntimeEvent,
  promptSource: 'mcp-prompt' | undefined,
): CanonicalRuntimeEvent {
  if (event.method !== 'turn.started' || promptSource === undefined)
    return event;
  return { ...event, promptSource };
}

/**
 * #4827: stamps that a person typed the turn's prompt. Only Station sets it,
 * from the entry point that admitted the send; `apply` drops an
 * adapter-supplied value before this runs.
 */
function withAuthoredBy(
  event: CanonicalRuntimeEvent,
  authoredBy: 'person' | undefined,
): CanonicalRuntimeEvent {
  if (event.method !== 'turn.started' || authoredBy === undefined) return event;
  return { ...event, authoredBy };
}

function withDispatchOrigin(
  event: CanonicalRuntimeEvent,
  dispatchOrigin: TurnDispatchOrigin | undefined,
): CanonicalRuntimeEvent {
  if (event.method !== 'turn.started' || dispatchOrigin === undefined)
    return event;
  return { ...event, dispatchOrigin };
}

/** What a turn-start reserves for its eventual `turn.started` event. */
interface TurnAttribution {
  invocationId?: string;
  experience?: SkillExperienceInvocationReferenceV1;
  clientOrigin?: ClientOrigin;
  principal?: PrincipalRef;
  /**
   * The idempotency key of the send that started this turn, so the sending
   * client can match its message to the turn exactly instead of by text.
   */
  clientTurnId?: string;
  /** #4512: the send's server-classified origin. */
  dispatchOrigin?: TurnDispatchOrigin;
  /** #4827: the prompt is a verified MCP prompt expansion. */
  promptSource?: 'mcp-prompt';
  /** #4827: a person typed the prompt into one of Station's clients. */
  authoredBy?: 'person';
}

function hasAttribution(attribution: TurnAttribution): boolean {
  return (
    reservesTurn(attribution) ||
    attribution.clientTurnId !== undefined ||
    attribution.dispatchOrigin !== undefined
  );
}

/**
 * Whether a send holds its turn's early `turn.started` back for attribution.
 * A send key alone does not: keyed internal sends (scheduled jobs, channel
 * relays) keep their events flowing exactly as before, and their key is
 * stamped only when the start arrives after acceptance. User sends always
 * carry an origin or principal, so theirs is held and stamped.
 *
 * #4512: a classified dispatch origin other than `unknown` is held too.
 * Stamped only on a start that arrives after acceptance, a delegated or
 * Task turn whose engine reported its start early would read as `unknown`,
 * and boot recovery decides on that field.
 */
function reservesTurn(attribution: TurnAttribution): boolean {
  return (
    attribution.clientOrigin !== undefined ||
    attribution.principal !== undefined ||
    attribution.experience !== undefined ||
    (attribution.dispatchOrigin !== undefined &&
      attribution.dispatchOrigin !== 'unknown')
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
  readonly #trusted = new WeakSet<object>();
  readonly #early = new Map<string, CanonicalRuntimeEvent>();
  readonly #legacyPending = new Map<
    string,
    Pick<
      TurnAttribution,
      | 'principal'
      | 'clientOrigin'
      | 'invocationId'
      | 'clientTurnId'
      | 'dispatchOrigin'
      | 'promptSource'
      | 'authoredBy'
    >
  >();
  readonly #legacyAccepted = new Map<
    string,
    Pick<
      TurnAttribution,
      | 'principal'
      | 'clientOrigin'
      | 'invocationId'
      | 'clientTurnId'
      | 'dispatchOrigin'
      | 'promptSource'
      | 'authoredBy'
    >
  >();
  readonly #legacyEarly = new Map<string, CanonicalRuntimeEvent>();

  begin(
    threadId: string,
    clientOrigin: ClientOrigin | undefined,
    principal?: PrincipalRef,
    experience?: SkillExperienceInvocationReferenceV1,
    clientTurnId?: string,
    dispatchOrigin?: TurnDispatchOrigin,
    promptSource?: 'mcp-prompt',
    authoredBy?: 'person',
  ): boolean {
    const attribution: TurnAttribution = {
      clientOrigin,
      principal,
      experience,
      clientTurnId,
      dispatchOrigin,
      promptSource,
      authoredBy,
    };
    if (!reservesTurn(attribution) || this.#inFlight.has(threadId)) {
      return false;
    }
    if (this.#inFlight.size >= ClientOriginTurnPropagation.MAX_PENDING)
      return false;
    this.#inFlight.set(threadId, attribution);
    if (
      principal !== undefined ||
      clientOrigin !== undefined ||
      (dispatchOrigin !== undefined && dispatchOrigin !== 'unknown')
    )
      this.#legacyPending.set(threadId, {
        principal,
        clientOrigin,
        clientTurnId,
        dispatchOrigin,
        promptSource,
        authoredBy,
      });
    return true;
  }

  bindInvocation(threadId: string, invocationId: string): void {
    const reserved = this.#inFlight.get(threadId);
    if (reserved) reserved.invocationId = invocationId;
    const legacy = this.#legacyPending.get(threadId);
    if (legacy) legacy.invocationId = invocationId;
  }

  settle(
    threadId: string,
    turnId: string,
    clientOrigin: ClientOrigin | undefined,
    principal?: PrincipalRef,
    experience?: SkillExperienceInvocationReferenceV1,
    clientTurnId?: string,
    invocationId?: string,
    dispatchOrigin?: TurnDispatchOrigin,
  ): CanonicalRuntimeEvent | undefined {
    const reserved = this.#inFlight.get(threadId);
    const attribution: TurnAttribution = {
      invocationId,
      clientOrigin: clientOrigin ?? reserved?.clientOrigin,
      principal: principal ?? reserved?.principal,
      experience: experience ?? reserved?.experience,
      clientTurnId: clientTurnId ?? reserved?.clientTurnId,
      dispatchOrigin: dispatchOrigin ?? reserved?.dispatchOrigin,
      promptSource: reserved?.promptSource,
      authoredBy: reserved?.authoredBy,
    };
    this.#inFlight.delete(threadId);
    const legacy = this.#legacyPending.get(threadId);
    this.#legacyPending.delete(threadId);
    if (
      invocationId !== undefined &&
      legacy &&
      this.#legacyAccepted.size < ClientOriginTurnPropagation.MAX_PENDING
    )
      this.#legacyAccepted.set(this.#key(threadId, turnId), legacy);
    if (!hasAttribution(attribution)) return undefined;
    const key = this.#key(threadId, turnId, invocationId);
    const early = this.#early.get(key);
    if (early) {
      this.#early.delete(key);
      return this.#attribute(early, attribution);
    }
    if (this.#accepted.size < ClientOriginTurnPropagation.MAX_PENDING) {
      this.#accepted.set(key, attribution);
    }
    return undefined;
  }

  apply(event: CanonicalRuntimeEvent): CanonicalRuntimeEvent | undefined {
    if (event.method !== 'turn.started') return event;
    if (this.#trusted.has(event)) return event;
    const { [SKILL_EXPERIENCE_METADATA_KEY]: ignored, ...metadata } =
      event.metadata ?? {};
    if (ignored !== undefined) event = { ...event, metadata };
    // The send's key is Station's fact, stamped by `#attribute` only; an
    // adapter that names one is not believed.
    if (event.clientTurnId !== undefined) {
      const { clientTurnId: _untrusted, ...unkeyed } = event;
      event = unkeyed;
    }
    // #4512: likewise the origin; boot recovery acts on it.
    if (event.dispatchOrigin !== undefined) {
      const { dispatchOrigin: _untrusted, ...unclassified } = event;
      event = unclassified;
    }
    // #4827: likewise the prompt's source; the approval guardian reads it.
    if (event.promptSource !== undefined) {
      const { promptSource: _untrusted, ...unsourced } = event;
      event = unsourced;
    }
    // #4827: and who wrote it; the approval guardian reads it as the
    // person's own words.
    if (event.authoredBy !== undefined) {
      const { authoredBy: _untrusted, ...unauthored } = event;
      event = unauthored;
    }
    // #2324: a turn the engine opened on its own is no send's turn. Holding
    // it for an in-flight reservation would attribute that send's origin to
    // it on settle — or drop it on retire, leaving its deltas with no start.
    if (isProviderTriggeredTurn(event)) return event;
    if (!event.turnId) return event;
    if (
      event.invocationId === undefined &&
      this.#inFlight.get(event.threadId)?.invocationId !== undefined
    ) {
      const key = this.#key(event.threadId, event.turnId);
      if (
        this.#legacyPending.has(event.threadId) &&
        this.#legacyEarly.size < ClientOriginTurnPropagation.MAX_PENDING
      ) {
        this.#legacyEarly.set(key, event);
        return undefined;
      }
    }
    if (event.invocationId === undefined) {
      const key = this.#key(event.threadId, event.turnId);
      const legacy = this.#legacyAccepted.get(key);
      if (legacy) {
        this.#legacyAccepted.delete(key);
        return this.#routeLegacy(event, legacy);
      }
    }
    const key = this.#key(event.threadId, event.turnId, event.invocationId);
    const attribution = this.#accepted.get(key);
    if (attribution) {
      this.#accepted.delete(key);
      return this.#attribute(event, attribution);
    }
    const reserved = this.#inFlight.get(event.threadId);
    if (
      reserved?.invocationId !== undefined &&
      reserved.invocationId !== event.invocationId
    )
      return event;
    if (reserved) {
      if (this.#early.size < ClientOriginTurnPropagation.MAX_PENDING) {
        this.#early.set(key, event);
        return undefined;
      }
      return event;
    }
    return event;
  }

  takeLegacyRouting(
    threadId: string,
    turnId: string,
  ): CanonicalRuntimeEvent | undefined {
    const key = this.#key(threadId, turnId);
    const event = this.#legacyEarly.get(key);
    const routing = this.#legacyAccepted.get(key);
    if (!event || !routing) return undefined;
    this.#legacyEarly.delete(key);
    this.#legacyAccepted.delete(key);
    return this.#routeLegacy(event, routing);
  }

  /**
   * #4830: whether a turn start on `threadId` is not yet what the store
   * holds: a send in flight (its acceptance not returned), an accepted send
   * whose `turn.started` has not arrived, or a start held for either. While
   * this is true the store's newest start is not the turn now running.
   * False is not proof of the opposite: a concurrent steer's cancel or
   * settle removes another send's reservation, and an invocationless legacy
   * start can leave an accepted key that reads true until session exit
   * (#4850 review; the fix is a turn-bound credential, #4882).
   */
  holdsTurnStart(threadId: string): boolean {
    if (this.#inFlight.has(threadId)) return true;
    const prefix = `${threadId.length}:${threadId}:`;
    for (const key of [
      ...this.#early.keys(),
      ...this.#accepted.keys(),
      ...this.#legacyEarly.keys(),
    ])
      if (key.startsWith(prefix)) return true;
    return false;
  }

  clearThread(threadId: string): void {
    this.#legacyPending.delete(threadId);
    const prefix = `${threadId.length}:${threadId}:`;
    for (const key of [
      ...this.#legacyAccepted.keys(),
      ...this.#legacyEarly.keys(),
    ]) {
      if (key.startsWith(prefix)) {
        this.#legacyAccepted.delete(key);
        this.#legacyEarly.delete(key);
      }
    }
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

  retire(
    threadId: string,
    turnId: string | undefined,
    invocationId?: string,
  ): void {
    const legacy = this.#legacyPending.get(threadId);
    if (invocationId === undefined || legacy?.invocationId === invocationId)
      this.#legacyPending.delete(threadId);
    const prefix = `${threadId.length}:${threadId}:`;
    for (const [key, routing] of this.#legacyAccepted) {
      if (
        key.startsWith(prefix) &&
        (turnId === undefined || key === this.#key(threadId, turnId)) &&
        (invocationId === undefined || routing.invocationId === invocationId)
      ) {
        this.#legacyAccepted.delete(key);
        this.#legacyEarly.delete(key);
      }
    }
    if (invocationId === undefined && turnId !== undefined)
      this.#legacyEarly.delete(this.#key(threadId, turnId));
    if (
      legacy &&
      (invocationId === undefined || legacy.invocationId === invocationId)
    ) {
      for (const [key, event] of this.#legacyEarly) {
        if (
          event.threadId === threadId &&
          (turnId === undefined || event.turnId === turnId)
        )
          this.#legacyEarly.delete(key);
      }
    }
    if (!turnId) {
      if (this.#inFlight.get(threadId)?.invocationId === invocationId)
        this.#inFlight.delete(threadId);
      return;
    }
    const key = this.#key(threadId, turnId, invocationId);
    this.#accepted.delete(key);
    this.#early.delete(key);
  }

  /**
   * The send failed before its acceptance. Any start it held back is still a
   * start the engine reported, so it is handed back to be published (without
   * attribution) instead of being kept here forever.
   */
  cancel(threadId: string): CanonicalRuntimeEvent[] {
    this.#inFlight.delete(threadId);
    this.#legacyPending.delete(threadId);
    const released: CanonicalRuntimeEvent[] = [];
    const prefix = `${threadId.length}:${threadId}:`;
    for (const [key, event] of this.#early) {
      if (!key.startsWith(prefix)) continue;
      this.#early.delete(key);
      released.push(event);
    }
    for (const [key, event] of this.#legacyEarly) {
      if (!key.startsWith(prefix)) continue;
      this.#legacyEarly.delete(key);
      released.push(event);
    }
    return released;
  }

  #routeLegacy(
    event: CanonicalRuntimeEvent,
    routing: Pick<
      TurnAttribution,
      | 'principal'
      | 'clientOrigin'
      | 'clientTurnId'
      | 'dispatchOrigin'
      | 'promptSource'
      | 'authoredBy'
    >,
  ): CanonicalRuntimeEvent {
    const result = withAuthoredBy(
      withPromptSource(
        withDispatchOrigin(
          withClientTurnId(
            withPrincipal(
              withClientOrigin(event, routing.clientOrigin),
              routing.principal,
            ),
            routing.clientTurnId,
          ),
          routing.dispatchOrigin,
        ),
        routing.promptSource,
      ),
      routing.authoredBy,
    );
    this.#trusted.add(result);
    return result;
  }

  #attribute(
    event: CanonicalRuntimeEvent,
    attribution: TurnAttribution,
  ): CanonicalRuntimeEvent {
    const attributed = withAuthoredBy(
      withPromptSource(
        withDispatchOrigin(
          withClientTurnId(
            withPrincipal(
              withClientOrigin(event, attribution.clientOrigin),
              attribution.principal,
            ),
            attribution.clientTurnId,
          ),
          attribution.dispatchOrigin,
        ),
        attribution.promptSource,
      ),
      attribution.authoredBy,
    );
    const result =
      attribution.experience && attributed.method === 'turn.started'
        ? {
            ...attributed,
            metadata: {
              ...attributed.metadata,
              [SKILL_EXPERIENCE_METADATA_KEY]: attribution.experience,
            },
          }
        : attributed;
    this.#trusted.add(result);
    return result;
  }

  #key(threadId: string, turnId: string, invocationId?: string): string {
    return `${threadId.length}:${threadId}:${JSON.stringify([turnId, invocationId ?? null])}`;
  }
}
