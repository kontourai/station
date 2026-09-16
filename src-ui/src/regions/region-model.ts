import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';

export const REGION_IDS = ['main', 'left', 'right', 'bottom'] as const;
export type RegionId = (typeof REGION_IDS)[number];
export const DOCK_REGION_IDS = [
  'left',
  'right',
  'bottom',
] as const satisfies readonly RegionId[];
export interface RegionState {
  /**
   * Whether the region is on screen. INDEPENDENT of whether it holds a pane
   * since #2153: a dock region may be visible and empty, and the shell mounts
   * a host for it that renders the region's chrome bar over a placeholder.
   * Closing a region's last tab therefore empties the region and leaves it
   * open (owner decision, #2153) — the chevron and the toolbar toggle are
   * what hide it, and they are the only writers of this that a user drives.
   * `main` is always visible; its null occupant is Home.
   */
  visible: boolean;
  size: number;
  /**
   * The surfaces placed in this region, in tab order (#2046 2a). A dock
   * region may hold several; `main` holds at most one (it keeps
   * displacement, #928 C2a). No surface is in two regions' `panes` at once
   * (`placeSurface` removes it from the region it leaves) and no id repeats
   * within one. `updateRegion` and the record parser hold these.
   */
  panes: readonly string[];
  /**
   * The SELECTED pane — the one the region's host shows — derived from
   * `panes`: always a member of it, or null when the region is empty. Every
   * pre-#2046 reader of "the region's occupant" reads this and keeps its
   * meaning for a one-pane region; `occupiedRegion` and its siblings read
   * `panes`, so a surface behind another's tab is still "in" its region.
   */
  occupant: string | null;
  /**
   * Whether this region is expanded over the workspace (#928 slice iii,
   * #1385). An attribute of the REGION, not of its occupant: the shell reads
   * it for any occupant, and navigation's `maximize` param is Chat's mirror
   * of it, never its source. `updateRegion` keeps the invariants — at most
   * one region is maximized, `main` never is, and a hidden or empty region
   * never is — and `placeSurface` clears it on both ends of a move, so a
   * relocation can never carry a maximize into the region it enters.
   */
  maximized: boolean;
}
export type RegionArrangement = Record<RegionId, RegionState>;

export const DEFAULT_DEVICE_REGION_ARRANGEMENT: RegionArrangement = {
  // `main` is always visible and Home is its default occupant (#928 C2a).
  main: {
    visible: true,
    size: 0,
    panes: ['home'],
    occupant: 'home',
    maximized: false,
  },
  left: {
    visible: false,
    size: 400,
    panes: [],
    occupant: null,
    maximized: false,
  },
  right: {
    visible: false,
    size: 400,
    panes: [],
    occupant: null,
    maximized: false,
  },
  bottom: {
    visible: false,
    size: 320,
    panes: ['chat'],
    occupant: 'chat',
    maximized: false,
  },
};

type DockSeedSettings = Pick<
  DeviceSettings,
  'chatDockHeight' | 'chatDockWidth'
>;

export type DockRegionId = (typeof DOCK_REGION_IDS)[number];

export function occupiedDockRegion(
  arrangement: RegionArrangement,
  surfaceId: string,
): DockRegionId | undefined {
  return DOCK_REGION_IDS.find((id) =>
    arrangement[id].panes.includes(surfaceId),
  );
}

/**
 * The region (dock or `main`) holding a surface, if any — holding, not
 * showing: a surface behind another pane's tab is still placed there.
 */
export function occupiedRegion(
  arrangement: RegionArrangement,
  surfaceId: string,
): RegionId | undefined {
  return REGION_IDS.find((id) => arrangement[id].panes.includes(surfaceId));
}

/** Whether a region holds no pane. */
function regionIsEmpty(state: RegionState): boolean {
  return state.panes.length === 0;
}

export function isDockRegion(id: RegionId): id is DockRegionId {
  return (DOCK_REGION_IDS as readonly RegionId[]).includes(id);
}

/**
 * Whether a surface declares `regionId` among the regions it may occupy
 * (`RegisteredSurface.regions`). A surface the registry does not know — a
 * test fixture, a pane a later slice registers at runtime — may take a dock
 * region and never `main`: the primary area is only ever handed to a surface
 * that declared it, so an undeclared id cannot displace Home by accident.
 */
export function surfaceMayOccupy(
  surfaceId: string,
  regionId: RegionId,
): boolean {
  const surface = resolveRegionSurface(surfaceId);
  return surface ? surface.regions.includes(regionId) : isDockRegion(regionId);
}

/**
 * The dock region a surface with no placement of its own lands in: its
 * `preferred` one when that is empty, else the first empty region in the
 * fallback order.
 *
 * The fallback tries `right` BEFORE `bottom` (#2156). Only an EMPTY region
 * is ever returned, so under either order nothing lands beside a pane that
 * is already there; what the order decides is which empty edge a surface
 * takes when its own default is taken. Bottom is Chat's by default, and an
 * empty Bottom is where Chat will land next (a closed Chat tab re-placed by
 * `dock=open`, `focusSession`, or ⌘D), so a surface with nowhere of its own
 * to go takes the right edge and leaves Bottom for Chat. The one journey
 * the order changes today is Chat itself: unplaced, with a remembered
 * `left` placement that is occupied and both other edges free, it now lands
 * right rather than bottom (`syncRegionArrangementFromDock`) — accepted, so
 * the rule has no Chat-shaped exception. A default, not a rule: Bottom
 * refuses nothing, and an explicit placement (a move from a tab, a region's
 * "+") still puts any surface there.
 */
