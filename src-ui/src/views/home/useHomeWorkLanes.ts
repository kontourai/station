import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clearSnooze,
  readSnoozes,
  type SnoozeMap,
  writeSnooze,
} from '../../utils/activity-snooze-store';
import {
  computeStableActiveOrder,
  type HomeLaneItem,
  isTerminalLifecycle,
  orderItemsByKeys,
  partitionHomeWorkItems,
  sortSettledTail,
  sortSnoozedShelf,
  TERMINAL_LINGER_MS,
  TERMINAL_SINCE_PRUNE_MARGIN_MS,
  WOKE_PILL_WINDOW_MS,
  withStableIds,
} from './home-lane-model';
import type { HomeWorkItem } from './home-view-model';
import { readTerminalSince, writeTerminalSince } from './terminal-since-store';

/** Re-render cadence so terminal linger / snooze wake / pill expiry progress
 * even without another prop change forcing it. Deliberately coarse — none of
 * these windows need sub-30s precision. */
const LANE_TICK_MS = 30_000;

export interface HomeWorkLanes {
  active: HomeLaneItem[];
  recentlyFinished: HomeLaneItem[];
  snoozed: HomeLaneItem[];
  settled: HomeLaneItem[];
  snoozedUntil: ReadonlyMap<string, number>;
  now: number;
  isWoken: (id: string) => boolean;
  snooze: (id: string, wakeAt: number) => void;
  wake: (id: string) => void;
}

/**
 * Derives the three Home lanes (active / snoozed / settled) plus a
* position-stable order for the active lane.
 *
 * `identityAliasRef`, `terminalSinceRef`, `orderRef`, and `wokeAtRef` are
 * mutated during render rather than via `setState`. That is safe here
 * specifically because each update is a pure, idempotent function of this
 * render's `items`/`now`: with the same inputs it always converges to the
 * same final ref state, so React StrictMode's double-invocation of the
 * render body cannot leave the refs in a divergent state (the second pass is
 * either a no-op or repeats the first pass's assignment). This is the same
 * class of exception React's own docs carve out for ref-cached derivations,
 * not a general license to write refs during render. It also does not, by
 * itself, extend to React's concurrent-rendering features — a render that
 * mutates these refs and is then interrupted/discarded (time-slicing,
 * `useTransition`, offscreen prerendering) still leaves the mutation applied
 * even though that render never committed; StrictMode's synchronous
 * double-invocation is the only concurrency shape this argument covers.
 */
export function useHomeWorkLanes(items: HomeWorkItem[]): HomeWorkLanes {
  const [now, setNow] = useState(() => Date.now());
  const [snoozeMap, setSnoozeMap] = useState<SnoozeMap>(() =>
    readSnoozes(Date.now()),
  );
  const identityAliasRef = useRef(new Map<string, string>());
  const terminalSinceRef = useRef<Map<string, number> | null>(null);
  if (terminalSinceRef.current === null) {
// Lazy ref init (React-sanctioned: safe to read/assign `ref.current`
// during render for a one-time initializer). Seeded from
// `terminal-since-store.ts` so a reload doesn't re-anchor the linger
// clock for items that were already terminal.
    terminalSinceRef.current = new Map(
      Object.entries(
        readTerminalSince(
          Date.now(),
          TERMINAL_LINGER_MS + TERMINAL_SINCE_PRUNE_MARGIN_MS,
        ),
      ),
    );
  }
  const orderRef = useRef<string[]>([]);
  const wokeAtRef = useRef(new Map<string, number>());
  const prevSnoozedIdsRef = useRef(new Set<string>());
/** Ids an explicit `wake` call is about to remove from the snoozed lane.
* The render-time diff below cannot otherwise tell that transition apart
* from a natural TTL lapse (both just look like "left the snoozed set"),
* and an explicit wake should dismiss silently rather than show a pill. */
  const explicitWakeRef = useRef(new Set<string>());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), LANE_TICK_MS);
    return () => clearInterval(id);
  }, []);

// Persist terminal-since after every render so a reload can seed the
// ref above from real anchors instead of re-anchoring to "now".
  useEffect(() => {
    writeTerminalSince(Object.fromEntries(terminalSinceRef.current ?? []));
  });

  const snoozedUntil = useMemo(
    () => new Map(Object.entries(snoozeMap)),
    [snoozeMap],
  );

// Resolve each item's stable identity BEFORE anything else keys off it —
// `laneItems[i].id` may differ from `items[i].id` in a future render even
// for "the same" row (conversationId promotion, task correlation forming);
// `.stableId` is what stays constant.
  const laneItems = withStableIds(items, identityAliasRef.current);
  const presentIds = new Set(laneItems.map((item) => item.id));

  for (const item of laneItems) {
    if (isTerminalLifecycle(item.lifecycleLabel)) {
      if (!terminalSinceRef.current.has(item.id)) {
// An item already arrives with the source's terminal update time.
// Persisted anchors can be pruned once they no longer affect the
// settled classification, so never recreate an old terminal item at
// "now" after that pruning (or on a fresh browser/store).
        terminalSinceRef.current.set(
          item.id,
          Math.min(item.updatedAt || now, now),
        );
      }
    } else if (terminalSinceRef.current.has(item.id)) {
      terminalSinceRef.current.delete(item.id);
    }
  }
  for (const id of [...terminalSinceRef.current.keys()]) {
    if (!presentIds.has(id)) terminalSinceRef.current.delete(id);
  }

  const partition = partitionHomeWorkItems({
    items: laneItems,
    now,
    snoozedUntil,
    terminalSince: terminalSinceRef.current,
  });

// "Woke from snooze" pill: any id that was in the snoozed lane last time
// this hook ran and is not this time (natural lapse or an explicit
// `wake`) gets a pill for WOKE_PILL_WINDOW_MS.
  const currentSnoozedIds = new Set(partition.snoozed.map((item) => item.id));
  for (const id of prevSnoozedIdsRef.current) {
    if (!currentSnoozedIds.has(id) && presentIds.has(id)) {
      if (explicitWakeRef.current.has(id)) {
        explicitWakeRef.current.delete(id);
      } else {
        wokeAtRef.current.set(id, now);
      }
    }
  }
  prevSnoozedIdsRef.current = currentSnoozedIds;
  for (const [id, wokeAt] of [...wokeAtRef.current]) {
    if (now - wokeAt > WOKE_PILL_WINDOW_MS || !presentIds.has(id)) {
      wokeAtRef.current.delete(id);
    }
  }

  orderRef.current = computeStableActiveOrder(
    orderRef.current,
    partition.active,
  );
  const active = orderItemsByKeys(partition.active, orderRef.current);
  const recentlyFinished = sortSettledTail(
    partition.recentlyFinished,
    terminalSinceRef.current,
  );
  const snoozed = sortSnoozedShelf(partition.snoozed, snoozedUntil);
  const settled = sortSettledTail(partition.settled, terminalSinceRef.current);

  return {
    active,
    recentlyFinished,
    snoozed,
    settled,
    snoozedUntil,
    now,
    isWoken: (id: string) => wokeAtRef.current.has(id),
    snooze: (id: string, wakeAt: number) => {
      setSnoozeMap(writeSnooze(id, wakeAt, Date.now()));
    },
    wake: (id: string) => {
// An explicit wake dismisses silently rather than showing "woke from
// snooze" for something the user just un-snoozed themselves.
      wokeAtRef.current.delete(id);
      explicitWakeRef.current.add(id);
      setSnoozeMap(clearSnooze(id, Date.now()));
    },
  };
}
