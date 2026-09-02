import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';

export const REGION_IDS = ['main', 'left', 'right', 'bottom'] as const;
export type RegionId = (typeof REGION_IDS)[number];
export const DOCK_REGION_IDS = [
  'left',
  'right',
  'bottom',
] as const satisfies readonly RegionId[];
export type RegionBreakpoint = 'phone' | 'desktop';
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
  'chatDockHeight' | 'chatDockWidth' | 'dockSlotPlacement'
>;

export function seedRegionLayoutFromDock(
  settings: DockSeedSettings,
  placement: (typeof DOCK_REGION_IDS)[number],
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
  placement = settings.dockSlotPlacement ?? 'bottom',
): RegionLayout {
  let next = updateRegion(layout, 'bottom', {
    size: settings.chatDockHeight,
  });
  next = updateRegion(next, 'left', { size: settings.chatDockWidth });
  next = updateRegion(next, 'right', { size: settings.chatDockWidth });
  for (const id of REGION_IDS) {
    if (id !== placement && next[id].occupant === 'chat') {
      next = updateRegion(next, id, { visible: false, occupant: null });
    }
  }
  return updateRegion(next, placement, {
    visible: isDockOpen,
    occupant: 'chat',
  });
}

export function placeSurface(
  layout: RegionLayout,
  surfaceId: string,
  regionId: RegionId,
): RegionLayout {
  let next = layout;
  for (const id of REGION_IDS) {
    if (id !== regionId && next[id].occupant === surfaceId) {
      next = updateRegion(next, id, { occupant: null, visible: false });
    }
  }
  return updateRegion(next, regionId, { occupant: surfaceId, visible: true });
}

export function dockMirrorDiff(
  previous: RegionLayout,
  next: RegionLayout,
): {
  placement?: RegionId;
  visible?: boolean;
  size?: Partial<Record<RegionId, number>>;
} {
  const previousPlacement = DOCK_REGION_IDS.find(
    (id) => previous[id].occupant === 'chat',
  );
  const placement = DOCK_REGION_IDS.find((id) => next[id].occupant === 'chat');
  const result: {
    placement?: RegionId;
    visible?: boolean;
    size?: Partial<Record<RegionId, number>>;
  } = {};
  if (placement !== previousPlacement && placement)
    result.placement = placement;
  if (placement !== previousPlacement && placement)
    result.visible = next[placement].visible;
  if (
    placement &&
    previousPlacement &&
    next[placement].visible !== previous[previousPlacement].visible
  )
    result.visible = next[placement].visible;
  const sizes: Partial<Record<RegionId, number>> = {};
  for (const id of DOCK_REGION_IDS)
    if (next[id].size !== previous[id].size) sizes[id] = next[id].size;
  if (Object.keys(sizes).length) result.size = sizes;
  return result;
}

/** Breakpoint availability belongs to the region model, never to a surface. */
export const REGION_AVAILABILITY: Readonly<
  Record<RegionBreakpoint, readonly RegionId[]>
> = {
  phone: ['main', 'bottom'],
  desktop: REGION_IDS,
};

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
    sourceFile: 'src-ui/src/components/chat-dock/ChatDock.tsx',
  },
]);

export function isRegionAvailable(
  id: RegionId,
  breakpoint: RegionBreakpoint,
): boolean {
  return REGION_AVAILABILITY[breakpoint].includes(id);
}

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
