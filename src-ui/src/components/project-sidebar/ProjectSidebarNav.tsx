import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { usePendingRouteSurfaceId } from '../../app-shell/useRoutePending';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useShowSurfacePage } from '../../contexts/useShowSurface';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { destinationIcon } from './nav-items';

interface ProjectSidebarNavProps {
  collapsed: boolean;
  isMobile: boolean;
  navigate: (path: string) => void;
  /** Current route path; drives the active highlight. Defaults to the live URL
   *  so callers that don't track navigation state still work. */
  activePath?: string;
  onAfterNavigate?: () => void;
}

export function ProjectSidebarNav({
  collapsed,
  isMobile,
  navigate,
  activePath,
  onAfterNavigate,
}: ProjectSidebarNavProps) {
  const regionModel = useRegionModelOptional();
  const showSurfacePage = useShowSurfacePage();
  const activeDestination = APP_DESTINATION_REGISTRY.getDestinationForView(
    resolveViewFromPath(activePath ?? window.location.pathname),
  );
  // archive#3313: pass the live flags through — calling getSidebar with no
  // flags meant a previewFlag-gated destination could never appear here, even
  // after its preview (or the developer-tools setting) was enabled.
  const sidebarDestinations = APP_DESTINATION_REGISTRY.getSidebar(
    useSurfaceVisibilityFlags(),
  );
  const pendingSurfaceId = usePendingRouteSurfaceId();

  const renderRow = (destination: DestinationDefinition) => {
    const label = destination.label();
    // A row backed by a `regionSurface` is a PLACE, like Home: pressing it
    // opens the surface as the page (`useShowSurfacePage` puts it in `main`
    // and the model navigates to `/`), so it is current exactly when `/` is
    // showing it. That is the same derivation `ProjectSidebar`'s Home row
    // reads (`main`'s occupant at `/`), so the two can never both be current:
    // `main` holds one surface. #1582 D4 made this row a pressed toggle
    // because it placed the surface in a DOCK beside whatever page was
    // current and never navigated; it now navigates, so it takes the
    // current-page state and no longer reports `aria-pressed`. A docked
    // Activity is a pane beside the page — its dock region's toolbar toggle
    // and ⌘⇧A carry that state, not this row.
    const isCurrent = destination.regionSurface
      ? (activePath ?? window.location.pathname) === '/' &&
        regionModel?.regions.main.occupant === destination.regionSurface
      : activeDestination?.id === destination.id;
    // SHELL-05: the route chunk takes ~1.4 s to arrive on a cold destination, and
    // the row the user clicked said nothing for all of it. `pendingSurfaceId`
    // is the suspended route outlet itself, not a timer started at click, and
    // it is resolved through the same `getDestinationForView` that decides which
    // row is active — so a deep route marks its owning row rather than
    // nothing at all.
    const isPending = pendingSurfaceId === destination.id;
    return (
      <button
        key={destination.id}
        type="button"
        className={`sidebar__nav-btn${
          isCurrent ? ' sidebar__nav-btn--active' : ''
        }${isPending ? ' sidebar__nav-btn--pending' : ''}`}
        aria-busy={isPending || undefined}
        aria-current={isCurrent ? 'page' : undefined}
        onClick={() => {
          // Pressing the current page again is a no-op placement: the model
          // re-selects the surface already in `main` and `/` is already the
          // route. From any other route it goes back to `/`, where the page is.
          if (destination.regionSurface)
            showSurfacePage(destination.regionSurface);
          else navigate(destination.route);
          if (isMobile) onAfterNavigate?.();
        }}
        title={collapsed ? label : undefined}
        aria-label={label}
        // archive#2652: a stable anchor per management group so the
        // first-run tour can point at a real nav affordance. Derived
        // from the registry's semantic owner, so a group added or
        // renamed later carries its anchor without a parallel list.
        data-first-run-anchor={
          destination.managementGroup
            ? `nav-${destination.managementGroup}`
            : undefined
        }
      >
        {destination.icon ? destinationIcon(destination.icon) : null}
        <span className="sidebar__nav-label">{label}</span>
        {isPending ? (
          <span className="sidebar__nav-spinner" aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  return (
    <div className="sidebar__nav">{sidebarDestinations.map(renderRow)}</div>
  );
}