export function firstFreeDockRegion(
  arrangement: RegionArrangement,
  preferred: DockRegionId,
): DockRegionId | undefined {
  if (regionIsEmpty(arrangement[preferred])) return preferred;
  return (['right', 'bottom', 'left'] as const).find((id) =>
    regionIsEmpty(arrangement[id]),
  );
}

/** The dock region holding chat; undefined when chat sits outside the dock (e.g. 'main'). */
export function chatRegion(
  arrangement: RegionArrangement,
): DockRegionId | undefined {
  return occupiedDockRegion(arrangement, 'chat');
}

/**
 * Whether `regionId` HOLDS Chat — selected or behind another pane's tab
 * (#2046 2b, ownership decision D3). The one derivation behind everything
 * that is Chat's rather than the selected pane's: `#chat-dock`, the "Dock"
 * landmark, the `dock.maximize` registration (`DockShell`), the persisted
 * snap key, the project binding's cleanup and the collapse-on-navigate
 * mirror (`useDockShellChrome`). Two readers of one rule, not two rules.
 */
export function regionHoldsChat(
  arrangement: RegionArrangement,
  regionId: RegionId,
): boolean {
  return arrangement[regionId].panes.includes('chat');
}

export function foldedDockRegion(
  arrangement: RegionArrangement,
  lastShownRegion: RegionId | null,
): DockRegionId | undefined {
  // Every VISIBLE dock region is a fold candidate, empty or not (#2153): a
  // visible empty region mounts a host of its own (`RegionShells`), so on a
  // bottom-only device it is as much a thing to fold as an occupied one —
  // leaving it out would fold to another region while the user is looking at
  // this one. `lastShownRegion` decides between visible candidates; without
  // it, a visible region HOLDING panes wins over a visible empty one, so the
  // one dock a coarse device shows is never a placeholder while the user's
  // panes sit in another visible region. The occupancy fallbacks below still
  // decide when NOTHING is visible.
  const visibleDock = DOCK_REGION_IDS.filter((id) => arrangement[id].visible);
  if (
    lastShownRegion &&
    DOCK_REGION_IDS.includes(lastShownRegion as DockRegionId) &&
    visibleDock.includes(lastShownRegion as DockRegionId)
  ) {
    return lastShownRegion as DockRegionId;
  }
  return (
    visibleDock.find((id) => !regionIsEmpty(arrangement[id])) ??
    visibleDock[0] ??
    chatRegion(arrangement) ??
    DOCK_REGION_IDS.find((id) => !regionIsEmpty(arrangement[id]))
  );
}

export function seedRegionArrangementFromDock(
  settings: DockSeedSettings,
  placement: DockRegionId,
  isDockOpen: boolean,
): RegionArrangement {
  return syncRegionArrangementFromDock(
    structuredClone(DEFAULT_DEVICE_REGION_ARRANGEMENT),
    settings,
    isDockOpen,
    placement,
  );
}

export function syncRegionArrangementFromDock(
  arrangement: RegionArrangement,
  settings: DockSeedSettings,
  isDockOpen: boolean,
  placement: DockRegionId,
): RegionArrangement {
  let next = arrangement;
  for (const id of DOCK_REGION_IDS) {
    if (regionIsEmpty(next[id]) || next[id].panes.includes('chat')) {
      next = updateRegion(next, id, {
        size:
          id === 'bottom' ? settings.chatDockHeight : settings.chatDockWidth,
      });
    }
  }

  const currentChatRegion = chatRegion(next);
  if (regionIsEmpty(next[placement])) {
    return placeSurface(next, 'chat', placement, isDockOpen);
  }
  // `dock=open` is Chat's mirror: an open shows CHAT, so its tab is selected
  // in the region it opens (2a review, MEDIUM — a region showing Activity's
  // tab used to open without Chat coming to the front). A close leaves the
  // selection where it was.
  const openChat = (region: DockRegionId) =>
    updateRegion(
      next,
      region,
      isDockOpen ? { visible: true, occupant: 'chat' } : { visible: false },
    );
  if (next[placement].panes.includes('chat')) return openChat(placement);
  if (currentChatRegion) return openChat(currentChatRegion);

  // Chat is in no region (#2046 2b: its tab was closed, which unplaces it).
  // Navigation saying the dock is CLOSED asks for nothing — an unplaced Chat
  // is not shown — so the arrangement stands; re-placing it hidden here would
  // undo the close on the next navigation change. `dock=open` (a
  // `focusSession` reveal, a deep link) places it the way `revealSurface`
  // would: into the first free dock region, else joining the requested one.
  if (!isDockOpen) return next;
  return placeSurface(
    next,
    'chat',
    firstFreeDockRegion(next, placement) ?? placement,
    true,
  );
}

