import type { CSSProperties } from 'react';
// Deep import, not the barrel: this component is rendered by
// `RouteViewBoundary`, which is on the eager entry path.
import type { PageFrameSpec } from '../components/page-frame/PageFrame';
import { Skeleton, SkeletonBlock, SkeletonList } from '../components/Skeleton';
import { SPLIT_PANE_DEFAULT_WIDTH } from '../components/split-pane-metrics';
import { useIsMobile } from '../hooks/useIsMobile';
import { useLocale } from '../i18n/LocaleContext';
import type { NavigationView } from '../types';
import { routePendingShape } from './route-pending-shape';
import './route-pending-skeleton.css';

/**
 * The body's answer to the header, for the window in which the header names
 * the arriving route and the arriving route has not run yet.
 *
 * Station's frame keeps the header up across a chunk load and fills it from
 * the route table (`resolvePageFrame`), so the title already says "Review"
 * about 8 ms after the click. What was missing underneath was the *shape*: a
 * single generic six-row list stood in for every route, so a split-pane
 * destination announced itself as a full-width list and then jumped to a
 * 280 px rail plus a detail pane once its chunk landed. The placeholder
 * promised a layout the page does not have.
 *
 * So the shape comes from `route-pending-shape.ts`, which reads the
 * destination's own frame spec plus the same three facts the arriving view will
 * read — the Guidance tab, the mobile breakpoint, and the pane's persisted
 * collapse — each through the function the view itself uses. The rail's width is
 * `SPLIT_PANE_DEFAULT_WIDTH`, the same constant `SplitPaneLayout` starts from,
 * rather than a number copied into a stylesheet. A user who has dragged a pane
 * wider will see the rail settle to their width when the chunk arrives; the
 * persisted width is keyed by a pane id, and for the panes that have one this
 * placeholder reads only the collapse, because a wrong width is a nudge while a
 * wrong collapse is a 252 px jump.
 *
 * There is deliberately no timer here and no cap on how long the previous body
 * may be held. Both would need a duration nothing derives, and the case they
 * exist for — a stale body surviving the header — does not arise on the path
 * Station navigates by. That is a narrower claim than "Suspense hides the old
 * subtree", and worth stating exactly, because it is conditional:
 *
 * React shows a Suspense fallback, and hides the boundary's previous children
 * with an inline `display: none`, when an **urgent** update suspends. Station's
 * navigation is urgent — `App.tsx` calls a plain `setCurrentView`, for a link
 * click and for `popstate` alike, and nothing in the UI wraps navigation in
 * `startTransition`. Under a transition React does the opposite: it keeps the
 * departing content revealed and renders no fallback at all, which is exactly
 * the symptom archive#3660 described. Both halves are asserted in
 * `__tests__/RoutePendingSkeleton.test.tsx`, so wrapping navigation in a
 * transition later reddens a test that names the reason instead of quietly
 * restoring the defect.
 */
export function RoutePendingSkeleton({
  view,
  spec,
}: {
  /** The arriving route. Omitted by a caller that has no route (embedded outlets, tests). */
  view?: NavigationView;
  spec?: PageFrameSpec | null;
}) {
  const { message } = useLocale();
  // A `matchMedia` subscription, but only for as long as this placeholder is
  // mounted — which is only while a route outlet is suspended.
  const isMobile = useIsMobile();
  const shape = view ? routePendingShape(view, spec, isMobile) : 'unshaped';

  if (shape === 'split-pane') {
    return (
      <div
        className="route-pending route-pending--split-pane"
        style={
          {
            '--route-pending-rail-width': `${SPLIT_PANE_DEFAULT_WIDTH}px`,
          } as CSSProperties
        }
      >
        <div className="route-pending__rail">
          <SkeletonList count={6} label={message('route.loading')} />
        </div>
        {/* Decorative: the rail's `SkeletonList` is already the one live
            region announcing the wait, and a second `role="status"` beside it
            makes a screen reader say "loading" twice for one navigation. */}
        <div className="route-pending__detail" aria-hidden="true">
          <Skeleton variant="line" className="route-pending__detail-title" />
          <Skeleton variant="block" />
        </div>
      </div>
    );
  }

  if (shape === 'detail-sheet') {
    return (
      <div className="route-pending route-pending--detail-sheet">
        <SkeletonBlock count={2} label={message('route.loading')} />
      </div>
    );
  }

  if (shape === 'region') {
    const blocks = <SkeletonBlock count={3} label={message('route.loading')} />;
    // A `flush` frame drops its body inset for a list rail that runs to the
    // frame edge. This shape has no rail — Guidance's Commands tab is the one
    // route that is both — so it puts the inset back and holds the x-origin the
    // arriving body renders at.
    return spec?.flush ? (
      <div className="route-pending route-pending--inset">{blocks}</div>
    ) : (
      blocks
    );
  }

  return <SkeletonList label={message('route.loading')} />;
}
