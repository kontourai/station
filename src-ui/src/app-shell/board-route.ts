/**
 * The one authority for a Board's URL (#2062).
 *
 * Three readers need the same answer — the panel's Boards rows, the route
 * parser (`routing.ts`), and the navigation store's independent pathname
 * parse — and Station has already paid for a URL shape spelled out in more
 * than one place: `/projects/<p>/layouts/<l>` is written as a literal in
 * `routing.ts` AND in `navigation-store.ts`, which is why a layout tab route
 * had to be taught to both. Boards start with one builder and one matcher.
 *
 * The segment is `/boards` rather than `/board`: `/board/...` is already the
 * archive#4079 task/session board face (`NavigationView` member `board`), an
 * unrelated product object that happens to share the word. Station's glossary
 * carries the collision explicitly.
 */
export const BOARD_ROUTE_PREFIX = '/boards';

/** The canonical path for one of the viewer's own Boards. */
export function boardPath(boardSlug: string): string {
  return `${BOARD_ROUTE_PREFIX}/${encodeURIComponent(boardSlug)}`;
}

/**
 * The Board a pathname addresses, or `null` when it addresses none.
 *
 * EXACT (one segment, optional trailing slash), for the reason
 * `resolveViewFromPath`'s project matcher is exact: a `startsWith` matcher
 * takes the second segment and silently discards the rest, so a stale or
 * mistyped deep link renders a real Board instead of "Page not found".
 */
export function parseBoardPath(pathname: string): string | null {
  const match = pathname.match(/^\/boards\/([^/]+)\/?$/);
  if (!match?.[1]) return null;
  try {
    // No `|| null` on the decode: `([^/]+)` cannot match an empty segment,
    // and percent-decoding a non-empty one always yields at least one code
    // unit (`%00` decodes to NUL, which is one character), so an
    // empty-string result is unreachable. It was there, and this branch is
    // the second unreachable guard #2062 removed rather than leave as
    // something a reader would take for a handled case (review F4).
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape is not a Board name; treat it as no match rather
    // than letting the decode throw out of a route parse.
    return null;
  }
}
