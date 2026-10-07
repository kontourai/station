import { useSyncExternalStore } from 'react';

/**
 * THE ticking source for elapsed durations: one module-wide interval that
 * every subscriber reads, so two surfaces showing the same item at the same
 * instant (a Home row, the dock row, the Activity row, the chat status pill)
 * read the same `now` and therefore the same duration. A per-surface clock is
 * how Activity once showed "0s" where Home showed "25s" for one turn: each
 * anchored to its own tick, up to 30 seconds apart.
 *
 * The interval runs only while something is subscribed and the page is
 * visible. Once a second, because `formatDuration` shows seconds under a
 * minute. A hidden page holds no timer; becoming visible catches up at once.
 */
const TICK_MS = 1000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function pageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function tick() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function start() {
  if (timer !== undefined || pageHidden()) return;
  timer = setInterval(tick, TICK_MS);
}

function stop() {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

function onVisibilityChange() {
  if (pageHidden()) {
    stop();
    return;
  }
  tick();
  start();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    now = Date.now();
    start();
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibilityChange);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop();
      if (typeof document !== 'undefined')
        document.removeEventListener('visibilitychange', onVisibilityChange);
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
