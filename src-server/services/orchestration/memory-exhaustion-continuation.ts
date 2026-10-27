/**
 * Continuing a conversation whose engine was killed for exhausting its
 * workload memory budget.
 *
 * When a Session ends with `session.exited` reason `memory-exhausted`, Station
 * hands one Station-authored turn to the conversation's inbox. The inbox
 * places it through the conversation's binding, so it runs in a successor
 * Session, whose first turn already carries the recovery note
 * (`memory-exhaustion-recovery.ts`). A person's Continue goes through
 * {@link MemoryExhaustionContinuation.continueOnRequest}, the same key and the
 * same inbox.
 *
 * Exactly once: the inbox key is derived from the dead Session and turn
 * (`memoryContinuationKey`). The same key with the same payload is the same
 * entry; with another sender's payload the inbox answers `conflict` and writes
 * nothing. So two devices, or a click racing the automatic path, cannot start
 * two continuations.
 *
 * Automatic continuation is its own explicit, capped path; ordinary recovery
 * still never replays a memory-killed turn. It is withheld when the turn was
 * interrupted (no `engine-memory-exhausted` failure is published for it), when
 * a request (approval or question) was still open at the kill, when the
 * conversation has moved on, or past {@link AUTO_CONTINUE_MAX} automatic
 * continuations in {@link AUTO_CONTINUE_WINDOW_MS} for the conversation. The
 * cap is counted in this process; a restart starts it again.
 */
import { createHash } from 'node:crypto';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  ENGINE_MEMORY_EXHAUSTED_CODE,
  isStationMemoryContinuationTurn,
  MEMORY_CONTINUATION_CLIENT_TURN_PREFIX,
  memoryContinuationKeyKind,
} from '@kontourai/station-contracts/provider';
import type { EventStore } from './event-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type {
  ThreadInboxActor,
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from './thread-inbox.js';

/** At most this many automatic continuations per conversation… */
export const AUTO_CONTINUE_MAX = 3;
/** …within this window. Past it, the person's Continue card remains. */
export const AUTO_CONTINUE_WINDOW_MS = 5 * 60_000;

/**
 * At most this many automatic continuations in a row in one conversation's
 * lineage. Only a turn a person sent resets the chain: a task that runs out of
 * memory every time stops after this many restarts and waits for Continue,
 * whatever the rate cap still allows.
 */
export const AUTO_CONTINUE_CHAIN_MAX = 2;

/** Client-origin actors that are a person (`ClientOrigin` kinds). */
const PERSON_ACTOR_KINDS = new Set(['operator', 'device']);

/** How far back the chain is walked; beyond it the chain counts as full. */
const CHAIN_WALK_SESSIONS = 32;

/** What the continuation turn says; the recovery note is added server-side. */
export const MEMORY_CONTINUATION_TEXT =
  'Continue the task from where it stopped.';

const MEMORY_CONTINUATION_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

/** The one inbox key for continuing `threadId`'s turn `turnId`. */
export function memoryContinuationKey(
  threadId: string,
  turnId: string,
): string {
  const digest = createHash('sha256')
    .update(`${threadId}\u0000${turnId}`)
    .digest('hex')
    .slice(0, 40);
  return `${MEMORY_CONTINUATION_CLIENT_TURN_PREFIX}${digest}`;
}

type DeadTurnRefusal =
  /** The newest turn did not end in a memory-exhaustion failure. */
  | 'not-memory-exhausted'
  /** A request was still open when the engine died. */
  | 'request-pending'
  /** The turn was stopped by a person. */
  | 'interrupted';

interface DeadTurn {
  readonly threadId: string;
  readonly turnId: string;
}

export type MemoryContinuationOutcome =
  | {
      readonly kind: 'queued';
      readonly conversationId: string;
      readonly clientTurnId: string;
    }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | DeadTurnRefusal
        | 'capped'
        | 'chain-limit'
        | 'delegated'
        | 'superseded'
        | 'already-claimed'
        | 'withdrawn';
    }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'inbox-unavailable'
        | 'no-owner'
        | 'conflict'
        | 'capacity'
        | 'not-permitted'
        | 'error';
    };

