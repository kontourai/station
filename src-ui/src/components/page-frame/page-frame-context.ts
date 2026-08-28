import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';

/**
 * The three text slots every page header has. A view publishes these when the
 * route table cannot know them statically (a tab the view remembers in
 * `sessionStorage`, a breadcrumb that has to clear a selection, a per-tab
 * description). Everything else about the header — where it sits, how big the
 * title is, what the eyebrow looks like — belongs to `PageFrame` and is not
 * negotiable per view. That split is the whole point: the audit found six
 * title sizes and nine title x-positions because every view owned its own
 * header markup.
 */
export interface PageHeaderContent {
  eyebrow?: ReactNode;
  title?: ReactNode;
  subtitle?: ReactNode;
}

export interface PageFrameContextValue {
/**
* The header's right-aligned action cell, or null when the route renders
* without a header. A view portals its primary action here instead of
* inventing a place for it (: eight of the eight split-pane routes
* had their primary action in a list-pane footer, below the fold on short
* viewports).
*/
  actionsNode: HTMLElement | null;
/**
* A route-owned mobile detail layer. It is a sibling of the framed page's
* ordinary body, so a sheet can escape a route entrance transform without
* reaching imperatively into the app shell.
*/
  mobileDetailNode: HTMLElement | null;
/**
* Which route the header currently belongs to, from
* `app-shell/route-identity.ts` — the same rule the route entrance and the
* sidebar's pending publisher key off, so "this is a different route" is
* decided once for the whole shell.
*/
  routeIdentity: string;
  setHeaderOverride: (content: PageHeaderContent | null) => void;
  registerMobileDetailSheet: () => () => void;
}

export const PageFrameContext = createContext<PageFrameContextValue | null>(
  null,
);

/**
 * The header's own class, named once.
 *
 * Exported so a test can assert a view renders NO page header without writing
 * the literal itself: `scripts/shell-conformance-ratchet.mjs` scans every
 * tracked `.tsx` under `views/`/`pages/` — co-located tests included, on
 * purpose, since header markup in a fixture is header markup waiting to be
 * copied into a view — and a bare `'page__header'` string there would count
 * as one.
 */
export const PAGE_HEADER_CLASS = 'page__header';

function sameContent(
  a: PageHeaderContent | null,
  b: PageHeaderContent | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Object.is(a.eyebrow, b.eyebrow) &&
    Object.is(a.title, b.title) &&
    Object.is(a.subtitle, b.subtitle)
  );
}

/**
 * Publishes header text from inside the route's own tree.
 *
 * `useLayoutEffect`, not `useEffect`: the header and the view paint in the
 * same commit, so a route whose title is only known to the view never shows
 * an empty header first.
 *
 * The identity contract callers must honour: pass STRINGS, or nodes memoised
 * with `useMemo`. The store bails out when all three slots are `Object.is`-
 * equal to what is already there, so a stable value settles after one extra
 * render; a node rebuilt on every render would not settle at all.
 */
export function usePageHeader(content: PageHeaderContent | null): void {
  const context = useContext(PageFrameContext);
  const setHeaderOverride = context?.setHeaderOverride;
  const ownsTheHeader = useOwnsTheHeader();
  useLayoutEffect(() => {
    if (!setHeaderOverride) return;
// A view the user has left publishes NOTHING rather than its own title:
// the frame falls back to the route table's name for the route now on
// screen. See `useOwnsTheHeader`.
    setHeaderOverride(ownsTheHeader ? content : null);
  });
  useLayoutEffect(() => {
    if (!setHeaderOverride) return;
    return () => setHeaderOverride(null);
  }, [setHeaderOverride]);
}

/**
 * Whether the calling tree still owns the page header.
 *
 * A header contribution — a title, an action — belongs to the route that was
 * on screen when the contributing component MOUNTED. That is the whole rule,
 * and it is one rule for both halves of the header.
 *
 * It is needed because the frame deliberately outlives the route: it sits
 * above Suspense so the page keeps its header while the next chunk loads. When
 * that chunk is slow, React can keep the departing view committed for the
 * whole load (measured live: 1.5s of Plugins' list and its "+ Install Plugin"
 * button under a "Review" title), and a view that is still mounted keeps
 * publishing. Nothing about the frame's own state can tell those apart —
 * only the contributor knows which route it came for.
 *
 * The route body remounts on every route-identity change (`AppViewContent`
 * keys the entrance wrapper by the same identity, pinned by its own test), so
 * a view that is on screen legitimately always reads its own identity here.
 */
function useOwnsTheHeader(): boolean {
  const routeIdentity = useContext(PageFrameContext)?.routeIdentity ?? null;
  const mountedFor = useRef(routeIdentity);
  return mountedFor.current === routeIdentity;
}

/**
 * The header's action cell — null outside a framed route, and null once the
 * route this caller mounted for has been left, so a departing view's action
 * cannot sit in the next route's header. `useIsPageFramed` is what separates
 * those two cases for a caller that renders its action in place when there is
 * no header to put it in.
 */
export function usePageFrameActionsSlot(): HTMLElement | null {
  const context = useContext(PageFrameContext);
  const ownsTheHeader = useOwnsTheHeader();
  if (!ownsTheHeader) return null;
  return context?.actionsNode ?? null;
}

/** The current route's mobile detail portal target, if its frame has mounted. */
export function usePageFrameMobileDetailSlot(): HTMLElement | null {
  const context = useContext(PageFrameContext);
  const ownsTheHeader = useOwnsTheHeader();
  if (!ownsTheHeader) return null;
  return context?.mobileDetailNode ?? null;
}

/**
 * Registers a real mobile-detail portal while it is mounted. Registration is
 * route-owned: a Suspense-retained tree from the route the user left cannot
 * make the arriving frame inert or publish into its detail layer.
 */
export function useRegisterPageFrameMobileDetailSheet(active: boolean): void {
  const context = useContext(PageFrameContext);
  const ownsTheHeader = useOwnsTheHeader();
  const register = context?.registerMobileDetailSheet;
  useLayoutEffect(() => {
    if (!active || !ownsTheHeader || !register) return;
    return register();
  }, [active, ownsTheHeader, register]);
}

/** True when the surrounding route renders a shared page header. */
export function useIsPageFramed(): boolean {
  return useContext(PageFrameContext) !== null;
}

export { sameContent as samePageHeaderContent };
