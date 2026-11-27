import { useMemo, useSyncExternalStore } from 'react';
import { useAuthorityPersistence } from '../../contexts/AuthorityPersistenceContext';
import {
  readSnoozes,
  snoozesVersion,
  subscribeSnoozes,
} from '../../utils/activity-snooze-store';
import {
  finishedAtOf,
  workAttentionCount,
} from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';
import { workStatus } from '../../views/home/work-status';
import { useInboxScope } from './InboxScopeFilter';
import { useInboxDismissals } from './inbox-dismissals';
import {
  groupMobileActivity,
  type MobileActivityGroup,
} from './mobile-activity-groups';
import { useConversationWorkState } from './useConversationWorkState';

/**
 * THE inbox's groups, from its live sources: the items with brief lifecycle
 * churn held (`useHeldLifecycles`) and the snooze map re-read on every
 * snooze write in this tab. The desktop inbox panel renders these, and the
 * inbox toggle's "Show chats, 3 need you" counts the same Needs-you group,
 * so snoozing a row and then hiding the inbox cannot leave the toggle
 * counting a row the panel no longer shows.
 */
export function useInboxGroups(
  items: HomeWorkItem[],
  now: number,
  workFacts?: WorkFactsById,
  query = '',
): MobileActivityGroup[] {
  const { namespace } = useAuthorityPersistence();
  const term = query.trim().toLocaleLowerCase();
  const matchingItems = useMemo(
    () =>
      term
        ? items.filter((item) =>
            [
              item.title,
              item.projectLabel,
              item.agentLabel,
              item.environmentLabel,
              workFacts?.get(item.id)?.station?.label,
            ].some((value) => value?.toLocaleLowerCase().includes(term)),
          )
        : items,
    [items, term, workFacts],
  );
  const includeDismissed = Boolean(term);
  const { visible, dismissed } = useInboxDismissals(matchingItems, workFacts);
  const state = useConversationWorkState();
  const resolution = useMemo(
    () => (state.supported ? new Set(Object.keys(state.settled)) : undefined),
    [state.supported, state.settled],
  );
  const version = useSyncExternalStore(
    subscribeSnoozes,
    snoozesVersion,
    snoozesVersion,
  );
  // `version` is the dependency that re-reads the map after a write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the change signal for readSnoozes
  const snoozed = useMemo(
    () => readSnoozes(now, namespace),
    [now, version, namespace],
  );
  const windowed = Boolean(resolution) && !term;
  const settledAt = state.settled;
  return useMemo(
    () => [
      ...groupMobileActivity(visible, now, snoozed, workFacts, resolution).map(
        (group) => (windowed ? windowShelf(group, now, settledAt) : group),
      ),
      ...(includeDismissed && dismissed.length
        ? [
            {
              id: 'dismissed' as const,
              // Rows marked done on this device, or hidden on the host.
              label: 'Marked done',
              items: dismissed,
            },
          ]
        : []),
    ],
    [
      visible,
      now,
      snoozed,
      workFacts,
      dismissed,
      resolution,
      includeDismissed,
      windowed,
      settledAt,
    ],
  );
}

/** How far back the Settled and Third-party shelves reach before "Show older". */
export const INBOX_SHELF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * When a row joined its shelf: a conversation's settlement record, else
 * (Tasks, or no record) when its work ended. A third-party Session's last
 * activity.
 */
function shelfTime(
  group: MobileActivityGroup,
  item: HomeWorkItem,
  settledAt: Readonly<Record<string, string>>,
) {
  if (group.id === 'external') return item.updatedAt;
  const record = settledAt[item.conversationId ?? item.id];
  const parsed = record === undefined ? Number.NaN : Date.parse(record);
  return Number.isFinite(parsed) ? parsed : finishedAtOf(item);
}

function windowShelf(
  group: MobileActivityGroup,
  now: number,
  settledAt: Readonly<Record<string, string>>,
): MobileActivityGroup {
  if (group.id !== 'settled' && group.id !== 'external') return group;
  const items: HomeWorkItem[] = [];
  const older: HomeWorkItem[] = [];
  for (const item of group.items)
    (now - shelfTime(group, item, settledAt) > INBOX_SHELF_WINDOW_MS
      ? older
      : items
    ).push(item);
  return older.length ? { ...group, items, older } : group;
}

/** How many rows the inbox's Needs-you group holds, from `useInboxGroups`. */
export function useInboxNeedsYouCount(
  items: HomeWorkItem[],
  now: number,
  workFacts?: WorkFactsById,
): number {
  // The same facts the inbox reads: without them this count's dismissal read
  // would see an engine-opened turn as waking a row, and restore it.
  const groups = useInboxGroups(items, now, workFacts);
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
  const working = new Set<string>();
  for (const group of groups) {
    for (const root of group.items) {
      for (const item of [root, ...(group.childrenById?.get(root.id) ?? [])]) {
        if (
          item.kind !== 'task' &&
          workStatus(item, now, workFacts?.get(item.id)).lane === 'running'
        )
          working.add(
            item.kind === 'remote-session'
              ? item.id
              : (item.conversationId ?? item.id),
          );
      }
    }
  }
  return working.size;
}
