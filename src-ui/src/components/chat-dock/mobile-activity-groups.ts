import {
  clearSnooze,
  readSnoozes,
  type SnoozeMap,
  writeSnooze,
} from '../../utils/activity-snooze-store';
import {
  partitionHomeWorkItems,
  terminalSinceFromRecency,
} from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';

// Re-exported for existing callers (station#1099 extracted the storage body
// into a shared module so the desktop Home lane model can observe the same
// snoozes — see activity-snooze-store.ts for the rationale).
export { clearSnooze, readSnoozes, type SnoozeMap, writeSnooze };

export type MobileActivityGroupId =
  | 'active'
  | 'settled'
  | 'snoozed'
  | 'earlier';

export const SNOOZE_OPTIONS = [
  { label: '30 min', ms: 30 * 60_000 },
  { label: '3 hours', ms: 3 * 3_600_000 },
  { label: 'Until 9 AM', ms: null },
] as const;

export type SnoozeOption = (typeof SNOOZE_OPTIONS)[number];

/** Resolve a preset against an injected clock; null means the next local 9am. */
export function snoozeWakeAt(option: SnoozeOption, now: number): number {
  if (option.ms !== null) return now + option.ms;
  const wake = new Date(now);
  wake.setHours(9, 0, 0, 0);
  if (wake.getTime() <= now) wake.setDate(wake.getDate() + 1);
  return wake.getTime();
}

export interface MobileActivityGroup {
  id: MobileActivityGroupId;
  label: string;
  items: HomeWorkItem[];
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

/**
 * Split work items into Active now / Just finished / Snoozed / Earlier.
 *
 * NOT A SECOND CLASSIFIER (station#3227 A6). This used to carry its own
 * "active" predicate (`Running`/`Needs attention` only) and its own 10-minute
 * settle window, while desktop Home partitioned the SAME items through
 * `partitionHomeWorkItems` (active = not terminal, 15-minute linger) — so
 * one device read "Active now 14" on Home and "Active now 1" in this
 * switcher, with the difference parked under "Just finished" having finished
 * nothing. Same label, two derivations, contradicting counts.
 *
 * The groups are now a straight rename of the shared partition's lanes:
 * active ("Active now"), recentlyFinished ("Just finished"), snoozed,
 * settled ("Earlier") — the same mapping the Sessions lanes already use
 * (`sessions-lane-model.ts`). An unfinished-but-idle item (`Ready`/`Recent`/
 * `Current`/`Unanswerable`) is active here for the same reason it is on
 * desktop: "Just finished"/"Earlier" assert the work FINISHED, and it did
 * not. `terminalSince` uses the shared fresh-load proxy
 * (`terminalSinceFromRecency`) because this surface, like the Sessions list,
 * has no persisted transition store.
 *
 * Still pure and `now`-injected so the linger boundary is testable without
 * faking timers. Input order is preserved within each group — callers hand
 * this list in already sorted by recency, and the partition is a single
 * stable pass.
 */
export function groupMobileActivity(
  items: HomeWorkItem[],
  now: number,
  snoozed: SnoozeMap = {},
): MobileActivityGroup[] {
  // `snoozeKeyFor` (below) and the partition's own snooze lookup are both
  // `item.id` — the partition reads the same key this module's writers use.
  const partition = partitionHomeWorkItems({
    items,
    now,
    snoozedUntil: new Map(Object.entries(snoozed)),
    terminalSince: terminalSinceFromRecency(items),
  });

  return [
    { id: 'active', label: 'Active now', items: partition.active },
    {
      id: 'settled',
      label: 'Just finished',
      items: partition.recentlyFinished,
    },
    { id: 'snoozed', label: 'Snoozed', items: partition.snoozed },
    { id: 'earlier', label: 'Earlier', items: partition.settled },
  ];
}
