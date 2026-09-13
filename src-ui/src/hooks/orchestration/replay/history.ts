import type {
  OrchestrationConversationEventWindow,
  OrchestrationSequencedEvent,
} from '@kontourai/station-contracts/orchestration';
import { useSyncExternalStore } from 'react';

/** The committed reader state, before the production transcript projector. */
export interface ReplayHistoryState {
  events: OrchestrationSequencedEvent[];
  currentSessionId?: string;
  sessionLineage?: OrchestrationConversationEventWindow['sessionLineage'];
  handoffs: OrchestrationConversationEventWindow['handoffs'];
  contextBoundaries: NonNullable<
    OrchestrationConversationEventWindow['contextBoundaries']
  >;
  hasMore: boolean;
  loading: boolean;
  settled: boolean;
  upgradeRequired: boolean;
  errorMessage?: string;
}

export const EMPTY_REPLAY_HISTORY: ReplayHistoryState = {
  events: [],
  handoffs: [],
  contextBoundaries: [],
  hasMore: false,
  loading: false,
  settled: false,
  upgradeRequired: false,
};
const histories = new Map<string, ReplayHistoryState>();
const loaders = new Map<string, () => Promise<void>>();
const listeners = new Set<() => void>();
export function setReplayHistory(id: string, value: ReplayHistoryState | null) {
  if (value) histories.set(id, value);
  else {
    histories.delete(id);
    loaders.delete(id);
  }
  for (const listener of listeners) listener();
}
export function getReplayHistory(id: string) {
  return histories.get(id) ?? null;
}
export function useReplayHistory(id: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getReplayHistory(id),
    () => null,
  );
}

/** Recorded reads advance with the tape, never by making a synthetic HTTP request. */
export function setReplayHistoryLoader(
  id: string,
  loader: () => Promise<void>,
) {
  loaders.set(id, loader);
}
export async function requestReplayHistory(id: string): Promise<void> {
  const loader = loaders.get(id);
  if (loader) await loader();
}
