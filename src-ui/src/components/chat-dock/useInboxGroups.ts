import { useMemo, useSyncExternalStore } from 'react';
import {
  readSnoozes,
  snoozesVersion,
  subscribeSnoozes,
} from '../../utils/activity-snooze-store';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import {
  groupMobileActivity,
  type MobileActivityGroup,
} from './mobile-activity-groups';
import { useHeldLifecycles } from './useHeldLifecycles';

/**
 * THE inbox's groups, from its live sources: the items with brief lifecycle
 * churn held (`useHeldLifecycles`) and the snooze map re-read on every
 * snooze write in this tab. The desktop inbox panel renders these, and the
 * inbox toggle's "Show inbox, 3 need you" counts the same Needs-you group,
 * so snoozing a row and then hiding the inbox cannot leave the toggle
 * counting a row the panel no longer shows.
 */
export function useInboxGroups(
  items: HomeWorkItem[],
  now: number,
): MobileActivityGroup[] {
  const heldItems = useHeldLifecycles(items);
  const version = useSyncExternalStore(
    subscribeSnoozes,
    snoozesVersion,
    snoozesVersion,
  );
  // `version` is the dependency that re-reads the map after a write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the change signal for readSnoozes
  const snoozed = useMemo(() => readSnoozes(now), [now, version]);
  return useMemo(
    () => groupMobileActivity(heldItems, now, snoozed),
    [heldItems, now, snoozed],
  );
}

/** How many rows the inbox's Needs-you group holds, from `useInboxGroups`. */
export function useInboxNeedsYouCount(
  items: HomeWorkItem[],
  now: number,
): number {
  const groups = useInboxGroups(items, now);
  return groups.find((group) => group.id === 'needsYou')?.items.length ?? 0;
}
