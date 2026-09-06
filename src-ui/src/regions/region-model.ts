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
}
export type RegionArrangement = Record<RegionId, RegionState>;

export const DEFAULT_DEVICE_REGION_ARRANGEMENT: RegionArrangement = {
  // `main` is always visible and Home is its default occupant (#928 C2a).
  main: { visible: true, size: 0, occupant: 'home' },
  left: { visible: false, size: 400, occupant: null },
  right: { visible: false, size: 400, occupant: null },
  bottom: { visible: false, size: 320, occupant: 'chat' },
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
 *   into the first free dock region, else it is unplaced;
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
  let next = updateRegion(arrangement, regionId, {
    occupant: surfaceId,
    visible: regionId === 'main' || visible,
  });
  if (previousRegion) {
    // An emptied dock region hides; an emptied `main` stays visible (the
    // outlet treats a null occupant as Home).
    next = updateRegion(next, previousRegion, {
      occupant: null,
      visible: previousRegion === 'main',
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
    });
  }
  const freeRegion = firstFreeDockRegion(next, regionId);
  if (freeRegion && surfaceMayOccupy(displacedSurface, freeRegion)) {
    return updateRegion(next, freeRegion, {
      occupant: displacedSurface,
      visible: displacedVisible,
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
): {
  placement?: DockRegionId;
  visible?: boolean;
  size?: Partial<Record<RegionId, number>>;
} {
  const previousPlacement = chatRegion(previous);
  const placement = chatRegion(next);
  const result: {
    placement?: DockRegionId;
    visible?: boolean;
    size?: Partial<Record<RegionId, number>>;
  } = {};
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
  if (placement && next[placement].visible !== previousVisible)
    result.visible = next[placement].visible;
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

export function updateRegion(
  arrangement: RegionArrangement,
  id: RegionId,
  patch: Partial<RegionState>,
): RegionArrangement {
  if (
    Object.entries(patch).every(
      ([key, value]) => arrangement[id][key as keyof RegionState] === value,
    )
  ) {
    return arrangement;
  }
  return { ...arrangement, [id]: { ...arrangement[id], ...patch } };
}
