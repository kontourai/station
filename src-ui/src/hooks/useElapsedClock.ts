import { useSyncExternalStore } from 'react';

/**
 * THE ticking source for elapsed durations: one module-wide interval that
 * every subscriber reads, so two surfaces showing the same item at the same
 * instant (a Home row, the dock row, the Activity row) read the same `now`
 * and therefore the same duration. A per-surface clock is how Activity once
 * showed "0s" where Home showed "25s" for one turn: each anchored to its own
 * tick, up to 30 seconds apart.
 *
 * The interval runs only while something is subscribed. Once a second,
 * because `formatDuration` shows seconds under a minute.
 */
const TICK_MS = 1000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(tick, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function getSnapshot(): number {
  // Nothing ticking: the stored instant may be from long ago, and the first
  // subscriber's render would paint it. Catch up, but only by whole ticks,
  // so repeated reads within one render return the same value.
  if (timer === undefined && Date.now() - now >= TICK_MS) now = Date.now();
  return now;
}

const idle = () => () => {};

/** `enabled: false` (nothing elapsed on screen) holds no subscription. */
export function useElapsedClock(enabled = true): number {
  return useSyncExternalStore(
    enabled ? subscribe : idle,
    getSnapshot,
    getSnapshot,
  );
}
