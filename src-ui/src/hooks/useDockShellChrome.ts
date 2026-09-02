import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  DOCK_COLLAPSED_HEIGHT,
  type DockSnap,
  dockSnapPixels,
  readDockSnap,
  shouldRestoreDockOnNavigation,
  snapAfterNavigationRestore,
  writeDockSnap,
} from '../components/chat-dock/dockSnap';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../contexts/DeviceSettingsContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useProjects } from '../contexts/ProjectsContext';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { readToolbarHeight } from '../lib/toolbarGeometry';
import type { DockMode } from '../types';
import {
  type DockSlotGeometry,
  deriveDockSlotGeometry,
} from './dock-slot-geometry';
import { useChatDockVerticalDrag } from './useChatDockVerticalDrag';
import { useDragResize } from './useDragResize';
import { useDockSlotPlacement, useIsMobile } from './useIsMobile';
import { useKeyboardShortcut } from './useKeyboardShortcut';
import { useMobileVisualViewport } from './useMobileVisualViewport';

const MIN_DOCK_HEIGHT = 200;
const MAX_DOCK_HEIGHT_OFFSET = 150;
const MIN_DOCK_WIDTH = 280;
const MAX_DOCK_WIDTH_PERCENT = 0.6;
const DOCK_WHEN = { not: 'composerFocused' } as const;

function clampDockHeight(value: number): number {
  return Math.max(
    MIN_DOCK_HEIGHT,
    Math.min(value, window.innerHeight - MAX_DOCK_HEIGHT_OFFSET),
  );
}

function clampDockWidth(value: number): number {
  return Math.max(
    MIN_DOCK_WIDTH,
    Math.min(value, window.innerWidth * MAX_DOCK_WIDTH_PERCENT),
  );
}

