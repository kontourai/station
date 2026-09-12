import type { ProviderSessionContinuationBoundary } from '@kontourai/station-contracts/provider';
import type { EventStore } from './event-store.js';

/** Read an observed native boundary; this does not create execution authority. */
export function readCompletedSourceBoundary(
  store: Pick<EventStore, 'latestEventByMethod'>,
  provider: string,
  threadId: string,
): ProviderSessionContinuationBoundary | undefined {
  const latest = store.latestEventByMethod(threadId, 'turn.completed', true);
  const event = latest?.payload;
  if (
    !latest ||
    latest.provider !== provider ||
    latest.threadId !== threadId ||
    event?.provider !== provider ||
    event.threadId !== threadId ||
    event.method !== 'turn.completed' ||
    event.finishReason !== 'stop' ||
    typeof event.turnId !== 'string' ||
    !event.turnId.trim() ||
    event.turnId.length > 512 ||
    !latest.id ||
    latest.id.length > 512
  )
    return undefined;
  return {
    kind: 'completed-turn',
    providerTurnId: event.turnId,
    observedEventId: latest.id,
  };
}
