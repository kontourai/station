import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';

export const REGION_IDS = ['main', 'left', 'right', 'bottom'] as const;
export type RegionId = (typeof REGION_IDS)[number];
export const DOCK_REGION_IDS = [
  'left',
  'right',
  'bottom',
] as const satisfies readonly RegionId[];
export interface RegionState {
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
  const surface = REGION_SURFACE_REGISTRY.get(surfaceId);
  return surface ? surface.regions.includes(regionId) : isDockRegion(regionId);
}

export function firstFreeDockRegion(
  arrangement: RegionArrangement,
  preferred: DockRegionId,
): DockRegionId | undefined {
  if (regionIsEmpty(arrangement[preferred])) return preferred;
  return (['bottom', 'right', 'left'] as const).find((id) =>
    regionIsEmpty(arrangement[id]),
  );
}

/** The dock region holding chat; undefined when chat sits outside the dock (e.g. 'main'). */
export function chatRegion(
  arrangement: RegionArrangement,
): DockRegionId | undefined {
  return occupiedDockRegion(arrangement, 'chat');
}

export function foldedDockRegion(
  arrangement: RegionArrangement,
  lastShownRegion: RegionId | null,
): DockRegionId | undefined {
  const visibleOccupied = DOCK_REGION_IDS.filter(
    (id) => !regionIsEmpty(arrangement[id]) && arrangement[id].visible,
  );
  if (
    lastShownRegion &&
    DOCK_REGION_IDS.includes(lastShownRegion as DockRegionId) &&
    visibleOccupied.includes(lastShownRegion as DockRegionId)
  ) {
    return lastShownRegion as DockRegionId;
  }
  return (
    visibleOccupied[0] ??
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
  if (next[placement].panes.includes('chat')) {
    return updateRegion(next, placement, { visible: isDockOpen });
  }
  if (currentChatRegion) {
    return updateRegion(next, currentChatRegion, { visible: isDockOpen });
  }

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
 * neighbour of the one that left when that was the selected pane; a region
 * left empty hides (a dock region) or stays visible showing Home (`main`).
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
  return withoutRegionPane(next, previousRegion, surfaceId);
}

/**
 * Take `surfaceId` out of `regionId`'s panes. A region left with other panes
 * keeps them and its visibility; when the pane leaving was the selected one,
 * the pane at its position (or the last) is selected, the way closing a tab
 * selects its neighbour. An emptied dock region hides (and a hide clears its
 * maximize); an emptied `main` stays visible — the outlet treats a null
 * occupant as Home. Shared by `placeSurface` (the region a surface leaves)
 * and `removeRegionPane` (a closed tab), so the two cannot select different
 * neighbours.
 */
function withoutRegionPane(
  arrangement: RegionArrangement,
  regionId: RegionId,
  surfaceId: string,
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
        }
      : {
          panes,
          occupant: null,
          visible: regionId === 'main',
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
  return withoutRegionPane(arrangement, regionId, surfaceId);
}

/**
 * Move every pane of dock region `from` into dock region `to` (#2046 2b: the
 * region bar's placement control moves the REGION — its tab order and its
 * selection go with it — where the pre-2b header moved the one surface it
 * belonged to). The panes join `to` after any it already holds, in `from`'s
 * order, and `from`'s selected pane is selected there; `to` is shown, and
 * both ends come out restored, the same rule `placeSurface` applies to a
 * relocation (#1385). A pane that does not declare `to` (`surfaceMayOccupy`)
 * stays behind, so `from` is emptied — and hides — only when everything
 * moved. The same region, or an empty `from`, is returned unchanged.
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
]);

function regionStatesEqual(a: RegionState, b: RegionState): boolean {
  return (
    a.visible === b.visible &&
    a.size === b.size &&
    // Surface ids carry no comma (`createSurfaceRegistry` ids are words),
    // so the joined form compares the lists element by element, in order.
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
