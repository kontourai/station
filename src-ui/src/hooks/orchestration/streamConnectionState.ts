export type StreamConnectionPhase =
  | 'unknown'
  | 'receiving'
  | 'caught-up'
  | 'interrupted'
  | 'closed';
export interface StreamConnectionState {
  phase: StreamConnectionPhase;
  since: number;
}
const empty: StreamConnectionState = { phase: 'unknown', since: 0 };
const states = new Map<string, StreamConnectionState>();
const listeners = new Set<() => void>();
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
) {
  const previous = getStreamConnectionState(apiBase).phase;
  // A known authorization failure outranks late errors from an open stream.
  // Only a newly authenticated delivery can establish recovery.
  if (previous === phase || (previous === 'closed' && phase === 'interrupted'))
    return false;
  states.set(apiBase, { phase, since: Date.now() });
  for (const listener of listeners) listener();
  return true;
}
