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
  occupiedRegion,
  placeSurface as placeSurfaceInArrangement,
  type RegionArrangement,
  type RegionId,
  type RegisteredSurface,
  regionLabel,
} from '../../regions/region-model';
import type { DockMode } from '../../types';

/**
 * The Layout picker's segment order: the three dock edges as they sit on screen
 * (left, bottom, right), then the primary area, then `Hidden` — which the row
 * appends rather than listing here, since it is not a region.
 *
 * `satisfies readonly RegionId[]` pins the members to the region union, and
 * `useRegionSurfaceMenu.placement.test.tsx` pins the converse: every member of
 * `REGION_IDS` appears here, so adding a region to the model without deciding
 * where its segment goes reds rather than silently dropping the segment.
 */
const SEGMENT_REGION_ORDER = [
  'left',
  'bottom',
  'right',
  'main',
] as const satisfies readonly RegionId[];

/** One row of the folded region menu, wherever that menu is hosted. */
export interface RegionSurfaceMenuItem {
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
 * One segment of a surface's placement row — a region it may occupy, or the
 * `Hidden` segment every row ends with.
 *
 * `checked` is DERIVED from the arrangement, never stored: a segment is pressed
 * when the surface occupies that region and the region is showing it. Exactly
 * one segment of a row is checked, `Hidden` being the else.
 */
export interface RegionPlacementSegment {
  key: string;
  /** `regionLabel(region)` — "Main", "Left", "Right", "Bottom" — or "Hidden". */
  label: string;
  /** `null` for the `Hidden` segment. */
  region: RegionId | null;
  checked: boolean;
  /**
   * What choosing this segment does to the region's CURRENT occupant, worded
   * from what `placeSurface` will actually do rather than from a guess about
   * it — the model relocates a displaced surface into the region the incoming
   * one vacates, else the first free dock region, else nowhere. `undefined`
   * when nothing is displaced.
   */
  displaces?: string;
  onSelect: () => void;
}

/** One surface's row of the Layout picker. */
export interface RegionPlacementRow {
  surfaceId: string;
  /** The surface's title — "Chat", "Activity". */
  label: string;
  /** `RegisteredSurface.icon` — the glyph key the picker renders. */
  icon: string;
  segments: RegionPlacementSegment[];
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
   * The fine pointer's Layout picker: one row per surface that declares regions,
   * each row a segmented choice over the regions that surface may occupy plus
   * `Hidden`. Empty on a folded device, which has `menuItems`.
   *
   * #1552 D2 replaced a per-region list of VERBS ("Place Activity here", "Swap
   * in Activity", "Hide Chat") with this. Every command that list carried is
   * still reachable and is now a state rather than an imperative: "Swap in
   * Activity" is choosing Activity's segment for that region, "Hide Chat" is
   * choosing Chat's `Hidden` segment. What it adds is the answer to the
   * question the verb list could not put on screen — where each surface
   * currently IS.
   *
   * Derived here rather than in the toolbar because the placement guard (a
   * region this device cannot use, a surface the registry does not hold), the
   * `main`-occupant rule and the show/hide derivation are the same rules
   * `toggleSurface` above owns; a second copy in the toolbar is what drifted
   * twice in #1420.
   */
  placementRows: RegionPlacementRow[];
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

  // A null `main` occupant IS Home on screen (`MainRegionSurface`).
  const occupantOf = (id: RegionId) =>
    id === 'main' ? (regions.main.occupant ?? 'home') : regions[id].occupant;
  const place = (surfaceId: string, id: RegionId) => {
    if (id !== 'main' && !(available as readonly RegionId[]).includes(id))
      return;
    if (!surfaces.has(surfaceId)) return;
    model.placeSurface(surfaceId, id);
  };

  /**
   * The regions a surface may be placed into on THIS device, in the picker's
   * segment order — intersected with what the surface itself declares, so no
   * segment ever offers a placement `placeSurface` would refuse.
   */
  const segmentRegions = (surface: RegisteredSurface): RegionId[] =>
    SEGMENT_REGION_ORDER.filter(
      (id) =>
        surface.regions.includes(id) &&
        (id === 'main' || (available as readonly RegionId[]).includes(id)),
    );

