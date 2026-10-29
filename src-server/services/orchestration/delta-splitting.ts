/**
 * Oversized text and reasoning deltas are split, never spilled
 * (docs/design/event-content-spill.md#deltas-split-never-spilled).
 *
 * A delta is a fragment by definition, so cutting one into ordered chunks
 * loses nothing, and every reader that concatenates deltas (the transcript
 * projection, delegation output, the live UI stream, the CLI) keeps working
 * on plain strings. Each chunk is measured on its JSON string body, so the
 * chunk's event stays far inside EventStore's stored-event target.
 */
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  jsonStringBodyBytes,
  splitJsonTextByEscapedBytes,
} from './event-content-spill.js';

/** Escaped bytes of text per delta event. */
export const DELTA_SPLIT_MAX_BYTES = 8 * 1024;

const SPLITTABLE = new Set(['content.text-delta', 'content.reasoning-delta']);

/**
 * The event itself, or its ordered chunks. The first chunk keeps the event
 * id; chunk `k` gets `${eventId}:${k}`, so a replay of the same delta
 * produces the same ids and EventStore's duplicate handling still applies.
 */
export function splitOversizedDelta(
  event: CanonicalRuntimeEvent,
): CanonicalRuntimeEvent[] {
  if (!SPLITTABLE.has(event.method)) return [event];
  const delta = (event as { delta?: unknown }).delta;
  if (typeof delta !== 'string') return [event];
  if (jsonStringBodyBytes(delta) <= DELTA_SPLIT_MAX_BYTES) return [event];
  return splitJsonTextByEscapedBytes(delta, DELTA_SPLIT_MAX_BYTES).map(
    (chunk, index) =>
      ({
        ...event,
        eventId: index === 0 ? event.eventId : `${event.eventId}:${index}`,
        delta: chunk,
      }) as CanonicalRuntimeEvent,
  );
}

/** An adapter stream with every oversized delta split in order. */
export async function* splitOversizedDeltas(
  events: AsyncIterable<CanonicalRuntimeEvent>,
): AsyncGenerator<CanonicalRuntimeEvent> {
  for await (const event of events) yield* splitOversizedDelta(event);
}
