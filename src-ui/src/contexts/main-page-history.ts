/**
 * `main`'s occupant as a fact of the history entry (#2986).
 *
 * The page at `/` is placement, not a URL: the sidebar's Home and Activity
 * rows swap `main`'s occupant without changing the address. Without a history
 * identity that swap added no entry, so Back from the Activity page left `/`
 * — and, in the Android app from its first entry, could close the app.
 *
 * Each `/` entry is stamped with the surface `main` showed on it, and a swap
 * made AT `/` is a navigation entry of its own (`RegionModelContext` pushes
 * it through the navigation store, so it has its own navigation index). A
 * traversal that lands on a stamped entry puts that surface back, so Back
 * returns to the previous page and Forward re-opens the one left. The stamp
 * is in `history.state`, which survives a reload.
 *
 * This module only reads and writes the stamp; it must not import the
 * navigation store, which imports the key to keep it off new route entries.
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
