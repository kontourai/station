import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useRegionModel,
  useRegionModelOptional,
} from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
} from '../../hooks/useIsMobile';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import {
  DOCK_REGION_IDS,
  foldedDockRegion,
  occupiedDockRegion,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
} from '../../regions/region-model';
import type { DockMode } from '../../types';
import './HeaderMenu.css';

const DOCK_WHEN = { not: 'composerFocused' } as const;

function RegionGlyph({ id }: { id: RegionId }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 16">
      <rect x="1" y="1" width="18" height="14" rx="2" />
      {id === 'left' ? (
        <path d="M6 1v14" />
      ) : id === 'right' ? (
        <path d="M14 1v14" />
      ) : (
        <path d="M1 10h18" />
      )}
    </svg>
  );
}

function RegionShortcut({
  surface,
  onToggle,
}: {
  surface: RegisteredSurface;
  onToggle: () => void;
}) {
  useKeyboardShortcut(
    surface.shortcut.id,
    surface.shortcut.key,
    [...surface.shortcut.modifiers],
    `Toggle ${surface.title} region`,
    onToggle,
    true,
    0,
    DOCK_WHEN,
  );
  return null;
}

function RegionSurfaceMenu({
  regionId,
  occupant,
  surfaces,
  onClose,
  onPlace,
}: {
  regionId: DockMode;
  occupant: string | null;
  surfaces: readonly RegisteredSurface[];
  onClose: () => void;
  onPlace: (surfaceId: string, regionId: DockMode) => void;
}) {
  const menuRef = useMenuFocus<HTMLDivElement>(true, onClose);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const choices = occupant
    ? surfaces.filter((surface) => surface.id !== occupant)
    : surfaces;
  const label = regionLabel(regionId);
  return createPortal(
    <>
      <button
        type="button"
        className="header-menu__dismiss-backdrop"
        aria-label={`Close ${label} region menu`}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onPointerDown={onClose}
      />
      <div
        ref={menuRef}
        className="app-toolbar__overflow-menu app-toolbar__region-menu"
        role="menu"
        aria-label={`${label} region surfaces`}
        tabIndex={-1}
      >
        {choices.map((surface) => (
          <button
            key={surface.id}
            type="button"
            role="menuitemradio"
            aria-checked="false"
            onClick={() => {
              onPlace(surface.id, regionId);
              onClose();
            }}
          >
            {occupant
              ? `Swap in ${surface.title}`
              : `Place ${surface.title} here`}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

function ConnectedRegionToolbarControls() {
  const {
    regions,
    lastShownRegion,
    surfaces,
    setRegion,
    placeSurface: placeSurfaceInModel,
  } = useRegionModel();
  const available = availablePlacements(useDockSlotDevice());
  const bottomOnly = available.length === 1;
  const surfaceList = [...surfaces.values()];
  const availableRegions = DOCK_REGION_IDS.filter((id) =>
    available.includes(id),
  );
  const [menuRegion, setMenuRegion] = useState<DockMode | null>(null);
  const foldedRegion = foldedDockRegion(regions, lastShownRegion);

  const showSurfaceAlone = useCallback(
    (surfaceId: string, regionId: DockMode) => {
      placeSurfaceInModel(surfaceId, regionId);
      for (const id of DOCK_REGION_IDS) {
        if (id !== regionId) setRegion(id, { visible: false });
      }
      setRegion(regionId, { visible: true });
    },
    [placeSurfaceInModel, setRegion],
  );

  const toggleSurface = useCallback(
    (surface: RegisteredSurface) => {
      const occupied = occupiedDockRegion(regions, surface.id);
      if (!occupied) {
        if (bottomOnly) showSurfaceAlone(surface.id, surface.defaultRegion);
        else placeSurfaceInModel(surface.id, surface.defaultRegion);
        return;
      }
      if (bottomOnly) {
        showSurfaceAlone(surface.id, occupied);
        return;
      }
      setRegion(occupied, { visible: !regions[occupied].visible });
    },
    [bottomOnly, placeSurfaceInModel, regions, setRegion, showSurfaceAlone],
  );

  const placeSurface = useCallback(
    (surfaceId: string, id: DockMode) => {
      if (!availableRegions.includes(id)) return;
      if (!surfaces.has(surfaceId)) return;
      placeSurfaceInModel(surfaceId, id);
    },
    [availableRegions, placeSurfaceInModel, surfaces],
  );

  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {surfaceList.map((surface) => (
        <RegionShortcut
          key={surface.id}
          surface={surface}
          onToggle={() => toggleSurface(surface)}
        />
      ))}
      {bottomOnly
        ? surfaceList.map((surface) => {
            const occupied = occupiedDockRegion(regions, surface.id);
            const pressed = occupied === foldedRegion;
            const actionLabel = `Show ${surface.title}`;
            return (
              <button
                key={surface.id}
                type="button"
                className="app-toolbar__region-btn"
                aria-label={actionLabel}
                aria-pressed={pressed}
                title={actionLabel}
                onClick={() => toggleSurface(surface)}
              >
                <RegionGlyph id={occupied ?? surface.defaultRegion} />
              </button>
            );
          })
        : availableRegions.map((id) => {
            const occupant = regions[id].occupant;
            const surface = occupant ? surfaces.get(occupant) : undefined;
            const label = regionLabel(id);
            const pressed = Boolean(surface && regions[id].visible);
            const actionLabel = surface
              ? `${pressed ? 'Hide' : 'Show'} ${surface.title} ${label} region`
              : `Choose a surface for ${label} region`;
            return (
              <span key={id} className="app-toolbar__region-control">
                <button
                  type="button"
                  className="app-toolbar__region-btn"
                  aria-label={actionLabel}
                  aria-pressed={pressed}
                  title={actionLabel}
                  onClick={() => {
                    if (surface) toggleSurface(surface);
                    else setMenuRegion(id);
                  }}
                >
                  <RegionGlyph id={id} />
                  {!surface && (
                    <span className="app-toolbar__region-add">+</span>
                  )}
                </button>
                {surface && surfaceList.length > 1 ? (
                  <button
                    type="button"
                    className="app-toolbar__region-swap"
                    aria-label={`Change ${label} region surface`}
                    aria-haspopup="menu"
                    aria-expanded={menuRegion === id}
                    onClick={() => setMenuRegion(id)}
                  >
                    ⋯
                  </button>
                ) : null}
              </span>
            );
          })}
      {menuRegion ? (
        <RegionSurfaceMenu
          regionId={menuRegion}
          occupant={regions[menuRegion].occupant}
          surfaces={surfaceList}
          onClose={() => setMenuRegion(null)}
          onPlace={placeSurface}
        />
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