/**
 * Place `surfaceId` in `regionId`, honouring the surface's declared regions
 * (`surfaceMayOccupy`; an ineligible placement returns the arrangement
 * unchanged — the toolbar never offers one, this is the backstop) and
 * removing it from whichever region it came from.
 *
 * What happens to the region's current panes depends on the target (#2046
 * 2a, decision 3):
 *
 * - into a dock region, the surface is ADDED as a pane — the last in tab
 *   order — and selected; the panes already there stay, behind it. Nothing is
 *   displaced any more: the pre-#2046 relocation of a displaced surface (the
 *   swap back into the vacated region, the `defaultRegion` and opposite-side
 *   search of #1386) is gone with the single-occupant region it served;
 * - into `main`, the surface REPLACES what `main` shows and the previous
 *   pane is UNPLACED, never relocated. `main` is the primary area: replacing
 *   what it shows must not spawn a dock panel the user did not ask for (#928
 *   C2a, owner decision), and it holds one pane.
 *
 * A surface already in the target region is SELECTED there (its tab shows)
 * and the region made visible; its panes do not change.
 *
 * The region a surface leaves keeps its other panes, selecting the
 * neighbour of the one that left when that was the selected pane; a dock
 * region left EMPTY by a placement HIDES (`withoutRegionPane` with
 * `'hide'`), and `main` stays visible showing Home. This is where a move
 * differs from a close (#2153): closing a region's last tab leaves the
 * region open on a placeholder — the owner's rule, so hiding stays the
 * chevron's and the toggle's act — but a placement is the user putting that
 * content somewhere else, and a placeholder left behind would be a second
 * dock nobody asked for (the join journey pins "does not open a second
 * dock").
 *
 * `main` is always visible; the `visible` argument only applies to a dock
 * region, and only to what the placement itself shows: a placement asked
 * not to show (`visible: false` — a `?dockSlotPlacement=` link without
 * `dock=open`) into a region that is showing ANOTHER pane neither hides
 * that region nor takes its tab; the surface joins behind it.
 */
export function placeSurface(
  arrangement: RegionArrangement,
  surfaceId: string,
  regionId: RegionId,
  visible = true,
): RegionArrangement {
  if (!surfaceMayOccupy(surfaceId, regionId)) return arrangement;
  const target = arrangement[regionId];
  // A relocation never carries a maximize (#1385): the region a surface
  // enters and the region it leaves both come out restored, whatever either
  // was before. The one #1385 saw — Chat maximized in `bottom`, Activity
  // swapped in, Chat's shell re-propped to `right` still full-width over the
  // Activity shell the user had just asked for — is a maximize that was the
  // occupant's flag surviving a move; as the region's attribute it is written
  // out here. Kept for a pane joining an occupied region too, so the rule
  // stays "a placement restores the region it enters".
  // Whether the reader is looking at another pane of this region right now.
  const showingAnother =
    target.visible && target.occupant !== null && target.occupant !== surfaceId;
  // The region the surface leaves, if any (it is in at most one). Undefined
  // when the surface is already in the target, which is then a select.
  const previousRegion = REGION_IDS.find(
    (id) => id !== regionId && arrangement[id].panes.includes(surfaceId),
  );
  const next = updateRegion(arrangement, regionId, {
    panes: target.panes.includes(surfaceId)
      ? target.panes
      : regionId === 'main'
        ? [surfaceId]
        : [...target.panes, surfaceId],
    occupant: visible || !showingAnother ? surfaceId : target.occupant,
    visible: regionId === 'main' || visible || showingAnother,
    maximized: false,
  });
  if (!previousRegion) return next;
  return withoutRegionPane(next, previousRegion, surfaceId, 'hide');
}

/**
 * Take `surfaceId` out of `regionId`'s panes. A region left with other panes
 * keeps them and its visibility; when the pane leaving was the selected one,
 * the pane at its position (or the last) is selected, the way closing a tab
 * selects its neighbour. Either way the region comes out RESTORED: a pane
 * leaving is a relocation, and every relocation restores (#1385) — a region
 * left maximized after Chat's close would hide the region the next Chat
 * reveal places into (index.css hides every non-maximized dock shell under
 * a maximized one), with ⌘M no longer registered to undo it. What an EMPTIED
 * dock region does is the caller's `whenEmpty` (#2153): a CLOSE (`'keep'`,
 * `removeRegionPane`) leaves it open and empty, showing its chrome bar over
 * a placeholder — the owner's last-tab rule, so hiding stays the chevron's
 * and the toggle's act; a MOVE (`'hide'`, `placeSurface`'s vacate and
 * `moveRegionPanes`) hides it, because a relocation is the user putting
 * that content somewhere else, and an empty placeholder left behind is a
 * second dock nobody asked for (the join journey in
 * `project-architecture.spec.ts` pins "does not open a second dock").
 * An emptied `main` stays visible as it always has — the outlet treats a
 * null occupant as Home. Shared by both callers so the two cannot select
 * different neighbours.
 */
function withoutRegionPane(
  arrangement: RegionArrangement,
  regionId: RegionId,
  surfaceId: string,
  whenEmpty: 'keep' | 'hide',
): RegionArrangement {
  const previous = arrangement[regionId];
  const index = previous.panes.indexOf(surfaceId);
  if (index === -1) return arrangement;
  const panes = previous.panes.filter((pane) => pane !== surfaceId);
  return updateRegion(
    arrangement,
    regionId,
    panes.length
      ? {
          panes,
          occupant:
            previous.occupant === surfaceId
              ? panes[Math.min(index, panes.length - 1)]
              : previous.occupant,
          maximized: false,
        }
      : {
          panes,
          occupant: null,
          visible:
            regionId === 'main' || (whenEmpty === 'keep' && previous.visible),
          maximized: false,
        },
  );
}

