import { useEffect, useRef, useState } from 'react';
import type { HomeLifecycleLabel } from '../../utils/lifecycle-priority';
import type { HomeWorkItem } from '../../views/home/home-view-model';

/**
 * How long a row's new lifecycle must hold before the list shows it. The
 * inbox groups and sorts by lifecycle, so a state that flickers — a turn
 * that reads idle for a moment while a reconnect catches up, a snapshot and
 * a live event briefly disagreeing — would move the row between the Running
 * and Idle lanes and back. Held, a blip never reaches the screen.
 */
export const LIFECYCLE_HOLD_MS = 1_200;

/**
 * Never held, in either direction: a state that asks the user to act (the
 * "Needs you" lane is exactly `Needs attention`) must never wait to appear,
 * and once answered it must not linger there as a stale ask.
 */
const IMMEDIATE = new Set<HomeLifecycleLabel>(['Needs attention', 'Failed']);

interface Held {
  shown: HomeLifecycleLabel;
  pending?: HomeLifecycleLabel;
  pendingSince?: number;
}

/**
 * The items with each row's lifecycle held through brief changes (see
 * `LIFECYCLE_HOLD_MS`). Only a move into or out of `Running` is held — that
 * is the state that flickers. A row's first appearance, a change into or out of an
 * act-now state, and every other change show at once. Rows that are
 * not being held keep their identity, and when nothing is held the input
 * array itself is returned, so memoized grouping downstream is undisturbed.
 */
export function useHeldLifecycles(
  items: HomeWorkItem[],
  holdMs = LIFECYCLE_HOLD_MS,
): HomeWorkItem[] {
  const held = useRef(new Map<string, Held>());
  const [, setWake] = useState(0);
  const now = Date.now();
  let nextDue: number | undefined;
  let changed = false;
  const seen = new Set<string>();
  const result = items.map((item) => {
    seen.add(item.id);
    const actual = item.lifecycleLabel;
    const entry = held.current.get(item.id);
    if (
      !entry ||
      entry.shown === actual ||
      IMMEDIATE.has(actual) ||
      IMMEDIATE.has(entry.shown) ||
      // Only moves into or out of "in motion" flicker (a turn that reads
      // idle for a beat mid-reconnect); leaving Draft, a failure clearing,
      // and the like are real events and show at once.
      (entry.shown !== 'Running' && actual !== 'Running')
    ) {
      held.current.set(item.id, { shown: actual });
      return item;
    }
    if (entry.pending !== actual) {
      entry.pending = actual;
      entry.pendingSince = now;
    }
    const due = (entry.pendingSince ?? now) + holdMs;
    if (now >= due) {
      held.current.set(item.id, { shown: actual });
      return item;
    }
    nextDue = nextDue === undefined ? due : Math.min(nextDue, due);
    changed = true;
    return { ...item, lifecycleLabel: entry.shown };
  });
  for (const id of held.current.keys()) {
    if (!seen.has(id)) held.current.delete(id);
  }

  useEffect(() => {
    if (nextDue === undefined) return;
    const timer = setTimeout(
      () => setWake((tick) => tick + 1),
      Math.max(0, nextDue - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nextDue]);

  return changed ? result : items;
}
