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
 * write goes through this module, so the localStorage body can be swapped
 * for a server-backed one (Task-only, falling back to local for
 * chat/session) without touching call sites.
 */

const SNOOZE_STORAGE_KEY = 'station.activity.snoozed';
const storageKey = (namespace?: string | null) =>
  namespace
    ? JSON.stringify([SNOOZE_STORAGE_KEY, namespace])
    : SNOOZE_STORAGE_KEY;

/**
 * Bumped on every write in this tab, so a surface that reads the map (the
 * inbox panel, the inbox toggle's Needs-you count) re-reads it at once
 * rather than holding the copy it read at mount.
 */
let version = 0;
const listeners = new Set<() => void>();
const snapshots = new Map<string, { entries: SnoozeMap; unsaved: boolean }>();
const MAX_CACHED_NAMESPACES = 16;

function remember(key: string, entries: SnoozeMap, unsaved: boolean) {
  snapshots.delete(key);
  snapshots.set(key, { entries, unsaved });
  if (snapshots.size > MAX_CACHED_NAMESPACES) {
    const oldest = snapshots.keys().next().value;
    if (oldest !== undefined) snapshots.delete(oldest);
  }
}

function liveEntries(entries: SnoozeMap, now: number): SnoozeMap {
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([, until]) => Number.isFinite(until) && until > now,
    ),
  );
}

function isSnoozeKey(key: string): boolean {
  if (key === SNOOZE_STORAGE_KEY) return true;
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && parsed[0] === SNOOZE_STORAGE_KEY;
  } catch {
    return false;
  }
}

function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (event.key !== null && !isSnoozeKey(event.key)) return;
  if (event.key === null) snapshots.clear();
  else snapshots.delete(event.key);
  changed();
}

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Subscribe to snooze writes in this tab; returns the unsubscribe. */
export function subscribeSnoozes(listener: () => void): () => void {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

/** Changes whenever a snooze is written, cleared or re-keyed. */
export function snoozesVersion(): number {
  return version;
}

/** Snoozed item id -> epoch ms at which the snooze lapses. */
export type SnoozeMap = Record<string, number>;

export function readSnoozes(now: number, namespace?: string | null): SnoozeMap {
  const key = storageKey(namespace);
  const cached = snapshots.get(key);
  if (cached?.unsaved) return liveEntries(cached.entries, now);
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      snapshots.delete(key);
      return {};
    }
    // Lapsed entries are dropped on read so the store cannot grow without
    // bound and a stale snooze never outlives its window.
    const entries = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' &&
          Number.isFinite(entry[1]) &&
          entry[1] > now,
      ),
    );
    remember(key, entries, false);
    return entries;
  } catch {
    return liveEntries(cached?.entries ?? {}, now);
  }
}

function write(entries: SnoozeMap, namespace?: string | null) {
  const key = storageKey(namespace);
  let unsaved = false;
  try {
    localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    unsaved = true;
  }
  // Failed persistence must not undo the action when subscribers re-read.
  remember(key, entries, unsaved);
  changed();
}

export function writeSnooze(
  id: string,
  until: number,
  now: number,
  namespace?: string | null,
): SnoozeMap {
  const next = { ...readSnoozes(now, namespace), [id]: until };
  write(next, namespace);
  return next;
}

export function clearSnooze(
  id: string,
  now: number,
  namespace?: string | null,
): SnoozeMap {
  const next = readSnoozes(now, namespace);
  delete next[id];
  write(next, namespace);
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
  namespace?: string | null,
): SnoozeMap {
  const current = readSnoozes(now, namespace);
  if (oldId === newId || !(oldId in current)) {
    return current;
  }
  const wakeAt = current[oldId];
  delete current[oldId];
  current[newId] = wakeAt;
  write(current, namespace);
  return current;
}
