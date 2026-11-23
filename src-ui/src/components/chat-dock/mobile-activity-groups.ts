import {
  clearSnooze,
  readSnoozes,
  type SnoozeMap,
  writeSnooze,
} from '../../utils/activity-snooze-store';
import {
  type LiveLaneId,
  partitionHomeWorkItems,
} from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { WorkFactsById } from '../../views/home/work-facts';

// Re-exported for existing callers (station#1099 extracted the storage body
// into a shared module so the desktop Home lane model can observe the same
// snoozes — see activity-snooze-store.ts for the rationale).
export { clearSnooze, readSnoozes, type SnoozeMap, writeSnooze };

export type MobileActivityGroupId =
  | 'open'
  | 'external'
  | LiveLaneId
  | 'settled'
  | 'snoozed'
  | 'earlier'
  | 'dismissed';

export interface MobileActivityGroup {
  id: MobileActivityGroupId;
  label: string;
  items: HomeWorkItem[];
  /**
   * Rows past the shelf's recency window (`INBOX_SHELF_WINDOW_MS`), shown
   * behind a "Show older" row. Search leaves every row in `items`.
   */
  older?: HomeWorkItem[];
  childrenById?: ReadonlyMap<string, readonly HomeWorkItem[]>;
}

/**
 * station#1295/#1311: the identity to key a snooze entry on.
 *
 * `HomeWorkItem.id` is `chat.conversationId || storeKey`
 * (`buildActiveChatTaskItems`) — the conversationId when the chat has one
 * (the durable, server-assigned identity, stable across reopens), else the
 * local store key. This is deliberately `item.id`, NOT `item.chatSessionId`:
 * `chatSessionId` is stable while a chat is brand-new and unsent (station
 * #1295's original bug — see below), but for an EXISTING Station-native or
 * bedrock conversation, `useOpenConversation` mints a fresh
 * `chatSessionId` (`${agentSlug}:${Date.now()}`) on every reopen while
 * `conversationId` stays constant — keying on `chatSessionId` there would
 * lose the snooze on every close+reopen (station#1311 review, opposite
 * direction). `item.id` is the one identity stable across BOTH shapes once
 * a conversationId exists.
 *
 * The one remaining gap `item.id` alone cannot cover is the moment of
 * PROMOTION itself: a snooze set before a brand-new chat's first send
 * (when `id` still reads as the store key, no conversationId yet) is
 * written under that key, and `id` flips to the conversationId once one is
 * assigned. That transition is handled where both ids are known together —
 * `ActiveChatsStore.assignConversationId` migrates any live snooze entry to
 * the new key at that exact point (`migrateSnoozeKey`,
 * `utils/activity-snooze-store.ts`) — not by having every read fall back to
 * a second, less stable key.
 */
export function snoozeKeyFor(item: HomeWorkItem): string {
  return item.id;
}

/** Inbox shelves reuse the shared status partition; drafts stay with open work. */
export function groupMobileActivity(
  items: HomeWorkItem[],
  now: number,
  snoozed: SnoozeMap = {},
  workFacts?: WorkFactsById,
  resolution?: ReadonlySet<string>,
): MobileActivityGroup[] {
  // `snoozeKeyFor` (below) and the partition's own snooze lookup are both
  // `item.id` — the partition reads the same key this module's writers use.
  const partition = partitionHomeWorkItems({
    items,
    now,
    workFacts,
    resolution,
    snoozedUntil: new Map(Object.entries(snoozed)),
  });

  const openIds = new Set(
    [...partition.idle, ...(partition.drafts ?? [])].map((item) => item.id),
  );
  const groups: MobileActivityGroup[] = [
    { id: 'needsYou', label: 'Needs attention', items: partition.needsYou },
    { id: 'running', label: 'Working', items: partition.running },
    {
      id: resolution ? 'open' : 'idle',
      label: 'Open',
      items: items.filter((item) => openIds.has(item.id)),
    },
    ...(!resolution
      ? [
          {
            id: 'settled' as const,
            label: 'Just finished',
            items: partition.recentlyFinished,
          },
        ]
      : []),
    { id: 'snoozed', label: 'Snoozed', items: partition.snoozed },
    { id: 'external', label: 'Third-party', items: partition.external ?? [] },
    {
      id: resolution ? 'settled' : 'earlier',
      label: 'Settled',
      items: partition.settled,
    },
  ];
  return groups
    .filter(
      (group) =>
        resolution ||
        !['needsYou', 'running', 'idle', 'external'].includes(group.id) ||
        group.items.length > 0,
    )
    .map((group) => ({
      ...group,
      childrenById: partition.childrenById,
    }));
}
