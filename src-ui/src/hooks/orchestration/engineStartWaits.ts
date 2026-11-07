import type {
  EngineStartWaitObservation,
  OrchestrationEngineStartWaitFrame,
} from '@kontourai/station-contracts/orchestration';
import { useSyncExternalStore } from 'react';

/** Transient, authorized start status. Reconnects and replacement snapshots
 * clear it before Station sends the starts that remain pending. */
const waits = new Map<string, Map<string, OrchestrationEngineStartWaitFrame>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function applyEngineStartWaitFrame(
  apiBase: string,
  frame: OrchestrationEngineStartWaitFrame,
): void {
  const station = waits.get(apiBase) ?? new Map();
  if (frame.wait || frame.pendingStart) station.set(frame.threadId, frame);
  else if (!station.delete(frame.threadId)) return;
  if (station.size) waits.set(apiBase, station);
  else waits.delete(apiBase);
  notify();
}

/** The stream (re)opened: Station re-sends what is still waiting. */
export function clearEngineStartWaits(apiBase: string): void {
  if (waits.delete(apiBase)) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The first reported wait among `threadIds` (a chat's candidate ids). */
export function readEngineStartWait(
  apiBase: string,
  threadIds: readonly (string | undefined)[],
): EngineStartWaitObservation | undefined {
  const station = waits.get(apiBase);
  if (!station) return undefined;
  for (const id of threadIds) {
    const wait = id ? station.get(id)?.wait : undefined;
    if (wait) return wait;
  }
  return undefined;
}

export function useEngineStartWait(
  apiBase: string,
  threadIds: readonly (string | undefined)[],
): EngineStartWaitObservation | undefined {
  const read = () => readEngineStartWait(apiBase, threadIds);
  return useSyncExternalStore(subscribe, read, read);
}

/** The server-owned first-start identity that Stop can address without a Session. */
export function readPendingEngineStart(
  apiBase: string,
  threadId: string,
): boolean {
  return waits.get(apiBase)?.get(threadId)?.pendingStart === true;
}
