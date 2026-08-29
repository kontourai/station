import type { OrchestrationEvent } from '../hooks/orchestration/types';

/**
 * #765 D6: the session's actual final output — the latest completed turn's
 * own `outputText`. A completed delegated task used to show only metadata
 * tiles and a collapsed "Details · N events"; the answer the task produced
 * was never surfaced by default. Read straight off `turn.completed` (the
 * adapter-reported terminal text), never accumulated from deltas — a partial
 * stream must not present as a final answer. `null` means no completed turn
 * has reported output, and callers render nothing rather than a placeholder.
 *
 * Its own module (not `useMutableSessionDetailState`) because it is a pure
 * projection over the event feed, and the detail-state hook module is
 * routinely mocked whole by structural tests.
 *
 * Only the LATEST terminal turn is consulted — never an earlier one. A
 * cancelled turn (`finishReason: 'cancelled'`, the adapter's mapping for an
 * interrupted turn) carries whatever partial text had streamed before the
 * abort; presenting that as the final answer would be a lie, and falling
 * back to a previous turn's answer would present a superseded result as THE
 * result. Both cases render nothing.
 */
export function latestTurnOutputText(
  events: OrchestrationEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.method !== 'turn.completed') {
      continue;
    }
    if (event.finishReason === 'cancelled') {
      return null;
    }
    return event.outputText?.trim() ? event.outputText : null;
  }
  return null;
}