/**
 * Close a pane's tab (#2046 2b): `surfaceId` leaves `regionId` and becomes
 * the occupant of NO region — unplaced, the state `main`'s displacement
 * already produces (#928 C2a) — rather than hidden in place. Hiding is what
 * the region's visibility toggle does and it hides every pane of the region;
 * a closed tab is one pane leaving while the others stay on screen. An
 * unplaced surface reads as "show" to its chord, its toolbar row and
 * `showSurface`, each of which places it afresh (`revealSurface`: its
 * previous region when free, else its default), so a closed Chat comes back
 * with ⌘D. The region keeps its other panes and selects the closed pane's
 * neighbour (`withoutRegionPane`); a surface the region does not hold is
 * ignored and the arrangement returned unchanged.
 */
export function removeRegionPane(
  arrangement: RegionArrangement,
  regionId: RegionId,
  surfaceId: string,
): RegionArrangement {
  return withoutRegionPane(arrangement, regionId, surfaceId, 'keep');
}

/**
 * Move every pane of dock region `from` into dock region `to` (#2046 2b: the
 * region bar's placement control moves the REGION — its tab order and its
 * selection go with it — where the pre-2b header moved the one surface it
 * belonged to). The panes join `to` after any it already holds, in `from`'s
 * order, and `from`'s selected pane is selected there; `to` is shown, and
 * both ends come out restored, the same rule `placeSurface` applies to a
 * relocation (#1385). A pane that does not declare `to` (`surfaceMayOccupy`)
 * stays behind, so `from` is emptied only when everything moved — and an
 * emptied `from` keeps its visibility (#2153), the same rule a closed last
 * tab takes: the grab moved the panes, not the region's openness.
 * The same region, or an empty `from`, is returned unchanged.
 */
export function moveRegionPanes(
  arrangement: RegionArrangement,
  from: DockRegionId,
  to: DockRegionId,
): RegionArrangement {
  if (from === to) return arrangement;
  const source = arrangement[from];
  if (regionIsEmpty(source)) return arrangement;
  const target = arrangement[to];
  const moving = source.panes.filter(
    (pane) => !target.panes.includes(pane) && surfaceMayOccupy(pane, to),
  );
  const staying = source.panes.filter((pane) => !moving.includes(pane));
  if (moving.length === 0) return arrangement;
  const movedSelected =
    source.occupant !== null && moving.includes(source.occupant);
  let next = updateRegion(arrangement, to, {
    panes: [...target.panes, ...moving],
    occupant: movedSelected ? source.occupant : target.occupant,
    visible: true,
    maximized: false,
  });
  next = updateRegion(
    next,
    from,
    staying.length
      ? {
          panes: staying,
          occupant: movedSelected ? staying[0] : source.occupant,
          maximized: false,
        }
      : { panes: [], occupant: null, visible: false, maximized: false },
  );
  return next;
}

/**
 * Select a pane the region holds: it becomes the region's `occupant`, the
 * one its host shows (#2046 2a). A surface the region does not hold is not
 * selected — nothing is placed by a select — and the arrangement is returned
 * unchanged. Visibility and maximize are untouched.
 */
export function selectRegionPane(
  arrangement: RegionArrangement,
  regionId: RegionId,
  surfaceId: string,
): RegionArrangement {
  if (!arrangement[regionId].panes.includes(surfaceId)) return arrangement;
  return updateRegion(arrangement, regionId, { occupant: surfaceId });
}

/**
 * Make a surface visible where it is, or place it where it belongs. A surface
 * already in a region (dock or `main`) is revealed there; an unplaced one
 * goes to `main` when that is its target, else to its preferred free dock
 * region.
 */
export function revealSurface(
  arrangement: RegionArrangement,
  surfaceId: string,
  preferred: RegionId,
): { arrangement: RegionArrangement; region: RegionId } {
  const occupied = occupiedRegion(arrangement, surfaceId);
  if (occupied) {
    // Revealed AND selected: a surface behind another pane's tab is not on
    // screen until its tab is (#2046 2a).
    return {
      arrangement: updateRegion(arrangement, occupied, {
        visible: true,
        occupant: surfaceId,
      }),
      region: occupied,
    };
  }
  if (preferred === 'main') {
    return {
      arrangement: placeSurface(arrangement, surfaceId, 'main'),
      region: 'main',
    };
  }
  const region = firstFreeDockRegion(arrangement, preferred) ?? preferred;
  return { arrangement: placeSurface(arrangement, surfaceId, region), region };
}

/**
 * The coarse-device reveal: the revealed dock region becomes the only visible
 * one. A reveal into `main` folds nothing — `main` is not a dock region, and
 * the dock's fold state is the user's, not this surface's.
 */
export function showSurfaceAlone(
  arrangement: RegionArrangement,
  surfaceId: string,
  preferred: RegionId,
): { arrangement: RegionArrangement; region: RegionId } {
  const revealed = revealSurface(arrangement, surfaceId, preferred);
  if (revealed.region === 'main') return revealed;
  let next = revealed.arrangement;
  for (const id of DOCK_REGION_IDS) {
    if (id !== revealed.region)
      next = updateRegion(next, id, { visible: false });
  }
  return { arrangement: next, region: revealed.region };
}

export interface DockMirrorDiff {
  placement?: DockRegionId;
  visible?: boolean;
  /**
   * Chat's maximize, for navigation's `maximize` param and
   * `lastDockMaximized`. Emitted only when Chat's region is visible after the
   * change and its `maximized` differs from before — an explicit maximize or
   * restore. A hide is not a maximize change even though the region's flag
   * clears with it: the provider's `setDockState(false, …)` forwards the
   * flag the region closed FROM (archive#945), so a remembered Full survives
   * the close. A non-chat region's maximize is never mirrored.
   */
  maximized?: boolean;
  size?: Partial<Record<RegionId, number>>;
}