export interface MemoryExhaustionContinuationPorts {
  readonly eventStore: Pick<
    EventStore,
    | 'conversationForSession'
    | 'listEventWindowByTurn'
    | 'hasTurnFacts'
    | 'listEventsByMethods'
    | 'firstEventByMethod'
  >;
  readonly service: Pick<
    OrchestrationService,
    'currentConversationSessionId' | 'sessionRecordedOwnerId'
  >;
  /**
   * Whether the conversation inbox holds an entry under `key`, and whether it
   * provably sent nothing (`not-delivered`: refused, or cancelled before it
   * was ever placed, as `ThreadInboxDelivery.nonDeliveryReason` decides). An
   * entry that may have started a turn, including a dismissed unconfirmed
   * one, is `live`.
   */
  readonly entryDelivery?: EntryDelivery;
  readonly submit:
    | ((input: {
        readonly conversationId: string;
        readonly clientTurnId: string;
        readonly payload: ThreadInboxPayload;
      }) => ThreadInboxSubmission)
    | undefined;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  readonly now?: () => number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** What the conversation inbox says of a continuation key. */
export type EntryDelivery = (
  conversationId: string,
  key: string,
) => 'live' | 'not-delivered' | undefined;

/**
 * The `entryDelivery` port over a conversation inbox: undefined for a key it
 * does not hold, `not-delivered` for one its own rule proves never sent
 * (ThreadInboxDelivery.nonDeliveryReason), `live` otherwise.
 */
export function inboxEntryDelivery(inbox: {
  entry(conversationId: string, key: string): unknown;
  nonDeliveryReason(conversationId: string, key: string): string | undefined;
}): EntryDelivery {
  return (conversationId, key) =>
    !inbox.entry(conversationId, key)
      ? undefined
      : inbox.nonDeliveryReason(conversationId, key)
        ? 'not-delivered'
        : 'live';
}

/**
 * The continuation as Station composes it: submitting to, and reading
 * delivery from, the conversation inbox. Without an inbox it can only refuse.
 */
export function memoryContinuationForInbox(options: {
  readonly eventStore: MemoryExhaustionContinuationPorts['eventStore'];
  readonly service: MemoryExhaustionContinuationPorts['service'];
  readonly inbox:
    | (Parameters<typeof inboxEntryDelivery>[0] & {
        submit: NonNullable<MemoryExhaustionContinuationPorts['submit']>;
      })
    | undefined;
  readonly logger: MemoryExhaustionContinuationPorts['logger'];
  readonly now?: () => number;
}): MemoryExhaustionContinuation {
  const { inbox } = options;
  return new MemoryExhaustionContinuation({
    eventStore: options.eventStore,
    service: options.service,
    submit: inbox ? (input) => inbox.submit(input) : undefined,
    ...(inbox ? { entryDelivery: inboxEntryDelivery(inbox) } : {}),
    logger: options.logger,
    ...(options.now ? { now: options.now } : {}),
  });
}

export class MemoryExhaustionContinuation {
  private readonly automatic = new Map<string, number[]>();
  /** Dead turns this process already continued automatically. */
  private readonly claimed = new Set<string>();

