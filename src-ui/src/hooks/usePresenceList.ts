import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Settles an enter or exit whose animation never ran. A little longer than
 * the `--motion-base` the CSS animates over, so a running animation or
 * transition ends it first.
 */
export const PRESENCE_FALLBACK_MS = 400;

/**
 * One rendered item of a presence list. `entering` is set only for an item
 * that arrived after the list first rendered (items present at mount do not
 * animate in); an `exiting` item has left `items` and stays where it was,
 * inert, until its exit finishes.
 */
export interface PresentItem<T> {
  key: string;
  item: T;
  phase: 'entering' | 'present' | 'exiting';
}

/**
 * Keeps an item that left `items` rendered in place so its row can collapse
 * (height and opacity) instead of vanishing and snapping its siblings, and
 * marks a newly arrived item so its row can grow in. The caller ends either
 * transition with `settle(key)` from the row's `animationend` (or
 * `transitionend`); `fallbackMs`
 * settles it anyway when the animation never runs (a hidden page, or a
 * stylesheet that has not loaded).
 */
export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  fallbackMs: number,
): { list: PresentItem<T>[]; settle: (key: string) => void } {
  const previous = useRef<PresentItem<T>[] | null>(null);
  const settled = useRef(new Set<string>());
  const [, rerender] = useState(0);

  const prior = previous.current;
  const priorByKey = new Map(prior?.map((entry) => [entry.key, entry]));
  const currentKeys = new Set<string>();
  const list: PresentItem<T>[] = items.map((item) => {
    const key = keyOf(item);
    currentKeys.add(key);
    const before = priorByKey.get(key);
    if (prior === null) return { key, item, phase: 'present' };
    if (!before || before.phase === 'exiting') {
      settled.current.delete(key);
      return { key, item, phase: 'entering' };
    }
    if (before.phase === 'entering' && !settled.current.has(key))
      return { key, item, phase: 'entering' };
    settled.current.delete(key);
    return { key, item, phase: 'present' };
  });
  prior?.forEach((entry, index) => {
    if (currentKeys.has(entry.key)) return;
    if (entry.phase === 'exiting' && settled.current.has(entry.key)) {
      settled.current.delete(entry.key);
      return;
    }
    if (entry.phase !== 'exiting') settled.current.delete(entry.key);
    // Back where it was: after the nearest earlier neighbour still listed.
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const found = list.findIndex((row) => row.key === prior[before].key);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    list.splice(at, 0, { ...entry, phase: 'exiting' });
  });
  previous.current = list;

  const moving = list
    .filter((entry) => entry.phase !== 'present')
    .map((entry) => entry.key)
    .join('\u0000');
  const settle = useCallback((key: string) => {
    if (settled.current.has(key)) return;
    settled.current.add(key);
    rerender((tick) => tick + 1);
  }, []);
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => {
      for (const key of moving.split('\u0000')) settled.current.add(key);
      rerender((tick) => tick + 1);
    }, fallbackMs);
    return () => clearTimeout(timer);
  }, [moving, fallbackMs]);

  return { list, settle };
}
