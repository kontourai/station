export type StreamConnectionPhase =
  | 'unknown'
  | 'receiving'
  | 'caught-up'
  | 'interrupted'
  | 'closed';
export interface StreamConnectionState {
  phase: StreamConnectionPhase;
  since: number;
  /**
   * When the stream last stopped being live, held across the disrupted
   * phases: a reconnect runs `interrupted` → `receiving` (catching up) →
   * `caught-up`, and one outage is one disruption, not two. Absent while the
   * stream is live. The status surface times its grace from this, so an
   * outage that moves between phases never restarts its clock (which is
   * what made the old status blink off and on at each phase change).
   */
  disruptedSince?: number;
}
const empty: StreamConnectionState = { phase: 'unknown', since: 0 };
const states = new Map<string, StreamConnectionState>();
const listeners = new Set<() => void>();
const isDisrupted = (phase: StreamConnectionPhase) =>
  phase === 'interrupted' || phase === 'receiving';
export function getStreamConnectionState(apiBase: string) {
  return states.get(apiBase) ?? empty;
}
export function subscribeStreamConnectionState(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setStreamConnectionState(
  apiBase: string,
  phase: StreamConnectionPhase,
  now = Date.now(),
) {
  const current = getStreamConnectionState(apiBase);
  const previous = current.phase;
  // A known authorization failure outranks late errors from an open stream.
  // Only a newly authenticated delivery can establish recovery.
  if (previous === phase || (previous === 'closed' && phase === 'interrupted'))
    return false;
  const disruptedSince = isDisrupted(phase)
    ? (current.disruptedSince ?? now)
    : undefined;
  states.set(apiBase, {
    phase,
    since: now,
    ...(disruptedSince !== undefined ? { disruptedSince } : {}),
  });
  for (const listener of listeners) listener();
  return true;
}
