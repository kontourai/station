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
  main: { visible: true, size: 0, occupant: 'home', maximized: false },
  left: { visible: false, size: 400, occupant: null, maximized: false },
  right: { visible: false, size: 400, occupant: null, maximized: false },
  bottom: { visible: false, size: 320, occupant: 'chat', maximized: false },
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
  return DOCK_REGION_IDS.find((id) => arrangement[id].occupant === surfaceId);
}

/** The region (dock or `main`) holding a surface, if any. */
export function occupiedRegion(
  arrangement: RegionArrangement,
  surfaceId: string,
): RegionId | undefined {
  return REGION_IDS.find((id) => arrangement[id].occupant === surfaceId);
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
  if (arrangement[preferred].occupant === null) return preferred;
  return (['bottom', 'right', 'left'] as const).find(
    (id) => arrangement[id].occupant === null,
  );
}

/**
 * Where a displaced surface goes when it cannot take the region the incoming
 * one vacated — one ordered candidate list, first available wins.
 *
 * Its own registered `defaultRegion` leads: the region it would have been
 * revealed into had nothing placed it. Then, when a SIDE is what it is
 * leaving, the other side — the two sides are the pair a reader already reads
 * as one row, and a surface pushed out of `left` landing in `bottom` reshapes
 * the whole workspace to move something sideways. Then the historical order.
 * The vacated region is not a candidate at all; the placer holds it.
 *
 * "Available" is free AND declared: `surfaceMayOccupy` gates every candidate,
 * so a relocation can never put a surface somewhere it does not declare, and
 * `isDockRegion` keeps `main` out of it even when a surface's default region
 * IS `main` — the primary area is only ever handed to a surface placed there
 * deliberately.
 *
 * #1386: this used to be `firstFreeDockRegion(next, regionId)`, whose
 * `preferred` argument was the region the PLACER had just taken. That region
 * is occupied by definition at this point, so the preference branch could
 * never fire and the fallback order decided every relocation.
 */
function displacementDestination(
  arrangement: RegionArrangement,
  displacedSurface: string,
  vacated: RegionId,
): DockRegionId | undefined {
  const candidates: readonly (RegionId | undefined)[] = [
    REGION_SURFACE_REGISTRY.get(displacedSurface)?.defaultRegion,
    vacated === 'left' ? 'right' : vacated === 'right' ? 'left' : undefined,
    'bottom',
    'right',
    'left',
  ];
  return candidates.find(
    (id): id is DockRegionId =>
      id !== undefined &&
      isDockRegion(id) &&
      arrangement[id].occupant === null &&
      surfaceMayOccupy(displacedSurface, id),
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
    (id) => arrangement[id].occupant !== null && arrangement[id].visible,
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
    DOCK_REGION_IDS.find((id) => arrangement[id].occupant !== null)
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
    if (next[id].occupant === null || next[id].occupant === 'chat') {
      next = updateRegion(next, id, {
        size:
          id === 'bottom' ? settings.chatDockHeight : settings.chatDockWidth,
      });
    }
  }

  const currentChatRegion = chatRegion(next);
  if (next[placement].occupant === null) {
    return placeSurface(next, 'chat', placement, isDockOpen);
  }
  if (next[placement].occupant === 'chat') {
    return updateRegion(next, placement, { visible: isDockOpen });
  }
  if (currentChatRegion) {
    return updateRegion(next, currentChatRegion, { visible: isDockOpen });
  }

  const freeRegion = (['bottom', 'left', 'right'] as const).find(
    (id) => next[id].occupant === null,
  );
  return freeRegion
    ? updateRegion(next, freeRegion, {
        visible: isDockOpen,
        occupant: 'chat',
      })
    : next;
}

/**
 * Place `surfaceId` in `regionId`, honouring the surface's declared regions
 * (`surfaceMayOccupy`; an ineligible placement returns the arrangement
 * unchanged — the toolbar never offers one, this is the backstop) and vacating
 * whichever region the surface came from.
 *
 * What happens to the region's previous occupant depends on the target:
 *
 * - into a dock region, the displaced surface relocates — back into the
 *   region the incoming surface vacated when it may occupy it (a swap), else
 *   into its own registered `defaultRegion` when that is free, else into the
 *   first available region of `displacementDestination`'s order (the
 *   opposite side first, when a side is what it is leaving), else it is
 *   unplaced;
 * - into `main`, the displaced surface is UNPLACED, never relocated. `main`
 *   is the primary area: replacing what it shows must not spawn a dock panel
 *   the user did not ask for (#928 C2a, owner decision).
 *
 * `main` is always visible; the `visible` argument only applies to a dock
 * region.
 */
