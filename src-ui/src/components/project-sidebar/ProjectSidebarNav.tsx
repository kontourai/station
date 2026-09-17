import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { usePendingRouteSurfaceId } from '../../app-shell/useRoutePending';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { occupiedRegion } from '../../regions/region-model';
import { destinationIcon } from './nav-items';

/**
 * The panel's destination rows. #2059 (design record D3): the left panel
 * lists PLACES only, so this is a flat list with no group headers — the
 * `Customize` and `System` disclosure groups went with the eleven
 * configuration destinations they held, which are now reached through the
 * footer's gear (Settings' Manage group) and the command palette. The
 * registry's `sidebar` field is the seam; routes, pages and palette entries
 * did not move.
 *
 * What survives here is the row itself: `aria-current` for a routed place,
 * `aria-pressed` for a placed surface, and the pending-route mark. Activity
 * is the only row today; Boards join it in slice 4 (#2061).
 */
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
  const showSurface = useShowSurface();
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
    // #1582 D4: a row backed by a `regionSurface` PLACES that surface; it does
    // not navigate, and the URL is unchanged by it. So its state is "is this
    // surface showing" (`aria-pressed`), not "is this the current page"
    // (`aria-current`) — the audit found Home and Activity both wearing the
    // current-page highlight at once, which claimed two current locations.
    // Exactly one row can be current, and it is always a routed one.
    //
    // The occupancy read covers `main` as well as the dock regions: #928 lets
    // Activity take the primary area, and a surface showing there is no less
    // shown than one in a side region.
    const placedRegion =
      destination.regionSurface && regionModel
        ? occupiedRegion(regionModel.regions, destination.regionSurface)
        : undefined;
    const isShown = Boolean(
      placedRegion && regionModel?.regions[placedRegion].visible,
    );
    const isCurrent =
      !destination.regionSurface && activeDestination?.id === destination.id;
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
        }${isShown ? ' sidebar__nav-btn--shown' : ''}${
          isPending ? ' sidebar__nav-btn--pending' : ''
        }`}
        aria-busy={isPending || undefined}
        aria-current={isCurrent ? 'page' : undefined}
        aria-pressed={destination.regionSurface ? isShown : undefined}
        onClick={() => {
          if (destination.regionSurface) {
            // A control that reports `aria-pressed` has to un-press. Hiding
            // goes through the model's own `toggleSurface` — the one decision
            // behind this surface's chord and its Regions-menu row (#1523,
            // #1420), so the sidebar carries no copy of the placement rules.
            // Revealing stays with `useShowSurface`, which routes to the
            // canonical deep link when no region host is mounted; the model's
            // toggle has no such fallback and would write state nothing
            // renders.
            //
            // From `main` this takes TWO presses, and that is the recorded
            // rule rather than a gap here: `toggleSurface`'s `main`-occupant
            // case (region-model.ts) relocates the surface to its
            // `defaultRegion` VISIBLE, so a chord that "hides" a `main`
            // occupant leaves Home behind rather than doing nothing (#1523).
            // Press one re-docks it and the row stays pressed — truthfully,
            // the surface is still showing; press two hides the dock region.
            if (isShown && regionModel)
              regionModel.toggleSurface(destination.regionSurface);
            else showSurface(destination.regionSurface);
          } else navigate(destination.route);
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
