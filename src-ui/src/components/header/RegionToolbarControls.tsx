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
  firstFreeDockRegion,
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

function ToolbarMenu({
  ariaLabel,
  dismissLabel,
  anchorRight,
  onClose,
  items,
}: {
  ariaLabel: string;
  dismissLabel: string;
  anchorRight: number;
  onClose: () => void;
  items: readonly {
    key: string;
    label: string;
    onSelect: () => void;
  }[];
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

  return createPortal(
    <>
      <button
        type="button"
        className="header-menu__dismiss-backdrop"
        aria-label={dismissLabel}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 'calc(var(--layer-navigation) - 1)',
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="app-toolbar__overflow-menu app-toolbar__region-menu"
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{ right: `${anchorRight}px` }}
      >
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
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
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);
  const foldedRegion = foldedDockRegion(regions, lastShownRegion);
  const menuOccupant = menuRegion && regions[menuRegion].occupant;
  const menuLabel = menuRegion && regionLabel(menuRegion);

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
        else {
          const destination = firstFreeDockRegion(
            regions,
            surface.defaultRegion,
          );
          if (destination) placeSurfaceInModel(surface.id, destination);
        }
        return;
      }
      if (bottomOnly) {
        if (occupied === foldedRegion && regions[occupied].visible) {
          setRegion(occupied, { visible: false });
        } else {
          showSurfaceAlone(surface.id, occupied);
        }
        return;
      }
      setRegion(occupied, { visible: !regions[occupied].visible });
    },
    [
      bottomOnly,
      foldedRegion,
      placeSurfaceInModel,
      regions,
      setRegion,
      showSurfaceAlone,
    ],
  );

  const openMenu = useCallback((id: DockMode, trigger: HTMLButtonElement) => {
    setMenuAnchorRight(
      window.innerWidth - trigger.getBoundingClientRect().right,
    );
    setMenuRegion(id);
  }, []);

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
      {bottomOnly ? (
        <button
          type="button"
          className="app-toolbar__region-btn"
          aria-label="Regions"
          title="Regions"
          aria-haspopup="menu"
          aria-expanded={menuRegion === 'bottom'}
          onClick={(event) => openMenu('bottom', event.currentTarget)}
        >
          <RegionGlyph id={foldedRegion ?? 'bottom'} />
        </button>
      ) : (
        availableRegions.map((id) => {
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
                {...(surface
                  ? { 'aria-pressed': pressed }
                  : {
                      'aria-haspopup': 'menu' as const,
                      'aria-expanded': menuRegion === id,
                    })}
                title={actionLabel}
                onClick={(event) => {
                  if (surface) toggleSurface(surface);
                  else openMenu(id, event.currentTarget);
                }}
              >
                <RegionGlyph id={id} />
                {!surface && <span className="app-toolbar__region-add">+</span>}
              </button>
              {surface && surfaceList.length > 1 ? (
                <button
                  type="button"
                  className="app-toolbar__region-swap"
                  aria-label={`Change ${label} region surface`}
                  aria-haspopup="menu"
                  aria-expanded={menuRegion === id}
                  onClick={(event) => openMenu(id, event.currentTarget)}
                >
                  ⋯
                </button>
              ) : null}
            </span>
          );
        })
      )}
      {menuRegion && bottomOnly ? (
        <ToolbarMenu
          ariaLabel="Region surfaces"
          dismissLabel="Close regions menu"
          anchorRight={menuAnchorRight}
          onClose={() => setMenuRegion(null)}
          items={surfaceList.map((surface) => {
            const occupied = occupiedDockRegion(regions, surface.id);
            const pressed = Boolean(
              occupied &&
                occupied === foldedRegion &&
                regions[occupied].visible,
            );
            return {
              key: surface.id,
              label: `${pressed ? 'Hide' : 'Show'} ${surface.title}`,
              onSelect: () => toggleSurface(surface),
            };
          })}
        />
      ) : menuRegion ? (
        <ToolbarMenu
          ariaLabel={`${menuLabel} region surfaces`}
          dismissLabel={`Close ${menuLabel} region menu`}
          anchorRight={menuAnchorRight}
          onClose={() => setMenuRegion(null)}
          items={(menuOccupant
            ? surfaceList.filter((surface) => surface.id !== menuOccupant)
            : surfaceList
          ).map((surface) => ({
            key: surface.id,
            label: menuOccupant
              ? `Swap in ${surface.title}`
              : `Place ${surface.title} here`,
            onSelect: () => placeSurface(surface.id, menuRegion),
          }))}
        />
      ) : null}
    </fieldset>
  );
}

export function RegionToolbarControls() {
  return useRegionModelOptional() ? <ConnectedRegionToolbarControls /> : null;
}
