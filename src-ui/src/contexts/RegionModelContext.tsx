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
import {
  DIALOG_HISTORY_KEY,
  registerDialogHistory,
} from '../components/dialog-history';
import {
  availablePlacements,
  dockFoldsToOneRegion,
  useDockSlotDevice,
  useIsMobile,
} from '../hooks/useIsMobile';
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
  endPhonePaneLayerInPlace,
  isDockRegion,
  moveRegionPanes as moveRegionPanesInArrangement,
  occupiedRegion,
  openPhonePaneLayer,
  type PhonePaneLayer,
  placeSurface as placeSurfaceInArrangement,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
  type RegionId,
  type RegionState,
  removeRegionPane,
  resolveRegionSurface,
  restorePhonePaneLayer,
  revealSurface,
  seedRegionArrangementFromDock,
  selectRegionPane,
  showSurfaceAlone,
  surfaceMayOccupy,
  syncRegionArrangementFromDock,
  toggleSurface as toggleSurfaceInArrangement,
  updateRegion,
} from '../regions/region-model';
import { normalizeDockMode } from '../types';
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

/**
 * What a caller may ask of `openInRegion` (#2048). `region` names a target;
 * absent, the surface's own rule applies (its default region, the first free
 * dock region when that one is taken — `revealSurface`). `placement` is the
 * host-open vocabulary (`WorkspacePaneHostOpenPlacement`); a region holds one
 * tab group in this batch, so only `add` opens and `split` is refused rather
 * than silently added. `focusExisting` (default true) reveals a pane already
 * in some region WHERE IT IS — but it never overrides an explicit `region`:
 * naming a different one MOVES the pane there (the reveal branch requires
 * `region` to be absent or the region the pane is already in). So pressing a
 * region's "+" for a singleton surface held elsewhere takes it from the
 * other region. `focusExisting: false` changes one case only: a held pane
 * targeting the region it is already in is re-placed rather than revealed.
 * With no target it is the surface's own rule either way.
 */
export interface OpenInRegionOptions {
  region?: RegionId;
  placement?: 'add' | 'split';
  focusExisting?: boolean;
}

/**
 * Why `openInRegion` did not place (#2048), each derived from the branch that
 * produced it: `no-surface` — the instance is no region surface's canonical
 * pane, or the id is neither a registered surface nor one an instance prefix
 * describes (#2049); `unsupported-placement` —
 * `split` asked of a tab-group region; `region-unavailable` — a dock region
 * this device's fold does not offer (a side region on a bottom-only device);
 * `refused` — the surface does not declare the region (`surfaceMayOccupy`).
 * A refusal changes no state and navigates nowhere.
 */
export type OpenInRegionRefusal =
  | 'no-surface'
  | 'unsupported-placement'
  | 'region-unavailable'
  | 'refused';

export type OpenInRegionOutcome =
  | {
      readonly ok: true;
      readonly region: RegionId;
      readonly surfaceId: string;
      /** The pane was already in `region` and was revealed there. */
      readonly existing: boolean;
    }
  | { readonly ok: false; readonly reason: OpenInRegionRefusal };

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
  /**
   * Place a surface (`placeSurface` in region-model.ts, #2046 2a): into a
   * dock region it joins the panes there, selected; into `main` it replaces;
   * into a region already holding it, it is selected and the region shown.
   */
  placeSurface(surfaceId: string, regionId: RegionId): void;
  /**
   * Reveal a surface where it is — its region shown and its tab selected —
   * or place it where it belongs (`revealSurface`/`showSurfaceAlone`): the
   * surface-keyed form of `openInRegion` with no options, plus the intent
   * outbox. Since #2048 it is `openSurfaceInRegion` underneath.
   */
  showSurface(surfaceId: string, intent?: SurfaceIntent): void;
  /**
   * Open a surface in a dock region (#2048): the model half of
   * `openInRegion` (`useOpenInRegion.ts`), which is the one producer callers
   * use for a cross-region open so that no caller reaches a region host's
   * own open action and reproduces the model's placement rules. Resolves the
   * target region (explicit, else the surface's rule), reveals it and places
   * or selects through the model — the host derives its document from the
   * arrangement, so a placement IS the open. Never a history entry: a dock
   * region's selection is the record's, and `main` is reached by the same
   * outlet navigation `placeSurface` makes. Returns a typed outcome; a
   * refusal leaves the arrangement as it was.
   *
   * Surface-keyed here, instance-keyed in `useOpenInRegion`: the instance →
   * surface fold (`regionSurfaceOfPane`) needs the pane contracts, which are
   * not in this provider's entry chunk — importing them here measured
   * +1,820 B gzip against a 527 B headroom — and `showSurface` needs the
   * surface form anyway (a projectless coding surface has no instance).
   */
  openSurfaceInRegion(
    surfaceId: string,
    options?: OpenInRegionOptions,
  ): OpenInRegionOutcome;
  /**
   * Select a pane the region holds (#2046 2a): it becomes the region's
   * `occupant`, the pane `RegionPaneHost` shows. Places nothing and changes
   * no visibility; a surface the region does not hold is ignored.
   */
  selectPane(regionId: RegionId, surfaceId: string): void;
  /**
   * Close a pane's tab (#2046 2b, `removeRegionPane`): the surface leaves the
   * region and is placed nowhere; the region keeps its other panes. A
   * surface the region does not hold is ignored.
   */
  removePane(regionId: RegionId, surfaceId: string): void;
  /**
   * Move a dock region's whole pane set — tab order and selection — into
   * another dock region (#2046 2b, `moveRegionPanes`): the region bar's
   * placement control. The destination is shown and becomes the last shown
   * region.
   */
  moveRegionPanes(from: DockRegionId, to: DockRegionId): void;
  /**
   * The surface's toggle — its chord, its row in the folded Regions menu, its
   * dock control's show/hide half. Decided once here, by the pure
   * `toggleSurface` in region-model.ts (#1523): a dock occupant's region is
   * hidden or revealed (the coarse fold rule included); a `main` occupant
   * returns to its default dock region, leaving Home in `main`; an unplaced
   * surface is shown. No caller carries its own copy of these rules (#1420).
   */
  toggleSurface(surfaceId: string): void;
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
  /**
   * The pane open OVER Chat on a bottom-only device, if any (the phone
   * layer, `openPhonePaneLayer`): which region and which pane, for the
   * region chrome's "‹ Chat" control. Transient; never persisted.
   */
  phoneLayer: { region: DockRegionId; surfaceId: string } | null;
  /**
   * Leave the phone layer — the "‹ Chat" control. Asks the unsaved-changes
   * guards first (`navigationStore.runNavigationGuards`), exactly as Back
   * does, then runs the same restore (`restorePhonePaneLayer`); the layer's history entry
   * is then consumed by its registration's cleanup, which travels back over
   * it because the `?maximize` mirror has already returned the URL to the
   * one the entry was pushed at (see the registration effect).
   */
  closePhoneLayer(): void;
}

