import type { HomeWorkItem } from '../views/home/home-view-model';
import { clearSnooze, readSnoozes } from './activity-snooze-store';
import { isRecord } from './isRecord';

const STORAGE_KEY = 'station.inbox.pinned.v1';
const MAX_PINS = 100;
const storageKey = (namespace?: string | null) =>
  namespace ? JSON.stringify([STORAGE_KEY, namespace]) : STORAGE_KEY;

type Pin = { pinnedAt: number };
type InboxPins = Record<string, Pin>;
type PinItem = Pick<HomeWorkItem, 'id' | 'environmentId'>;
const snapshots = new Map<string, { pins: InboxPins; pending: boolean }>();
const listeners = new Set<() => void>();
let version = 0;

function changed() {
  version += 1;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== localStorage) return;
  if (event.key === null) snapshots.clear();
  else if (
    event.key === STORAGE_KEY ||
    event.key.startsWith(`["${STORAGE_KEY}",`)
  ) {
    snapshots.delete(event.key);
  } else return;
  changed();
}

export function subscribeInboxPins(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', onStorage);
  };
}

export function inboxPinsVersion() {
  return version;
}

function keyFor(item: PinItem) {
  return item.environmentId
    ? JSON.stringify([item.environmentId, item.id])
    : item.id;
}

function bounded(entries: [string, Pin][]): InboxPins {
  return Object.fromEntries(
    entries.sort((a, b) => b[1].pinnedAt - a[1].pinnedAt).slice(0, MAX_PINS),
  );
}

export function readInboxPins(namespace?: string | null): InboxPins {
  const key = storageKey(namespace);
  const snapshot = snapshots.get(key);
  if (snapshot?.pending) return { ...snapshot.pins };
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!isRecord(parsed)) {
      snapshots.delete(key);
      return {};
    }
    const entries: [string, Pin][] = [];
    for (const [id, pin] of Object.entries(parsed)) {
      if (
        isRecord(pin) &&
        typeof pin.pinnedAt === 'number' &&
        Number.isFinite(pin.pinnedAt)
      )
        entries.push([id, { pinnedAt: pin.pinnedAt }]);
    }
    const pins = bounded(entries);
    remember(key, pins, false);
    return pins;
  } catch {
    return { ...snapshot?.pins };
  }
}

export function isInboxPinned(item: PinItem, pins: InboxPins): boolean {
  return Object.hasOwn(pins, keyFor(item));
}

export function pinInboxItem(item: PinItem, namespace?: string | null) {
  const now = Date.now();
  if (Object.hasOwn(readSnoozes(now, namespace), item.id))
    clearSnooze(item.id, now, namespace);
  const pins = readInboxPins(namespace);
  if (!isInboxPinned(item, pins)) {
    write({ [keyFor(item)]: { pinnedAt: now }, ...pins }, namespace);
  }
}

export function unpinInboxItem(item: PinItem, namespace?: string | null) {
  const pins = readInboxPins(namespace);
  if (!isInboxPinned(item, pins)) return;
  delete pins[keyFor(item)];
  write(pins, namespace);
}

export function toggleInboxPin(item: PinItem, namespace?: string | null) {
  if (isInboxPinned(item, readInboxPins(namespace)))
    unpinInboxItem(item, namespace);
  else pinInboxItem(item, namespace);
}

export function migrateInboxPin(
  oldId: string,
  newId: string,
  namespace?: string | null,
) {
  const pins = readInboxPins(namespace);
  if (oldId === newId || !Object.hasOwn(pins, oldId)) return;
  const pin = pins[oldId];
  delete pins[oldId];
  write(
    Object.hasOwn(pins, newId) ? pins : { ...pins, [newId]: pin },
    namespace,
  );
}

function remember(key: string, pins: InboxPins, pending: boolean) {
  snapshots.delete(key);
  snapshots.set(key, { pins: { ...pins }, pending });
  if (snapshots.size > MAX_PINS) {
    const oldest = snapshots.keys().next();
    if (!oldest.done) snapshots.delete(oldest.value);
  }
}

function write(entries: InboxPins, namespace?: string | null) {
  const key = storageKey(namespace);
  const pins = bounded(Object.entries(entries));
  let pending = false;
  try {
    localStorage.setItem(key, JSON.stringify(pins));
  } catch {
    pending = true;
  }
  remember(key, pins, pending);
  changed();
}
