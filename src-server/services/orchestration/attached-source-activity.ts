import {
  ATTACHED_SOURCE_ACTIVE_WINDOW_MS,
  type AttachedSourceActivity,
} from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { activeTurnIdForEvents } from './session-lifecycle-service.js';

/**
 * Whether the external harness behind a read-only attached session is still
 * working on it (`AttachedSourceActivity`), from the events Station imported
 * from its transcript.
 *
 * The open turn is the same fold `hasActiveTurn` uses. The write time is the
 * newest event's `createdAt`, which is the transcript record's own time: the
 * follower dates the events it writes itself (envelope, owner record) no later
 * than the newest source event, never `now`, so they cannot make a dormant
 * transcript look freshly written.
 *
 * Recency gates the open turn because a turn can stay open forever: Claude
 * Code records a completion (`turn_duration`) only in interactive runs, and an
 * interrupted or crashed run records none.
 */
export function deriveAttachedSourceActivity(
  events: readonly CanonicalRuntimeEvent[],
  now: number,
): AttachedSourceActivity {
  let lastWriteMs: number | undefined;
  let lastWriteAt: string | undefined;
  for (const event of events) {
    const ms = Date.parse(event.createdAt);
    if (
      Number.isFinite(ms) &&
      (lastWriteMs === undefined || ms > lastWriteMs)
    ) {
      lastWriteMs = ms;
      lastWriteAt = event.createdAt;
    }
  }
  const written = lastWriteAt ? { lastWriteAt } : {};
  if (activeTurnIdForEvents([...events]) === undefined)
    return { state: 'idle', ...written };
  return lastWriteMs !== undefined &&
    now - lastWriteMs <= ATTACHED_SOURCE_ACTIVE_WINDOW_MS
    ? { state: 'active', ...written }
    : { state: 'quiet', ...written };
}