/**
 * What a surface's toggle (its chord, or its row in the folded Regions menu)
 * does, decided from the arrangement alone (#1523; #1420 wanted no placement
 * rule left in the toolbar):
 *
 * - `arrangement`: the toggle resolved to a state write — a dock occupant
 *   hidden or revealed in place, or a `main` occupant relocated to its
 *   `defaultRegion`. `shownRegion` names the dock region that became visible,
 *   for the fold's `lastShownRegion`, or null when something was hidden.
 * - `show`: the toggle means "show it", and the model's own `showSurface`
 *   owns that (where an unplaced surface lands, the coarse show-alone fold,
 *   the `main` navigation).
 * - `none`: nothing to do — a `main` occupant whose default IS `main` (Home).
 */
export type SurfaceToggle =
  | {
      kind: 'arrangement';
      arrangement: RegionArrangement;
      shownRegion: DockRegionId | null;
    }
  | { kind: 'show' }
  | { kind: 'none' };

/**
 * Resolve a surface's toggle. Occupying a dock region toggles that region's
 * visibility, with the coarse rule kept from the folded menu: on a
 * bottom-only device the surface is HIDDEN only when it is the folded region
 * (the one visible dock such a device has); any other placed-but-not-showing
 * surface is shown alone instead. A surface the region holds behind another
 * pane's tab is not showing, so its toggle SELECTS it (#2046 2a) — on a fine
 * pointer in place, on a coarse device through the show path — and only the
 * selected pane's toggle hides its region. Occupying `main` moves the
 * surface to its `defaultRegion` when that is a dock region — visible, and
 * folded alone on a coarse device — so a chord that "hides" a `main`
 * occupant leaves Home behind (an emptied `main` reads as Home) rather than
 * doing nothing. Unplaced means show.
 */
export function toggleSurface(
  arrangement: RegionArrangement,
  surfaceId: string,
  defaultRegion: RegionId,
  options: { lastShownRegion: RegionId | null; bottomOnly: boolean },
): SurfaceToggle {
  const occupied = occupiedRegion(arrangement, surfaceId);
  if (!occupied) return { kind: 'show' };
  if (occupied === 'main') {
    if (!isDockRegion(defaultRegion)) return { kind: 'none' };
    let next = placeSurface(arrangement, surfaceId, defaultRegion, true);
    if (options.bottomOnly) {
      for (const id of DOCK_REGION_IDS) {
        if (id !== defaultRegion)
          next = updateRegion(next, id, { visible: false });
      }
    }
    return {
      kind: 'arrangement',
      arrangement: next,
      shownRegion: defaultRegion,
    };
  }
  const region = arrangement[occupied];
  const showing = region.visible && region.occupant === surfaceId;
  if (options.bottomOnly) {
    const folded = foldedDockRegion(arrangement, options.lastShownRegion);
    if (occupied === folded && showing) {
      return {
        kind: 'arrangement',
        arrangement: updateRegion(arrangement, occupied, { visible: false }),
        shownRegion: null,
      };
    }
    return { kind: 'show' };
  }
  return {
    kind: 'arrangement',
    arrangement: updateRegion(
      arrangement,
      occupied,
      showing ? { visible: false } : { visible: true, occupant: surfaceId },
    ),
    shownRegion: showing ? null : occupied,
  };
}

export function dockMirrorDiff(
  previous: RegionArrangement,
  next: RegionArrangement,
): DockMirrorDiff {
  const previousPlacement = chatRegion(previous);
  const placement = chatRegion(next);
  const result: DockMirrorDiff = {};
  if (placement !== previousPlacement && placement) {
    result.placement = placement;
    result.size = { [placement]: next[placement].size };
  }
  // Visibility is compared across the move, not re-emitted with it: a
  // same-visibility move must not reach `setDockState`, which records
  // `lastDockMaximized` (navigation-store.ts) as a side effect.
  const previousVisible = previousPlacement
    ? previous[previousPlacement].visible
    : false;
  const previousMaximized = previousPlacement
    ? previous[previousPlacement].maximized
    : false;
  if (placement && next[placement].visible !== previousVisible)
    result.visible = next[placement].visible;
  // Chat in no region (#2046 2b: its tab closed) is Chat not showing, and
  // navigation must say so — `focusSession`'s `setDockState(true, …)` is a
  // CHANGE only against a closed mirror, and that change is what re-places
  // Chat (`syncRegionArrangementFromDock`). Emitted once, on the leave.
  if (!placement && previousPlacement && previousVisible)
    result.visible = false;
  if (
    placement &&
    next[placement].visible &&
    next[placement].maximized !== previousMaximized
  )
    result.maximized = next[placement].maximized;
  const sizes: Partial<Record<RegionId, number>> = {};
  for (const id of DOCK_REGION_IDS)
    if (next[id].panes.includes('chat') && next[id].size !== previous[id].size)
      sizes[id] = next[id].size;
  if (Object.keys(sizes).length) result.size = { ...result.size, ...sizes };
  return result;
}

export interface SurfaceShortcut {
  id: string;
  key: string;
  modifiers: readonly ('cmd' | 'ctrl' | 'shift' | 'alt')[];
}

