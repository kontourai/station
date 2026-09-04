import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useRegionModel,
  useRegionModelOptional,
} from '../../contexts/RegionModelContext';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import {
  DOCK_REGION_IDS,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
} from '../../regions/region-model';
import type { DockMode } from '../../types';
import './HeaderMenu.css';
import { useRegionSurfaceMenu } from './useRegionSurfaceMenu';

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
    /** Present for a menu of toggles; absent for a menu of one-shot commands. */
    checked?: boolean;
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
            {...(item.checked === undefined
              ? { role: 'menuitem' as const }
              : {
                  role: 'menuitemcheckbox' as const,
                  'aria-checked': item.checked,
                })}
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
    surfaces,
    placeSurface: placeSurfaceInModel,
  } = useRegionModel();
  const {
    available,
    bottomOnly,
    commandsInOverflowMenu,
    surfaceList,
    toggleSurface,
    menuItems,
  } = useRegionSurfaceMenu();
  const availableRegions = DOCK_REGION_IDS.filter((id) =>
    available.includes(id),
  );
  const [menuRegion, setMenuRegion] = useState<DockMode | null>(null);
  useEffect(() => {
    // Closing, not just not-rendering: the overflow branch below returns before
    // the menu markup, which unmounts the portal while leaving this state set.
    // Widening back would then re-open a menu the user never reopened, and
    // `useMenuFocus` would pull focus into it.
    if (commandsInOverflowMenu) setMenuRegion(null);
  }, [commandsInOverflowMenu]);
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);
  const menuOccupant = menuRegion && regions[menuRegion].occupant;
  const menuLabel = menuRegion && regionLabel(menuRegion);

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

  const shortcuts = surfaceList.map((surface) => (
    <RegionShortcut
      key={surface.id}
      surface={surface}
      onToggle={() => toggleSurface(surface)}
    />
  ));

  // #917: where the `⋯` overflow menu exists, it takes the region commands and
  // this row renders NO control at all. The 44px button plus its gap is
  // exactly what pushed the Settings gear off a 402px viewport once the
  // fieldset stopped packing below its contents, and a region button in that
  // row is what the connection button was colliding with in the first place.
  // An empty fieldset is not good enough — it still costs its own box and its
  // legend — so nothing is rendered here but the chords, which are `null`
  // elements. `commandsInOverflowMenu`, not `bottomOnly`: see the hook.
  if (commandsInOverflowMenu) return <>{shortcuts}</>;

  return (
    <fieldset className="app-toolbar__regions">
      <legend>Regions</legend>
      {shortcuts}
      {bottomOnly ? (
        <button
          type="button"
          className="app-toolbar__region-btn"
          aria-label="Regions"
          title="Regions"
          aria-haspopup="menu"
          aria-expanded={menuRegion !== null}
          onClick={(event) => openMenu('bottom', event.currentTarget)}
        >
          <RegionGlyph id="bottom" />
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
          items={menuItems}
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
