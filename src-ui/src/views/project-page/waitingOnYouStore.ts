import { useSyncExternalStore } from 'react';

/**
 * The Waiting on you counts per Project slug (#5064), published by the one
 * lazily loaded `ProjectWaitingOnYouSource` the sidebar mounts while the
 * `project-overview` preview is on, and read by the sidebar rows and the
 * Room header. Keeping the Tasks read and the Overview rule in that lazy
 * source keeps both out of the sidebar's first paint and out of the entry
 * bundle. Empty until the source has counted, and again once it unmounts.
 */
const EMPTY: ReadonlyMap<string, number> = new Map();
let current: ReadonlyMap<string, number> = EMPTY;
const listeners = new Set<() => void>();

export function publishWaitingOnYou(counts: ReadonlyMap<string, number>) {
  const next = counts.size ? counts : EMPTY;
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWaitingOnYouCounts(): ReadonlyMap<string, number> {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => EMPTY,
  );
}
