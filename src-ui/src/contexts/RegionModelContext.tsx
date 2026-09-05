import type {
  DeviceSettings,
  RegionArrangementRecord,
} from '@kontourai/station-contracts/device-settings';
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
  isDefaultRegionArrangementRecord,
  parseRegionArrangementRecord,
  regionArrangementRecordsEqual,
  toRegionArrangementRecord,
} from '../regions/region-arrangement-record';
import {
  chatRegion,
  DOCK_REGION_IDS,
  type DockRegionId,
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

/**
 * Trailing-edge coalescing window for the `regionArrangement` write (#928 D).
 * A drag resolves to one `setRegion` today, but a toggle-and-place burst is
 * several writes in one frame; one record lands per burst, holding the
 * latest state at the moment the timer fires. A `pagehide` flush covers the
 * tab closing inside the window.
 */
const REGION_ARRANGEMENT_PERSIST_DELAY_MS = 150;

/**
 * Where the arrangement starts (#928 D). Precedence, highest first:
 *
 * 1. URL and navigation for Chat (`dock`, `dockSlotPlacement`, then the
 *    `dockSlotPlacement` device setting) — applied through the same
 *    `syncRegionArrangementFromDock` the legacy seed uses, so a deep link
 *    still wins over what the record says about Chat.
 * 2. The `regionArrangement` record, for every other surface, every size and
 *    every visibility. A record equal to the registry default is one this
 *    device has never written, and reads as absent.
 * 3. The legacy dock seed (`chatDockHeight`/`chatDockWidth` plus Chat's
 *    navigation state), which is all an older device has.
 */
function initialRegionArrangement(
  settings: DeviceSettings,
  dockMode: DockRegionId,
  isDockOpen: boolean,
): RegionArrangement {
  const stored = parseRegionArrangementRecord(settings.regionArrangement);
  if (
    stored &&
    !isDefaultRegionArrangementRecord(toRegionArrangementRecord(stored))
  ) {
    return syncRegionArrangementFromDock(
      stored,
      settings,
      isDockOpen,
      dockMode,
    );
  }
  return seedRegionArrangementFromDock(settings, dockMode, isDockOpen);
}

function recordOf(value: unknown): RegionArrangementRecord | null {
  const parsed = parseRegionArrangementRecord(value);
  return parsed ? toRegionArrangementRecord(parsed) : null;
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
  const [regions, setRegions] = useState<RegionArrangement>(() =>
    initialRegionArrangement(settings, dockMode, isDockOpen),
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
  // The record this provider last wrote or adopted. Seeded from the mount
  // state rather than from storage, so a mount is never itself a write: what
  // the URL did to Chat at load stays a navigation fact, and a device whose
  // record equals the default keeps holding the default until the user
  // changes something.
  const persistedRecordRef = useRef<RegionArrangementRecord | null>(null);
  if (persistedRecordRef.current === null)
    persistedRecordRef.current = toRegionArrangementRecord(regions);
  // The stored record as last seen, canonicalized (null when unparseable).
  // Compared by CONTENT, not identity: the store re-materializes every value
  // from JSON on any setting's write, so an unrelated write hands this
  // provider an equal record under a new reference.
  const seenStoredRecordRef = useRef<
    RegionArrangementRecord | null | undefined
  >(undefined);
  if (seenStoredRecordRef.current === undefined)
    seenStoredRecordRef.current = recordOf(settings.regionArrangement);

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

  const persistRegionArrangement = useCallback(() => {
    const latest = toRegionArrangementRecord(regionsRef.current);
    if (
      persistedRecordRef.current &&
      regionArrangementRecordsEqual(latest, persistedRecordRef.current)
    )
      return;
    persistedRecordRef.current = latest;
    setDeviceSetting('regionArrangement', latest);
  }, [setDeviceSetting]);

  // Every arrangement write — `setRegion`, `placeSurface`, `showSurface`, the
  // in-place legacy sync below — lands here through `regions`, and one record
  // is written per burst on the trailing edge (#928 D).
  useEffect(() => {
    if (
      persistedRecordRef.current &&
      regionArrangementRecordsEqual(
        toRegionArrangementRecord(regions),
        persistedRecordRef.current,
      )
    )
      return;
    const timer = window.setTimeout(
      persistRegionArrangement,
      REGION_ARRANGEMENT_PERSIST_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [regions, persistRegionArrangement]);

  useEffect(() => {
    window.addEventListener('pagehide', persistRegionArrangement);
    return () =>
      window.removeEventListener('pagehide', persistRegionArrangement);
  }, [persistRegionArrangement]);

  // Cross-tab adoption (#928 D): another tab's write reaches this one through
  // the store's `storage` listener as a new `settings.regionArrangement`.
  // Adoption is a READ. What this path writes: nothing to the record —
  // `persistedRecordRef` is set to the adopted record first, so the persist
  // effect above sees an already-persisted state and stays silent. The Chat
  // mirror effect below MAY fire (`setDockMode`/`setDockState`/the legacy
  // size keys), which is correct: the other tab's Chat placement is now this
  // tab's too, and navigation must say so.
  useEffect(() => {
    const incoming = recordOf(settings.regionArrangement);
    const seen = seenStoredRecordRef.current;
    if (incoming === null) {
      seenStoredRecordRef.current = null;
      return;
    }
    if (seen && regionArrangementRecordsEqual(incoming, seen)) return;
    seenStoredRecordRef.current = incoming;
    // This tab's own write coming back: the store echoes every `set` to its
    // listeners in the same document, and a `storage` event from another tab
    // can carry a record we wrote a moment ago.
    if (
      regionArrangementRecordsEqual(
        incoming,
        toRegionArrangementRecord(regionsRef.current),
      )
    )
      return;
    if (
      persistedRecordRef.current &&
      regionArrangementRecordsEqual(incoming, persistedRecordRef.current)
    )
      return;
    const adopted = parseRegionArrangementRecord(settings.regionArrangement);
    if (!adopted) return;
    persistedRecordRef.current = incoming;
    regionsRef.current = adopted;
    setRegions(adopted);
  }, [settings.regionArrangement]);

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
