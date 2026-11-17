import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * #4827: whether a person typed a turn's prompt. The one shared answer for
 * every reader that must tell a person's own words from text an agent, a
 * peer Station, a bridge or Station itself put in a conversation: the
 * approval guardian's person section, and any guard that lets only a
 * person-started turn do something.
 *
 * The answer is a positive, server-stamped mark, never an inference:
 *
 * - `authoredBy: 'person'` on the `turn.started`, which `ClientOriginTurnPropagation`
 *   stamps only for a send or steer that a composer route proved a person
 *   typed into one of Station's own clients (`personTypedRequest`), or that
 *   such a route queued on the conversation inbox. An adapter-supplied
 *   value is dropped before it is stored.
 * - and, as defence in depth, no `clientOrigin.sender` (an agent, a
 *   delegated result, a coordinator, an engine) and no `promptSource` (an
 *   MCP server's prompt expansion).
 *
 * Do NOT decide this from `dispatchOrigin: 'interactive'` or a Session's
 * `priorOrigin()`: those say whose chat a turn was placed in, and a
 * delegated child's result continuing in a person's chat inherits
 * `interactive`. Do not decide it from `clientOrigin.actor` either: a peer
 * Station's delegation credential, the CLI and chat bridges all resolve to a
 * device or operator actor. A turn recorded before the mark existed has
 * none, so it is not the person's (fail closed).
 *
 * A steer a person typed carries the mark too. "Was this turn started by a
 * person" asks about the turn's own start, not its steers; use
 * {@link isCurrentTurnPersonAuthored}.
 */
export function isPersonAuthoredTurn(
  event: Pick<CanonicalRuntimeEvent, 'method'> & {
    authoredBy?: unknown;
    promptSource?: unknown;
    clientOrigin?: { sender?: unknown } | null;
  },
): boolean {
  return (
    event.method === 'turn.started' &&
    event.authoredBy === 'person' &&
    event.promptSource === undefined &&
    (event.clientOrigin?.sender ?? undefined) === undefined
  );
}

/**
 * {@link isPersonAuthoredTurn} as a SQL condition over an
 * `orchestration_events` row's JSON `payload`, for readers that select in
 * the store. Kept beside the predicate so the two cannot drift; a test runs
 * both over the same stored turns.
 */
export const PERSON_AUTHORED_TURN_SQL = `method = 'turn.started'
  AND json_valid(payload)
  AND json_extract(payload, '$.authoredBy') = 'person'
  AND json_type(payload, '$.promptSource') IS NULL
  AND json_type(payload, '$.clientOrigin.sender') IS NULL`;

/** The store read {@link isCurrentTurnPersonAuthored} needs. */
export interface CurrentTurnStartReader {
  /** The thread's newest own `turn.started` (never a steer), if any. */
  latestOwnTurnStarted(
    threadId: string,
  ): { payload: CanonicalRuntimeEvent } | undefined;
}

/**
 * Whether the turn now running (or last run) on `threadId` was started by a
 * person typing it, by its own `turn.started`, never a steer. `threadId` is
 * the orchestration thread, which every engine adapter passes as
 * `InvocationContext.conversationId`. No turn means no.
 */
export function isCurrentTurnPersonAuthored(
  store: CurrentTurnStartReader,
  threadId: string,
): boolean {
  const started = store.latestOwnTurnStarted(threadId);
  return started !== undefined && isPersonAuthoredTurn(started.payload);
}

/**
 * {@link isCurrentTurnPersonAuthored} for a tool call's invocation: its
 * `conversationId` is the orchestration thread. An invocation with none
 * (a direct, non-orchestrated run) was not started by a person typing.
 */
export function isInvocationTurnPersonAuthored(
  store: CurrentTurnStartReader,
  invocation: { conversationId?: string },
): boolean {
  return (
    invocation.conversationId !== undefined &&
    isCurrentTurnPersonAuthored(store, invocation.conversationId)
  );
}
