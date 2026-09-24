/**
 * Each event's own position in the server's event stream: its global
 * sequence, carried as the SSE frame id. Keyed by the event object so it
 * survives the semantic delivery buffer (which holds and later replays the
 * same object). Events that did not arrive on the stream (replay, tests that
 * fold directly) have none.
 *
 * #2436 folds a recorded approval-posture decision by it: the latest decision
 * by server order wins, whatever order frames and HTTP results arrive in.
 */
const positionByEvent = new WeakMap<object, number>();

export function recordEventPosition(
  event: object,
  position: number | undefined,
): void {
  if (position === undefined) return;
  positionByEvent.set(event, position);
}

export function eventStreamPosition(event: object): number | undefined {
  return positionByEvent.get(event);
}