export interface DockShellChrome {
  isDockOpen: boolean;
  isDockMaximized: boolean;
  dockMode: DockMode;
  dockHeight: number;
  dockWidth: number;
  setDockHeight: (value: number) => void;
  setDockWidth: (value: number) => void;
  previousDockHeight: number;
  setPreviousDockHeight: (value: number) => void;
  previousDockOpen: boolean;
  setPreviousDockOpen: (value: boolean) => void;
  isDragging: boolean;
  setIsDragging: (value: boolean) => void;
  dockSnap: DockSnap;
  liveDragHeight: number | null;
  setLiveDragHeight: (value: number | null) => void;
  /**
   * A drag that starts from Collapsed previews the real body at the live
   * pointer height without committing the open/half navigation state — the
   * release snap is the only owner of that transition. Derived once here
   * (archive#4460) so `DockShell` and a docked occupant's own
   * rendering (file-drop enablement, its `resetKey`) read the SAME value
   * instead of two independent `!isDockOpen && liveDragHeight !== null`
   * computations that could disagree mid-render.
   */
  isCollapsedDragPreview: boolean;
  toolbarHeight: number;
  collapsedHeight: number;
  isMobile: boolean;
  visualViewport: ReturnType<typeof useMobileVisualViewport>;
  availableDockSlotPlacements: readonly DockMode[];
  effectiveDockSlotPlacement: DockMode;
  applyDockSnap: (next: DockSnap) => void;
  commitDesktopBottomHeight: (height: number) => void;
  commitDockPlacement: (mode: DockMode) => void;
  /**
   * Restores a maximized dock to its docked size — the archive#869 navigation
   * escape hatch. Exposed so a caller can invoke it explicitly at a
   * navigation seam this hook's own pathname-watching effect cannot see
   * (e.g. a route change with no pathname delta, only a query change).
   */
  restoreDockToDocked: () => void;
  /** Side-panel (left/right) width drag. */
  onSidePanelResizePointerDown: (
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  /** The mobile header's own drag-to-resize surface. */
  onMobileHeaderDragPointerDown: (
    event: React.PointerEvent<HTMLElement>,
  ) => void;
  onMobileHeaderDragClickCapture: (
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  /**
   * archive#4525: the dock's own remembered project binding — the single
   * source of truth an occupant (Chat, and anything else project-specific)
   * CONSUMES rather than derives from its own, remounting, local state. See
   * `setActiveProjectSlug`'s doc for the update contract.
   */
  activeProjectSlug: string | null;
  /**
   * Binds (or clears, via `null`) the dock's remembered project. Persisted
   * (`chatDockProjectSlug`, mirroring `chatDockHeight`/`chatDockWidth`) so it
   * survives a reload, and owned by this hook's one ambient instance
   * (`DockShell`) so it survives an occupant switch — the exact remount that
   * used to reset a session-derived badge to "No project" (archive#4525
   * Phase 1). Intended callers: an explicit project-switcher pick (archive#4524),
   * a new chat that carries its own explicit project, and this hook's own
   * project-deletion cleanup below. Never call this merely because the
   * active session is momentarily unknown (a remount, a reconnect race) —
   * that is exactly the reset this binding exists to stop.
   */
  setActiveProjectSlug: (slug: string | null) => void;
}

/**
 * The single owner of dock CHROME — geometry, snap state, placement,
 * drag/resize wiring and the dock.maximize shortcut. Every
 * occupant of the ambient dock (Chat, Home, Activity) reads the SAME instance
 * through `DockShell`; a full-screen Chat placement (`ChatWorkspacePane`
 * outside the ambient dock) gets its own independent instance so cmd+D /
 * cmd+M keep working there too.
 *
 * This absorbs what `useChatDockState` used to own for geometry/dragging —
 * moved here so it survives an ambient OCCUPANT SWITCH (Chat unmounting in
 * favor of Home does not reset this hook, because it is called by the
 * persistent `DockShell`, not by the occupant). `useChatDockState` keeps only
 * occupant-owned display preferences (font size, reasoning/tool-details,
 * auto-hide) that have no meaning outside a Chat pane.
 *
 * `publishesDockSlotClearance` mirrors the flag `useChatDockState` used to
 * take: true for the one ambient mount that reserves route space via
 * `onGeometryChange`, false for the fullscreen placement (which lives inside
 * its own route layout and has nothing to clear).
 *
 * `registersDockShortcuts` (archive#4460): a DOCKED
 * `ChatWorkspacePane` STILL calls this hook once locally (rules of hooks
 * forbid calling it conditionally), even though `DockShell` already owns the
 * real registration for that render — that local call must NOT also register
 * `dock.maximize`, or the shortcut registry (last-register-wins,
 * mount-order-only `useLayoutEffect`s) can end up dispatching through the
 * dead local closure after an occupant switch away and back, silently
 * desyncing from `DockShell`'s actual state. The ambient dock and a
 * full-screen `ChatWorkspacePane` are NOT mutually exclusive — a
 * `workspace-pane` route can render its own full-screen Chat pane while the
 * ambient dock (docked to any occupant) stays mounted alongside it — so both
 * a `DockShell` instance and a full-screen instance can legitimately want to
 * register at once. What matters is that a DOCKED Chat's OWN local instance
 * never does.
 */
export function useDockShellChrome({
  publishesDockSlotClearance,
  registersDockShortcuts,
  onGeometryChange,
}: {
  /**
   * Whether this instance reserves route space by publishing
   * `--dock-slot-size` (via `onGeometryChange`).
   *
   * Required, and deliberately not optional (archive#3972). Exactly ONE
   * mount may publish it: the ambient shell (`DockShell`), which sits over
   * the routes. A full-screen Chat placement is INSIDE the layout, so it has
   * nothing to clear — and when it published anyway,
   * `/projects/<p>/layouts/chat` reserved 320px for a dock that was not
   * there. A default here would decide that for a caller that never thought
   * about it, and the safe answer is not the common one; every mount states
   * it explicitly.
   */
  publishesDockSlotClearance: boolean;
  /** See the `registersDockShortcuts` paragraph above. */
  registersDockShortcuts: boolean;
  onGeometryChange?: (geometry: DockSlotGeometry | null) => void;
}): DockShellChrome {
  const settings = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const {
    isDockOpen,
    isDockMaximized,
    dockMode,
    pathname,
    setDockState,
    setDockMode,
    collapseMaximizedDock,
  } = useNavigation();
  const regionModel = useRegionModelOptional();
  const isMobile = useIsMobile();
  const visualViewport = useMobileVisualViewport();
  // Step 3a moves the dock's OPEN STATE onto the region model and deliberately
  // leaves PLACEMENT on navigation. The model seeds its chat occupant from
  // `settings.dockSlotPlacement` alone, whereas navigation's `dockMode` is a
  // precedence chain — URL param, then `dockModeOverride`, then the setting
  // (navigation-store.ts:415). The Coding layout takes the override path via
  // `setDockModeQuiet`, which never writes the setting, so deriving placement
  // from the model would move that dock from the right panel to a bottom bar.
  // Placement moves in the step where the model actually owns it.
  const modelChatRegion =
    regionModel &&
    (['left', 'right', 'bottom'] as const).find(
      (id) => regionModel.regions[id].occupant === 'chat',
    );
  const readerDockMode = dockMode;
  // Visibility is read from whichever region the model says holds chat — the
  // sync effect writes `visible: isDockOpen` there, so this is equal to
  // `isDockOpen` today. Reading `regions[dockMode]` instead would be wrong
  // whenever the two disagree: an unoccupied region seeds `visible: false`.
  const readerIsDockOpen =
    regionModel && modelChatRegion
      ? regionModel.regions[modelChatRegion].visible
      : isDockOpen;
  const {
    available: availableDockSlotPlacements,
    effective: effectiveDockSlotPlacement,
  } = useDockSlotPlacement(readerDockMode);

  // archive#4525: the dock's remembered project binding. Read LIVE every
  // render (the same pattern `chatShowReasoning`/`chatShowToolDetails` use
  // in `useChatDockState` — no one-time seed into local state) so a
  // cross-tab or Settings-import change is reflected immediately, and this
  // is what makes the binding survive a docked Chat occupant's remount: the
  // occupant reads it fresh from here instead of owning a local copy that
  // resets on mount.
  const activeProjectSlug = settings.chatDockProjectSlug;
  const setActiveProjectSlug = useCallback(
    (slug: string | null) => {
      setDeviceSetting('chatDockProjectSlug', slug);
    },
    [setDeviceSetting],
  );
  // Project-deletion cleanup (archive#4525 acceptance: "only an explicit
  // picker change (or project deletion)" may change the binding). Gated on
  // `publishesDockSlotClearance` — the same single-writer flag every other
  // side effect in this hook already uses — so only the one ambient
  // `DockShell` instance reconciles this; a full-screen placement's own
  // local instance never fights it.
  //
  // (archive#4525): the original guard was `!isLoading`,
  // which is ALSO true the instant the query settles into an ERROR — and
  // `ProjectsContext` folds a missing `data` (the error shape) to the same
  // `[]` a confirmed-empty list produces. A cold boot before the server
  // durably listens, or any broken-network window, would have read as
  // "the bound project is gone" and wiped a perfectly valid binding
  // (cross-tab, since the setting is shared). `isConfirmedLoaded` requires
  // POSITIVE evidence — a successful, error-free load with real data —
  // before this may ever clear anything.
  const {
    projects: projectsForBindingCleanup,
    isConfirmedLoaded: projectsConfirmedLoaded,
  } = useProjects();
  useEffect(() => {
    if (!publishesDockSlotClearance) return;
    if (!activeProjectSlug || !projectsConfirmedLoaded) return;
    const boundProjectStillExists = projectsForBindingCleanup.some(
      (project) => project.slug === activeProjectSlug,
    );
    if (!boundProjectStillExists) setActiveProjectSlug(null);
  }, [
    publishesDockSlotClearance,
    activeProjectSlug,
    projectsConfirmedLoaded,
    projectsForBindingCleanup,
    setActiveProjectSlug,
  ]);

  const [dockHeight, setDockHeightState] = useState(() =>
    clampDockHeight(settings.chatDockHeight),
  );
  const [dockWidth, setDockWidthState] = useState(() =>
    clampDockWidth(settings.chatDockWidth),
  );
  const dockHeightRef = useRef(dockHeight);
  const dockWidthRef = useRef(dockWidth);
  const draggingRef = useRef(false);
  const setDockHeight = useCallback((value: number) => {
    dockHeightRef.current = value;
    setDockHeightState(value);
  }, []);
  const setDockWidth = useCallback((value: number) => {
    dockWidthRef.current = value;
    setDockWidthState(value);
  }, []);
  const setIsDragging = useCallback(
    (value: boolean) => {
      if (draggingRef.current && !value) {
        if (effectiveDockSlotPlacement === 'bottom') {
          setDeviceSetting(
            'chatDockHeight',
            Math.round(clampDockHeight(dockHeightRef.current)),
          );
        } else {
          setDeviceSetting(
            'chatDockWidth',
            Math.round(clampDockWidth(dockWidthRef.current)),
          );
        }
      }
      draggingRef.current = value;
      setIsDraggingState(value);
    },
    [effectiveDockSlotPlacement, setDeviceSetting],
  );
  const [previousDockHeight, setPreviousDockHeight] = useState(dockHeight);
  const [previousDockOpen, setPreviousDockOpen] = useState(true);
  const [isDragging, setIsDraggingState] = useState(false);
  const [dockSnap, setDockSnap] = useState<DockSnap>(() => readDockSnap());
  const [liveDragHeight, setLiveDragHeight] = useState<number | null>(null);
  const isCollapsedDragPreview = !readerIsDockOpen && liveDragHeight !== null;

  const toolbarHeight = useMemo(() => readToolbarHeight(), []);
  const collapsedHeight = useMemo(() => {
    void isMobile;
    if (typeof window === 'undefined') return DOCK_COLLAPSED_HEIGHT;
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      '--chat-dock-header-height',
    );
    return parseInt(raw, 10) || DOCK_COLLAPSED_HEIGHT;
  }, [isMobile]);

  const applyDockSnap = useCallback(
    (next: DockSnap) => {
      setDockSnap(next);
      writeDockSnap(next);
      const px = dockSnapPixels(next, {
        viewportHeight: visualViewport.height,
        toolbarHeight,
        collapsedHeight,
      });
      if (next === 'collapsed') {
        setDockState(false, false);
      } else if (next === 'full') {
        setPreviousDockHeight(dockHeight);
        setDockHeight(px);
        setDockState(true, true);
      } else {
        setDockHeight(px);
        setDockState(true, false);
      }
    },
    [
      toolbarHeight,
      collapsedHeight,
      dockHeight,
      setDockHeight,
      setDockState,
      visualViewport.height,
    ],
  );

  const commitDesktopBottomHeight = useCallback(
    (height: number) => {
      setDockHeight(height);
      setPreviousDockHeight(height);
      setDockState(true, false);
    },
    [setDockHeight, setDockState],
  );

  const commitDockPlacement = useCallback(
    (mode: DockMode) => {
      setDockMode(mode);
    },
    [setDockMode],
  );

  // archive#869 / archive#1298: a maximized dock is opaque and full-height, so navigating
  // to another part of the app changed the view *underneath* it and nothing
  // moved — from the user's side the click did nothing.
  //
  // Restore it to its docked size so the transition is legible. The dock's
  // own `transition: height` (200ms, and disabled under
  // `prefers-reduced-motion`) does the animating — an instant disappearance
  // would leave the same "what just happened" gap in the other direction.
  //
  // Uses `collapseMaximizedDock`, NOT `setDockState(isDockOpen, false)`:
  // the dock stays open the whole time (no close-then-reopen round trip), so
  // `setDockState`'s "the caller's `maximized` argument overwrites
  // `lastDockMaximized`" behavior — correct for an explicit non-maximized
  // open or the archive#945 mobile close — would instead permanently wipe the
  // maximize preference on every one of archive#1298's collapse-on-navigate seams.
  // Review finding (archive#1312): this collapse now fires far more often
  // than the original archive#869 effect alone did, so that clobber stopped being a
  // rare edge case. `focusSession`'s `setDockState(true, lastDockMaximized)`
  // is what actually restores Full later — this is the one caller that must
  // leave `lastDockMaximized` alone.
  const restoreDockToDocked = useCallback(() => {
    const reconciled = snapAfterNavigationRestore(dockSnap);
    if (reconciled) {
      setDockSnap(reconciled);
      writeDockSnap(reconciled);
    }
    setDockHeight(previousDockHeight);
    collapseMaximizedDock();
  }, [dockSnap, previousDockHeight, setDockHeight, collapseMaximizedDock]);

  const previousPathnameRef = useRef(pathname);
  useEffect(() => {
    if (!publishesDockSlotClearance) return;
    const restore = shouldRestoreDockOnNavigation({
      previousPathname: previousPathnameRef.current,
      pathname,
      isDockMaximized,
    });
    previousPathnameRef.current = pathname;
    if (!restore) return;
    restoreDockToDocked();
  }, [
    pathname,
    isDockMaximized,
    publishesDockSlotClearance,
    restoreDockToDocked,
  ]);

  // Mobile keeps the dock's committed height in lockstep with the persisted
  // snap (Half/Full) whenever open — desktop's continuous drag owns its own
  // height directly.
  useEffect(() => {
    if (!publishesDockSlotClearance || !isMobile || !readerIsDockOpen) return;
    const next = isDockMaximized ? 'full' : dockSnap;
    if (next === 'collapsed') return;
    setDockHeight(
      dockSnapPixels(next, {
        viewportHeight: visualViewport.height,
        toolbarHeight,
        collapsedHeight,
      }),
    );
  }, [
    collapsedHeight,
    dockSnap,
    isDockMaximized,
    readerIsDockOpen,
    isMobile,
    publishesDockSlotClearance,
    setDockHeight,
    toolbarHeight,
    visualViewport.height,
  ]);

  // Single geometry authority: whoever renders this hook (the ambient
  // DockShell, or a full-screen Chat placement) is the one source of truth
  // for the dock's live size — no occupant derives or reports a second copy.
  //
  // useLayoutEffect, not useEffect: this writes the shell's clearance, and a
  // write that lands after paint shows one frame of the wrong geometry. The
  // frame is invisible on an idle machine and wide under load, which is
  // exactly the shape of a defect that passes alone and fails in a full E2E
  // bucket (archive#3929).
  //
  // WITH cleanup, unlike the pre-archive#4460 `useAmbientDockSlotGeometry`
  // this replaced (which deliberately had none — "removing these properties
  // cleared the shell's clearance for a window on every settings, placement
  // or occupant change"). That earlier code was reconciling TWO independent
  // sources on every run — Chat's own live report versus a settings-derived
  // fallback for every other occupant — so a cleanup-then-recompute could
  // observably land on the WRONG source mid-transition. This hook has only
  // ONE source: its own local state, read and rewritten by this exact same
  // synchronous effect. Cleanup and re-run happen in the same
  // `useLayoutEffect` pass, before paint, from the same closure — there is no
  // second effect and no intermediate value for anything to observe, so the
  // failure mode the old comment warned about does not apply here (review-
  // verified, archive#4460).
  useLayoutEffect(() => {
    if (!publishesDockSlotClearance) return;
    onGeometryChange?.(
      deriveDockSlotGeometry({
        placement: effectiveDockSlotPlacement,
        isOpen: readerIsDockOpen,
        height: dockHeight,
        width: dockWidth,
        liveDragHeight,
      }),
    );
    return () => {
      onGeometryChange?.(null);
    };
  }, [
    effectiveDockSlotPlacement,
    dockWidth,
    readerIsDockOpen,
    dockHeight,
    liveDragHeight,
    publishesDockSlotClearance,
    onGeometryChange,
  ]);

  const { onPointerDown: onSidePanelResizePointerDown } = useDragResize({
    setIsDragging,
    setHeight: setDockHeight,
    setWidth: setDockWidth,
    direction: 'horizontal',
    fromLeft: effectiveDockSlotPlacement === 'left',
    onDragStart: () => {
      if (!readerIsDockOpen) setDockState(true, false);
    },
  });

  const {
    onPointerDown: onMobileHeaderDragPointerDown,
    onClickCapture: onMobileHeaderDragClickCapture,
  } = useChatDockVerticalDrag({
    mode: 'mobile-snap',
    toolbarHeight,
    collapsedHeight,
    ignoreInteractiveTargets: true,
    dragInteractiveTargets: true,
    onSnap: applyDockSnap,
    onCommitHeight: commitDesktopBottomHeight,
    onLiveHeight: setLiveDragHeight,
    onDragStateChange: setIsDragging,
  });

  // Maximize remains region chrome. The visibility shortcut is registered by
  // `RegionToolbarControls` from the surface registry's metadata, outside all
  // surface renderers.
  useKeyboardShortcut(
    'dock.maximize',
    'm',
    ['cmd'],
    'Maximize/restore dock',
    useCallback(() => {
      if (isDockMaximized) {
        setDockHeight(previousDockHeight);
        setDockState(previousDockOpen, false);
      } else {
        setPreviousDockHeight(dockHeight);
        setPreviousDockOpen(readerIsDockOpen);
        setDockHeight(window.innerHeight - toolbarHeight);
        setDockState(true, true);
      }
    }, [
      isDockMaximized,
      dockHeight,
      readerIsDockOpen,
      previousDockHeight,
      previousDockOpen,
      setDockState,
      setDockHeight,
      toolbarHeight,
    ]),
    registersDockShortcuts,
    0,
    DOCK_WHEN,
  );

  return {
    isDockOpen: readerIsDockOpen,
    isDockMaximized,
    dockMode: readerDockMode,
    dockHeight,
    dockWidth,
    setDockHeight,
    setDockWidth,
    previousDockHeight,
    setPreviousDockHeight,
    previousDockOpen,
    setPreviousDockOpen,
    isDragging,
    setIsDragging,
    dockSnap,
    liveDragHeight,
    setLiveDragHeight,
    isCollapsedDragPreview,
    toolbarHeight,
    collapsedHeight,
    isMobile,
    visualViewport,
    availableDockSlotPlacements,
    effectiveDockSlotPlacement,
    applyDockSnap,
    commitDesktopBottomHeight,
    commitDockPlacement,
    restoreDockToDocked,
    onSidePanelResizePointerDown,
    onMobileHeaderDragPointerDown,
    onMobileHeaderDragClickCapture,
    activeProjectSlug,
    setActiveProjectSlug,
  };
}
