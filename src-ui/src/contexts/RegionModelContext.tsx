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
  REGION_SURFACE_REGISTRY,
  type RegionId,
  type RegionLayout,
  type RegionState,
  seedRegionLayoutFromDock,
  syncRegionLayoutFromDock,
  updateRegion,
} from '../regions/region-model';
import { useDeviceSettings } from './DeviceSettingsContext';
import { useNavigation } from './NavigationContext';

interface RegionModelValue {
  regions: RegionLayout;
  surfaces: typeof REGION_SURFACE_REGISTRY;
  setRegion(id: RegionId, patch: Partial<RegionState>): void;
}

const RegionModelContext = createContext<RegionModelValue | null>(null);

export function RegionModelProvider({ children }: { children: ReactNode }) {
  const settings = useDeviceSettings();
  const { isDockOpen } = useNavigation();
  const [regions, setRegions] = useState<RegionLayout>(
    // Step 1 persists region layout via legacy dock keys; its own record arrives when regions become user-visible.
    () => seedRegionLayoutFromDock(settings, isDockOpen),
  );
  const regionsRef = useRef(regions);
  regionsRef.current = regions;

  const setRegion = useCallback((id: RegionId, patch: Partial<RegionState>) => {
    const next = updateRegion(regionsRef.current, id, patch);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    setRegions(next);
  }, []);

  // Until regions become user-visible, the model observes the legacy dock
  // authority and never drives it.
  useEffect(() => {
    setRegions((current) => {
      const next = syncRegionLayoutFromDock(
        current,
        {
          chatDockHeight: settings.chatDockHeight,
          chatDockWidth: settings.chatDockWidth,
          dockSlotPlacement: settings.dockSlotPlacement,
        },
        isDockOpen,
      );
      regionsRef.current = next;
      return next;
    });
  }, [
    isDockOpen,
    settings.chatDockHeight,
    settings.chatDockWidth,
    settings.dockSlotPlacement,
  ]);

  const value = useMemo(
    () => ({
      regions,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion,
    }),
    [regions, setRegion],
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
