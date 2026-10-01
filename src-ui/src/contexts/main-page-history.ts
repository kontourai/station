import { DIALOG_HISTORY_KEY } from '../components/dialog-history';

/**
 * `main`'s occupant as a fact of the history entry (#2986).
 *
 * The page at `/` is placement, not a URL: the sidebar's Home and Activity
 * rows swap `main`'s occupant without changing the address. Without a history
 * identity that swap added no entry, so Back from the Activity page left `/`
 * — and, in the Android app from its first entry, could close the app.
 *
 * Each `/` entry is stamped with the surface `main` showed on it, and a swap
 * made AT `/` pushes a same-URL entry for the new occupant. A traversal that
 * lands on a stamped entry puts that surface back (`RegionModelContext`), so
 * Back returns to the previous page and Forward re-opens the one left. The
 * stamp is in `history.state`, which survives a reload.
 *
 * The pushed entry copies the state it lands on, so it shares the navigation
 * index of the entry beneath, the way a dialog layer does: a traversal between
 * the two is not a route change and asks no unsaved-changes guard.
 */
export const MAIN_PAGE_HISTORY_KEY = '__stationMainPage';

function stateRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === 'object' && !Array.isArray(state)
    ? { ...(state as Record<string, unknown>) }
    : {};
}

/** The surface a history entry says `main` showed, if it says. */
export function mainPageOf(state: unknown): string | undefined {
  const page = stateRecord(state)[MAIN_PAGE_HISTORY_KEY];
  return typeof page === 'string' && page.length > 0 ? page : undefined;
}

/** Records on the live entry which surface `main` is showing. */
export function stampMainPage(surfaceId: string): void {
  if (mainPageOf(window.history.state) === surfaceId) return;
  try {
    window.history.replaceState(
      {
        ...stateRecord(window.history.state),
        [MAIN_PAGE_HISTORY_KEY]: surfaceId,
      },
      '',
      window.location.href,
    );
  } catch {
    // WebKit rate-limits history writes with a SecurityError. An unstamped
    // entry is one a traversal leaves `main` alone on.
  }
}

/**
 * A new same-URL entry for a page swap. The entry being left keeps the stamp
 * of what it showed. A dialog's Back marker belongs to the entry the dialog
 * opened on, so it is not carried (as `navigationStore.navigate` does not).
 */
export function pushMainPage(previous: string, next: string): void {
  stampMainPage(previous);
  const state = stateRecord(window.history.state);
  delete state[DIALOG_HISTORY_KEY];
  state[MAIN_PAGE_HISTORY_KEY] = next;
  try {
    window.history.pushState(state, '', window.location.href);
  } catch {
    // See `stampMainPage`: the swap stands, without an entry of its own.
    stampMainPage(next);
  }
}
