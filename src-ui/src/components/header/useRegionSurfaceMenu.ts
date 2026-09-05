import { useCallback } from 'react';
import { useRegionModel } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
  useIsMobile,
} from '../../hooks/useIsMobile';
import {
  foldedDockRegion,
  isDockRegion,
  occupiedDockRegion,
  type RegisteredSurface,
} from '../../regions/region-model';
import type { DockMode } from '../../types';

/** One row of the folded region menu, wherever that menu is hosted. */
export interface RegionSurfaceMenuItem {
  key: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
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
}

/**
 * The one implementation of "toggle this surface's region" and of the folded
 * menu built on it, shared by the toolbar controls (which register the
 * keyboard chords, render the fine pointer's per-region buttons, and still own
 * the folded menu on a coarse device too wide to count as mobile) and by the
 * `⋯` overflow menu (which owns those rows on a phone since #917 moved them
 * out of the toolbar row).
 *
 * It lives here rather than in either consumer because the coarse branch is
 * subtle — an occupied-but-not-folded surface is SHOWN alone rather than
 * hidden — and a second copy would drift from this one silently.
 *
 * It decides only whether the surface is being shown or hidden. Showing is
 * the model's own `showSurface`, called directly; this hook does not take
 * `useShowSurface`'s no-host navigation fallback, so a chord issued while no
 * region host is registered (a Chat workspace layout) mutates the model and
 * renders nothing, as it did before. Where an unplaced surface lands, when it
 * may take a free region rather than evict an occupant, and how a coarse
 * device folds the other regions are the model's placement rules, and this
 * used to carry its own copy of them, which drifted twice in one epic (#1420).
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
    (surface: RegisteredSurface) => {
      const occupied = occupiedDockRegion(regions, surface.id);
      if (!occupied) {
        model.showSurface(surface.id);
        return;
      }
      if (bottomOnly) {
        if (
          occupied === foldedDockRegion(regions, lastShownRegion) &&
          regions[occupied].visible
        ) {
          model.setRegion(occupied, { visible: false });
        } else {
          model.showSurface(surface.id);
        }
        return;
      }
      model.setRegion(occupied, { visible: !regions[occupied].visible });
    },
    [bottomOnly, lastShownRegion, model, regions],
  );

  const surfaceList = [...surfaces.values()].filter((surface) =>
    surface.regions.some(isDockRegion),
  );
  const foldedRegion = foldedDockRegion(regions, lastShownRegion);

  return {
    available,
    bottomOnly,
    commandsInOverflowMenu: bottomOnly && isMobile,
    surfaceList,
    toggleSurface,
    menuItems: bottomOnly
      ? surfaceList.map((surface) => {
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
  };
}
