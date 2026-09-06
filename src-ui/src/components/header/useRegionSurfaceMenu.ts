import { useCallback } from 'react';
import { useRegionModel } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
  useIsMobile,
} from '../../hooks/useIsMobile';
import {
  DOCK_REGION_IDS,
  foldedDockRegion,
  isDockRegion,
  occupiedDockRegion,
  occupiedRegion,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
} from '../../regions/region-model';
import type { DockMode } from '../../types';

/** One row of the folded region menu, wherever that menu is hosted. */
export interface RegionSurfaceMenuItem {
  key: string;
  label: string;
  /**
   * Present for a Show/Hide toggle row (whether the surface is the dock's
   * visible one); absent for a one-shot command row (`Move <title> to the
   * dock`), which has no checked state to claim. Each host renders the two
   * with the roles its container allows.
   */
  checked?: boolean;
  onSelect: () => void;
}

/**
 * One row of the fine-pointer Layout menu. `checked` is present only for the
 * show/hide toggle a region with an occupant has; a placement/swap row is a
 * one-shot command and carries none, exactly as the per-region popovers this
 * menu replaced distinguished them.
 */
export interface RegionLayoutMenuItem {
  key: string;
  label: string;
  checked?: boolean;
  onSelect: () => void;
}

/** One region's block of the fine-pointer Layout menu. */
export interface RegionLayoutMenuGroup {
  region: RegionId;
  /** `regionLabel(region)` — "Main", "Left", "Right", "Bottom". */
  label: string;
  items: RegionLayoutMenuItem[];
}

export interface RegionSurfaceMenu {
  /** The dock edges this device can use, read once for every consumer. */
  available: readonly DockMode[];
  /** Coarse pointer or narrow viewport: the bottom edge is the only dock. */
  bottomOnly: boolean;
  /**
   * True when the `⋯` overflow menu owns this device's region commands and the
   * toolbar row renders none at all (#917).
   *
   * `bottomOnly` alone would be the wrong question. It is true for ANY coarse
   * pointer — `availablePlacements` says so deliberately — but the `⋯` button
   * is only displayed under the mobile media query (chat.css
   * `.app-toolbar__overflow-btn`), which a tablet in landscape (coarse, 1180
   * wide, 820 tall) does not match. Handing that device's region commands to a
   * button it never renders would leave them with no route but the chord, so
   * the commands move exactly as far as the button that opens them reaches and
   * the toolbar keeps its folded control everywhere else.
   */
  commandsInOverflowMenu: boolean;
  /**
   * The surfaces that may occupy a DOCK region, in registry order. A surface
   * whose only placement is `main` (Home) is not a dock toggle, so it has no
   * chord row here and no Show/Hide row in the folded menu.
   */
  surfaceList: RegisteredSurface[];
  toggleSurface: (surface: RegisteredSurface) => void;
  /** The folded device's rows; empty on a fine pointer, which has buttons. */
  menuItems: RegionSurfaceMenuItem[];
  /**
   * The fine pointer's Layout menu, grouped per region — the same commands the
   * five per-region toolbar buttons exposed (#1536 F): a Show/Hide row for a
   * region that has an occupant, and a Place/Swap row per other surface that
   * declares the region. Empty on a folded device, which has `menuItems`.
   *
   * Grouped here rather than in the toolbar because the placement guard (a
   * region this device cannot use, a surface the registry does not hold) and
   * the show/hide derivation are the same rules `toggleSurface` above owns;
   * a second copy in the toolbar is what drifted twice in #1420.
   */
  layoutGroups: RegionLayoutMenuGroup[];
}

/**
 * The folded region menu and the surface toggle its rows and the chords
 * issue, shared by the toolbar controls (which register the keyboard chords,
 * render the fine pointer's per-region buttons, and still own the folded menu
 * on a coarse device too wide to count as mobile) and by the `⋯` overflow
 * menu (which owns those rows on a phone since #917 moved them out of the
 * toolbar row).
 *
 * It decides nothing about placement. `toggleSurface` is the model's own
 * command (`RegionModelContext.toggleSurface`, backed by `toggleSurface` in
 * region-model.ts): what a dock occupant's toggle does, how a coarse device
 * folds, and where a `main` occupant goes are all decided there, once. This
 * hook used to carry its own copy of the show/hide half of those rules, which
 * drifted from the model twice in one epic (#1420), and then could not see
 * that a surface occupying `main` is neither shown nor hidden by a dock
 * toggle (#1523). It also does not take `useShowSurface`'s no-host navigation
 * fallback: a chord issued while no region host is registered (a Chat
 * workspace layout) mutates the model and renders nothing, as it did before.
 *
 * Must be called under a `RegionModelProvider`; a consumer that can render
 * outside one gates on `useRegionModelOptional` first, the way
 * `RegionToolbarControls` does.
 */
