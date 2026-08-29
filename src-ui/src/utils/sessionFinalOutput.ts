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
 */
export function latestTurnOutputText(
  events: OrchestrationEvent[],
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.method === 'turn.completed' && event.outputText?.trim()) {
      return event.outputText;
    }
  }
  return null;
}