export function regionLabel(id: RegionId): string {
  return id[0]?.toUpperCase() + id.slice(1);
}

export interface RegisteredSurface {
  id: string;
  title: string;
  icon: string;
  /** The toggle chord, where the surface has one. Home has none. */
  shortcut?: SurfaceShortcut;
  /**
   * Where this surface may be placed. `placeSurface` refuses anything else;
   * the region toolbar offers a surface only for the regions it declares.
   */
  regions: readonly RegionId[];
  defaultRegion: RegionId;
  /**
   * Who offers this surface (#2047). `shell` — the default when absent — is
   * the toolbar's Layout picker, the folded Regions menu's Show rows and a
   * chord; `catalog` means a region's "+" catalog is its only offer, and the
   * shell lists it only where it is already placed (a placed pane's tab, its
   * folded Hide/Show row). An explicit flag rather than "has no shortcut",
   * which is a coincidence a later entry would break silently. Readers:
   * `useRegionSurfaceMenu` (`surfaceList`, which feeds the picker rows, the
   * chords and the unplaced Show rows). `?surface=<id>` is a command and
   * reveals either kind.
   */
  exposure?: 'shell' | 'catalog';
  /** Repository-relative renderer source, used by the architecture ratchet. */
  sourceFile: string;
}

export function createSurfaceRegistry(
  surfaces: readonly RegisteredSurface[],
): ReadonlyMap<string, RegisteredSurface> {
  const registry = new Map<string, RegisteredSurface>();
  for (const surface of surfaces) {
    if (!surface.id || registry.has(surface.id)) {
      throw new Error(`Duplicate or empty surface id: ${surface.id}`);
    }
    registry.set(surface.id, Object.freeze({ ...surface }));
  }
  return registry;
}

export const REGION_SURFACE_REGISTRY = createSurfaceRegistry([
  {
    id: 'chat',
    title: 'Chat',
    icon: 'chat',
    shortcut: { id: 'dock.toggle', key: 'd', modifiers: ['cmd'] },
    // Dock regions only for now. Chat's `main` placement would be a
    // projectless full-screen `ChatWorkspacePane`, a mount no entry point has
    // ever made: the full-screen placement is layout-bound (`layoutSlug` is
    // required for cross-project routing), owns its own dock-shortcut
    // registration, and `App.tsx` treats a full-screen Chat as owning the
    // whole viewport (no region host). Declaring `main` here without that
    // mount would advertise a placement the outlet cannot render (#928 C2a).
    regions: DOCK_REGION_IDS,
    defaultRegion: 'bottom',
    sourceFile: 'src-ui/src/components/chat-dock/ChatDock.tsx',
  },
  {
    id: 'activity',
    title: 'Activity',
    icon: 'activity',
    shortcut: {
      id: 'activity.toggle',
      key: 'a',
      modifiers: ['cmd', 'shift'],
    },
    regions: REGION_IDS,
    defaultRegion: 'right',
    sourceFile: 'src-ui/src/views/activity/ActivityWorkspacePane.tsx',
  },
  {
    // #2050: the work this conversation set running. Dock regions only, and
    // catalog-only exposure with no chord — it belongs beside a chat, and the
    // toolbar's picker is for surfaces that stand on their own.
    id: 'workspace-agents',
    title: 'Agents',
    icon: 'agent',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'right',
    exposure: 'catalog',
    sourceFile: 'src-ui/src/workspace-panes/AgentsWorkspacePane.tsx',
  },
  {
    // Home is a surface whose only placement is the primary area: its default
    // region is `main` and it declares no other, so no dock control ever
    // offers it and a dock swap can never carry it out of `main` (#928 C2a).
    // No chord: the destination registry has no Home shortcut and this slice
    // invents none.
    id: 'home',
    title: 'Home',
    icon: 'home',
    regions: ['main'],
    defaultRegion: 'main',
    sourceFile: 'src-ui/src/views/home/HomeSurface.tsx',
  },
  // The three coding panes as dock surfaces (#2047): one of each per region
  // set, bound to the dock's active project (`REGION_SURFACE_PANES`). Ids
  // keep the `pane:builtin:<surface id>` rule the docked-capability pins
  // assert. Catalog-only: the region's "+" offers them, the toolbar does not,
  // and none has a chord. Dock regions only: their `main` placement is the
  // coding layout, which is a route, not a surface.
  {
    // #1969: a captured simulator/emulator screen. Dock regions only and
    // catalog-only, like the coding panes — it is a working surface you add
    // beside a conversation, not one the Layout picker offers. `right` by
    // default because a device screen is portrait-tall and a side region is
    // where the height is. Pure over ids here, like every other entry: the
    // pane's contract and renderer are the inventory's and the registry's
    // chunk stays free of both.
    id: 'device',
    title: 'Device',
    icon: 'device',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'right',
    exposure: 'catalog',
    sourceFile: 'src-ui/src/workspace-panes/DeviceWorkspacePane.tsx',
  },
  {
    id: 'coding:terminal',
    title: 'Terminal',
    icon: 'terminal',
    regions: DOCK_REGION_IDS,
    // Bottom, beside Chat — the owner's 2026-09-15 direction (#2156); a
    // default, not a rule.
    defaultRegion: 'bottom',
    exposure: 'catalog',
    sourceFile: 'src-ui/src/components/coding-layout/CodingTerminalPane.tsx',
  },
  {
    id: 'coding:diff',
    title: 'Diff',
    icon: 'diff',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'right',
    exposure: 'catalog',
    sourceFile: 'src-ui/src/components/coding-layout/DiffPanel.tsx',
  },
  {
    id: 'coding:file-browser',
    title: 'Files',
    icon: 'files',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'left',
    exposure: 'catalog',
    sourceFile: 'src-ui/src/components/coding-layout/FileTreePanel.tsx',
  },
]);