export function useRegionSurfaceMenu(): RegionSurfaceMenu {
  const model = useRegionModel();
  const { regions, lastShownRegion, surfaces } = model;
  const available = availablePlacements(useDockSlotDevice());
  const isMobile = useIsMobile();
  const bottomOnly = available.length === 1;

  const toggleSurface = useCallback(
    (surface: RegisteredSurface) => model.toggleSurface(surface.id),
    [model],
  );

  const surfaceList = [...surfaces.values()].filter((surface) =>
    surface.regions.some(isDockRegion),
  );
  const foldedRegion = foldedDockRegion(regions, lastShownRegion);

  // Every registered surface, not `surfaceList`: `main` offers Home, which
  // occupies no dock region and is therefore not a dock toggle.
  const allSurfaces = [...surfaces.values()];
  const surfacesFor = (id: RegionId) =>
    allSurfaces.filter((surface) => surface.regions.includes(id));
  // A null `main` occupant IS Home on screen (`MainRegionSurface`), so Home is
  // never offered while it is already showing.
  const occupantOf = (id: RegionId) =>
    id === 'main' ? (regions.main.occupant ?? 'home') : regions[id].occupant;
  const placeSurface = (surfaceId: string, id: RegionId) => {
    if (id !== 'main' && !(available as readonly RegionId[]).includes(id))
      return;
    if (!surfaces.has(surfaceId)) return;
    model.placeSurface(surfaceId, id);
  };
  const layoutGroup = (id: RegionId): RegionLayoutMenuGroup => {
    const occupant = occupantOf(id);
    const surface = occupant ? surfaces.get(occupant) : undefined;
    // `main` is always visible, so it has no show/hide row — only placements.
    const toggleRow: RegionLayoutMenuItem[] =
      surface && id !== 'main'
        ? [
            {
              key: `${id}:visibility`,
              label: `${regions[id].visible ? 'Hide' : 'Show'} ${surface.title}`,
              checked: regions[id].visible,
              onSelect: () => toggleSurface(surface),
            },
          ]
        : [];
    return {
      region: id,
      label: regionLabel(id),
      items: [
        ...toggleRow,
        ...surfacesFor(id)
          .filter((candidate) => candidate.id !== occupant)
          .map((candidate) => ({
            key: `${id}:${candidate.id}`,
            // `main` always has an occupant (a null one is Home), so its rows
            // are always a placement, never a swap.
            label:
              occupant && id !== 'main'
                ? `Swap in ${candidate.title}`
                : `Place ${candidate.title} here`,
            onSelect: () => placeSurface(candidate.id, id),
          })),
      ],
    };
  };

  return {
    available,
    bottomOnly,
    commandsInOverflowMenu: bottomOnly && isMobile,
    surfaceList,
    toggleSurface,
    menuItems: bottomOnly
      ? surfaceList.map((surface) => {
          // A surface occupying `main` is not a dock toggle: "Show" would
          // reveal it where it already is (nothing happens) and "Hide" has no
          // meaning for the always-visible primary area. Its row names what
          // the toggle does — return it to the dock (#1523).
          if (occupiedRegion(regions, surface.id) === 'main') {
            return {
              key: surface.id,
              label: `Move ${surface.title} to the dock`,
              onSelect: () => toggleSurface(surface),
            };
          }
          const occupied = occupiedDockRegion(regions, surface.id);
          // The surface is shown only when it IS the folded region — the one
          // visible dock a coarse device has — not merely when its own region
          // is marked visible.
          const shown = Boolean(
            occupied && occupied === foldedRegion && regions[occupied].visible,
          );
          return {
            key: surface.id,
            label: `${shown ? 'Hide' : 'Show'} ${surface.title}`,
            checked: shown,
            onSelect: () => toggleSurface(surface),
          };
        })
      : [],
    layoutGroups: bottomOnly
      ? []
      : [
          'main' as RegionId,
          ...DOCK_REGION_IDS.filter((id) =>
            (available as readonly RegionId[]).includes(id),
          ),
        ]
          .map(layoutGroup)
          // Defensive, and deliberately untested: today's registry always
          // leaves at least one row per region (a dock region offers Chat and
          // Activity; `main` offers whichever of Home/Activity is not in it),
          // so this filter has no reachable case to assert. It is here so a
          // future registry cannot print a heading with nothing under it.
          .filter((group) => group.items.length > 0),
  };
}
