import type { OrchestrationEvent } from '../types';

/** Bind a tape event to the synthetic replay chat. Lineage ids stay off the chat. */
export function rewriteEventThreadId(
  event: OrchestrationEvent,
  replayId: string,
): OrchestrationEvent {
  return { ...event, threadId: replayId };
}
