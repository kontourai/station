import { useMemo, useSyncExternalStore } from 'react';
import {
  readSnoozes,
  snoozesVersion,
  subscribeSnoozes,
} from '../../utils/activity-snooze-store';
import { workAttentionCount } from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import {
  groupMobileActivity,
  type MobileActivityGroup,
} from './mobile-activity-groups';
import { useInboxScope } from './InboxScopeFilter';
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
  workFacts?: WorkFactsById,
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
    () => groupMobileActivity(heldItems, now, snoozed, workFacts),
    [heldItems, now, snoozed, workFacts],
  );
}

/** How many rows the inbox's Needs-you group holds, from `useInboxGroups`. */
export function useInboxNeedsYouCount(
  items: HomeWorkItem[],
  now: number,
): number {
  const groups = useInboxGroups(items, now);
  const group = groups.find((group) => group.id === 'needsYou');
  return group ? workAttentionCount(group.items, now, group.childrenById) : 0;
}

/**
 * How many rows the inbox shows as Running: its own scope filter, then its
 * own groups (held lifecycles included), so the toggle's "N working" badge
 * is a count of exactly the rows that say Running. Not the dock's open chat
 * tabs, which miss chats running elsewhere and, after a reload, every chat
 * whose local state has not caught up yet.
 */
export function useInboxWorkingCount(
  items: HomeWorkItem[],
  now: number,
  workFacts?: WorkFactsById,
): number {
  const scope = useInboxScope(items, now, workFacts);
  const groups = useInboxGroups(scope.items, now, workFacts);
  return groups.find((group) => group.id === 'running')?.items.length ?? 0;
}
