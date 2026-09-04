import { useState } from 'react';
import { resolveViewFromPath } from '../../app-shell/routing';
import {
  APP_SURFACE_REGISTRY,
  type SurfaceDefinition,
  type SurfaceSection,
} from '../../app-shell/surface-registry';
import { usePendingRouteSurfaceId } from '../../app-shell/useRoutePending';
import { useRegionModelOptional } from '../../contexts/RegionModelContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { occupiedDockRegion } from '../../regions/region-model';
import { PROJECT_SIDEBAR_NAV_GROUPS, surfaceIcon } from './nav-items';

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
  const activeSurface = APP_SURFACE_REGISTRY.getSurfaceForView(
    resolveViewFromPath(activePath ?? window.location.pathname),
  );
  // archive#3313: pass the live flags through — calling getSidebar with no
  // flags meant a previewFlag-gated surface could never appear here, even
  // after its preview (or the developer-tools setting) was enabled.
  const sidebarSurfaces = APP_SURFACE_REGISTRY.getSidebar(
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
    ReadonlySet<SurfaceSection>
  >(() => new Set());
  const toggleSection = (section: SurfaceSection) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);
      if (!next.delete(section)) next.add(section);
      return next;
    });
  };

  const renderRow = (surface: SurfaceDefinition) => {
    const label = surface.label();
    const occupiedRegion =
      surface.regionSurface && regionModel
        ? occupiedDockRegion(regionModel.regions, surface.regionSurface)
        : undefined;
    const isActive = surface.regionSurface
      ? Boolean(occupiedRegion && regionModel?.regions[occupiedRegion].visible)
      : activeSurface?.id === surface.id;
    // SHELL-05: the route chunk takes ~1.4 s to arrive on a cold surface, and
    // the row the user clicked said nothing for all of it. `pendingSurfaceId`
    // is the suspended route outlet itself, not a timer started at click, and
    // it is resolved through the same `getSurfaceForView` that decides which
    // row is active — so a deep route marks its owning row rather than
    // nothing at all.
    const isPending = pendingSurfaceId === surface.id;
    return (
      <button
        key={surface.id}
        type="button"
        className={`sidebar__nav-btn${isActive ? ' sidebar__nav-btn--active' : ''}${
          isPending ? ' sidebar__nav-btn--pending' : ''
        }`}
        aria-busy={isPending || undefined}
        onClick={() => {
          if (surface.regionSurface) showSurface(surface.regionSurface);
          else navigate(surface.route);
          if (isMobile) onAfterNavigate?.();
        }}
        title={collapsed ? label : undefined}
        aria-label={label}
        // archive#2652: a stable anchor per management group so the
        // first-run tour can point at a real nav affordance. Derived
        // from the registry's semantic owner, so a group added or
        // renamed later carries its anchor without a parallel list.
        data-first-run-anchor={
          surface.managementGroup ? `nav-${surface.managementGroup}` : undefined
        }
      >
        {surface.icon ? surfaceIcon(surface.icon) : null}
        <span className="sidebar__nav-label">{label}</span>
        {isPending ? (
          <span className="sidebar__nav-spinner" aria-hidden="true" />
        ) : null}
      </button>
    );
  };

  const primarySurfaces = sidebarSurfaces.filter(
    (surface) => surface.sidebar?.section === 'primary',
  );

  return (
    <div className="sidebar__nav">
      {primarySurfaces.map(renderRow)}
      {PROJECT_SIDEBAR_NAV_GROUPS.map((section) => {
        const sectionOpen = !collapsedSections.has(section.id);
        const sectionActive = activeSurface?.sidebar?.section === section.id;
        const items = sidebarSurfaces.filter(
          (surface) => surface.sidebar?.section === section.id,
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
