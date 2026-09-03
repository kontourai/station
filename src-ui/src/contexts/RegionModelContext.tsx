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
  updateRegion,
} from '../regions/region-model';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from './DeviceSettingsContext';
import { useNavigation } from './NavigationContext';

interface RegionModelValue {
  regions: RegionLayout;
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
  const regionsRef = useRef(regions);
  const mirroredRegionsRef = useRef(regions);
  regionsRef.current = regions;

  const setRegion = useCallback((id: RegionId, patch: Partial<RegionState>) => {
    const next = updateRegion(regionsRef.current, id, patch);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    setRegions(next);
  }, []);

  const placeSurface = useCallback((surfaceId: string, regionId: RegionId) => {
    const next = placeSurfaceInLayout(regionsRef.current, surfaceId, regionId);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
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
    const next = seedRegionLayoutFromDock(settings, dockMode, isDockOpen);
    regionsRef.current = next;
    // A seed is inbound; marking it mirrored keeps the outbound effect from
    // replaying it as a user write (which would stamp `dockSlotPlacement`
    // into the URL of a tab that merely received another tab's setting).
    mirroredRegionsRef.current = next;
    setRegions(next);
  }, [dockMode, isDockOpen]);

  const value = useMemo(
    () => ({
      regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion,
      placeSurface,
    }),
    [regions, setRegion, placeSurface],
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
