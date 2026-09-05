import { useState } from 'react';
import {
  APP_DESTINATION_REGISTRY,
  type DestinationDefinition,
  type DestinationSection,
} from '../../app-shell/destination-registry';
import { resolveViewFromPath } from '../../app-shell/routing';
import { usePendingRouteSurfaceId } from '../../app-shell/useRoutePending';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { occupiedDockRegion } from '../../regions/region-model';
import { destinationIcon, PROJECT_SIDEBAR_NAV_GROUPS } from './nav-items';

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

  // SHELL-15: `Customize` and `System` used to be mutually exclusive
  // accordions whose open state was DERIVED FROM THE ROUTE — exactly one
  // could be open, and on Home neither was, so every one of the nine
  // management destinations cost two clicks from Home and every cross-group
  // move cost two clicks from anywhere. Both groups now start open (the rows
  // fit: three top-level entries plus two groups of two and five) and the
  // user's own collapse survives navigation instead of being overwritten by
  // whichever group the next route belongs to.
  const [collapsedSections, setCollapsedSections] = useState<
    ReadonlySet<DestinationSection>
  >(() => new Set());
  const toggleSection = (section: DestinationSection) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  };

  const renderRow = (destination: DestinationDefinition) => {
    const label = destination.label();
    const occupiedRegion =
      destination.regionSurface && regionModel
        ? occupiedDockRegion(regionModel.regions, destination.regionSurface)
        : undefined;
    const isActive = destination.regionSurface
      ? Boolean(occupiedRegion && regionModel?.regions[occupiedRegion].visible)
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
        className={`sidebar__nav-btn${isActive ? ' sidebar__nav-btn--active' : ''}${
          isPending ? ' sidebar__nav-btn--pending' : ''
        }`}
        aria-busy={isPending || undefined}
        onClick={() => {
          if (destination.regionSurface) showSurface(destination.regionSurface);
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

  const primaryDestinations = sidebarDestinations.filter(
    (destination) => destination.sidebar?.section === 'primary',
  );

  return (
    <div className="sidebar__nav">
      {primaryDestinations.map(renderRow)}
      {PROJECT_SIDEBAR_NAV_GROUPS.map((section) => {
        const sectionOpen = !collapsedSections.has(section.id);
        const sectionActive =
          activeDestination?.sidebar?.section === section.id;
        const items = sidebarDestinations.filter(
          (destination) => destination.sidebar?.section === section.id,
        );
        return (
          <div className="sidebar__nav-group" key={section.id}>
            <button
              type="button"
              className={`sidebar__nav-btn sidebar__nav-group-toggle${sectionActive ? ' sidebar__nav-btn--active' : ''}`}
              aria-expanded={sectionOpen}
              aria-controls={`sidebar-${section.id}-nav`}
              onClick={() => toggleSection(section.id)}
              title={collapsed ? section.label : undefined}
            >
              {section.icon}
              <span className="sidebar__nav-label">{section.label}</span>
              <span className="sidebar__nav-chevron" aria-hidden="true">
                {sectionOpen ? '−' : '+'}
              </span>
            </button>
            <div
              id={`sidebar-${section.id}-nav`}
              className="sidebar__nav-group-items"
              hidden={!sectionOpen}
            >
              {items.map(renderRow)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
