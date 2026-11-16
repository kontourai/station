import type { HomeWorkItem } from '../views/home/home-view-model';
import type { WorkFacts } from '../views/home/work-facts';
import { isRecord } from './isRecord';

const STORAGE_KEY = 'station.inbox.dismissed.v1';
const MAX_DISMISSALS = 500;
const storageKey = (namespace?: string | null) =>
  namespace ? JSON.stringify([STORAGE_KEY, namespace]) : STORAGE_KEY;

interface Dismissal {
  lifecycle: string;
  updatedAt: number;
  dismissedAt: number;
  attention?: string;
  thirdParty?: boolean;
}

export type InboxDismissals = Record<string, Dismissal>;
let version = 0;
const listeners = new Set<() => void>();

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (
    event.key === STORAGE_KEY ||
    event.key?.startsWith('["station.inbox.dismissed.v1",') ||
    event.key === null
  )
    changed();
}

export function subscribeInboxDismissals(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

export function inboxDismissalsVersion() {
  return version;
}

function keyFor(item: HomeWorkItem) {
  const id = item.id;
  return item.environmentId ? JSON.stringify([item.environmentId, id]) : id;
}

export function readInboxDismissals(
  namespace?: string | null,
): InboxDismissals {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(storageKey(namespace)) ?? '{}',
    );
    if (!isRecord(parsed)) return {};
    const entries: [string, Dismissal][] = [];
    for (const [key, entry] of Object.entries(parsed)) {
      if (
        isRecord(entry) &&
        typeof entry.lifecycle === 'string' &&
        typeof entry.updatedAt === 'number' &&
        Number.isFinite(entry.updatedAt) &&
        typeof entry.dismissedAt === 'number' &&
        Number.isFinite(entry.dismissedAt) &&
        (entry.attention === undefined ||
          typeof entry.attention === 'string') &&
        (entry.thirdParty === undefined ||
          typeof entry.thirdParty === 'boolean')
      ) {
        entries.push([
          key,
          {
            lifecycle: entry.lifecycle,
            updatedAt: entry.updatedAt,
            dismissedAt: entry.dismissedAt,
            attention: entry.attention,
            thirdParty: entry.thirdParty,
          },
        ]);
      }
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function write(entries: InboxDismissals, namespace?: string | null) {
  localStorage.setItem(
    storageKey(namespace),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(entries)
          .sort((a, b) => b[1].dismissedAt - a[1].dismissedAt)
          .slice(0, MAX_DISMISSALS),
      ),
    ),
  );
  changed();
}

export function dismissInboxItem(
  item: HomeWorkItem,
  facts?: WorkFacts,
  namespace?: string | null,
) {
  write(
    {
      ...readInboxDismissals(namespace),
      [keyFor(item)]: {
        lifecycle: item.lifecycleLabel,
        updatedAt: item.updatedAt,
        dismissedAt: Date.now(),
        attention: facts?.attention,
        thirdParty: item.controlMode === 'read-only-attached' || undefined,
      },
    },
    namespace,
  );
}

export function restoreInboxItems(
  items: readonly HomeWorkItem[],
  namespace?: string | null,
) {
  const entries = readInboxDismissals(namespace);
  let removed = false;
  for (const item of items) {
    const key = keyFor(item);
    if (Object.hasOwn(entries, key)) {
      delete entries[key];
      removed = true;
    }
  }
  if (removed) write(entries, namespace);
}

export function hasInboxDismissal(
  item: HomeWorkItem,
  entries: InboxDismissals,
) {
  return Object.hasOwn(entries, keyFor(item));
}

/**
 * Lifecycles an engine-opened turn may move a dismissed conversation through
 * without bringing it back: it ran or finished. Failing, stopping, needing
 * attention or becoming unanswerable still does.
 */
const QUIET_LIFECYCLES: ReadonlySet<string> = new Set([
  'Running',
  'Current',
  'Ready',
  'Recent',
  'Completed',
]);

export function isInboxDismissed(
  item: HomeWorkItem,
  entries: InboxDismissals,
  facts?: WorkFacts,
) {
  if (!hasInboxDismissal(item, entries)) return false;
  const entry = entries[keyFor(item)];
  if (entry.thirdParty) return item.controlMode === 'read-only-attached';
  if (facts !== undefined && entry.attention !== facts.attention) return false;
  // A turn the engine opened on its own (background work finishing, a task
  // notification) is nobody's new message: it does not undo a dismissal
  // unless it fails, stops or needs the person.
  if (
    facts?.engineOpenedTurn &&
    QUIET_LIFECYCLES.has(item.lifecycleLabel) &&
    QUIET_LIFECYCLES.has(entry.lifecycle)
  )
    return true;
  if (entry.lifecycle !== item.lifecycleLabel) return false;
  // Streaming and tool progress continuously advance recency during a turn.
  return (
    item.lifecycleLabel === 'Running' ||
    item.lifecycleLabel === 'Draft' ||
    item.updatedAt <= entry.updatedAt
  );
}

export function migrateInboxDismissal(
  oldId: string,
  newId: string,
  namespace?: string | null,
) {
  const entries = readInboxDismissals(namespace);
  if (oldId === newId || !Object.hasOwn(entries, oldId)) return;
  const old = entries[oldId];
  delete entries[oldId];
  if (!Object.hasOwn(entries, newId)) entries[newId] = old;
  write(entries, namespace);
}