/**
 * A family of INSTANCE-KEYED dock panes, resolved by the prefix its ids carry
 * (#2049). A pull-request pane and a file preview are one-per-thing, not
 * one-per-Station: their identity is the pull request or the previewed file,
 * so `RegionState.panes` holds the instance id itself
 * (`pr:<host>/<owner>/<repo>#<n>`, `file-preview:<nonce>`) and this table is
 * how every id-keyed reader resolves it — `resolveRegionSurface` below, which
 * the record parser, the model's placement rule, the provider's open, the
 * shell's mount rule and the title readers all go through.
 *
 * Plain data, and DELIBERATELY no pane contract import: this module is in the
 * entry chunk and the pane contracts are not, so naming a descriptor here by
 * its id string rather than by its constant is what keeps the two apart (a
 * cross-chunk cycle fails the build; #2048 measured +1,820 B for the
 * alternative). `region-surface-panes.ts` — the host's chunk — is where the
 * same prefixes mint the actual `WorkspacePaneInstance`, and
 * `docked-capability-derivation.test.ts` pins each `descriptorId` here to a
 * built-in descriptor that declares `docked`.
 *
 * These surfaces are never registry keys: there is no blank occurrence to
 * register, `REGION_SURFACE_PANES` holds none of them, and a region's
 * chooser cannot offer them (`RegionEmptyChooser` lists `surfaces`, the
 * registry, which holds no prefix family). They reach a region only through
 * `openInRegion` from a link click.
 */
export interface InstanceSurfacePrefix {
  /** The prefix every id of this family starts with. */
  prefix: string;
  /**
   * Whether an id is one this family can actually MINT — the full shape, not
   * the prefix. `resolveRegionSurface` admits through this rather than through
   * `startsWith`, because a pane id is data now: it is read back from a stored
   * arrangement record, and a build that mints a different shape (a provider
   * segment, a version) then rolled back leaves ids in that record which the
   * host chunk's `regionSurfacePane` refuses. Admitting one here and refusing
   * it there mounts a region host with no pane in it: chrome, no tab strip,
   * and therefore no close control.
   *
   * The shape is spelled as a regular expression rather than by calling the
   * contract's own parser because this module is entry-chunk resident and the
   * pane contracts are not (see the table's note above). The duplication is
   * held to the minters by `region-instance-panes.test.ts`, which runs a table
   * of ids through `matches` and through `regionSurfacePane` and requires the
   * same answer.
   */
  matches: (id: string) => boolean;
  /** The built-in descriptor its occurrences carry (`pane:builtin:…`). */
  descriptorId: string;
  /**
   * The title an id alone can carry — a tab whose instance has not been
   * resolved (the folded Regions menu, the shell landmark) shows this.
   * `RegionPaneHost` prefers the pane's own title where its inventory entry
   * derives one (`#123`, a file's name).
   */
  title: string;
  icon: string;
  regions: readonly RegionId[];
  defaultRegion: RegionId;
  /** Repository-relative renderer source, used by the architecture ratchet. */
  sourceFile: string;
}

/**
 * `pr:<host>/<owner>/<repository>#<ref>`, the exact shape
 * `workspacePullRequestPaneId` mints: a lowercase host with an optional port,
 * two lowercase path segments, and up to twelve digits.
 */
const PULL_REQUEST_SURFACE_ID =
  /^pr:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/[a-z0-9._-]+\/[a-z0-9._-]+#[0-9]{1,12}$/;

/**
 * `file-preview:<nonce>`, the 32 hex digits `createFilePreviewPaneInstance`
 * mints (`filePreviewPaneInstance.ts`, `FILE_PREVIEW_NONCE_PATTERN`).
 */
const FILE_PREVIEW_SURFACE_ID = /^file-preview:[0-9a-f]{32}$/;

export const INSTANCE_SURFACE_PREFIXES: readonly InstanceSurfacePrefix[] = [
  {
    prefix: 'pr:',
    matches: (id) => PULL_REQUEST_SURFACE_ID.test(id),
    descriptorId: 'pane:builtin:workspace-pull-request',
    title: 'Pull request',
    icon: 'diff',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'right',
    sourceFile:
      'src-ui/src/components/coding-layout/PullRequestReviewPanel.tsx',
  },
  {
    prefix: 'file-preview:',
    matches: (id) => FILE_PREVIEW_SURFACE_ID.test(id),
    descriptorId: 'pane:builtin:workspace-preview:file-preview',
    title: 'File preview',
    icon: 'files',
    regions: DOCK_REGION_IDS,
    defaultRegion: 'right',
    sourceFile: 'src-ui/src/workspace-panes/FilePreviewPane.tsx',
  },
];

const INSTANCE_SURFACE_CACHE = new Map<string, RegisteredSurface>();

