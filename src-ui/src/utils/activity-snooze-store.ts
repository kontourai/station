/**
 * Shared "not now" storage for Home work items (archive#1099).
 *
 * One localStorage-backed map, keyed by `HomeWorkItem.id`, so snoozing an
 * item from the mobile chat-dock inbox (`mobile-activity-groups.ts`, which
 * re-exports these primitives for compatibility) and snoozing the same item
 * from the desktop Home view (`home-lane-model.ts`) observe the same state —
 * there is exactly one snooze, not two surfaces disagreeing about it.
 *
 * OD1 (archive#1099): this stays client-local/per-browser rather than a
 * server-side Task field. Home's work list merges three item kinds (Task,
 * chat, orchestration session) and only Tasks have durable server identity;
 * a server field would only cover one of the three kinds, producing
 * inconsistent snooze semantics by item kind for the majority (chat/session)
 * of what gets triaged live. `SnoozeStore` below is the seam: every read/
 * write goes through this module, so a later slice can swap the localStorage
 * body for a server-backed one (Task-only, falling back to local for
 * chat/session) without touching call sites.
 */

const SNOOZE_STORAGE_KEY = 'station.activity.snoozed';

/** Snoozed item id -> epoch ms at which the snooze lapses. */
export type SnoozeMap = Record<string, number>;

export function readSnoozes(now: number): SnoozeMap {
  try {
    const raw = localStorage.getItem(SNOOZE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
// Lapsed entries are dropped on read so the store cannot grow without
// bound and a stale snooze never outlives its window.
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && entry[1] > now,
      ),
    );
  } catch {
    return {};
  }
}

export function writeSnooze(id: string, until: number, now: number): SnoozeMap {
  const next = { ...readSnoozes(now), [id]: until };
  try {
    localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(next));
  } catch {
/* ignore — snooze is a convenience, not state worth failing over */
  }
  return next;
}

export function clearSnooze(id: string, now: number): SnoozeMap {
  const next = readSnoozes(now);
  delete next[id];
  try {
    localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(next));
  } catch {
/* ignore */
  }
  return next;
}

/**
* archive#1311 a chat's `HomeWorkItem.id` is
 * `conversationId || storeKey` — before a brand-new chat's first send
 * assigns a server `conversationId`, `id` reads as the local store key, and
 * a snooze set during that window is written under it. The moment
 * `assignConversationId` flips the canonical id over to the conversationId,
 * a snooze still keyed by the old store key would silently stop matching
 * (archive#1295's original report). Call this at the exact promotion point
 * (`ActiveChatsStore.assignConversationId`) to carry any live snooze over to
 * the new key — a single localStorage read/write, and a no-op when nothing
 * is snoozed under `oldId` or when the ids already match.
 */
export function migrateSnoozeKey(
  oldId: string,
  newId: string,
  now: number,
): SnoozeMap {
  const current = readSnoozes(now);
  if (oldId === newId || !(oldId in current)) {
    return current;
  }
  const wakeAt = current[oldId];
  delete current[oldId];
  current[newId] = wakeAt;
  try {
    localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(current));
  } catch {
/* ignore — snooze is a convenience, not state worth failing over */
  }
  return current;
}