/**
 * Gap G1: what Chat's dock looked like before a phone layer, kept for the
 * life of the layer in this tab's session storage. The layer's maximize (and
 * the dock open it may add) ride Chat's `?dock`/`?maximize` URL params, so a
 * reload with a layer open would otherwise come back with Chat maximized and
 * no layer to undo it. The record names the layer's LIVE history entry id
 * (rewritten whenever the layer pushes a new entry); every ending of a layer
 * removes it, and so does the provider unmounting with a layer open. A
 * record found at mount whose entry is exactly the entry being loaded
 * therefore means a reload with that layer open, and the load restores the
 * pre-layer dock state instead of the URL's.
 */
const PHONE_LAYER_PRE_STATE_KEY = 'station.phoneLayer.preLayerDock.v1';

interface PhoneLayerPreState {
  visible: boolean;
  maximized: boolean;
  dockMemory: boolean;
}

interface StoredPhoneLayerPreState extends PhoneLayerPreState {
  /** The `registerDialogHistory` id of the layer's live entry. */
  entry: string;
}

function takePhoneLayerPreState(): PhoneLayerPreState | null {
  try {
    const raw = window.sessionStorage.getItem(PHONE_LAYER_PRE_STATE_KEY);
    if (raw === null) return null;
    window.sessionStorage.removeItem(PHONE_LAYER_PRE_STATE_KEY);
    // Keyed to the layer's live history entry, exactly: only a load ON that
    // entry (a reload with the layer open) is the layer's. Any other load
    // finds a stale record — a tab that unloaded mid-layer and navigated
    // since — and the URL it was given stands.
    const state: unknown = window.history.state;
    const marker =
      state !== null && typeof state === 'object'
        ? (state as Record<string, unknown>)[DIALOG_HISTORY_KEY]
        : undefined;
    const value = JSON.parse(raw) as Partial<StoredPhoneLayerPreState>;
    if (typeof marker !== 'string' || marker !== value.entry) return null;
    return typeof value.visible === 'boolean' &&
      typeof value.maximized === 'boolean' &&
      typeof value.dockMemory === 'boolean'
      ? {
          visible: value.visible,
          maximized: value.maximized,
          dockMemory: value.dockMemory,
        }
      : null;
  } catch {
    return null;
  }
}

function writePhoneLayerPreState(state: StoredPhoneLayerPreState | null) {
  try {
    if (state)
      window.sessionStorage.setItem(
        PHONE_LAYER_PRE_STATE_KEY,
        JSON.stringify(state),
      );
    else window.sessionStorage.removeItem(PHONE_LAYER_PRE_STATE_KEY);
  } catch {
    // Storage unavailable: a reload with a layer open keeps the URL's state,
    // the behaviour before G1.
  }
}

/**
 * The prefix of the layer's `registerDialogHistory` ids
 * (`<prefix>:<load>-<n>`). `<load>` is a per-page-load nonce: a reload keeps
 * the entries (and their markers) an earlier load pushed while its counter
 * starts again, so without it the first layer after a reload could get the
 * very id of the entry it opens on — and `dialog-history` would read Back as
 * "still on my entry" and not close it.
 */
