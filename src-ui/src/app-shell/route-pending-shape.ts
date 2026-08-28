// Deep import, not the barrel: this module is on the eager entry path and the
// page-frame barrel also reaches `PageEyebrowTrail`, which only lazy views use.
import type { PageFrameSpec } from '../components/page-frame/PageFrame';
import {
  AGENTS_PANE_ID,
  CONNECTIONS_ENGINES_PANE_ID,
  CONNECTIONS_MODELS_PANE_ID,
  readPersistedPaneCollapsed,
  shouldShowMobileDetailSheet,
} from '../components/split-pane-metrics';
import type { NavigationView } from '../types';
import { resolveGuidanceTab } from '../views/guidance-tab';

/**
 * Which shape the body holds while a route's chunk is in flight.
 *
 * - `split-pane` — list rail + detail pane, and below the mobile breakpoint the
 *   list alone (the stylesheet collapses it, mirroring `SplitPaneLayout.css`).
 * - `detail-sheet` — the detail filling the width, with no list beside it. Two
 *   routes arrive that way: a mobile route that opens an editor, and a desktop
 *   route whose list pane is persisted collapsed.
 * - `region` — one column of content the frame pads and `.content-view`
 *   scrolls.
 * - `unshaped` — the route has no frame, so nothing has told the user which
 *   page they are arriving at and there is no declared shape to hold.
 */
export type RoutePendingShape =
  | 'split-pane'
  | 'detail-sheet'
  | 'region'
  | 'unshaped';

/**
 * The frame's own layout fields decide the base shape.
 *
 * `flush` is set by exactly one spec in `page-frame-registry.ts`, the shared
 * `SPLIT_PANE` constant, because dropping the body inset is what a list rail
 * that runs to the frame edge needs; `fill` alongside it means that rail owns
 * its own height. A route declared that way IS a split pane.
 *
 * Guidance is the one route whose frame cannot answer this. It is a single
 * route with three tabs and one `SPLIT_PANE` spec, but its Commands tab renders
 * a single-column list (`CommandsView`), so the spec alone classifies a third
 * of the route wrongly. The tab is knowable before the chunk loads — it is in
 * the URL, or in the session memory `GuidanceView` itself reads — so this asks
 * `resolveGuidanceTab`, the same resolver the view will ask.
 */
function baseShape(
  view: NavigationView,
  spec: PageFrameSpec,
): Exclude<RoutePendingShape, 'unshaped'> {
  if (view.type === 'guidance') {
    return resolveGuidanceTab(view.tab) === 'commands'
      ? 'region'
      : 'split-pane';
  }
  return spec.flush && spec.body === 'fill' ? 'split-pane' : 'region';
}

/**
 * Whether the arriving split-pane route already names an item, which is what
 * `SplitPaneLayout` turns into a non-null `selectedId`.
 *
 * This is `route-identity.ts`'s "primary record a route is about" fields, PLUS
 * `guidance.selectedId` — which that file deliberately EXCLUDES. The two
 * questions are different and the difference is exactly that field:
 *
 * - `routeIdentity` asks "is this a different route?", i.e. may the entrance
 *   replay and may the route body remount. Picking a row in Guidance's split
 *   pane is not leaving the surface, so re-keying on it would remount an
 *   editor mid-edit. It stays out.
 * - This asks "which side will the pane open on?" — and a selected row is
 *   precisely what makes it open on the detail. It has to come in.
 *
 * So the overlap is a consequence, not a definition, and any future route whose
 * pane opens on a detail without changing its identity belongs here and not
 * there. Deliberately a switch and not a truthiness test over unknown fields:
 * `plugins`, `review-queue`, `connections-providers`, `connections-engines`,
 * `connections-tools` and bare `agents` name no record and open on their list,
 * and Activity without an id is the "all sessions" list rather than one
 * session.
 */
export function routeOpensDetailPane(view: NavigationView): boolean {
  switch (view.type) {
    case 'agent-new':
    case 'agent-edit':
    case 'connections-provider-edit':
    case 'connections-runtime-edit':
    case 'connections-tool-edit':
      return true;
    case 'activity':
      return view.sessionId !== undefined;
    // `/guidance/new` selects `__new__` in the tab's own pane, so any selected
    // id — including the literal `new` — opens the detail.
    case 'guidance':
      return view.selectedId !== undefined;
    default:
      return false;
  }
}

/**
 * The persisted pane the arriving route will mount, or `null` for a route whose
 * pane persists nothing (it always starts expanded).
 *
 * Three views mount a pane with an id; the ids themselves are declared once in
 * `split-pane-metrics.ts` and imported by both the view and this file.
 */
function paneIdForRoute(view: NavigationView): string | null {
  switch (view.type) {
    case 'agents':
    case 'agent-new':
    case 'agent-edit':
      return AGENTS_PANE_ID;
    case 'connections-engines':
    case 'connections-runtime-edit':
      return CONNECTIONS_ENGINES_PANE_ID;
    case 'connections-providers':
    case 'connections-provider-edit':
      return CONNECTIONS_MODELS_PANE_ID;
    default:
      return null;
  }
}

const PENDING_SELECTION = 'pending-selection';

/**
 * The shape to hold for `view`, given its registered frame and whether the
 * viewport is currently the mobile one.
 *
 * `isMobile` comes in as an argument because it is a `matchMedia`
 * subscription — the caller owns it via `useIsMobile`, the same hook
 * `SplitPaneLayout` uses, so both read one breakpoint. The two storage reads
 * are made here rather than passed in because they are the same synchronous
 * reads the arriving view will make, from the same keys.
 */
export function routePendingShape(
  view: NavigationView,
  spec: PageFrameSpec | null | undefined,
  isMobile: boolean,
): RoutePendingShape {
  if (!spec) return 'unshaped';
  const base = baseShape(view, spec);
  if (base !== 'split-pane') return base;

  if (isMobile) {
    // Below the breakpoint the pane shows one side; the collapse state is a
    // desktop affordance and `SplitPaneLayout` ignores it there. The
    // placeholder knows THAT the route names a record, not which one, and
    // `shouldShowMobileDetailSheet` only tests the id for null — so a stand-in
    // is the whole of what the shared rule needs to decide this.
    return shouldShowMobileDetailSheet(
      isMobile,
      routeOpensDetailPane(view) ? PENDING_SELECTION : null,
    )
      ? 'detail-sheet'
      : 'split-pane';
  }
  return readPersistedPaneCollapsed(paneIdForRoute(view))
    ? 'detail-sheet'
    : 'split-pane';
}
