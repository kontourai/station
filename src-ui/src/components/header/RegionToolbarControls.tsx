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
      ) : id === 'bottom' ? (
        <path d="M1 10h18" />
      ) : (
        // `main`: the filled centre of the same frame, since the primary area
        // is the space the three dock edges surround.
        <rect x="5" y="4" width="10" height="8" rx="1" fill="currentColor" />
      )}
    </svg>
  );
}

function RegionShortcut({
  surface,
  shortcut,
  onToggle,
}: {
  surface: RegisteredSurface;
  shortcut: NonNullable<RegisteredSurface['shortcut']>;
  onToggle: () => void;
}) {
  useKeyboardShortcut(
    shortcut.id,
    shortcut.key,
    [...shortcut.modifiers],
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
  // Every registered surface, not the hook's dock-only `surfaceList`: the
  // `main` control offers Home, which occupies no dock region.
  const allSurfaces = [...surfaces.values()];
  const surfacesFor = (id: RegionId) =>
    allSurfaces.filter((surface) => surface.regions.includes(id));
  const [menuRegion, setMenuRegion] = useState<RegionId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout owners are this effect's trigger, not values it reads — it exists to fire when they change.
  useEffect(() => {
    // Close whenever the branch that OWNS the menu changes, not only when the
    // overflow branch takes over. Three transitions reach this, and rendering
    // through any of them is wrong in a different way:
    //   fine -> coarse while still wide: `bottomOnly` flips but the overflow
    //     branch does not, so an open per-region popover silently becomes the
    //     folded Regions menu, anchored where the old trigger used to be.
    //   -> overflow: the early return below unmounts the portal without
    //     clearing this, so widening back re-opens a menu nobody reopened.
    //   overflow -> back: same state, restored under a different owner.
    // The anchor belongs to the trigger that opened it, and that trigger is
    // what these transitions replace.
    setMenuRegion(null);
  }, [bottomOnly, commandsInOverflowMenu]);
  const [menuAnchorRight, setMenuAnchorRight] = useState(8);
  // A null `main` occupant IS Home on screen (`MainRegionSurface`), so Home
  // is never offered while it is already showing.
  const occupantOf = (id: RegionId) =>
    id === 'main' ? (regions.main.occupant ?? 'home') : regions[id].occupant;
  const menuOccupant = menuRegion && occupantOf(menuRegion);
  const menuLabel = menuRegion && regionLabel(menuRegion);

  const openMenu = useCallback((id: RegionId, trigger: HTMLButtonElement) => {
    setMenuAnchorRight(
      window.innerWidth - trigger.getBoundingClientRect().right,
    );
    setMenuRegion(id);
  }, []);

  const placeSurface = useCallback(
    (surfaceId: string, id: RegionId) => {
      if (id !== 'main' && !availableRegions.includes(id)) return;
      if (!surfaces.has(surfaceId)) return;
      placeSurfaceInModel(surfaceId, id);
    },
    [availableRegions, placeSurfaceInModel, surfaces],
  );

  const shortcuts = surfaceList.flatMap((surface) =>
    surface.shortcut ? (
      <RegionShortcut
        key={surface.id}
        surface={surface}
        shortcut={surface.shortcut}
        onToggle={() => toggleSurface(surface)}
      />
    ) : (
      []
    ),
  );

  // `main` is always visible, so its control has no show/hide toggle: the
  // primary click opens the placement menu. Fine pointer only — a coarse
  // device folds its region commands (#1400's toolbar occlusion floor), and
  // this slice defers `main` there rather than widen that fold.
  const mainOccupant = occupantOf('main');
  const mainChoices = surfacesFor('main').filter(
    (surface) => surface.id !== mainOccupant,
  );
  const mainLabel = `Change ${regionLabel('main')} region surface`;

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
        <>
          {mainChoices.length > 0 ? (
            <button
              type="button"
              className="app-toolbar__region-btn"
              aria-label={mainLabel}
              title={mainLabel}
              aria-haspopup="menu"
              aria-expanded={menuRegion === 'main'}
              onClick={(event) => openMenu('main', event.currentTarget)}
            >
              <RegionGlyph id="main" />
            </button>
          ) : null}
          {availableRegions.map((id) => {
            const occupant = regions[id].occupant;
            const surface = occupant ? surfaces.get(occupant) : undefined;
            const label = regionLabel(id);
            const pressed = Boolean(surface && regions[id].visible);
            const actionLabel = surface
              ? `${pressed ? 'Hide' : 'Show'} ${surface.title} ${label} region`
              : `Choose a surface for ${label} region`;
            // What the swap menu would offer: the surfaces that declare this
            // region, other than the one already in it.
            const swapChoices = surfacesFor(id).filter(
              (candidate) => candidate.id !== occupant,
            );
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
                  {!surface && (
                    <span className="app-toolbar__region-add">+</span>
                  )}
                </button>
                {surface && swapChoices.length > 0 ? (
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
          })}
        </>
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
          items={surfacesFor(menuRegion)
            .filter((surface) => surface.id !== menuOccupant)
            .map((surface) => ({
              key: surface.id,
              // `main` always has an occupant (a null one is Home), so its
              // menu is always a placement, never a swap.
              label:
                menuOccupant && menuRegion !== 'main'
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
