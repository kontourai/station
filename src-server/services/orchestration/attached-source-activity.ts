import {
  ATTACHED_SOURCE_ACTIVE_WINDOW_MS,
  type AttachedSourceActivity,
} from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { activeTurnIdForEvents } from './session-lifecycle-service.js';

/**
 * How far past the read time a write may be dated and still count (as now).
 * Sources are read on this host, so their clocks agree to well within this;
 * a write dated later is not evidence of recent activity and is not counted.
 * Clamping it to the read time instead would keep it `active` until its own
 * date plus the window.
 */
export const ATTACHED_SOURCE_CLOCK_SKEW_MS = 60_000;

/**
 * Whether the external harness behind a read-only attached session is still
 * working on it (`AttachedSourceActivity`), from what Station observed of its
 * transcript.
 *
 * The open turn is the same fold `hasActiveTurn` uses. The write time is the
 * later of the newest event's `createdAt` (the record's own time: the
 * follower dates the events it writes itself no later than the newest source
 * event, never `now`) and `sourceWriteAt`, the newest write the source itself
 * reported (`AttachedSessionSourceMetadata.lastWriteAt`), which covers writes
 * that produce no event: an OpenCode step still streaming, or a Claude
 * subagent writing its own transcript.
 *
 * Recency gates the open turn because a turn can stay open forever: Claude
 * Code records a completion (`turn_duration`) only in interactive runs, and an
 * interrupted or crashed run records none.
 */
export function deriveAttachedSourceActivity(
  events: readonly CanonicalRuntimeEvent[],
  now: number,
  sourceWriteAt?: string,
): AttachedSourceActivity {
  let lastWriteMs: number | undefined;
  let lastWriteAt: string | undefined;
  const consider = (at: string | undefined) => {
    if (at === undefined) return;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms > now + ATTACHED_SOURCE_CLOCK_SKEW_MS)
      return;
    if (lastWriteMs === undefined || ms > lastWriteMs) {
      lastWriteMs = ms;
      lastWriteAt = at;
    }
  };
  for (const event of events) consider(event.createdAt);
  consider(sourceWriteAt);
  const written = lastWriteAt ? { lastWriteAt } : {};
  if (activeTurnIdForEvents([...events]) === undefined)
    return { state: 'idle', ...written };
  return lastWriteMs !== undefined &&
    now - Math.min(lastWriteMs, now) <= ATTACHED_SOURCE_ACTIVE_WINDOW_MS
    ? { state: 'active', ...written }
    : { state: 'quiet', ...written };
}
