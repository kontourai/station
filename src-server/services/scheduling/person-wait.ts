import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * How long an automation Task may wait for a person in total, across all of
 * its approval and input requests, before its turn is interrupted. Approval
 * requests carry no expiry of their own and the idle-session sweep never
 * parks a Session with a running turn, so without this an unanswered request
 * would hold an engine and an episode open indefinitely. A day leaves room
 * for an overnight answer.
 */
export const AUTOMATION_PERSON_WAIT_CEILING_MS = 24 * 60 * 60 * 1000;

export type PersonWait = Readonly<{
  /** Time spent with at least one blocking request open, up to `now`. */
  waitedMs: number;
  /** When the open wait began; absent when no request is open now. */
  waitingSince?: number;
}>;

/**
 * Folds a Session's persisted events into the time it spent waiting on a
 * person: from a blocking `request.opened` until its `request.resolved`, or
 * until a turn terminal (`turn.completed`, `turn.aborted`) or
 * `session.exited`, which leaves nothing waiting for the answer. Overlapping
 * requests count once. An asynchronous question (`blocking: false`) does not
 * stop the Agent working, so it is not waiting.
 *
 * Derived from the event log alone, so the same answer comes back after a
 * restart: a request still open then has been waiting since it opened.
 */
export function foldPersonWait(
  events: readonly CanonicalRuntimeEvent[],
  now: number,
): PersonWait {
  const open = new Set<string>();
  let since: number | undefined;
  let waitedMs = 0;
  const close = (at: number) => {
    if (since !== undefined) waitedMs += Math.max(0, at - since);
    since = undefined;
  };
  for (const event of events) {
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    if (event.method === 'request.opened') {
      if (event.blocking === false) continue;
      open.add(event.requestId);
      since ??= at;
    } else if (event.method === 'request.resolved') {
      if (!open.delete(event.requestId) || open.size > 0) continue;
      close(at);
    } else if (
      event.method === 'turn.completed' ||
      event.method === 'turn.aborted' ||
      event.method === 'session.exited'
    ) {
      open.clear();
      close(at);
    }
  }
  if (since === undefined) return { waitedMs };
  return { waitedMs: waitedMs + Math.max(0, now - since), waitingSince: since };
}
