import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  chatRegion,
  DOCK_REGION_IDS,
  dockMirrorDiff,
  placeSurface as placeSurfaceInLayout,
  REGION_SURFACE_REGISTRY,
  type RegionId,
  type RegionLayout,
  type RegionState,
  seedRegionLayoutFromDock,
  syncRegionLayoutFromDock,
  updateRegion,
} from '../regions/region-model';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from './DeviceSettingsContext';
import { useNavigation } from './NavigationContext';

interface RegionModelValue {
  regions: RegionLayout;
  lastShownRegion: RegionId | null;
  surfaces: typeof REGION_SURFACE_REGISTRY;
  setRegion(id: RegionId, patch: Partial<RegionState>): void;
  placeSurface(surfaceId: string, regionId: RegionId): void;
}

const RegionModelContext = createContext<RegionModelValue | null>(null);

export function RegionModelProvider({ children }: { children: ReactNode }) {
  const settings = useDeviceSettings();
  const { isDockOpen, isDockMaximized, dockMode, setDockMode, setDockState } =
    useNavigation();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const [regions, setRegions] = useState<RegionLayout>(
    // Step 1 persists region layout via legacy dock keys; its own record arrives when regions become user-visible.
    () => seedRegionLayoutFromDock(settings, dockMode, isDockOpen),
  );
  const [lastShownRegion, setLastShownRegion] = useState<RegionId | null>(
    () => chatRegion(regions) ?? null,
  );
  const regionsRef = useRef(regions);
  const mirroredRegionsRef = useRef(regions);
  regionsRef.current = regions;

  const setRegion = useCallback((id: RegionId, patch: Partial<RegionState>) => {
    const next = updateRegion(regionsRef.current, id, patch);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    if (patch.visible === true) setLastShownRegion(id);
    setRegions(next);
  }, []);

  const placeSurface = useCallback((surfaceId: string, regionId: RegionId) => {
    const next = placeSurfaceInLayout(regionsRef.current, surfaceId, regionId);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    setLastShownRegion(regionId);
    setRegions(next);
  }, []);

  useEffect(() => {
    const previous = mirroredRegionsRef.current;
    const diff = dockMirrorDiff(previous, regions);
    const placement = diff.placement;
    if (placement) setDockMode(placement);
    if (diff.visible !== undefined)
      setDockState(diff.visible, diff.visible ? isDockMaximized : false);
    if (diff.size !== undefined)
      for (const id of DOCK_REGION_IDS) {
        const size = diff.size[id];
        if (size !== undefined)
          setDeviceSetting(
            id === 'bottom' ? 'chatDockHeight' : 'chatDockWidth',
            size,
          );
      }
    mirroredRegionsRef.current = regions;
  }, [isDockMaximized, regions, setDeviceSetting, setDockMode, setDockState]);

  // Navigation remains an inbound source for deep links and browser history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: device-setting notifications are mirror traffic, not inbound navigation.
  useEffect(() => {
    const current = regionsRef.current;
    const placement = chatRegion(current);
    if (placement === dockMode && current[placement].visible === isDockOpen)
      return;
    const next = syncRegionLayoutFromDock(
      regionsRef.current,
      settings,
      isDockOpen,
      dockMode,
    );
    regionsRef.current = next;
    const nextChatRegion = chatRegion(next);
    if (isDockOpen && nextChatRegion) setLastShownRegion(nextChatRegion);
    if (nextChatRegion && nextChatRegion !== dockMode) {
      setDockMode(nextChatRegion);
    }
    // A seed is inbound; marking it mirrored keeps the outbound effect from
    // replaying it as a user write. A conflicting requested region is the
    // exception above: Chat cannot occupy it, so navigation is corrected to
    // the region Chat actually retained (#928).
    mirroredRegionsRef.current = next;
    setRegions(next);
  }, [dockMode, isDockOpen]);

  const value = useMemo(
    () => ({
      regions,
      lastShownRegion,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion,
      placeSurface,
    }),
    [regions, lastShownRegion, setRegion, placeSurface],
  );
  return (
    <RegionModelContext.Provider value={value}>
      {children}
    </RegionModelContext.Provider>
  );
}

export function useRegionModelOptional(): RegionModelValue | null {
  return useContext(RegionModelContext);
}

export function useRegionModel(): RegionModelValue {
  const value = useRegionModelOptional();
  if (!value)
    throw new Error('useRegionModel must be used within RegionModelProvider');
  return value;
}
