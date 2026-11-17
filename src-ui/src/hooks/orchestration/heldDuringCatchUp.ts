import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from './streamConnectionState';

/**
 * Whether `apiBase`'s event stream is replaying what this document missed:
 * from its first frame after a (re)connect until `caught-up`. Raw, with no
 * grace period, unlike the "Catching up…" status a person reads.
 */
export function useStreamCatchingUp(apiBase: string | undefined): boolean {
  const read = () =>
    apiBase !== undefined &&
    getStreamConnectionState(apiBase).phase === 'receiving';
  return useSyncExternalStore(subscribeStreamConnectionState, read, read);
}

/**
 * A reconnect replays what a view missed one event at a time, so a request
 * opened and resolved inside the gap would otherwise flash through the
 * approval surfaces: counts climb, then count down. While `catchingUp`, this
 * keeps returning the value from before the replay began, and the value
 * flows again once the replay ends.
 *
 * The hold is bounded (`maxHoldMs`): a catch-up that never reports its end
 * must not freeze what the person can answer.
 */
export function useHeldDuringCatchUp<T>(
  value: T,
  catchingUp: boolean,
  maxHoldMs = MAX_CATCH_UP_HOLD_MS,
): T {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    setExpired(false);
    if (!catchingUp) return;
    const timer = setTimeout(() => setExpired(true), maxHoldMs);
    return () => clearTimeout(timer);
  }, [catchingUp, maxHoldMs]);
  // Only a REconnect holds: one that follows a catch-up this view saw finish.
  // The first connection also replays before it is caught up (and a stream
  // that never reports catching up stays "receiving"), so holding then would
  // hide what is already waiting.
  const wasCatchingUp = useRef(catchingUp);
  const caughtUpOnce = useRef(false);
  if (wasCatchingUp.current && !catchingUp) caughtUpOnce.current = true;
  wasCatchingUp.current = catchingUp;
  const holding = catchingUp && !expired && caughtUpOnce.current;
  const held = useRef(value);
  if (!holding) held.current = value;
  return holding ? held.current : value;
}

export const MAX_CATCH_UP_HOLD_MS = 5_000;

const settledRequestIds = new Set<string>();
const MAX_SETTLED = 256;

/**
 * Requests Station itself reported settled (checked from the approval sheet,
 * or refused as already answered) that a transcript or chat record may still
 * list: its resolution fell outside the loaded window, or none was written.
 * Module-wide, so every surface counting approvals agrees, and a remount
 * cannot bring the request back.
 */
export function rememberSettledRequest(requestId: string | undefined) {
  if (!requestId) return;
  settledRequestIds.add(requestId);
  for (const old of [...settledRequestIds].slice(
    0,
    Math.max(0, settledRequestIds.size - MAX_SETTLED),
  ))
    settledRequestIds.delete(old);
}

export function isSettledRequest(requestId: string | undefined): boolean {
  return requestId !== undefined && settledRequestIds.has(requestId);
}

/** Tests only. */
export function forgetSettledRequests() {
  settledRequestIds.clear();
}
