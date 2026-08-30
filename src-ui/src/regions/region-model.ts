import type { DeviceSettings } from '@kontourai/station-contracts/device-settings';

export const REGION_IDS = ['main', 'left', 'right', 'bottom'] as const;
export type RegionId = (typeof REGION_IDS)[number];
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
  isDockOpen: boolean,
): RegionLayout {
  return syncRegionLayoutFromDock(
    structuredClone(DEFAULT_DEVICE_REGION_LAYOUT),
    settings,
    isDockOpen,
  );
}

export function syncRegionLayoutFromDock(
  layout: RegionLayout,
  settings: DockSeedSettings,
  isDockOpen: boolean,
): RegionLayout {
  const placement = settings.dockSlotPlacement ?? 'bottom';
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
