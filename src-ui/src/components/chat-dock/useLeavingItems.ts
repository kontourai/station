import { useEffect, useRef, useState } from 'react';

/** How long a removed row keeps rendering while it collapses (`--motion-base`). */
export const LEAVING_MS = 240;

/**
 * The rows to render: the current ones, plus each one just removed, marked
 * `leaving`, for as long as its collapse runs. Rows then come and go by
 * animating their own height instead of snapping their neighbours.
 */
export function useLeavingItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Array<{ item: T; key: string; leaving: boolean }> {
  const [leaving, setLeaving] = useState<Map<string, T>>(() => new Map());
  const previous = useRef<readonly T[]>(items);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    const current = new Set(items.map(keyOf));
    const removed = previous.current.filter(
      (item) => !current.has(keyOf(item)),
    );
    previous.current = items;
    if (removed.length === 0) return;
    setLeaving((map) => {
      const next = new Map(map);
      for (const item of removed) next.set(keyOf(item), item);
      return next;
    });
    // Not cleared when the list changes again: each removal finishes its
    // own collapse.
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLeaving((map) => {
        const next = new Map(map);
        for (const item of removed) next.delete(keyOf(item));
        return next;
      });
    }, LEAVING_MS);
    timers.current.add(timer);
  }, [items, keyOf]);
  const present = items.map((item) => ({
    item,
    key: keyOf(item),
    leaving: false,
  }));
  const presentKeys = new Set(present.map((row) => row.key));
  for (const [key, item] of leaving)
    if (!presentKeys.has(key)) present.push({ item, key, leaving: true });
  return present;
}
