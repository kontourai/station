import { useCallback } from 'react';
import { useRegionModel } from '../../contexts/RegionModelContext';
import {
  availablePlacements,
  useDockSlotDevice,
  useIsMobile,
} from '../../hooks/useIsMobile';
import {
  DOCK_REGION_IDS,
  type DockRegionId,
  foldedDockRegion,
  isDockRegion,
  occupiedRegion,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
  resolveRegionSurface,
} from '../../regions/region-model';
import type { DockMode } from '../../types';

/**
 * The toolbar's toggle order: the three dock edges as they sit on screen —
 * left, bottom, right (#2143). `satisfies` pins the members to the dock
 * union; `useRegionSurfaceMenu.toggles.test.tsx` pins the converse, that every
 * member of `DOCK_REGION_IDS` has a toggle, so adding a dock region to the
 * model without deciding where its toggle goes reds rather than silently
 * leaving the region with no control.
 */
const TOGGLE_REGION_ORDER = [
  'left',
  'bottom',
  'right',
] as const satisfies readonly DockRegionId[];

/** One row of the folded region menu, wherever that menu is hosted. */
interface RegionSurfaceMenuItem {
  key: string;
  label: string;
  /**
   * `RegisteredSurface.icon` — the glyph key the row renders in its 16px slot.
   * Carried explicitly rather than inferred from `key`: the two happen to be
   * equal for both of today's dock surfaces, which is exactly the coincidence a
   * later registry entry would break silently.
   */
  icon: string;
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
 * One thing an EMPTY region's control offers to show there: a shell surface
 * that declares the region (#2143). Choosing it is the model's own
 * `placeSurface` — a surface held elsewhere moves, a surface in `main` hands
 * the primary area back to Home — never a second placement rule here.
 */
export interface RegionToggleOffer {
  surfaceId: string;
  /** The surface's title — "Chat", "Activity". */
  label: string;
  /** `RegisteredSurface.icon`, for the row's 16px glyph slot. */
  icon: string;
  onSelect: () => void;
}

/**
 * One dock region's toolbar control (#2143): a show/hide TOGGLE while the
 * region holds panes, and — since an empty region cannot be shown (the shell
 * mounts no host for it, and the model hides a region its last pane leaves) —
 * an offer of what can be placed there while it holds none.
 *
 * `visible` is DERIVED from the arrangement, never stored: pressed means the
 * region is visible AND holds a pane. A hidden region holding two panes is one
 * unpressed toggle, and pressing it brings both tabs back with the same
 * selection, because the toggle writes the REGION's visibility and nothing
 * about its panes.
 */
export interface RegionToggle {
  region: DockRegionId;
  /** `regionLabel(region)` — "Left", "Bottom", "Right". */
  label: string;
  /** The titles of the panes the region holds, in tab order; empty when none. */
  paneTitles: string[];
  visible: boolean;
  /**
   * Show or hide the region — the model's `setRegion(region, { visible })`.
   * The region bar's chevron reaches the SAME model write through
   * `applyDockSnap`, which also records the shell's snap and height and
   * passes `maximized` (a chevron collapse clears it); this toggle writes
   * `visible` alone, so a region hidden here keeps its maximize memory and
   * comes back maximized, while one hidden from its chevron comes back at
   * the snap the chevron stored. A no-op for an empty region, whose control
   * opens `offers` instead.
   */
  onToggle: () => void;
  /** What an EMPTY region's control offers; empty for an occupied region. */
  offers: RegionToggleOffer[];
}

interface RegionSurfaceMenu {
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
   * The fine pointer's per-region toggles (#2143), one per dock region this
   * device can use, in screen order. Empty on a folded device, which has
   * `menuItems`.
   *
   * #1552 D2's placement picker — one row per SURFACE, a segmented choice of
   * regions — answered "where is Chat?"; every other control the epic shipped
   * (#2046's tab strip, #2047's "+", the region bar's grab, maximize and
   * chevron) answers "what does this REGION hold, and is it open?". The
   * toolbar now asks the region's question too, the way every comparable
   * shell's layout toggles do, and a surface's placement is the tab's own
   * affordance (`RegionChromeBar`'s move menu) rather than the toolbar's.
   *
   * Derived here rather than in the toolbar because the device guard (a
   * region this device cannot use) and the surface filter (`surfaceList`) are
   * the same rules the chords and the folded menu use; a second copy in the
   * toolbar is what drifted twice in #1420.
   */
  regionToggles: RegionToggle[];
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

  // The surfaces the SHELL offers: those declaring a dock region, minus the
  // catalog-only ones (#2047, `RegisteredSurface.exposure`) — a region's "+"
  // is their only offer, so they get no picker row, no chord and no unplaced
  // Show row. A placed one still appears where it is placed: the per-region
  // loop in `foldedMenuItems` reads `region.panes`, not this list.
  const surfaceList = [...surfaces.values()].filter(
    (surface) =>
      surface.regions.some(isDockRegion) && surface.exposure !== 'catalog',
  );
  const foldedRegion = foldedDockRegion(regions, lastShownRegion);

  const place = (surfaceId: string, id: RegionId) => {
    if (id !== 'main' && !(available as readonly RegionId[]).includes(id))
      return;
    if (!surfaces.has(surfaceId)) return;
    model.placeSurface(surfaceId, id);
  };

  /**
   * The folded device's rows, per REGION (#2046 2b, D2). Each occupied dock
   * region contributes its panes in tab order: the SELECTED pane's row is
   * the region's Show/Hide — hiding it hides the region, every pane of it —
   * and each pane behind a tab gets a `Show <title> in the dock` row whose
   * toggle selects it (`toggleSurface`, #2046 2a). Grouped by region so the
   * rows say what the toggle acts on: two surfaces sharing a region are two
   * rows of one region, not two independent toggles that happen to move the
   * same shell. After them, the `main` occupant's "Move … to the dock" row
   * and a `Show` row for each unplaced dock surface, in registry order.
   *
   * "… the dock", for the same reason on every row: these rows exist only on
   * a BOTTOM-ONLY device (`availablePlacements`: a coarse pointer or a
   * viewport at or under 768px, so a narrow desktop window too), where the
   * fold gives the whole shell one dock slot.
   *
   * #1386: the bare `Hide Activity` was the accessible name of the SHELL
   * HEADER's own visibility control at the same time — two buttons, one name,
   * both on screen (pinned by `RegionShellParity.test.tsx`, and the reason
   * `project-architecture.spec.ts` has to scope its query to the pane). The
   * shell's control is the one a user points at, so the row is what says
   * which shell it means.
   */
  const foldedMenuItems = (): RegionSurfaceMenuItem[] => {
    const rows: RegionSurfaceMenuItem[] = [];
    const placed = new Set<string>();
    for (const regionId of DOCK_REGION_IDS) {
      const region = regions[regionId];
      for (const paneId of region.panes) {
        // Resolved rather than registry-read, so a placed instance-keyed
        // pane (#2049) gets its Hide/Show row here too; its title is the
        // prefix's generic one ("Pull request", "File"), since the folded
        // menu has no instance in hand.
        const surface = resolveRegionSurface(paneId);
        if (!surface) continue;
        placed.add(paneId);
        // Shown only when this IS the folded region's selected pane — the
        // one visible dock a coarse device has — not merely when its region
        // is marked visible, nor when the region shows another pane's tab.
        const shown =
          regionId === foldedRegion &&
          region.visible &&
          region.occupant === paneId;
        rows.push({
          key: `${regionId}:${paneId}`,
          label: shown
            ? `Hide ${surface.title} from the dock`
            : `Show ${surface.title} in the dock`,
          icon: surface.icon,
          checked: shown,
          onSelect: () => toggleSurface(surface),
        });
      }
    }
    for (const surface of surfaceList) {
      if (placed.has(surface.id)) continue;
      // A surface occupying `main` is not a dock toggle: "Show" would reveal
      // it where it already is (nothing happens) and "Hide" has no meaning
      // for the always-visible primary area. Its row names what the toggle
      // does — return it to the dock (#1523).
      if (occupiedRegion(regions, surface.id) === 'main') {
        rows.push({
          key: surface.id,
          label: `Move ${surface.title} to the dock`,
          icon: surface.icon,
          onSelect: () => toggleSurface(surface),
        });
        continue;
      }
      rows.push({
        key: surface.id,
        label: `Show ${surface.title} in the dock`,
        icon: surface.icon,
        checked: false,
        onSelect: () => toggleSurface(surface),
      });
    }
    return rows;
  };

  const regionToggle = (region: DockRegionId): RegionToggle => {
    const state = regions[region];
    const held = state.panes.length > 0;
    return {
      region,
      label: regionLabel(region),
      // Resolved rather than registry-read, so an instance-keyed pane (#2049)
      // names itself in the tooltip by its prefix's generic title.
      paneTitles: state.panes.map(
        (id) => resolveRegionSurface(id)?.title ?? id,
      ),
      visible: held && state.visible,
      onToggle: () => {
        if (!held) return;
        model.setRegion(region, { visible: !state.visible });
      },
      // An occupied region offers nothing here: its "+" (#2047) is where more
      // panes come from, and a toggle that also placed would be two controls
      // under one name. An empty one offers the shell surfaces declaring it,
      // in registry order — the same `surfaceList` the chords are built from.
      offers: held
        ? []
        : surfaceList
            .filter((surface) => surface.regions.includes(region))
            .map((surface) => ({
              surfaceId: surface.id,
              label: surface.title,
              icon: surface.icon,
              onSelect: () => place(surface.id, region),
            })),
    };
  };

  return {
    available,
    bottomOnly,
    commandsInOverflowMenu: bottomOnly && isMobile,
    surfaceList,
    toggleSurface,
    menuItems: bottomOnly ? foldedMenuItems() : [],
    // One toggle per dock region THIS device can use, in screen order. A
    // folded device has one dock and no toggles: its folded menu is the
    // per-region control there.
    regionToggles: bottomOnly
      ? []
      : TOGGLE_REGION_ORDER.filter((id) =>
          (available as readonly RegionId[]).includes(id),
        ).map(regionToggle),
  };
}
