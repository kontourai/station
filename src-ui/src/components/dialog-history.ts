export const DIALOG_HISTORY_KEY = '__stationDialog';

interface DialogHistoryEntry {
  id: string;
  close: () => void;
  cleanupToken?: object;
  /**
   * The URL this dialog's layer was pushed at, which is also the URL the entry
   * underneath still carries. Ordinary cleanup may only fold the layer away by
   * travelling back while the two still agree. Captured when the entry is
   * constructed, so it is never absent to fall open into the collapse path.
   */
  pushedUrl: string;
}

/**
 * Stamps the entry a collapsed dialog layer leaves behind as a navigable entry
 * of the navigation store's own — see `collapseDialogLayer` below for why the
 * residue needs an identity rather than the one it inherited.
 *
 * A hook rather than a direct call because the navigation store imports THIS
 * module for `DIALOG_HISTORY_KEY`; importing it back would close a cycle. The
 * store installs this at module init, so the unregistered fallback describes a
 * build — or an isolated test — that has not loaded the store.
 *
 * Adoption is two-phase on purpose. The adopter only DERIVES the residue's
 * state; the `commit` it hands back is what moves the store's own bookkeeping,
 * and the caller runs it strictly after the history write returns. A store that
 * advanced while producing the state would be left permanently one ahead of
 * history if that write threw — WebKit rate-limits history mutations with a
 * SecurityError — and every later traversal delta would be wrong.
 */
interface CollapsedEntryAdoption {
  state: Record<string, unknown>;
  commit: () => void;
}

type CollapsedEntryAdopter = (
  state: Record<string, unknown>,
) => CollapsedEntryAdoption;

let adoptCollapsedEntry: CollapsedEntryAdopter | null = null;

/**
 * Last registration wins and there is no unregister: the adopter is a single
 * slot, not a subscriber list. Passing `null` clears it back to the fallback.
 */
export function setCollapsedDialogEntryAdopter(
  adopter: CollapsedEntryAdopter | null,
) {
  adoptCollapsedEntry = adopter;
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

/**
 * Drops this layer's marker from the live entry, keeping the URL and the rest
 * of the state, and hands the residue to the navigation store to stamp.
 *
 * The residue is a genuinely navigable entry: it holds a URL the entry beneath
 * does not. It inherits that entry's navigation index, though — the marker
 * push copies the state it lands on, and a `replaceState` writer rewrites the
 * index it already found — so leaving it untouched makes the store read a
 * delta of 0 on the next Back and skip `runNavigationGuards` entirely, which
 * would let a Back off this entry abandon a dirty editor without asking. The
 * store assigns the index a `pushState` of its own would have.
 */
function collapseDialogLayer() {
  // `markerFromState` matched, so the live state is an object carrying this
  // layer's id; that is all it derives, and all this needs.
  const kept = { ...(window.history.state as Record<string, unknown>) };
  delete kept[DIALOG_HISTORY_KEY];
  const adoption = adoptCollapsedEntry?.(kept);
  window.history.replaceState(adoption?.state ?? kept, '', window.location.href);
  // Only once the entry really carries the index: a throwing `replaceState`
  // must leave the store's bookkeeping where it was, not one ahead of history.
  adoption?.commit();
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
 *
 * That leaves a deliberate asymmetry in the back stack, and it is the contract
 * rather than a side effect: a param change made THROUGH a dialog leaves one
 * entry behind, so Back undoes the switch and returns the user where they
 * were, while the same change made outside a dialog leaves none. The dialog
 * case is the one reached by a thumb on a phone's Back gesture, and returning
 * to the previous selection is what that gesture is asking for.
 */
export function registerDialogHistory(id: string, close: () => void) {
  ensureListener();
  const existing = entries.find((entry) => entry.id === id);
  const entry = existing ?? { id, close, pushedUrl: window.location.href };
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

      if (markerFromState(window.history.state) !== id) {
        markOrphaned(id);
        return;
      }

      if (window.location.href === entry.pushedUrl) {
        markOrphaned(id);
        suppressNextPop = true;
        window.history.back();
        return;
      }

      // A same-entry URL mutation must survive an ordinary close. `replaceState`
      // callers (the navigation store's `updateParams`) rewrite the URL of
      // whichever entry is live — the dialog's own — and carry this marker
      // forward with it, so some live entry still carries this id while the
      // entry underneath holds the pre-dialog URL. Travelling back would
      // discard the caller's navigation; collapse the layer where it stands
      // instead, keeping the new URL (archive#549).
      //
      // The match is by id, not by entry: a `pushState` that copies the state
      // it found (`useSectionNavigation`'s lightweight branch) can leave the
      // same id on more than one entry, which is why the id is not orphaned
      // here — an orphan armed for a reused id ('mobile-task-switcher' is a
      // constant) would make a later reopen skip its own entry. In the
      // ordinary case that costs nothing, because this path leaves no entry
      // carrying the id. Where a state-copying push HAS duplicated it, the
      // stranded marked entry costs one wasted Back press — the other tail of
      // the same identity-by-id limitation as #758.
      //
      // Known limitation (#758): if this layer is the INNER of two stacked
      // dialogs and the URL moved, collapsing in place leaves the outer's
      // own-entry check reading an entry it does not own, so the next Back
      // reverts the URL; with no navigation guard registered it then takes a
      // second press to close the outer dialog, while a registered guard's
      // restore/replay bounce closes it on the first. Unreachable today — no
      // nested dialog writes the URL.
      collapseDialogLayer();
    });
  };
}
