export const DIALOG_HISTORY_KEY = '__stationDialog';

interface DialogHistoryEntry {
  id: string;
  close: () => void;
  cleanupToken?: object;
}

const entries: DialogHistoryEntry[] = [];
const orphanedMarkers = new Set<string>();
const MAX_ORPHANED_MARKERS = 64;
let listening = false;
let suppressNextPop = false;

function markOrphaned(id: string) {
  orphanedMarkers.add(id);
  while (orphanedMarkers.size > MAX_ORPHANED_MARKERS) {
    const oldest = orphanedMarkers.values().next().value;
    if (typeof oldest !== 'string') break;
    orphanedMarkers.delete(oldest);
  }
}

function markerFromState(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const marker = (state as Record<string, unknown>)[DIALOG_HISTORY_KEY];
  return typeof marker === 'string' ? marker : null;
}

function pushDialogEntry(id: string) {
  const current = window.history.state;
  const state =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, [DIALOG_HISTORY_KEY]: id }
      : { [DIALOG_HISTORY_KEY]: id };
  window.history.pushState(state, '', window.location.href);
}

function skipOrphanedMarker() {
  const marker = markerFromState(window.history.state);
  if (!marker || !orphanedMarkers.delete(marker)) return false;
  window.history.back();
  return true;
}

function handlePopState() {
  if (suppressNextPop) {
    suppressNextPop = false;
    skipOrphanedMarker();
    return;
  }

  if (skipOrphanedMarker()) return;

  const top = entries.at(-1);
  if (!top || markerFromState(window.history.state) === top.id) return;
  entries.pop();
  markOrphaned(top.id);
  top.close();
}

function ensureListener() {
  if (listening) return;
  window.addEventListener('popstate', handlePopState);
  listening = true;
}

/**
 * Adds a same-URL history layer for one mounted dialog.
 *
 * Browser Back removes that layer and closes only the newest dialog. Ordinary
 * close paths still update React state synchronously; their deferred cleanup
 * removes the matching history entry without navigating the page underneath.
 * Cleanup is deferred by one microtask so React StrictMode's effect replay
 * reclaims the same entry instead of creating a second history layer.
 */
export function registerDialogHistory(id: string, close: () => void) {
  ensureListener();
  const existing = entries.find((entry) => entry.id === id);
  const entry = existing ?? { id, close };
  entry.close = close;
  entry.cleanupToken = undefined;

  if (!existing) {
    entries.push(entry);
    pushDialogEntry(id);
  }

  return () => {
    const cleanupToken = {};
    entry.cleanupToken = cleanupToken;
    queueMicrotask(() => {
      if (entry.cleanupToken !== cleanupToken) return;
      const index = entries.indexOf(entry);
      if (index < 0) return;
      entries.splice(index, 1);

      if (markerFromState(window.history.state) === id) {
        markOrphaned(id);
        suppressNextPop = true;
        window.history.back();
      } else {
        markOrphaned(id);
      }
    });
  };
}