  /**
   * Where a surface sits in an arrangement, and whether that means the reader
   * can SEE it. The one derivation behind both the pressed segment and the
   * displacement note below, so the two cannot disagree about the same surface
   * in the same arrangement (#1552 review M3: the note promised "moves to Right"
   * for a relocation `placeSurface` makes with `visible: false`, and the picker
   * then showed that surface as Hidden).
   *
   * `main` is always visible, so holding it is always showing.
   */
  const placementOf = (
    arrangement: RegionArrangement,
    surfaceId: string,
  ): { region: RegionId | undefined; shown: boolean } => {
    const region = occupiedRegion(arrangement, surfaceId);
    return {
      region,
      shown: Boolean(
        region && (region === 'main' || arrangement[region].visible),
      ),
    };
  };

  /**
   * What happens to the region's current occupant if `surfaceId` takes the
   * region — computed by running the model's own `placeSurface` over the
   * arrangement and reading the result, not by restating its rules here.
   *
   * This is the honest form of what the retired verb list called "Swap in X".
   * The rules are not obvious (a swap back into the vacated region, else the
   * first free dock region, else unplaced; and into `main` the displaced surface
   * is always unplaced), and a hand-written sentence about them is a claim
   * nothing derives — the class of defect this arc exists to remove. Pure
   * function, no state touched.
   *
   * A relocation can also arrive HIDDEN — `placeSurface` carries the target
   * region's previous visibility across to the displaced surface — so a landing
   * region alone does not mean the reader will see it there. Three outcomes,
   * three sentences.
   */
  const displacementNote = (
    surfaceId: string,
    id: RegionId,
  ): string | undefined => {
    const displaced = occupantOf(id);
    if (!displaced || displaced === surfaceId) return undefined;
    const displacedTitle = surfaces.get(displaced)?.title ?? displaced;
    const next = placeSurfaceInArrangement(regions, surfaceId, id);
    const landed = placementOf(next, displaced);
    if (!landed.region) return `${displacedTitle} is hidden`;
    return landed.shown
      ? `${displacedTitle} moves to ${regionLabel(landed.region)}`
      : `${displacedTitle} moves to ${regionLabel(landed.region)}, hidden`;
  };

  const placementRow = (surface: RegisteredSurface): RegionPlacementRow => {
    // Showing, not merely placed: a surface in a hidden dock region is Hidden as
    // far as this picker is concerned, which is the same question the folded
    // menu's `checked` answers — and the same `placementOf` the displacement
    // note reads, so a segment and a tooltip can never describe one surface two
    // ways.
    const { region: held, shown } = placementOf(regions, surface.id);
    return {
      surfaceId: surface.id,
      label: surface.title,
      icon: surface.icon,
      segments: [
        ...segmentRegions(surface).map((id) => ({
          key: `${surface.id}:${id}`,
          label: regionLabel(id),
          region: id as RegionId | null,
          checked: shown && held === id,
          displaces: displacementNote(surface.id, id),
          onSelect: () => {
            // Already there but hidden: this is a reveal, not a move — the same
            // command the retired "Show <surface>" row issued.
            if (held === id) {
              if (!shown) model.setRegion(id, { visible: true });
              return;
            }
            place(surface.id, id);
          },
        })),
        {
          key: `${surface.id}:hidden`,
          label: 'Hidden',
          region: null,
          checked: !shown,
          onSelect: () => {
            if (!held) return;
            // A dock region hides. `main` cannot: it is always visible, and the
            // only thing "hidden" can mean for its occupant is that Home has it
            // back — which is `placeSurface`'s own documented rule for `main`
            // (the displaced surface is UNPLACED, never relocated), so this
            // takes that route rather than inventing an unplace primitive.
            if (held === 'main') model.placeSurface('home', 'main');
            else model.setRegion(held, { visible: false });
          },
        },
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
              icon: surface.icon,
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
            icon: surface.icon,
            checked: shown,
            onSelect: () => toggleSurface(surface),
          };
        })
      : [],
    // One row per surface that declares a DOCK region — `surfaceList`, the same
    // set the chords and the folded menu use. Home is excluded by that filter
    // and correctly so: its only placement is `main`, so its row would be a
    // segmented control with one segment and a `Hidden` that means "put
    // something else in the primary area".
    placementRows: bottomOnly ? [] : surfaceList.map(placementRow),
  };
}
