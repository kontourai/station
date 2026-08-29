export const DIALOG_HISTORY_KEY = '__stationDialog';

interface DialogHistoryEntry {
  id: string;
  close: () => void;
  cleanupToken?: object;
  /**
   * The URL this dialog's layer was pushed at, which is also the URL the entry
   * underneath still carries. Ordinary cleanup may only fold the layer away by
   * travelling back while the two still agree.
   */
  pushedUrl?: string;
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

function pushDialogEntry(entry: DialogHistoryEntry) {
  const current = window.history.state;
  const state =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...current, [DIALOG_HISTORY_KEY]: entry.id }
      : { [DIALOG_HISTORY_KEY]: entry.id };
  window.history.pushState(state, '', window.location.href);
  entry.pushedUrl = window.location.href;
}

/** The live entry's state with this layer's marker removed, nothing else touched. */
function stateWithoutMarker() {
  const current = window.history.state;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return current;
  }
  const next = { ...(current as Record<string, unknown>) };
  delete next[DIALOG_HISTORY_KEY];
  return next;
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
 *
 * Ordinary cleanup folds the layer by travelling back only while the live URL
 * still matches the one the layer was pushed at; a URL the dialog changed
 * before closing must survive the close.
 */
export function registerDialogHistory(id: string, close: () => void) {
  ensureListener();
  const existing = entries.find((entry) => entry.id === id);
  const entry = existing ?? { id, close };
  entry.close = close;
  entry.cleanupToken = undefined;

  if (!existing) {
    entries.push(entry);
    pushDialogEntry(entry);
  }

  return () => {
    const cleanupToken = {};
    entry.cleanupToken = cleanupToken;
    queueMicrotask(() => {
      if (entry.cleanupToken !== cleanupToken) return;
      const index = entries.indexOf(entry);
      if (index < 0) return;
      entries.splice(index, 1);

      markOrphaned(id);
      if (markerFromState(window.history.state) !== id) return;

      if (window.location.href === entry.pushedUrl) {
        suppressNextPop = true;
        window.history.back();
        return;
      }

      // A same-entry URL mutation must survive an ordinary close. `replaceState`
      // callers (the navigation store's `updateParams`) rewrite the URL of
      // whichever entry is live — the dialog's own — and carry this marker
      // forward with it, so the layer is still ours but the entry underneath
      // holds the pre-dialog URL. Travelling back would discard the caller's
      // navigation; collapse the layer where it stands instead, keeping the new
      // URL and leaving the entry no longer claimed by any dialog (archive#549).
      window.history.replaceState(
        stateWithoutMarker(),
        '',
        window.location.href,
      );
    });
  };
}
