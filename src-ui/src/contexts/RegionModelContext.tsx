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
import { availablePlacements, useDockSlotDevice } from '../hooks/useIsMobile';
import {
  chatRegion,
  DOCK_REGION_IDS,
  dockMirrorDiff,
  placeSurface as placeSurfaceInArrangement,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
  type RegionId,
  type RegionState,
  revealSurface,
  seedRegionArrangementFromDock,
  showSurfaceAlone,
  surfaceMayOccupy,
  syncRegionArrangementFromDock,
  updateRegion,
} from '../regions/region-model';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from './DeviceSettingsContext';
import { useNavigation } from './NavigationContext';
import { navigationStore } from './navigation-store';
import { clearSurfaceDeepLinkParams } from './surface-deep-link';

export interface SurfaceIntent {
  session?: string;
  focus?: 'evidence';
}

export interface SurfaceIntentRecord extends SurfaceIntent {
  token: number;
}

type SurfaceIntents = Partial<Record<string, SurfaceIntentRecord>>;

function withoutSurfaceIntent(
  current: SurfaceIntents,
  surfaceId: string,
): SurfaceIntents {
  if (!current[surfaceId]) return current;
  return Object.fromEntries(
    Object.entries(current).filter(([id]) => id !== surfaceId),
  );
}

interface RegionModelValue {
  regions: RegionArrangement;
  lastShownRegion: RegionId | null;
  surfaces: typeof REGION_SURFACE_REGISTRY;
  setRegion(id: RegionId, patch: Partial<RegionState>): void;
  placeSurface(surfaceId: string, regionId: RegionId): void;
  showSurface(surfaceId: string, intent?: SurfaceIntent): void;
  /**
   * Undelivered one-shot instructions, keyed by surface — an OUTBOX, not a
   * store of "what this surface is showing". A mounted placement takes its
   * record with `consumeSurfaceIntent` and holds its own copy from then on;
   * anything still here has not been delivered to anyone (#928).
   */
  surfaceIntents: Readonly<SurfaceIntents>;
  /**
   * Called by the placement that has taken delivery of `surfaceIntents[id]`.
   * The record is dropped, so the consumer's own unmount can no longer make
   * the same instruction look new: the consumption record now outlives the
   * consumer. The token guard keeps a take from swallowing a NEWER intent
   * minted between the render that read the record and this call.
   */
  consumeSurfaceIntent(surfaceId: string, token: number): void;
  /**
   * Whether a region surface host is mounted, i.e. whether `showSurface` can
   * produce anything the reader will see. Not a predicate re-derived from the
   * route: the app mounts `RegionShells` only while `showAmbientChatDock`
   * holds (`App.tsx`), and a Chat workspace layout owns the whole view
   * instead — so a commanded reveal during one mutates state nothing renders.
   * This is that host's own registration, so it cannot drift from whatever
   * gates the host. `useShowSurface` navigates to the surface's deep link
   * instead when it is false.
   */
  canRenderRegionSurfaces: boolean;
  /** Called by a mounted region surface host; returns its unregister. */
  registerRegionSurfaceHost(): () => void;
}

const RegionModelContext = createContext<RegionModelValue | null>(null);

/**
 * `main` is the route outlet at `/` and nowhere else (`App.tsx`): a surface
 * placed there is only on screen at `/`. The model is the one place that
 * knows a placement landed in `main`, so it is the model that navigates —
 * after the state write, through the same store call `useShowSurface` makes.
 * On any other route the routed view renders and `main`'s occupant is kept,
 * not cleared, so coming back to `/` shows what was placed (#928 C2a).
 */
function navigateToMainOutlet() {
  if (window.location.pathname !== '/') navigationStore.navigate('/');
}

