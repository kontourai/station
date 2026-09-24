/**
 * The latest orchestration event-stream position this client has applied,
 * per Station. The position is the server's own event sequence (the SSE frame
 * id `ensureOrchestrationEventStream` already tracks for resume), so it orders
 * a client's action against server events without comparing clocks.
 *
 * #2334 stamps an approval pick with it: a report at a later position was
 * decided after the user picked.
 */
const latestByApiBase = new Map<string, number>();

export function recordStreamPosition(
  apiBase: string,
  position: number | undefined,
): void {
  if (position === undefined) return;
  const previous = latestByApiBase.get(apiBase);
  if (previous === undefined || position > previous)
    latestByApiBase.set(apiBase, position);
}

export function latestStreamPosition(apiBase: string): number | undefined {
  return latestByApiBase.get(apiBase);
}

/**
 * Each event's own stream position, keyed by the event object so it survives
 * the semantic delivery buffer (which holds and later replays the same
 * object). Events that did not arrive on the stream (replay, tests that fold
 * directly) have none.
 */
const positionByEvent = new WeakMap<object, number>();

export function recordEventPosition(
  apiBase: string,
  event: object,
  position: number | undefined,
): void {
  if (position === undefined) return;
  positionByEvent.set(event, position);
  recordStreamPosition(apiBase, position);
}

export function eventStreamPosition(event: object): number | undefined {
  return positionByEvent.get(event);
}
