/**
 * Which Guidance tab a route resolves to, and the one place that answers it.
 *
 * Guidance is a single route (`/guidance`) whose body is a different layout per
 * tab — Skills is a split pane, Commands is a single-column list. The tab
 * therefore decides the page's shape, and TWO readers need it: the view itself,
 * and the shell's route placeholder, which has to pick a shape before
 * `GuidanceView`'s chunk exists. Both read this, so a placeholder can never
 * disagree with the tab the view is about to open.
 *
 * It lives in its own module rather than in `GuidanceView.tsx` because that
 * file is a lazy route chunk: importing the resolver from there would hoist the
 * whole view — its sub-views and their editors — onto the eager entry path.
 */
export type GuidanceTab = 'skills' | 'commands';

export const GUIDANCE_TAB_MEMORY_KEY = 'station-guidance-tab';

/**
 * Which Guidance list is on screen, when the reader narrowed it.
 *
 * Only one narrowing exists: `commands` is the set of skills that are runnable
 * as a `/command`. It is a URL param rather than component state because a
 * bookmark, a palette entry and a deep link all have to land on the same list,
 * and a remembered-in-React filter cannot be linked to.
 */
export type GuidanceFilter = 'commands';

export function isGuidanceFilter(value: unknown): value is GuidanceFilter {
  return value === 'commands';
}

/**
 * The tab remembered from this session, or `skills`.
 *
 * `sessionStorage` can throw in privacy-restricted webviews, and an unreadable
 * memory is the same answer as no memory. A retired tab left in the memory by
 * an older build reads as the default rather than as itself.
 */
export function readRememberedGuidanceTab(): GuidanceTab {
  try {
    return sessionStorage.getItem(GUIDANCE_TAB_MEMORY_KEY) === 'commands'
      ? 'commands'
      : 'skills';
  } catch {
    return 'skills';
  }
}

/** The URL wins over the memory; the memory wins over the default. */
export function resolveGuidanceTab(routeTab: GuidanceTab | undefined) {
  return routeTab ?? readRememberedGuidanceTab();
}