export function placeSurface(
  arrangement: RegionArrangement,
  surfaceId: string,
  regionId: RegionId,
  visible = true,
): RegionArrangement {
  if (!surfaceMayOccupy(surfaceId, regionId)) return arrangement;
  const previousRegion = REGION_IDS.find(
    (id) => id !== regionId && arrangement[id].occupant === surfaceId,
  );
  const displacedSurface = arrangement[regionId].occupant;
  // A relocation never carries a maximize (#1385): the region a surface
  // enters and the region it leaves both come out restored, whatever either
  // was before. The one #1385 saw — Chat maximized in `bottom`, Activity
  // swapped in, Chat's shell re-propped to `right` still full-width over the
  // Activity shell the user had just asked for — is a maximize that was the
  // occupant's flag surviving a move; as the region's attribute it is written
  // out here.
  let next = updateRegion(arrangement, regionId, {
    occupant: surfaceId,
    visible: regionId === 'main' || visible,
    maximized: false,
  });
  if (previousRegion) {
    // An emptied dock region hides; an emptied `main` stays visible (the
    // outlet treats a null occupant as Home).
    next = updateRegion(next, previousRegion, {
      occupant: null,
      visible: previousRegion === 'main',
      maximized: false,
    });
  }
  if (displacedSurface === null || displacedSurface === surfaceId) return next;
  if (regionId === 'main') return next;
  const displacedVisible = arrangement[regionId].visible;
  if (
    previousRegion &&
    previousRegion !== 'main' &&
    surfaceMayOccupy(displacedSurface, previousRegion)
  ) {
    return updateRegion(next, previousRegion, {
      occupant: displacedSurface,
      visible: displacedVisible,
      maximized: false,
    });
  }
  const freeRegion = displacementDestination(next, displacedSurface, regionId);
  if (freeRegion) {
    return updateRegion(next, freeRegion, {
      occupant: displacedSurface,
      visible: displacedVisible,
      maximized: false,
    });
  }
  return next;
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
    return {
      arrangement: updateRegion(arrangement, occupied, { visible: true }),
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
 * surface is shown alone instead. Occupying `main` moves the surface to its
 * `defaultRegion` when that is a dock region — visible, and folded alone on a
 * coarse device — so a chord that "hides" a `main` occupant leaves Home
 * behind (an emptied `main` reads as Home) rather than doing nothing.
 * Unplaced means show.
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
  if (options.bottomOnly) {
    const folded = foldedDockRegion(arrangement, options.lastShownRegion);
    if (occupied === folded && arrangement[occupied].visible) {
      return {
        kind: 'arrangement',
        arrangement: updateRegion(arrangement, occupied, { visible: false }),
        shownRegion: null,
      };
    }
    return { kind: 'show' };
  }
  const visible = !arrangement[occupied].visible;
  return {
    kind: 'arrangement',
    arrangement: updateRegion(arrangement, occupied, { visible }),
    shownRegion: visible ? occupied : null,
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
  if (
    placement &&
    next[placement].visible &&
    next[placement].maximized !== previousMaximized
  )
    result.maximized = next[placement].maximized;
  const sizes: Partial<Record<RegionId, number>> = {};
  for (const id of DOCK_REGION_IDS)
    if (next[id].occupant === 'chat' && next[id].size !== previous[id].size)
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
    a.occupant === b.occupant &&
    a.maximized === b.maximized
  );
}

/**
 * Apply `patch` to one region, holding the maximize invariants for the whole
 * arrangement (#928 slice iii): `main` is never maximized, a hidden or empty
 * region is never maximized (the region-level form of "a closed dock is never
 * maximized", archive#795 — `is-collapsed` and `is-maximized` together render
 * a blank full-height shell), and at most one region is maximized at a time,
 * so maximizing one restores every other. Returns the same reference when
 * nothing changes.
 */
export function updateRegion(
  arrangement: RegionArrangement,
  id: RegionId,
  patch: Partial<RegionState>,
): RegionArrangement {
  const merged: RegionState = { ...arrangement[id], ...patch };
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