const PHONE_LAYER_HISTORY_ID = 'phone-pane-layer';
const PHONE_LAYER_LOAD_NONCE = Math.random().toString(36).slice(2, 10);

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
 * 1. A URL deep link, for Chat only: `dockSlotPlacement` PLACES Chat there
 *    (`placeSurface`: joining the panes the region holds, selected, since
 *    #2046 2a — nothing is displaced from a dock region any more), and
 *    `dock=open` shows it. Both are Chat's links, so when either CHANGES
 *    the record — places or shows Chat — Chat's tab is selected in the
 *    region it acts on (2a review); a param that merely remembers what the
 *    record holds, the reload case, leaves the record's selection alone.
 *    Read from the URL itself, not from navigation's blended `dockMode`,
 *    which falls back to the device setting.
 * 2. The `regionArrangement` record: every surface's placement, every size,
 *    every visibility — Chat's included when the URL says nothing. A record
 *    equal to the registry default is one this device has never written and
 *    reads as absent, which is what carries a pre-record device's dock
 *    position through the upgrade (its only state is the legacy keys).
 * 3. The legacy dock seed (`chatDockHeight`/`chatDockWidth`, the
 *    `dockSlotPlacement` device setting, navigation's `dock`), which is all
 *    an older device has. Only this path reads the legacy size keys; a record
 *    keeps its own sizes.
 *
 * Maximize follows the same order (#928 slice iii): the URL's `maximize=true`
 * is a Chat deep-link fact and maximizes Chat's region whichever path placed
 * it — with Chat's tab selected there when the maximize is the URL's doing,
 * since a maximized region showing another pane is not what the link named;
 * otherwise the record's own `maximized` (and selection) stands; the legacy
 * seed carries none of its own (navigation's flag IS the URL param).
 *
 * A mount is not a write: nothing here reaches navigation or device settings.
 * A record and legacy keys that disagree are reconciled by the mirror on the
 * next user change (see `mirroredRegionsRef` and `seenNavigationRef`).
 */
function initialRegionArrangement(
  settings: DeviceSettings,
  dockMode: DockRegionId,
  isDockOpen: boolean,
  isDockMaximized: boolean,
): RegionArrangement {
  const arrangement = initialRegionPlacement(settings, dockMode, isDockOpen);
  if (!isDockMaximized) return arrangement;
  const chatAt = chatRegion(arrangement);
  if (!chatAt) return arrangement;
  // `updateRegion` holds the invariants: a hidden Chat stays restored even
  // if a hand-typed URL says `maximize=true` without `dock=open`. A
  // maximize the record already holds is the URL remembering, and the
  // record's selection stands; one the URL adds is Chat's link, and Chat's
  // tab is what it maximizes (see `initialRegionPlacement`).
  const maximized = updateRegion(arrangement, chatAt, { maximized: true });
  return maximized === arrangement
    ? arrangement
    : selectRegionPane(maximized, chatAt, 'chat');
}

function initialRegionPlacement(
  settings: DeviceSettings,
  dockMode: DockRegionId,
  isDockOpen: boolean,
): RegionArrangement {
  const stored = parseRegionArrangementRecord(settings.regionArrangement);
  if (
    !stored ||
    isDefaultRegionArrangementRecord(toRegionArrangementRecord(stored))
  ) {
    return seedRegionArrangementFromDock(settings, dockMode, isDockOpen);
  }
  const linkedPlacement = normalizeDockMode(
    new URLSearchParams(window.location.search).get('dockSlotPlacement'),
  );
  const chatAt = chatRegion(stored);
  // `isDockOpen` is a URL fact (`dock=open`; navigation-store.ts), so an
  // absent param defers to the record's own visibility for Chat.
  const chatVisible = isDockOpen || (chatAt ? stored[chatAt].visible : false);
  // The URL's Chat params persist across reloads (`setDockMode` and
  // `setDockState` write them), so at load they are usually the URL
  // REMEMBERING what the record already holds. Only a param that changes
  // Chat's placement or visibility is acting as a link — and a link names
  // Chat, so Chat's tab is what it shows (#2046 2b, 2a review); a param that
  // changes nothing leaves the record's selection, which is the user's last
  // tab choice, alone. A placement naming the region Chat is already in is
  // therefore not re-placed (`placeSurface` would select it), only shown.
  let next = stored;
  if (linkedPlacement && chatAt !== linkedPlacement) {
    next = placeSurfaceInArrangement(
      stored,
      'chat',
      linkedPlacement,
      chatVisible,
    );
  } else if (isDockOpen) {
    next = chatAt
      ? updateRegion(stored, chatAt, { visible: true })
      : placeSurfaceInArrangement(stored, 'chat', dockMode, true);
  }
  if (next === stored) return stored;
  const placed = chatRegion(next);
  return placed ? selectRegionPane(next, placed, 'chat') : next;
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
  const available = availablePlacements(useDockSlotDevice());
  const bottomOnly = dockFoldsToOneRegion(available);
  // Phone-sized, not merely folded: a phone layer maximizes its region so the
  // pane reads full screen; a wide coarse device keeps the region's size.
  const isMobile = useIsMobile();
  const { setDeviceSetting } = useDeviceSettingsActions();
  // A reload that happened with a phone layer open (gap G1): the URL's
  // Chat params are the layer's, so the load starts from the pre-layer ones
  // and the mount effect below writes them back to navigation.
  const [reloadedOverLayer] = useState(takePhoneLayerPreState);
  const [regions, setRegions] = useState<RegionArrangement>(() =>
    initialRegionArrangement(
      settings,
      dockMode,
      reloadedOverLayer ? reloadedOverLayer.visible : isDockOpen,
      reloadedOverLayer ? reloadedOverLayer.maximized : isDockMaximized,
    ),
  );
  const [lastShownRegion, setLastShownRegion] = useState<RegionId | null>(
    () => chatRegion(regions) ?? null,
  );
  const lastShownRegionRef = useRef(lastShownRegion);
  lastShownRegionRef.current = lastShownRegion;
  const [surfaceIntents, setSurfaceIntents] = useState<SurfaceIntents>({});
  const [mountedSurfaceHosts, setMountedSurfaceHosts] = useState(0);
  const surfaceIntentTokenRef = useRef(0);
  const adoptedIntentKeyRef = useRef<string | null>(null);
  // The phone layer (`openPhonePaneLayer`). A ref beside the state for the
  // same reason `regionsRef` is: opens and restores read the latest value
  // inside one event, before React re-renders.
  const [phoneLayer, setPhoneLayerState] = useState<PhonePaneLayer | null>(
    null,
  );
  const phoneLayerRef = useRef<PhonePaneLayer | null>(null);
  const layerDockMemoryRef = useRef(false);
  // Set by a layer's restore, applied at the end of the mirror effect.
  const pendingDockMemoryRef = useRef<boolean | null>(null);
  // Whether the open layer maximized its region, so a Back the user cancels
  // can put the layer back exactly as it was.
  const layerMaximizedRef = useRef(false);
  // Bumped per layer and per re-pushed entry: each history entry gets its own
  // id, so the marker `dialog-history` orphans on a Back can never match a
  // LATER layer's live entry and skip it.
  const layerEntryRef = useRef(0);
  // The live entry's unregister. A layer's first entry is registered by the
  // effect below; a Back's reinstatement registers the next one
  // SYNCHRONOUSLY, inside the popstate that asked (gap G3), so a second Back
  // queued in the same tick lands on it rather than on the page before.
  const layerHistoryRef = useRef<(() => void) | null>(null);
  const leavePhoneLayerByBackRef = useRef<() => void>(() => {});
  // The open layer's pre-layer dock state (gap G1), stored against each
  // entry the layer registers.
  const layerPreStateRef = useRef<PhoneLayerPreState | null>(null);
  const registerLayerEntry = useCallback(() => {
    const entry = `${PHONE_LAYER_HISTORY_ID}:${PHONE_LAYER_LOAD_NONCE}-${layerEntryRef.current}`;
    layerHistoryRef.current = registerDialogHistory(entry, () =>
      leavePhoneLayerByBackRef.current(),
    );
    if (layerPreStateRef.current)
      writePhoneLayerPreState({ ...layerPreStateRef.current, entry });
  }, []);
  // `toggleSurface` is declared above the layer's exits; it reaches the
  // current one through this.
  const closePhoneLayerRef = useRef<() => void>(() => {});
  // The Back an unsaved-changes guard is deciding, if any
  // (`leavePhoneLayerByBack`). While set, the layer is reinstated and neither
  // navigation's inbound sync nor the dismissal effect may act on it.
  const layerBackDecisionRef = useRef<object | null>(null);
  const setPhoneLayer = useCallback((layer: PhonePaneLayer | null) => {
    phoneLayerRef.current = layer;
    // Whatever ends a layer ends any Back decision about it. A guard that
    // never answers (its component unmounted with the prompt up) would
    // otherwise leave the decision set for the session, and navigation's
    // inbound sync and the dismissal effect both stand down while it is.
    if (!layer) {
      layerBackDecisionRef.current = null;
      layerPreStateRef.current = null;
      writePhoneLayerPreState(null);
    }
    setPhoneLayerState(layer);
  }, []);
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
  // Navigation as last acted on. The legacy-sync effect below runs on the
  // dependency change React reports, and a MOUNT is one of those; only a
  // change since this snapshot is an inbound navigation event. Without it, a
  // record whose Chat placement disagrees with the legacy keys would be
  // "corrected" at mount — and `setDockMode` would write the device setting
  // before the user touched anything.
  const seenNavigationRef = useRef({ dockMode, isDockOpen, isDockMaximized });

  const setRegion = useCallback((id: RegionId, patch: Partial<RegionState>) => {
    const next = updateRegion(regionsRef.current, id, patch);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    if (patch.visible === true) setLastShownRegion(id);
    setRegions(next);
  }, []);

  /**
   * Apply an arrangement a reveal or open produced: the fold's last shown
   * region follows it, and a landing in `main` navigates to the outlet.
   */
  const commit = useCallback((next: RegionArrangement, region: RegionId) => {
    regionsRef.current = next;
    setLastShownRegion(region);
    setRegions(next);
    if (region === 'main') navigateToMainOutlet();
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

  const selectPane = useCallback((regionId: RegionId, surfaceId: string) => {
    const next = selectRegionPane(regionsRef.current, regionId, surfaceId);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    setRegions(next);
  }, []);

  const removePane = useCallback((regionId: RegionId, surfaceId: string) => {
    const next = removeRegionPane(regionsRef.current, regionId, surfaceId);
    if (next === regionsRef.current) return;
    regionsRef.current = next;
    setRegions(next);
  }, []);

  const moveRegionPanes = useCallback(
    (from: DockRegionId, to: DockRegionId) => {
      const next = moveRegionPanesInArrangement(regionsRef.current, from, to);
      if (next === regionsRef.current) return;
      regionsRef.current = next;
      setLastShownRegion(to);
      setRegions(next);
    },
    [],
  );

  const openSurfaceInRegion = useCallback(
    (
      surfaceId: string,
      options: OpenInRegionOptions = {},
    ): OpenInRegionOutcome => {
      // The id-keyed resolution, not the shell registry: an instance-keyed
      // pane (#2049) is a surface its prefix describes, and this is the one
      // gate a link click passes through.
      const surface = resolveRegionSurface(surfaceId);
      if (!surface) return { ok: false, reason: 'no-surface' };
      if (options.placement === 'split')
        return { ok: false, reason: 'unsupported-placement' };
      const current = regionsRef.current;
      const held = occupiedRegion(current, surfaceId);
      const target = options.region;
      // The phone layer: on a bottom-only device, a pane opened with no
      // explicit region — or with a side region the fold does not offer,
      // which used to be refused `region-unavailable` — opens OVER Chat, as
      // a selected tab of Chat's region, with a history entry so Back
      // returns to the conversation. `main` keeps its own rule (a Home
      // reveal, a pane the user put in the primary area), and so does an
      // explicit `bottom`: that is the user placing a pane (#2158), not
      // looking at one.
      const overChat =
        bottomOnly &&
        held !== 'main' &&
        (target === undefined
          ? surface.defaultRegion !== 'main' || held !== undefined
          : isDockRegion(target) &&
            !(available as readonly RegionId[]).includes(target));
      if (overChat) {
        const opened = openPhonePaneLayer(current, surfaceId, {
          lastShownRegion: lastShownRegionRef.current,
          maximize: isMobile,
          layer: phoneLayerRef.current,
        });
        if (opened) {
          // The maximize memory as the layer found it: the layer's own
          // maximize is mirrored into it, and a close from a hidden Chat
          // would otherwise forward that as the memory (see the restore).
          if (!phoneLayerRef.current) {
            layerDockMemoryRef.current = navigationStore.lastDockMaximized;
            layerEntryRef.current += 1;
            const chatAt = chatRegion(current);
            layerPreStateRef.current = {
              visible: chatAt ? current[chatAt].visible : false,
              maximized: chatAt ? current[chatAt].maximized : false,
              dockMemory: navigationStore.lastDockMaximized,
            };
          }
          layerMaximizedRef.current =
            opened.arrangement[opened.layer.region].maximized;
          commit(opened.arrangement, opened.layer.region);
          setPhoneLayer(opened.layer);
          return {
            ok: true,
            region: opened.layer.region,
            surfaceId,
            existing: held !== undefined,
          };
        }
      }
      // Already open somewhere, and not asked to go elsewhere: reveal it
      // there (region shown, tab selected) rather than opening a second time.
      if (
        held !== undefined &&
        options.focusExisting !== false &&
        (target === undefined || target === held)
      ) {
        const shown = bottomOnly
          ? showSurfaceAlone(current, surfaceId, held)
          : revealSurface(current, surfaceId, held);
        commit(shown.arrangement, shown.region);
        return { ok: true, region: shown.region, surfaceId, existing: true };
      }
      if (target !== undefined) {
        if (!surfaceMayOccupy(surfaceId, target))
          return { ok: false, reason: 'refused' };
        if (
          isDockRegion(target) &&
          !(available as readonly RegionId[]).includes(target)
        )
          return { ok: false, reason: 'region-unavailable' };
        let next = placeSurfaceInArrangement(current, surfaceId, target);
        if (bottomOnly && isDockRegion(target))
          for (const id of DOCK_REGION_IDS)
            if (id !== target)
              next = updateRegion(next, id, { visible: false });
        commit(next, target);
        return { ok: true, region: target, surfaceId, existing: false };
      }
      // No target: the surface's own rule — its region if it has one, else
      // its default (the first free dock region when that is taken); on a
      // bottom-only device the revealed region becomes the only visible one.
      const shown = bottomOnly
        ? showSurfaceAlone(current, surfaceId, surface.defaultRegion)
        : revealSurface(current, surfaceId, surface.defaultRegion);
      commit(shown.arrangement, shown.region);
      return {
        ok: true,
        region: shown.region,
        surfaceId,
        existing: held !== undefined,
      };
    },
    [available, bottomOnly, commit, isMobile, setPhoneLayer],
  );

  const showSurface = useCallback(
    (surfaceId: string, intent?: SurfaceIntent) => {
      const opened = openSurfaceInRegion(surfaceId);
      // An unregistered id was never a reveal; the intent outbox is left
      // alone for it, as before #2048.
      if (!opened.ok) return;
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
    [openSurfaceInRegion],
  );

  const toggleSurface = useCallback(
    (surfaceId: string) => {
      // Resolved, not registry-read: the folded Regions menu renders a
      // Hide/Show row for every pane a region HOLDS, instance-keyed ones
      // included, and a row whose toggle is a no-op would be a control that
      // says it does something it does not.
      const surface = resolveRegionSurface(surfaceId);
      if (!surface) return;
      // "Hide <pane>" for the pane a phone layer is showing is the way back
      // to Chat, not a hide of Chat's region: the toggle rule would hide the
      // whole folded region, Chat with it.
      const layer = phoneLayerRef.current;
      const layerRegion = layer ? regionsRef.current[layer.region] : null;
      if (
        layer?.surfaceId === surfaceId &&
        layerRegion?.visible &&
        layerRegion.occupant === surfaceId
      ) {
        closePhoneLayerRef.current();
        return;
      }
      const toggled = toggleSurfaceInArrangement(
        regionsRef.current,
        surfaceId,
        surface.defaultRegion,
        { lastShownRegion, bottomOnly },
      );
      if (toggled.kind === 'none') return;
      if (toggled.kind === 'show') {
        // Showing is `showSurface`'s: it owns the unplaced landing, the
        // coarse show-alone fold and the `main` navigation.
        showSurface(surfaceId);
        return;
      }
      regionsRef.current = toggled.arrangement;
      if (toggled.shownRegion) setLastShownRegion(toggled.shownRegion);
      setRegions(toggled.arrangement);
    },
    [bottomOnly, lastShownRegion, showSurface],
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

  // The way back from a phone layer (`restorePhonePaneLayer`): Back's
  // `close`, the "‹ Chat" control (`closePhoneLayer`), and the dismissal
  // effect below.
  const restorePhoneLayer = useCallback(() => {
    const layer = phoneLayerRef.current;
    if (!layer) return;
    setPhoneLayer(null);
    const current = regionsRef.current;
    const next = restorePhonePaneLayer(current, layer);
    // The layer's maximize was mirrored into `lastDockMaximized`, and the
    // way back writes it again whichever exit ran: "‹ Chat" through the
    // mirror's restore write, a hidden Chat through the archive#945 close
    // rule (the maximize a region closes FROM — the layer's own), Back not at
    // all. None of those is the user's. The memory the layer found is put
    // back AFTER the mirror has written (see the end of the mirror effect),
    // so every exit leaves it the same.
    if (next === current) {
      navigationStore.lastDockMaximized = layerDockMemoryRef.current;
      return;
    }
    pendingDockMemoryRef.current = layerDockMemoryRef.current;
    regionsRef.current = next;
    setRegions(next);
  }, [setPhoneLayer]);

  // Anything else that takes the layer's pane off screen — "Show Chat" in the
  // folded menu, the tab closed, the region hidden, another tab adopting a
  // record — dismisses the layer: the tab it minted goes, and its history
  // entry is consumed by the registration's cleanup below.
  useEffect(() => {
    const layer = phoneLayerRef.current;
    if (!layer || layer !== phoneLayer || layerBackDecisionRef.current) return;
    const state = regions[layer.region];
    if (state.visible && state.occupant === layer.surfaceId) return;
    restorePhoneLayer();
  }, [phoneLayer, regions, restorePhoneLayer]);

  // The layer is a bottom-only device's (review M3): when the fold opens (a
  // narrow window widened, split view resized) the layer ENDS where it
  // stands (`endPhonePaneLayerInPlace`). A pane the layer moved out of
  // another region goes back there — shown and selected if the reader was
  // looking at it — unless its own unsaved-changes guard is registered
  // (dirty): the move remounts the pane, so a dirty one stays where it is,
  // an ordinary tab of Chat's region (gap G4). The maximize the layer added
  // is undone, and the arrangement that results is the one saved. The
  // history entry goes with the registration.
  useEffect(() => {
    if (bottomOnly) return;
    const layer = phoneLayerRef.current;
    if (!layer) return;
    setPhoneLayer(null);
    const next = endPhonePaneLayerInPlace(regionsRef.current, layer, {
      returnToOrigin: !navigationStore.hasNavigationGuard(layer.surfaceId),
    });
    if (next === regionsRef.current) {
      navigationStore.lastDockMaximized = layerDockMemoryRef.current;
      return;
    }
    pendingDockMemoryRef.current = layerDockMemoryRef.current;
    regionsRef.current = next;
    setRegions(next);
  }, [bottomOnly, setPhoneLayer]);

  // One history entry per layer, not per pane: a replacement keeps the entry
  // (the effect is keyed on whether a layer is open), so one Back returns to
  // Chat however many panes were opened over it. DECLARED BEFORE the mirror
  // effect below on purpose: effects run in declaration order within a
  // commit, so the marker is pushed at the pre-layer URL and the mirror's
  // `?maximize=true` then lands on the marker entry by `replaceState`. Back
  // therefore travels to the entry without it; and on an in-app close the
  // mirror's clearing write lands before `dialog-history`'s deferred cleanup
  // compares URLs, so the entry is travelled back over, not collapsed.
  //
  // Every deliberate exit — Back, "‹ Chat" (`closePhoneLayer`), the folded
  // menu's hide of the layer's pane, a chat-focus intent — asks the
  // unsaved-changes guards first (a pull request review draft is component
  // state; the restore unmounts it). Only the layer pane's own guards are
  // asked (`owner`: the region host scopes each pane's `useUnsavedGuard` to
  // its surface through `UnsavedGuardOwnerContext`), so an unrelated dirty
  // form elsewhere neither prompts nor decides whether the layer closes. Back has already left the entry when it
  // asks; `leavePhoneLayerByBack` keeps the layer as it was while the guard
  // decides.
  const phoneLayerOpen = phoneLayer !== null;
  const leavePhoneLayerByBack = useCallback(() => {
    const layer = phoneLayerRef.current;
    if (!layer) return;
    // One decision at a time: a second Back while the prompt is up starts a
    // new one, and the guard cancels the first (`useUnsavedGuard`), whose
    // answer must then change nothing.
    const decision = {};
    layerBackDecisionRef.current = decision;
    const current = () => layerBackDecisionRef.current === decision;
    let reinstated = false;
    // Back has already left the layer's entry and dropped `?maximize` from
    // the URL. While the guard decides, the layer stays exactly as it was —
    // shown, selected, maximized — under a fresh entry, so the prompt sits
    // over the pane the user sees and a second Back lands on that entry
    // rather than on the page before the layer. The mirror is handed the
    // popped state so it writes the layer's view back onto the new entry;
    // navigation's inbound sync is held off meanwhile (see that effect).
    const reinstate = () => {
      reinstated = true;
      const nav = navigationStore.getSnapshot();
      mirroredRegionsRef.current = updateRegion(
        regionsRef.current,
        layer.region,
        { visible: nav.isDockOpen, maximized: false },
      );
      const next = updateRegion(regionsRef.current, layer.region, {
        visible: true,
        occupant: layer.surfaceId,
        maximized: layerMaximizedRef.current,
      });
      regionsRef.current = next;
      setRegions(next);
      layerHistoryRef.current?.();
      layerEntryRef.current += 1;
      registerLayerEntry();
    };
    navigationStore.runNavigationGuards(
      () => {
        if (!current()) return;
        layerBackDecisionRef.current = null;
        // Discard: the in-app restore; the registration's cleanup travels
        // back over the reinstated entry, if there is one.
        restorePhoneLayer();
      },
      () => {
        if (!current()) return;
        layerBackDecisionRef.current = null;
        if (!reinstated) reinstate();
      },
      // The layer's pane's guards only — not every dirty form in the app.
      { owner: layer.surfaceId },
    );
    if (current() && !reinstated) reinstate();
  }, [registerLayerEntry, restorePhoneLayer]);
  leavePhoneLayerByBackRef.current = leavePhoneLayerByBack;
  const closePhoneLayer = useCallback(() => {
    // No layer, nothing to leave — and no guard to ask. Chat-focus intents
    // call this on every device (`useDismissPhoneLayer`), so asking with no
    // layer would put a "Discard?" in front of an unrelated dirty form
    // whose answer changes nothing.
    if (!phoneLayerRef.current) return;
    navigationStore.runNavigationGuards(restorePhoneLayer, undefined, {
      owner: phoneLayerRef.current.surfaceId,
    });
  }, [restorePhoneLayer]);
  closePhoneLayerRef.current = closePhoneLayer;
  useEffect(() => {
    if (!phoneLayerOpen) return;
    registerLayerEntry();
    return () => {
      layerHistoryRef.current?.();
      layerHistoryRef.current = null;
    };
  }, [phoneLayerOpen, registerLayerEntry]);

  const persistRegionArrangement = useCallback(() => {
    // A phone layer is transient: the record is written as if it were not
    // open, so a reload never finds a pane over Chat with no layer (and no
    // tab strip) to take it away again.
    const layer = phoneLayerRef.current;
    const latest = toRegionArrangementRecord(
      layer
        ? restorePhonePaneLayer(regionsRef.current, layer)
        : regionsRef.current,
    );
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
    // The other tab may have hidden or emptied the region this tab last
    // showed; the fold then points at the first dock region still showing
    // something, so the next fold/unfold acts on a region that exists.
    setLastShownRegion((previous) => {
      const stillShown =
        previous !== null &&
        adopted[previous].visible &&
        (previous === 'main' || adopted[previous].occupant !== null);
      if (stillShown) return previous;
      return (
        DOCK_REGION_IDS.find(
          (id) => adopted[id].visible && adopted[id].occupant !== null,
        ) ?? previous
      );
    });
    setRegions(adopted);
  }, [settings.regionArrangement]);

  useEffect(() => {
    const previous = mirroredRegionsRef.current;
    const diff = dockMirrorDiff(previous, regions);
    const placement = diff.placement;
    if (placement) setDockMode(placement);
    // Chat's maximize is the region's (#928 slice iii); navigation's
    // `maximize` param and `lastDockMaximized` are its mirror, written here
    // through the one setter that owns both. A close forwards the maximize
    // the region is closing FROM, so a close from Full keeps the memory
    // (archive#945). A show forwards only a maximize the diff carries (a show
    // that is also a maximize): a hidden region's `maximized` is always false
    // (`updateRegion` clears it with the hide), so forwarding it would set
    // `lastDockMaximized` to false on the very next show and `focusSession`'s
    // `setDockState(true, lastDockMaximized)` would reopen docked (#1563).
    // `setDockState(true, undefined)` leaves the memory alone and does not
    // touch the URL's `maximize` param: every param write that closes the dock
    // clears it (archive#795, station#1613), and a param that arrives without
    // passing a writer (a `?maximize=true` link without `dock=open`) is
    // re-seeded into the region by the inbound effect below, so that Chat
    // opens at Full rather than diverging from the shell. A maximize change
    // navigation already shows — the collapse-on-navigate seam clears the URL
    // param first (`useDockShellChrome.restoreDockToDocked`) precisely so
    // `lastDockMaximized` is left alone (archive#1298) — is not re-written,
    // because `setDockState(open, false)` would overwrite that memory.
    if (diff.visible !== undefined) {
      const previousChat = chatRegion(previous);
      setDockState(
        diff.visible,
        diff.visible
          ? diff.maximized
          : previousChat
            ? previous[previousChat].maximized
            : false,
      );
    } else if (
      diff.maximized !== undefined &&
      diff.maximized !== isDockMaximized
    ) {
      setDockState(true, diff.maximized);
    }
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
    if (pendingDockMemoryRef.current !== null) {
      navigationStore.lastDockMaximized = pendingDockMemoryRef.current;
      pendingDockMemoryRef.current = null;
    }
  }, [isDockMaximized, regions, setDeviceSetting, setDockMode, setDockState]);

  // Gap G1: put navigation back in line with the pre-layer dock state the
  // arrangement was seeded from. A mount is otherwise not a write; this one
  // repairs params the layer left behind, once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once for the state taken at mount.
  useEffect(() => {
    if (!reloadedOverLayer) return;
    setDockState(reloadedOverLayer.visible, reloadedOverLayer.maximized);
    navigationStore.lastDockMaximized = reloadedOverLayer.dockMemory;
  }, []);
  // The provider going away with a layer open (not a reload — a reload runs
  // no cleanup) takes the layer with it, so its pre-layer record goes too.
  useEffect(
    () => () => {
      if (phoneLayerRef.current) writePhoneLayerPreState(null);
    },
    [],
  );

  // Navigation remains an inbound source for deep links and browser history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: device-setting notifications are mirror traffic, not inbound navigation.
  useEffect(() => {
    const seen = seenNavigationRef.current;
    if (
      seen.dockMode === dockMode &&
      seen.isDockOpen === isDockOpen &&
      seen.isDockMaximized === isDockMaximized
    )
      return;
    seenNavigationRef.current = { dockMode, isDockOpen, isDockMaximized };
    // A phone layer's Back is waiting on an unsaved-changes guard: the URL
    // travelled back, but the layer is reinstated until the user answers, so
    // this navigation is not Chat's to act on (`leavePhoneLayerByBack`).
    if (layerBackDecisionRef.current) return;
    const current = regionsRef.current;
    const placement = chatRegion(current);
    let next = current;
    if (
      !(placement === dockMode && current[placement].visible === isDockOpen)
    ) {
      next = syncRegionArrangementFromDock(
        current,
        settings,
        isDockOpen,
        dockMode,
      );
    }
    // Navigation's `maximize` is also inbound (#928 slice iii): a
    // `?maximize=true` link, `focusSession`'s `setDockState(true,
    // lastDockMaximized)` restore and the coding pane's mount all still speak
    // it, and Chat's region is what the shell renders.
    const chatAfterSync = chatRegion(next);
    if (chatAfterSync && next[chatAfterSync].maximized !== isDockMaximized) {
      // A maximize is Chat's: its tab comes to the front of the region it
      // maximizes. A restore leaves the selection alone.
      next = updateRegion(
        next,
        chatAfterSync,
        isDockMaximized
          ? { maximized: true, occupant: 'chat' }
          : { maximized: false },
      );
    }
    if (next === current) return;
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
  }, [dockMode, isDockOpen, isDockMaximized]);

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

  // Never offered off a fold, even for the render before the effect above
  // ends the layer: "‹ Chat" is a bottom-only device's control.
  const phoneLayerView = useMemo(
    () =>
      phoneLayer && bottomOnly
        ? { region: phoneLayer.region, surfaceId: phoneLayer.surfaceId }
        : null,
    [bottomOnly, phoneLayer],
  );
  const value = useMemo(
    () => ({
      regions,
      lastShownRegion,
      surfaces: REGION_SURFACE_REGISTRY,
      setRegion,
      placeSurface,
      showSurface,
      openSurfaceInRegion,
      selectPane,
      removePane,
      moveRegionPanes,
      toggleSurface,
      surfaceIntents,
      consumeSurfaceIntent,
      canRenderRegionSurfaces: mountedSurfaceHosts > 0,
      registerRegionSurfaceHost,
      phoneLayer: phoneLayerView,
      closePhoneLayer,
    }),
    [
      regions,
      lastShownRegion,
      setRegion,
      placeSurface,
      showSurface,
      openSurfaceInRegion,
      selectPane,
      removePane,
      moveRegionPanes,
      toggleSurface,
      surfaceIntents,
      consumeSurfaceIntent,
      mountedSurfaceHosts,
      registerRegionSurfaceHost,
      phoneLayerView,
      closePhoneLayer,
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
