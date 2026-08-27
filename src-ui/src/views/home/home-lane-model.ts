import { compareTaskRecency, type HomeWorkItem } from './home-view-model';

/**
 * Position-stable active lane + snooze/linger model for the Home work list
 * (station#1099). Every function here is pure and `now`-injected so the
 * invariants are testable without faking timers; the stateful glue (refs,
 * localStorage, a re-render tick) lives in `useHomeWorkLanes.ts`.
 *
 * Design reference (issue #1099, competitor analysis): the active lane never
 * reorders on activity — rows hold position from entry until a lifecycle
 * transition (settle/snooze) moves them out of the lane; new items enter at
 * the top.
 */

/**
 * How long NON-conversation terminal work lingers in "Recently finished" /
 * "Just finished" before settling. Terminal conversations do not use this —
 * they leave only after their rendered inventory version is durably
 * acknowledged by the server (see `partitionHomeWorkItems`).
 *
 * THE one linger window (station#3227 A6): desktop Home lanes, the Sessions
 * lanes, and the mobile activity groups (`mobile-activity-groups.ts`) all
 * classify through `partitionHomeWorkItems`, so this constant is the only
 * home the window has. Mobile used to carry its own 10-minute
 * `RECENTLY_SETTLED_WINDOW_MS`, which is how "Active now"/"Just finished"
 * counted differently on two surfaces of the same device.
 */
export const TERMINAL_LINGER_MS = 15 * 60 * 1000;

/**
 * Safety margin beyond `TERMINAL_LINGER_MS` used when pruning persisted
 * terminal-since anchors on read (`terminal-since-store.ts`). An anchor
 * older than `TERMINAL_LINGER_MS` is already settled regardless of its exact
 * value, so the margin only needs to cover clock skew / a slow reload, not
 * meaningfully extend how long a settled item's anchor is retained.
 */
export const TERMINAL_SINCE_PRUNE_MARGIN_MS = 5 * 60 * 1000;

