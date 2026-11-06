import { DELEGATION_PROVENANCE_METADATA_KEY } from '@kontourai/station-contracts/provider';
import { turnDispatchOrigin } from '@kontourai/station-contracts/runtime-events';
import type { EventStore } from './event-store.js';
import type { SessionDispatchFacts } from './thread-inbox.js';

/**
 * #4512: a Session's dispatch facts from its own record. A delegated child
 * is one whose start carries the provenance stamp only a dispatch route
 * writes for a context Station derived or attested (`direct-claim` is a
 * requester's own word). Its prior origin is that of its newest turn that
 * was not itself a delegated result. `taskBound` is its room execution
 * binding. Together: whether the Session works for no one watching it.
 */
export function readSessionDispatchFacts(
  eventStore: Pick<
    EventStore,
    | 'latestEventByMethod'
    | 'listEventsByMethods'
    | 'readProjectTaskRoomExecutionBinding'
  >,
  sessionId: string,
): SessionDispatchFacts & { readonly taskBound: boolean } {
  const started = eventStore.latestEventByMethod(sessionId, 'session.started')
    ?.payload as { metadata?: Record<string, unknown> } | undefined;
  const provenance = started?.metadata?.[DELEGATION_PROVENANCE_METADATA_KEY];
  return {
    taskBound:
      eventStore.readProjectTaskRoomExecutionBinding(sessionId) !== undefined,
    delegatedChild:
      provenance === 'caller-derived' || provenance === 'runtime-attested',
    priorOrigin: () => {
      const prior = eventStore
        .listEventsByMethods(sessionId, ['turn.started'])
        .map(
          (event) =>
            event.payload as {
              dispatchOrigin?: unknown;
              clientOrigin?: { sender?: { kind?: unknown } };
            },
        )
        .filter(
          (payload) =>
            payload.clientOrigin?.sender?.kind !== 'delegation-result',
        )
        .at(-1);
      return prior ? turnDispatchOrigin(prior) : 'unknown';
    },
  };
}