  constructor(private readonly ports: MemoryExhaustionContinuationPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** Feed every persisted orchestration event; never throws. */
  observe(event: { method?: unknown; threadId?: unknown; reason?: unknown }) {
    if (
      event.method !== 'session.exited' ||
      event.reason !== 'memory-exhausted' ||
      typeof event.threadId !== 'string'
    )
      return;
    try {
      this.continueAutomatically(event.threadId);
    } catch (error) {
      this.ports.logger.warn('automatic continuation failed', {
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The dead turn of `threadId`, read from its own newest turn window, or why
   * it cannot be continued automatically.
   */
  private deadTurn(threadId: string): DeadTurn | DeadTurnRefusal {
    const payloads = this.ports.eventStore
      .listEventWindowByTurn(threadId, { turnLimit: 1, direction: 'newest' })
      .events.map((event) => record(event.payload))
      .filter((payload): payload is Record<string, unknown> => !!payload);
    let failureIndex = -1;
    payloads.forEach((payload, index) => {
      if (payload.method === 'runtime.error') failureIndex = index;
    });
    const failure = payloads[failureIndex];
    if (
      !failure ||
      failure.code !== ENGINE_MEMORY_EXHAUSTED_CODE ||
      typeof failure.turnId !== 'string'
    )
      return 'not-memory-exhausted';
    const turnId = failure.turnId;
    if (
      payloads.some(
        (payload) =>
          payload.turnId === turnId &&
          (payload.method === 'turn.aborted' ||
            (payload.method === 'session.stop-settled' &&
              payload.initiatedBy === 'user')),
      )
    )
      return 'interrupted';
    const before = payloads.slice(0, failureIndex);
    const resolved = new Set(
      before
        .filter((payload) => payload.method === 'request.resolved')
        .map((payload) => payload.requestId),
    );
    if (
      before.some(
        (payload) =>
          payload.method === 'request.opened' &&
          !resolved.has(payload.requestId),
      )
    )
      return 'request-pending';
    return { threadId, turnId };
  }

  /**
   * Whether the conversation still stands where the engine died: the dead
   * Session is current, or its reserved successor has not run a turn.
   */
  private stillAtDeadTurn(conversationId: string, threadId: string): boolean {
    const current =
      this.ports.service.currentConversationSessionId(conversationId);
    if (current === threadId) return true;
    const successor = this.ports.eventStore.conversationForSession(current);
    return (
      successor?.predecessorSessionId === threadId &&
      !this.ports.eventStore.hasTurnFacts(current)
    );
  }

  private conversationOf(threadId: string): string {
    return (
      this.ports.eventStore.conversationForSession(threadId)?.conversationId ??
      threadId
    );
  }

  private stateOf(
    conversationId: string,
    key: string,
  ): 'live' | 'dead' | undefined {
    const delivery = this.ports.entryDelivery?.(conversationId, key);
    if (delivery === undefined) return undefined;
    return delivery === 'not-delivered' ? 'dead' : 'live';
  }

  /**
   * The key this request continues under, or why it does not. A live entry
   * under any key of the dead turn means someone already continued it. After
   * a cancelled or refused entry Station does not try again on its own (the
   * cancel was a person's decision); a person's Continue takes the next
   * person key, so two devices clicking then still name one entry.
   */
  private keyFor(
    conversationId: string,
    dead: DeadTurn,
    by: 'automatic' | 'person',
  ): string | MemoryContinuationOutcome {
    const base = memoryContinuationKey(dead.threadId, dead.turnId);
    const personKeys = [
      `${base}-p`,
      ...[2, 3, 4, 5].map((n) => `${base}-p${n}`),
    ];
    const states = [base, ...personKeys].map((key) =>
      this.stateOf(conversationId, key),
    );
    if (states.includes('live'))
      return { kind: 'skipped', reason: 'already-claimed' };
    if (by === 'automatic')
      return states.includes('dead')
        ? { kind: 'skipped', reason: 'withdrawn' }
        : base;
    const free = personKeys.find(
      (_key, index) => states[index + 1] === undefined,
    );
    return free ?? { kind: 'skipped', reason: 'withdrawn' };
  }

  private submit(
    conversationId: string,
    dead: DeadTurn,
    actor: ThreadInboxActor,
    by: 'automatic' | 'person',
  ): MemoryContinuationOutcome {
    if (!this.ports.submit)
      return { kind: 'failed', reason: 'inbox-unavailable' };
    const clientTurnId = this.keyFor(conversationId, dead, by);
    if (typeof clientTurnId !== 'string') return clientTurnId;
    const submitted = this.ports.submit({
      conversationId,
      clientTurnId,
      payload: {
        message: MEMORY_CONTINUATION_TEXT,
        actor,
        clientOrigin: MEMORY_CONTINUATION_CLIENT_ORIGIN,
      },
    });
    if (submitted.outcome !== 'queued')
      return { kind: 'failed', reason: submitted.outcome };
    return { kind: 'queued', conversationId, clientTurnId };
  }

  /**
   * Automatic continuations since the last turn a person sent, walking the
   * conversation's lineage back from `threadId`.
   */
  private automaticChain(threadId: string): number {
    let chain = 0;
    let session: string | undefined = threadId;
    for (let walked = 0; session && walked < CHAIN_WALK_SESSIONS; walked += 1) {
      const starts = this.ports.eventStore
        .listEventsByMethods(session, ['turn.started'])
        .map((event) => record(event.payload))
        .reverse();
      for (const start of starts) {
        if (!start) continue;
        const kind = isStationMemoryContinuationTurn(start as never)
          ? memoryContinuationKeyKind(start.clientTurnId as string)
          : undefined;
        if (kind === 'automatic') chain += 1;
        // A person's Continue, or a turn an operator or a device sent, ends
        // the chain. Station's other turns (check-backs) and turns whose
        // origin is unknown neither count nor reset it.
        else if (
          kind === 'person' ||
          PERSON_ACTOR_KINDS.has(
            String(record(record(start.clientOrigin)?.actor)?.kind),
          )
        )
          return chain;
      }
      session =
        this.ports.eventStore.conversationForSession(
          session,
        )?.predecessorSessionId;
    }
    return session ? AUTO_CONTINUE_CHAIN_MAX : chain;
  }

  /**
   * A delegated child's conversation: its parent decides whether to retry,
   * so Station does not continue it on its own.
   */
  private delegated(conversationId: string): boolean {
    const metadata = record(
      record(
        this.ports.eventStore.firstEventByMethod(
          conversationId,
          'session.started',
        )?.payload,
      )?.metadata,
    );
    return (
      typeof record(metadata?.delegation)?.parentConversationId === 'string' ||
      typeof metadata?.parentConversationId === 'string' ||
      typeof metadata?.parentTaskId === 'string'
    );
  }

  /** Station's own continuation after `threadId` exited for memory. */
  continueAutomatically(threadId: string): MemoryContinuationOutcome {
    const dead = this.deadTurn(threadId);
    if (typeof dead === 'string') return { kind: 'skipped', reason: dead };
    const key = memoryContinuationKey(dead.threadId, dead.turnId);
    if (this.claimed.has(key))
      return { kind: 'skipped', reason: 'already-claimed' };
    const conversationId = this.conversationOf(threadId);
    if (!this.stillAtDeadTurn(conversationId, threadId))
      return { kind: 'skipped', reason: 'superseded' };
    if (this.delegated(conversationId))
      return { kind: 'skipped', reason: 'delegated' };
    if (this.automaticChain(threadId) >= AUTO_CONTINUE_CHAIN_MAX)
      return { kind: 'skipped', reason: 'chain-limit' };
    const now = this.now();
    const recent = (this.automatic.get(conversationId) ?? []).filter(
      (at) => now - at < AUTO_CONTINUE_WINDOW_MS,
    );
    if (recent.length >= AUTO_CONTINUE_MAX) {
      this.automatic.set(conversationId, recent);
      return { kind: 'skipped', reason: 'capped' };
    }
    const owner = this.ports.service.sessionRecordedOwnerId(threadId);
    if (!owner) return { kind: 'failed', reason: 'no-owner' };
    this.claimed.add(key);
    const outcome = this.submit(
      conversationId,
      dead,
      { userId: owner },
      'automatic',
    );
    if (outcome.kind === 'queued')
      this.automatic.set(conversationId, [...recent, now]);
    else this.claimed.delete(key);
    return outcome;
  }

  /**
   * A person's Continue: no cap and no pending-request rule (the request died
   * with the engine, and the person chose to go on). The inbox applies the
   * sender's own permission to send to the conversation.
   */
  continueOnRequest(input: {
    readonly conversationId: string;
    readonly actor: ThreadInboxActor;
  }): MemoryContinuationOutcome {
    const current = this.ports.service.currentConversationSessionId(
      input.conversationId,
    );
    const predecessor =
      this.ports.eventStore.conversationForSession(
        current,
      )?.predecessorSessionId;
    const memoryKilled = (threadId: string): DeadTurn | undefined => {
      const dead = this.deadTurn(threadId);
      if (dead === 'not-memory-exhausted') return undefined;
      return typeof dead === 'string' ? this.newestFailedTurn(threadId) : dead;
    };
    if (!this.ports.eventStore.hasTurnFacts(current)) {
      // The dead Session is current, or its successor is reserved and idle.
      const turn =
        memoryKilled(current) ??
        (predecessor ? memoryKilled(predecessor) : undefined);
      if (!turn) return { kind: 'skipped', reason: 'not-memory-exhausted' };
      return this.submit(input.conversationId, turn, input.actor, 'person');
    }
    const turn = memoryKilled(current);
    if (turn)
      return this.submit(input.conversationId, turn, input.actor, 'person');
    // A successor already ran: either it is this dead turn's continuation
    // (someone continued first), or the conversation moved on and an old
    // card must not start a continuation now.
    const continued = predecessor ? memoryKilled(predecessor) : undefined;
    if (continued) {
      const outcome = this.keyFor(input.conversationId, continued, 'person');
      if (
        typeof outcome !== 'string' &&
        outcome.kind === 'skipped' &&
        outcome.reason === 'already-claimed'
      )
        return outcome;
    }
    return { kind: 'skipped', reason: 'not-memory-exhausted' };
  }

  private newestFailedTurn(threadId: string): DeadTurn | undefined {
    const failure = this.ports.eventStore
      .listEventWindowByTurn(threadId, { turnLimit: 1, direction: 'newest' })
      .events.map((event) => record(event.payload))
      .filter((payload) => payload?.method === 'runtime.error')
      .at(-1);
    return typeof failure?.turnId === 'string'
      ? { threadId, turnId: failure.turnId }
      : undefined;
  }
}