export function RegionModelProvider({ children }: { children: ReactNode }) {
  const settings = useDeviceSettings();
  const {
    isDockOpen,
    isDockMaximized,
    dockMode,
    surfaceIntent,
    setDockMode,
    setDockState,
    updateParams,
  } = useNavigation();
  const bottomOnly = availablePlacements(useDockSlotDevice()).length === 1;
  const { setDeviceSetting } = useDeviceSettingsActions();
  const [regions, setRegions] = useState<RegionArrangement>(
    // Step 1 persists the region arrangement via legacy dock keys; its own record arrives when regions become user-visible.
    () => seedRegionArrangementFromDock(settings, dockMode, isDockOpen),
  );
  const [lastShownRegion, setLastShownRegion] = useState<RegionId | null>(
    () => chatRegion(regions) ?? null,
  );
  const [surfaceIntents, setSurfaceIntents] = useState<SurfaceIntents>({});
  const [mountedSurfaceHosts, setMountedSurfaceHosts] = useState(0);
  const surfaceIntentTokenRef = useRef(0);
  const adoptedIntentKeyRef = useRef<string | null>(null);
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
    // A refused placement (the surface does not declare this region) must not
    // navigate either: nothing was placed, so there is nothing to go and see.
    if (!surfaceMayOccupy(surfaceId, regionId)) return;
    const next = placeSurfaceInArrangement(
      regionsRef.current,
      surfaceId,
      regionId,
    );
    if (next !== regionsRef.current) {
      regionsRef.current = next;
      setLastShownRegion(regionId);
      setRegions(next);
    }
    if (regionId === 'main') navigateToMainOutlet();
  }, []);

  const showSurface = useCallback(
    (surfaceId: string, intent?: SurfaceIntent) => {
      const surface = REGION_SURFACE_REGISTRY.get(surfaceId);
      if (!surface) return;
      const shown = bottomOnly
        ? showSurfaceAlone(regionsRef.current, surfaceId, surface.defaultRegion)
        : revealSurface(regionsRef.current, surfaceId, surface.defaultRegion);
      regionsRef.current = shown.arrangement;
      setLastShownRegion(shown.region);
      setRegions(shown.arrangement);
      if (shown.region === 'main') navigateToMainOutlet();
      if (intent) {
        const token = ++surfaceIntentTokenRef.current;
        // The record is exactly what this caller asked for. It used to
        // inherit `session` from whatever record still stood, which made a
        // focus-only intent re-deliver an older session — the same
        // stale-delivery this fix exists to remove, and no caller mints that
        // shape (`App.tsx` passes no intent at all for a sessionless reveal).
        setSurfaceIntents((current) => ({
          ...current,
          [surfaceId]: { ...intent, token },
        }));
        return;
      }
      // A reveal carrying no session is "show me this surface", never "show
      // me what the last link named". Leaving a standing record here would
      // leave it DELIVERABLE: an intent minted while no placement was
      // mounted survives to the next mount, which this reveal is about to
      // cause. Anything still in the outbox by definition reached nobody, so
      // dropping it cannot undo a delivery already made (#928).
      setSurfaceIntents((current) => withoutSurfaceIntent(current, surfaceId));
    },
    [bottomOnly],
  );

  // Counted rather than a boolean: React can commit a replacement host before
  // running the departing one's cleanup, and a boolean would then end up
  // false with a host on screen.
  const registerRegionSurfaceHost = useCallback(() => {
    setMountedSurfaceHosts((count) => count + 1);
    return () => setMountedSurfaceHosts((count) => count - 1);
  }, []);

  const consumeSurfaceIntent = useCallback(
    (surfaceId: string, token: number) => {
      setSurfaceIntents((current) => {
        if (current[surfaceId]?.token !== token) return current;
        return withoutSurfaceIntent(current, surfaceId);
      });
    },
    [],
  );

  useEffect(() => {
    const previous = mirroredRegionsRef.current;
    const diff = dockMirrorDiff(previous, regions);
    const placement = diff.placement;
    if (placement) setDockMode(placement);
    if (diff.visible !== undefined) setDockState(diff.visible, isDockMaximized);
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
    const next = syncRegionArrangementFromDock(
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

  const intentKey = surfaceIntent
    ? `${surfaceIntent.surfaceId}|${surfaceIntent.sessionId ?? ''}|${surfaceIntent.focus ?? ''}`
    : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the stable string key prevents replaceState reparses from adopting the same intent twice.
  useEffect(() => {
    if (!intentKey || !surfaceIntent) {
      adoptedIntentKeyRef.current = null;
      return;
    }
    if (adoptedIntentKeyRef.current === intentKey) return;
    adoptedIntentKeyRef.current = intentKey;
    if (REGION_SURFACE_REGISTRY.has(surfaceIntent.surfaceId)) {
      // A sessionless link (`activityDeepLink()` with no session mints a bare
      // `/?surface=activity`) must reveal the surface WITHOUT an intent: an
      // intent object mints a token, which the next mounted placement reads as
      // a fresh instruction. Passing none is what makes `showSurface` clear an
      // undelivered record instead. Same shape as App.tsx's `navigateToView`.
      showSurface(
        surfaceIntent.surfaceId,
        surfaceIntent.sessionId
          ? { session: surfaceIntent.sessionId, focus: surfaceIntent.focus }
          : undefined,
      );
    }
    updateParams(clearSurfaceDeepLinkParams());
  }, [intentKey]);

  const value = useMemo(
    () => ({
      regions,
      lastShownRegion,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion,
      placeSurface,
      showSurface,
      surfaceIntents,
      consumeSurfaceIntent,
      canRenderRegionSurfaces: mountedSurfaceHosts > 0,
      registerRegionSurfaceHost,
    }),
    [
      regions,
      lastShownRegion,
      setRegion,
      placeSurface,
      showSurface,
      surfaceIntents,
      consumeSurfaceIntent,
      mountedSurfaceHosts,
      registerRegionSurfaceHost,
    ],
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
