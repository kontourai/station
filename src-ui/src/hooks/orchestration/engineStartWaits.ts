import type {
  EngineStartWaitObservation,
  OrchestrationEngineStartWaitFrame,
} from '@kontourai/station-contracts/orchestration';
import { useSyncExternalStore } from 'react';

/**
 * #4568: the engine-start waits the orchestration stream reported, per
 * Station and thread. A brand-new chat's first start has no Session summary
 * to carry its wait, so this is how its composer learns of it. Station sends
 * every change and, on each stream open, every wait still queued, so a
 * reconnect starts from an empty set rather than keeping a stale one.
 */
const waits = new Map<string, Map<string, EngineStartWaitObservation>>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function applyEngineStartWaitFrame(
  apiBase: string,
  frame: OrchestrationEngineStartWaitFrame,
): void {
  const station = waits.get(apiBase) ?? new Map();
  if (frame.wait) station.set(frame.threadId, frame.wait);
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
    const wait = id ? station.get(id) : undefined;
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

export function resetEngineStartWaitsForTests(): void {
  waits.clear();
  notify();
}