/** How long a "woke from snooze" pill stays visible after a snooze lapses. */
export const WOKE_PILL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Settled for lane purposes — deliberately NOT including `'Unanswerable'`
 * (station#1783). The settled/"Just finished" lane asserts the work FINISHED,
 * and an unanswerable session did not; it stopped being reachable. So it
 * stays in the Active lane, ranked and chipped, with its basis on the row.
 *
 * station#3227 A6: this is now the ONE "active" predicate for every surface
 * that renders the label "Active now" — desktop Home lanes, the Sessions
 * lanes (`sessions-lane-model.ts`), and the mobile activity groups
 * (`mobile-activity-groups.ts` now derives its groups from
 * `partitionHomeWorkItems` instead of a private `Running`/`Needs attention`
 * match). An earlier version of this comment recorded the desktop/mobile
 * divergence as defensible; the audit found the counts contradicting on one
 * device ("Active now 14" vs "Active now 1") and retired it.
 */
export function isTerminalLifecycle(
  label: HomeWorkItem['lifecycleLabel'],
): boolean {
  return label === 'Completed' || label === 'Failed' || label === 'Stopped';
}

/**
 * A `HomeWorkItem` with a logical identity that survives the two known
 * `id`-changing promotions on the default path (review finding, station#1099):
 *
 * (a) `useActiveChatSessionMessaging.ts`'s `assignConversationId` flips a
 *     chat's `id` from its local session key to the server-assigned
 *     conversationId on the first message.
 * (b) `mergeHomeWorkItems` drops a chat/orchestration item and replaces it
 *     with a differently-keyed task item once a durable Task's `sessionId`
 *     correlates to the same underlying session.
 *
 * Both transitions still share at least one of `id`/`chatSessionId`/
 * `taskSessionId`/`orchestrationThreadId` with the item's prior appearance —
 * `chatSessionId` survives (a) unconditionally (it is the chat store's own
 * key, never reassigned); in (b) the new task item's `taskSessionId` equals
 * whichever key `isPersistedTaskCorrelation` just matched on, which is
 * exactly the prior item's `id` or `chatSessionId`. `withStableIds` aliases
 * every one of an item's identity keys onto the first-seen canonical id, so
 * ordering/list keys stay anchored across both promotions without needing
 * to know in advance which one occurred.
 *
 * Not persisted: the alias map (like `orderRef`) lives only in
 * `useHomeWorkLanes`'s in-memory refs, so a reload rebuilds active-lane
 * position from recency, same as a brand-new session. AC1's scope is status
 * churn within a session, not surviving a reload.
 */
export interface HomeLaneItem extends HomeWorkItem {
  readonly stableId: string;
}

function identityKeysFor(item: HomeWorkItem): string[] {
  const keys = [item.id];
  if (item.chatSessionId) keys.push(item.chatSessionId);
  if (item.taskSessionId) keys.push(item.taskSessionId);
  if (item.orchestrationThreadId) keys.push(item.orchestrationThreadId);
  return keys;
}

/**
 * Resolves each item's stable logical identity against `aliasMap`, which is
 * mutated in place — an accumulator the caller (`useHomeWorkLanes`) holds
 * across renders, the same ref-cache pattern as `orderRef`/`terminalSinceRef`.
 * Also prunes aliases for canonical ids no longer reachable from any item in
 * this call, so the map cannot grow without bound as chats/sessions/tasks
 * come and go.
 */
export function withStableIds(
  items: readonly HomeWorkItem[],
  aliasMap: Map<string, string>,
): HomeLaneItem[] {
  const result: HomeLaneItem[] = [];
  const seenCanonicals = new Set<string>();

  for (const item of items) {
    const keys = identityKeysFor(item);
    let canonical: string | undefined;
    for (const key of keys) {
      const existing = aliasMap.get(key);
      if (existing !== undefined) {
        canonical = existing;
        break;
      }
    }
    if (canonical === undefined) canonical = item.id;
    for (const key of keys) aliasMap.set(key, canonical);
    seenCanonicals.add(canonical);
    result.push({ ...item, stableId: canonical });
  }

  for (const [key, canonical] of [...aliasMap]) {
    if (!seenCanonicals.has(canonical)) aliasMap.delete(key);
  }

  return result;
}

/**
 * Generic over the item type (defaulting to `HomeLaneItem`) because the
 * partition only reads `id`/`lifecycleLabel`/`conversationUpdatedAt`/
 * `acknowledgedAt` — the mobile activity groups (station#3227 A6) hand it
 * bare `HomeWorkItem`s and must get the SAME object references back, while
 * desktop callers keep their `stableId`-carrying lane items.
 */
export interface LaneInputs<T extends HomeWorkItem = HomeLaneItem> {
  items: readonly T[];
  now: number;
  /** item id -> epoch ms at which a live snooze lapses. */
  snoozedUntil: ReadonlyMap<string, number>;
  /** item id -> epoch ms of the first observed terminal transition. */
  terminalSince: ReadonlyMap<string, number>;
}

export interface LanePartition<T extends HomeWorkItem = HomeLaneItem> {
  active: T[];
  recentlyFinished: T[];
  snoozed: T[];
  settled: T[];
}

export function partitionHomeWorkItems<T extends HomeWorkItem>({
  items,
  now,
  snoozedUntil,
  terminalSince,
}: LaneInputs<T>): LanePartition<T> {
  const active: T[] = [];
  const recentlyFinished: T[] = [];
  const snoozed: T[] = [];
  const settled: T[] = [];

  for (const item of items) {
    // A live snooze wins over every other classification, matching the
    // mobile inbox's rule (mobile-activity-groups.ts) — snoozing something
    // still running is the entire point of the verb. Deliberately keyed by
    // the raw `item.id`, not `stableId` — snooze/terminal-since keying is
    // out of scope for the identity-alias fix above (a smaller, disclosed
    // residual risk: an item snoozed/lingering right as its id promotes
    // could momentarily lose that state under its new id).
    const wakeAt = snoozedUntil.get(item.id);
    if (wakeAt !== undefined && wakeAt > now) {
      snoozed.push(item);
      continue;
    }
    if (isTerminalLifecycle(item.lifecycleLabel)) {
      // Completed conversations are attention items, not a timed toast.
      // A fresh terminal version remains in Just finished through reloads and
      // device changes until the user actually opens it. Non-conversation
      // work keeps the historic Earlier behavior; it has no transcript to
      // acknowledge through the conversation inventory.
      if (item.conversationUpdatedAt) {
        if (
          item.acknowledgedAt !== undefined &&
          item.acknowledgedAt >= Date.parse(item.conversationUpdatedAt)
        ) {
          settled.push(item);
          continue;
        }
        recentlyFinished.push(item);
        continue;
      }
      // Non-conversation work has no transcript version to acknowledge.
      // Retain its historical time-based placement while direct chats and
      // runtime conversations use the durable path above.
      const since = terminalSince.get(item.id) ?? now;
      if (now - since >= TERMINAL_LINGER_MS) {
        settled.push(item);
        continue;
      }
      recentlyFinished.push(item);
      continue;
    }
    active.push(item);
  }

  return { active, recentlyFinished, snoozed, settled };
}

/**
 * Fresh-load proxy for the `terminalSince` map on surfaces with no persisted
 * observation store (the Sessions lanes, the mobile activity groups). Home
 * observes terminal transitions live and persists when it first saw one
 * (`terminal-since-store.ts`); a store-less surface has observed nothing, and
 * an empty map would make `partitionHomeWorkItems` read `since = now` for
 * every terminal row — parking the entire finished inventory in "Recently
 * finished"/"Just finished" forever.
 *
 * So the map is seeded from the item's own recency fold (`updatedAt`). That
 * is a PROXY for the transition, not an observation of it: it says when the
 * item last did anything, which for terminal work is when it stopped. It can
 * only be wrong in the harmless direction — terminal work that keeps
 * receiving events lingers a little longer.
 */
export function terminalSinceFromRecency(
  items: readonly HomeWorkItem[],
): Map<string, number> {
  const terminalSince = new Map<string, number>();
  for (const item of items) {
    if (isTerminalLifecycle(item.lifecycleLabel)) {
      terminalSince.set(item.id, item.updatedAt);
    }
  }
  return terminalSince;
}

/**
 * AC1 ordering invariant: status churn never reorders the active lane.
 *
 * `previousOrder` is the caller's last committed order (a list of
 * `HomeLaneItem.stableId` — NOT `HomeWorkItem.id`; the raw `id` can change
 * out from under a still-visible row, see `withStableIds` above). Stable ids
 * still present in `activeItems` keep their prior relative position exactly
 * — recomputing this every render on the same set of stable ids is a no-op
 * regardless of how many times a row's `lifecycleLabel`, `updatedAt`, or
 * even its raw `id` changed in between. Only stable ids genuinely new to the
 * lane (not in `previousOrder`) are inserted, at the top, ordered by recency
 * among themselves via `compareTaskRecency`. A stable id that leaves the
 * lane (settled or snoozed) is dropped and — if it later returns — re-enters
 * as new.
 */
export function computeStableActiveOrder(
  previousOrder: readonly string[],
  activeItems: readonly HomeLaneItem[],
): string[] {
  const byStableId = new Map(activeItems.map((item) => [item.stableId, item]));
  const kept = previousOrder.filter((id) => byStableId.has(id));
  const keptSet = new Set(kept);
  const incoming = [...activeItems]
    .filter((item) => !keptSet.has(item.stableId))
    .sort(compareTaskRecency)
    .map((item) => item.stableId);
  return [...incoming, ...kept];
}

export function orderItemsByKeys(
  items: readonly HomeLaneItem[],
  order: readonly string[],
): HomeLaneItem[] {
  const byStableId = new Map(items.map((item) => [item.stableId, item]));
  const ordered: HomeLaneItem[] = [];
  for (const id of order) {
    const item = byStableId.get(id);
    if (item) ordered.push(item);
  }
  return ordered;
}

/** Collapsed snoozed shelf, sorted by wake time (soonest first). */
export function sortSnoozedShelf(
  items: readonly HomeLaneItem[],
  snoozedUntil: ReadonlyMap<string, number>,
): HomeLaneItem[] {
  return [...items].sort(
    (left, right) =>
      (snoozedUntil.get(left.id) ?? Number.POSITIVE_INFINITY) -
      (snoozedUntil.get(right.id) ?? Number.POSITIVE_INFINITY),
  );
}

/** Paginated settled tail, sorted by when work ended (most recent first). */
export function sortSettledTail(
  items: readonly HomeLaneItem[],
  terminalSince: ReadonlyMap<string, number>,
): HomeLaneItem[] {
  return [...items].sort(
    (left, right) =>
      (terminalSince.get(right.id) ?? right.updatedAt) -
      (terminalSince.get(left.id) ?? left.updatedAt),
  );
}

/** Short relative label for a future wake time ("in 12m", "in 3h", "in 2d"). */
export function formatWakeTime(wakeAt: number, now: number): string {
  const diffMs = Math.max(0, wakeAt - now);
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days}d`;
}

// Snooze preset date math (design (b): In 1 hour / This evening / Tomorrow
// 9am / Next week Mon 9am) lives in `./snooze-presets.ts`, not here. Only
// the lazily-loaded `SnoozeMenu` needs it (AC4 — this module is imported
// eagerly by `useHomeWorkLanes`, so keeping the preset-menu-only code out of
// it keeps that code out of the entry bundle too).
