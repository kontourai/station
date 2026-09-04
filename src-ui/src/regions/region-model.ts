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
export type RegionLayout = Record<RegionId, RegionState>;

export const DEFAULT_DEVICE_REGION_LAYOUT: RegionLayout = {
  main: { visible: true, size: 0, occupant: null },
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
  layout: RegionLayout,
  surfaceId: string,
): DockRegionId | undefined {
  return DOCK_REGION_IDS.find((id) => layout[id].occupant === surfaceId);
}

export function firstFreeDockRegion(
  layout: RegionLayout,
  preferred: DockRegionId,
): DockRegionId | undefined {
  if (layout[preferred].occupant === null) return preferred;
  return (['bottom', 'right', 'left'] as const).find(
    (id) => layout[id].occupant === null,
  );
}

/** The dock region holding chat; undefined when chat sits outside the dock (e.g. 'main'). */
export function chatRegion(layout: RegionLayout): DockRegionId | undefined {
  return occupiedDockRegion(layout, 'chat');
}

export function foldedDockRegion(
  layout: RegionLayout,
  lastShownRegion: RegionId | null,
): DockRegionId | undefined {
  const visibleOccupied = DOCK_REGION_IDS.filter(
    (id) => layout[id].occupant !== null && layout[id].visible,
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
    chatRegion(layout) ??
    DOCK_REGION_IDS.find((id) => layout[id].occupant !== null)
  );
}

export function seedRegionLayoutFromDock(
  settings: DockSeedSettings,
  placement: DockRegionId,
  isDockOpen: boolean,
): RegionLayout {
  return syncRegionLayoutFromDock(
    structuredClone(DEFAULT_DEVICE_REGION_LAYOUT),
    settings,
    isDockOpen,
    placement,
  );
}

export function syncRegionLayoutFromDock(
  layout: RegionLayout,
  settings: DockSeedSettings,
  isDockOpen: boolean,
  placement: DockRegionId,
): RegionLayout {
  let next = layout;
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

export function placeSurface(
  layout: RegionLayout,
  surfaceId: string,
  regionId: RegionId,
  visible = true,
): RegionLayout {
  const previousRegion = REGION_IDS.find(
    (id) => id !== regionId && layout[id].occupant === surfaceId,
  );
  const displacedSurface = layout[regionId].occupant;
  const next = updateRegion(layout, regionId, {
    occupant: surfaceId,
    visible,
  });
  if (previousRegion) {
    return updateRegion(next, previousRegion, {
      occupant: displacedSurface,
      visible: displacedSurface === null ? false : layout[regionId].visible,
    });
  }
  if (displacedSurface !== null && displacedSurface !== surfaceId) {
    const freeRegion = firstFreeDockRegion(
      next,
      DOCK_REGION_IDS.includes(regionId as DockRegionId)
        ? (regionId as DockRegionId)
        : 'bottom',
    );
    if (freeRegion) {
      return updateRegion(next, freeRegion, {
        occupant: displacedSurface,
        visible: layout[regionId].visible,
      });
    }
  }
  return next;
}

export function revealSurface(
  layout: RegionLayout,
  surfaceId: string,
  preferred: DockRegionId,
): { layout: RegionLayout; region: DockRegionId } {
  const occupied = occupiedDockRegion(layout, surfaceId);
  if (occupied) {
    return {
      layout: updateRegion(layout, occupied, { visible: true }),
      region: occupied,
    };
  }
  const region = firstFreeDockRegion(layout, preferred) ?? preferred;
  return { layout: placeSurface(layout, surfaceId, region), region };
}

export function showSurfaceAlone(
  layout: RegionLayout,
  surfaceId: string,
  preferred: DockRegionId,
): { layout: RegionLayout; region: DockRegionId } {
  const revealed = revealSurface(layout, surfaceId, preferred);
  let next = revealed.layout;
  for (const id of DOCK_REGION_IDS) {
    if (id !== revealed.region)
      next = updateRegion(next, id, { visible: false });
  }
  return { layout: next, region: revealed.region };
}

export function dockMirrorDiff(
  previous: RegionLayout,
  next: RegionLayout,
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
  shortcut: SurfaceShortcut;
  defaultRegion: DockRegionId;
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
    defaultRegion: 'right',
    sourceFile: 'src-ui/src/views/activity/ActivityWorkspacePane.tsx',
  },
]);

export function updateRegion(
  layout: RegionLayout,
  id: RegionId,
  patch: Partial<RegionState>,
): RegionLayout {
  if (
    Object.entries(patch).every(
      ([key, value]) => layout[id][key as keyof RegionState] === value,
    )
  ) {
    return layout;
  }
  return { ...layout, [id]: { ...layout[id], ...patch } };
}