/**
 * The surface an id names: a registered one, else an instance-keyed one its
 * prefix describes (#2049). THE id-keyed lookup — every reader that used to
 * call `REGION_SURFACE_REGISTRY.get(id)` for a placement decision or a title
 * calls this instead, so an instance-keyed pane is a pane everywhere or
 * nowhere. `model.surfaces` stays the registry Map: it is the SHELL's
 * inventory (what the toolbar may offer, what a chord toggles), and an
 * instance pane is in neither.
 *
 * `registry` is a parameter for the record parser's older-registry tests,
 * which read a stored record against a registry a past build had.
 *
 * An instance-keyed id is admitted by its family's full shape
 * (`InstanceSurfacePrefix.matches`), never by the prefix alone: the host
 * chunk's `regionSurfacePane` mints an occurrence by the same shape, and an id
 * only one of the two admits is a region host with no pane in it.
 *
 * Resolved surfaces are cached by id so repeated reads return one frozen
 * object. The set is bounded by the ids ever resolved, which includes a
 * refused open (`openSurfaceInRegion` resolves before it decides) and an id
 * since dropped from the record — a superset of the panes now open, still one
 * small frozen object per well-shaped id a user's clicks produced.
 */
export function resolveRegionSurface(
  surfaceId: string,
  registry: ReadonlyMap<string, RegisteredSurface> = REGION_SURFACE_REGISTRY,
): RegisteredSurface | undefined {
  const registered = registry.get(surfaceId);
  if (registered) return registered;
  const cached = INSTANCE_SURFACE_CACHE.get(surfaceId);
  if (cached) return cached;
  const prefix = INSTANCE_SURFACE_PREFIXES.find((entry) =>
    entry.matches(surfaceId),
  );
  if (!prefix) return undefined;
  const surface: RegisteredSurface = Object.freeze({
    id: surfaceId,
    title: prefix.title,
    icon: prefix.icon,
    regions: prefix.regions,
    defaultRegion: prefix.defaultRegion,
    // Catalog exposure, for the same reason the coding panes have it: the
    // toolbar's Layout picker, the chords and the unplaced Show rows must
    // not offer a pane that exists only because a link was clicked.
    exposure: 'catalog',
    sourceFile: prefix.sourceFile,
  });
  INSTANCE_SURFACE_CACHE.set(surfaceId, surface);
  return surface;
}

function regionStatesEqual(a: RegionState, b: RegionState): boolean {
  return (
    a.visible === b.visible &&
    a.size === b.size &&
    // Surface ids carry no comma — registered ids are words, and an
    // instance-keyed id is built from a validated host/owner/repository and
    // a number or a hex nonce (`workspacePullRequestPaneId`,
    // `file-preview:<nonce>`), none of which admit one — so the joined form
    // compares the lists element by element, in order.
    String(a.panes) === String(b.panes) &&
    a.occupant === b.occupant &&
    a.maximized === b.maximized
  );
}

/**
 * The pane invariants of one region (#2046 2a): no id repeats in `panes`,
 * `main` holds at most one pane (the selected one), and `occupant` is a
 * member of `panes` — the requested one when it is, else the first — or null
 * when the region is empty. Returns `panes` by reference when it already
 * satisfies them, so an unchanged set keeps its identity.
 */
export function normalizeRegionPanes(
  id: RegionId,
  panes: readonly string[],
  occupant: string | null,
): Pick<RegionState, 'panes' | 'occupant'> {
  let set = new Set(panes).size === panes.length ? panes : [...new Set(panes)];
  const selected =
    occupant !== null && set.includes(occupant) ? occupant : (set[0] ?? null);
  if (id === 'main' && set.length > 1) set = selected ? [selected] : [];
  return { panes: set, occupant: selected };
}

/**
 * Apply `patch` to one region, holding the maximize invariants for the whole
 * arrangement (#928 slice iii): `main` is never maximized, a hidden or empty
 * region is never maximized (the region-level form of "a closed dock is never
 * maximized", archive#795 — `is-collapsed` and `is-maximized` together render
 * a blank full-height shell), and at most one region is maximized at a time,
 * so maximizing one restores every other — and the pane invariants
 * (`normalizeRegionPanes`). Returns the same reference when nothing changes.
 *
 * A patch naming `occupant` without `panes` is the single-occupant write
 * (every pre-#2046 caller, the legacy dock seed): `null` empties the region,
 * an id the region holds selects it, and an id it does not hold REPLACES its
 * panes. A patch naming `panes` sets the tab order outright, with `occupant`
 * (when given and a member) the selected one.
 */
export function updateRegion(
  arrangement: RegionArrangement,
  id: RegionId,
  patch: Partial<RegionState>,
): RegionArrangement {
  const previous = arrangement[id];
  const merged: RegionState = { ...previous, ...patch };
  if (patch.occupant !== undefined && patch.panes === undefined) {
    if (patch.occupant === null) merged.panes = [];
    else if (!previous.panes.includes(patch.occupant))
      merged.panes = [patch.occupant];
  }
  Object.assign(
    merged,
    normalizeRegionPanes(id, merged.panes, merged.occupant),
  );
  if (
    merged.maximized &&
    (id === 'main' || !merged.visible || merged.occupant === null)
  ) {
    merged.maximized = false;
  }
  let next = regionStatesEqual(arrangement[id], merged)
    ? arrangement
    : { ...arrangement, [id]: merged };
  if (merged.maximized) {
    for (const other of REGION_IDS) {
      if (other !== id && next[other].maximized) {
        next = { ...next, [other]: { ...next[other], maximized: false } };
      }
    }
  }
  return next;
}
