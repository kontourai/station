import { WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-browser-preview';
import {
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-coding-panels';
import {
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
} from '@kontourai/station-contracts/workspace-evidence-panels';
import { WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID } from '@kontourai/station-contracts/workspace-file-preview';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import type {
  WorkspacePaneHostDocumentV1,
  WorkspacePaneHostScope,
} from '@kontourai/station-contracts/workspace-pane-host';
import { Tooltip } from '@kontourai/ui/react';
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { subscribeCenterChatPageRequests } from '../../app-shell/chat-placement';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import {
  type ShortcutWhen,
  useKeyboardShortcuts,
} from '../../contexts/KeyboardShortcutsContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useDockSlotDevice, useIsMobile } from '../../hooks/useIsMobile';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { useMobileVisualViewport } from '../../hooks/useMobileVisualViewport';
import { NO_SESSION_PANELS_KEY } from '../../lib/coding-panels-record';
import { BrowserPreviewPaneLauncher } from '../../workspace-panes/BrowserPreviewPaneLauncher';
import { useCodingChatPositionEffects } from '../../workspace-panes/CodingChatPane';
import { clearOpenFilePreviewIntent } from '../../workspace-panes/openFilePreviewIntent';
import { PaneHeadSlotsContext } from '../../workspace-panes/PaneHeadSlots';
import { RegionChromeSlotsContext } from '../../workspace-panes/RegionChromeSlots';
import type {
  WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostPopOut,
} from '../../workspace-panes/WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from '../../workspace-panes/WorkspacePaneHostOpenContext';
import { workspacePaneHostScopeKey } from '../../workspace-panes/workspacePaneHostNavigation';
import { workspacePaneHostGroupContaining } from '../../workspace-panes/workspacePaneHostReducerTree';
import { ActionOverflowMenu, type OverflowAction } from '../ActionOverflowMenu';
import { Button } from '../Button';
import { ChatWorkspacePane } from '../chat-dock/ChatDock';
import { inboxToggleLabel } from '../chat-dock/inbox-toggle-label';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  CheckGlyph,
  CloseGlyph,
  CodeGlyph,
  DiffGlyph,
  DocumentGlyph,
  FolderGlyph,
  GlobeGlyph,
  PlusGlyph,
  ShieldGlyph,
  TargetGlyph,
  TerminalGlyph,
} from '../icons/Glyph';
import { Empty } from '../state';
import {
  CODING_FOLD_HYSTERESIS,
  CODING_FOLD_SETTLE_MS,
  CODING_LOWER_MIN_HEIGHT,
  CODING_SIDE_DEFAULT_WIDTH,
  CODING_SIDE_MIN_WIDTH,
  CODING_TRANSCRIPT_MIN_WIDTH,
  clampCodingLowerHeight,
  clampCodingSideWidth,
  codingLowerDefaultHeight,
  codingLowerMaxHeight,
  codingSideMaxWidth,
  codingTranscriptWidth,
  resizeCodingPanelFromKeyboard,
  useCodingSessionPanels,
} from './codingPanels';
import type { CodingStackLocation } from './codingStackPage';
import './CodingWorkbench.css';

/**
 * Only the Chat page's own chords and the composer own text keys, so the
 * stack's Back/Forward chords stay out of a focused composer or terminal
 * (Alt+Arrow is word motion in both).
 */
/** Whether keyboard focus is in something that edits text. */
/**
 * Whether focus is in an editor that owns these keys itself — CodeMirror
 * (⌘[ outdents), xterm, a contenteditable rich editor — whose own handler
 * takes the key. There the stack declines. A plain input, textarea or the
 * composer does not own ⌘[ or Alt+←: off macOS, Alt+← there is the browser's
 * Back, which would leave the layout, so the stack handles the chord instead.
 */
function focusInKeyOwningEditor(): boolean {
  const focused = document.activeElement;
  if (!(focused instanceof Element)) return false;
  return Boolean(
    focused.closest(
      '[contenteditable=""], [contenteditable="true"], .cm-editor, .xterm',
    ),
  );
}

const STACK_CHORD_WHEN: ShortcutWhen = { not: 'terminalFocused' };
const USER_MOVE_WINDOW_MS = 1000;
/** A separator press that moves less than this is a click, not a resize. */
const DRAG_THRESHOLD_PX = 2;

type StackTransition = 'push' | 'pop' | null;

const readHistoryIndex = () => navigationStore.getHistoryIndex();
const readActiveChat = () => navigationStore.getSnapshot().activeChat;
const NO_BADGES: Readonly<Record<string, number>> = {};
const PERSISTENCE_NOTICE_DELAY_MS = 1500;
const RAIL_ORDER = [
  WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
  WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID,
  WORKSPACE_PLAN_PANE_DESCRIPTOR_ID,
  WORKSPACE_READINESS_PANE_DESCRIPTOR_ID,
  WORKSPACE_TRUST_PANE_DESCRIPTOR_ID,
] as string[];
function railRank(descriptorId: string): number {
  const rank = RAIL_ORDER.indexOf(descriptorId);
  return rank === -1 ? RAIL_ORDER.length : rank;
}

/**
 * A click's `detail` is 0 when a key activated the button: that reader is on
 * the keyboard, and focus should follow what they opened.
 */
function activatedByKeyboard(event: { detail: number }): boolean {
  return event.detail === 0;
}

export interface CodingWorkbenchProps {
  projectId: string;
  projectSlug: string;
  /**
   * Whether this layout's centre shows Chat (`resolveLayoutChatPlacement`'s
   * `center`). False on a bottom-only device, whose Chat is the dock: the
   * Chat page then opens the dock instead of rendering Chat a second time.
   */
  centerChat: boolean;
  /**
   * Past the wide fold (`useCodingWide`, with Chat in the centre): a pane
   * opens BESIDE Chat and the Terminal below, instead of over it. The host
   * passes the same answer it renders the Terminal by.
   */
  wide?: boolean;
  location: CodingStackLocation;
  scope: WorkspacePaneHostScope;
  /** The panes a drill-in can show, in the host's document order. */
  instances: readonly WorkspacePaneInstance[];
  /** The host's live document, for the catalog's target group. */
  hostDocument: () => WorkspacePaneHostDocumentV1 | null;
  /**
   * The Terminal pane and how to draw it, for the lower panel on a wide
   * screen. The host renders it there and nowhere else while wide, so one
   * terminal is never mounted twice.
   */
  terminal?: { instance: WorkspacePaneInstance; render(): ReactNode };
  /**
   * A state the layout reports above both pages — its catalog loading or
   * failing, a pane host it could not mount. The Chat page stays usable.
   */
  notice?: ReactNode;
  paneLabel(instance: WorkspacePaneInstance): string;
  /**
   * What a pane's name abbreviates — a File Preview's full path behind its
   * file name (#3047). The rail's tooltip and the panel head's title; null
   * when the name is the whole story.
   */
  paneDetail?(instance: WorkspacePaneInstance): string | null;
  hostOpen: WorkspacePaneHostOpenAction | null;
  onOpenCatalog(request: WorkspacePaneHostCatalogRequest): void;
  browserPreviewAvailability?: WorkspacePaneAvailability;
  /**
   * A count to badge a drill-in's rail icon with, by descriptor id — the
   * Diff's changed files when the layout already knows them. Absent means
   * unknown, and no badge is drawn.
   */
  badges?: Readonly<Record<string, number>>;
  /** Pop-out for the drill-in on screen (the desktop app), behind its ⋯. */
  popOut?: WorkspacePaneHostPopOut;
  /**
   * The host's persistence standing. Said only when it is a problem — the
   * host is drawn chromeless, so its "saved in this tab" line is gone.
   */
  persistence?: 'owned' | 'contended' | 'unavailable';
  /** Whether the reader may close this drill-in (one they opened, not a built-in). */
  closable?(instance: WorkspacePaneInstance): boolean;
  /**
   * The location is not yet the layout's own (its catalog is still loading):
   * the page shown now is a placeholder, so settling on the real page is
   * arrival — no transition, no announcement, no focus move.
   */
  provisional?: boolean;
  /** The drill-in page: the layout's pane host (and its notices). */
  children: ReactNode;
}

/**
 * The Coding layout's main display as a navigation stack (#928 coding
 * stack): the conversation is the Chat page, and each pane — Files, Diff,
 * Terminal, the evidence panes, anything the "+" catalog adds — is a page
 * drilled into from it. The bar is the breadcrumb alone (Inbox / conversation
 * / pane, earlier crumbs go back); the drill-ins are an icon rail on the
 * trailing edge. Back and Forward are the browser's and the stack's chords
 * (⌘[ ⌘] on macOS, Alt+← Alt+→ elsewhere) — there are no buttons for them.
 *
 * Every page change is the navigation store's: a drill-in is the pane host's
 * `?pane=` selection (a pushed history entry), the Chat page is its absence,
 * and Back/Forward traverse browser history when the adjacent entry is this
 * layout's own. Choosing another conversation in the inbox is a sibling
 * move on the same page and replaces the entry (`setActiveChat`), so Back
 * never walks the reader through every conversation they glanced at.
 *
 * Past the wide fold (#3040) the same `?pane=` is a tool open BESIDE Chat:
 * the drill-in page becomes a side panel, Chat stays the page, and a rail
 * pick toggles or switches the panel by REPLACING the entry — Back still
 * leaves the layout or the session, never merely closes a panel. The
 * Terminal opens in a lower panel under both, a per-session fact of its
 * own (#3051) with no URL at all. Both are remembered per conversation.
 *
 * Both pages stay mounted and the inactive one is hidden and inert, so a
 * composer draft, a transcript's scroll and a terminal survive the round trip.
 * The inbox is Chat's own (`ChatWorkspacePane`'s inbox panel, collapsed and
 * reopened by its `inboxOpen` setting): this stack does not mount a second
 * one, and does not decide whether it shows.
 */
export function CodingWorkbench({
  projectId,
  projectSlug,
  centerChat,
  wide = false,
  location,
  scope,
  instances,
  hostDocument,
  terminal,
  notice,
  paneLabel,
  paneDetail,
  hostOpen,
  onOpenCatalog,
  browserPreviewAvailability,
  badges = NO_BADGES,
  provisional = false,
  popOut,
  persistence = 'owned',
  closable,
  children,
}: CodingWorkbenchProps) {
  const { setDeviceSetting } = useDeviceSettingsActions();
  const scopeKey = workspacePaneHostScopeKey(scope);
  const { isMac } = useKeyboardShortcuts();
  const historyIndex = useSyncExternalStore(
    navigationStore.subscribe,
    readHistoryIndex,
    readHistoryIndex,
  );
  const activeChat = useSyncExternalStore(
    navigationStore.subscribe,
    readActiveChat,
    readActiveChat,
  );

  // ── Wide: the URL's pane is the side panel, the Terminal is the lower one.
  const terminalId = terminal?.instance.instanceId ?? null;
  const sessionKey = activeChat ?? NO_SESSION_PANELS_KEY;
  const { panels, update: updatePanels } = useCodingSessionPanels(sessionKey);
  const sidePaneId =
    wide && location.page === 'drill-in' && location.paneId !== terminalId
      ? location.paneId
      : null;
  const sideOpen = sidePaneId !== null;
  const lowerOpen = wide && terminal !== undefined && panels.terminalOpen;
  /** The stack's page: on a wide screen Chat is always it. */
  const page: 'chat' | 'drill-in' = wide ? 'chat' : location.page;
  const paneId = wide ? sidePaneId : location.paneId;

  // A phone's on-screen keyboard shrinks the visual viewport, not the
  // layout one: the workbench fits the visible part (as the compact pane host
  // it replaces did), so a focused terminal or preview is not left under the
  // keyboard.
  const isMobile = useIsMobile();
  const visualViewport = useMobileVisualViewport();
  const rootRef = useRef<HTMLDivElement>(null);
  const [fittedHeight, setFittedHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!isMobile || !rootRef.current) {
      setFittedHeight(null);
      return;
    }
    const top = rootRef.current.getBoundingClientRect().top;
    const available = Math.max(
      0,
      visualViewport.offsetTop + visualViewport.height - top,
    );
    setFittedHeight((current) => (current === available ? current : available));
  }, [isMobile, visualViewport.height, visualViewport.offsetTop]);
  const [chatTitle, setChatTitle] = useState('Chat');
  const chatPageRef = useRef<HTMLElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  /**
   * When the reader last moved the stack themselves (0: not pending). Only
   * such a move, landing within `USER_MOVE_WINDOW_MS`, moves focus; any
   * change the stack observes consumes it, so a move that did not change the
   * page (a rail click between two drill-ins, a Back a guard cancelled)
   * cannot steal focus on a later, unrelated page change.
   */
  const userMoveRef = useRef(0);
  const drillInPageRef = useRef<HTMLElement>(null);
  const lowerPanelRef = useRef<HTMLElement>(null);
  const currentCrumbRef = useRef<HTMLSpanElement>(null);
  const sideHeadingRef = useRef<HTMLHeadingElement>(null);
  const lowerHeadingRef = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState('');

  // A preview the host already holds for a path (the rail names each
  // preview's path), so a link to an open file shows it rather than opening
  // a second occurrence; shown the way a rail pick would show it.
  const existingPreviewFor = useCallback(
    (path: string) =>
      instances.find((instance) => paneDetail?.(instance) === path)
        ?.instanceId ?? null,
    [instances, paneDetail],
  );
  const focusExistingPreview = useCallback(
    (instanceId: string) => {
      if (wide)
        navigationStore.updateParams({ pane: instanceId, paneScope: scopeKey });
      else navigationStore.setActiveWorkspacePane(instanceId, scopeKey);
    },
    [scopeKey, wide],
  );
  useCodingChatPositionEffects({
    projectId,
    projectSlug,
    // A File Preview intent is the Chat position's to open, as it was the
    // Coding tab's — a transcript link, a session panel's file, a shared
    // URL — whatever tool is beside Chat. The Files pane's own row write
    // names itself (`openFilePreviewIntentFrom`) and is left to it.
    paneHostOpen: page === 'chat' ? hostOpen : null,
    existingPreviewFor,
    focusExisting: focusExistingPreview,
    // A phone's Chat is the dock, maximized while the Chat page is the page.
    ownsMobileDock: page === 'chat',
  });

  // ── Transitions: the entering page slides in from the side it came from —
  // a push (drill-in) from the trailing edge, a pop (Back) from the leading
  // edge. Direction is the history index delta, not the page kind, so
  // Forward onto the Chat page still reads as forward.
  const [focusRequest, setFocusRequest] = useState(0);
  const [transition, setTransition] = useState<{
    page: 'chat' | 'drill-in';
    kind: StackTransition;
  }>({ page, kind: null });
  const previous = useRef({ page, historyIndex, provisional });
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { page, historyIndex, provisional };
    const recentUserMove =
      userMoveRef.current > 0 &&
      performance.now() - userMoveRef.current < USER_MOVE_WINDOW_MS;
    userMoveRef.current = 0;
    if (last.page === page) return;
    // The first real resolution (a cold deep link resolving past the layout's
    // loading state) is arrival, not a move: no slide, no focus change.
    if (last.provisional) return;
    setTransition({
      page,
      kind: historyIndex < last.historyIndex ? 'pop' : 'push',
    });
    // Focus follows the reader's own move, and never stays on the page that
    // just became inert: the conversation's composer, or the pane's page.
    const leaving =
      page === 'chat' ? drillInPageRef.current : chatPageRef.current;
    const focusWasLeft = Boolean(
      leaving &&
        document.activeElement &&
        leaving.contains(document.activeElement),
    );
    if (recentUserMove || focusWasLeft) {
      if (page === 'chat') setFocusRequest((request) => request + 1);
      // The drill-in's name in the breadcrumb, not the whole page: a
      // normal-sized focus ring on the thing that says where the reader is.
      else currentCrumbRef.current?.focus();
    }
  }, [page, historyIndex, provisional]);

  // ── Back / Forward: browser history and the stack's chords.
  const goToChatPage = useCallback(() => {
    // The Files pane keeps its selected file in the URL (a File Preview
    // intent) for its own return trip; the Chat page must not carry it, or
    // arriving there would open that file again.
    navigationStore.navigate(window.location.pathname, {
      pane: null,
      paneScope: null,
      ...clearOpenFilePreviewIntent(),
    });
  }, []);
  // Each returns whether it moved; a chord that did nothing leaves the key
  // to the browser (its own Back/Forward) rather than swallowing it.
  const goBack = useCallback((): boolean => {
    const entry = navigationStore.adjacentLocation(-1);
    if (entry?.pathname === window.location.pathname) {
      userMoveRef.current = performance.now();
      window.history.back();
      return true;
    }
    // Arrived on a drill-in from elsewhere (a link, a reload): its parent is
    // the Chat page, reached forward rather than by leaving the layout.
    if (pageRef.current === 'drill-in') {
      userMoveRef.current = performance.now();
      goToChatPage();
      return true;
    }
    return false;
  }, [goToChatPage]);
  const goForward = useCallback((): boolean => {
    const entry = navigationStore.adjacentLocation(1);
    if (entry?.pathname !== window.location.pathname) return false;
    userMoveRef.current = performance.now();
    window.history.forward();
    return true;
  }, []);
  // The chords stand down only inside an editor that owns the keys.
  const backChord = useCallback(
    () => (focusInKeyOwningEditor() ? false : goBack()),
    [goBack],
  );
  const forwardChord = useCallback(
    () => (focusInKeyOwningEditor() ? false : goForward()),
    [goForward],
  );
  useKeyboardShortcut(
    'codingStack.back',
    isMac ? '[' : 'ArrowLeft',
    isMac ? ['cmd'] : ['alt'],
    'Back in the Coding stack',
    backChord,
    true,
    0,
    STACK_CHORD_WHEN,
  );
  useKeyboardShortcut(
    'codingStack.forward',
    isMac ? ']' : 'ArrowRight',
    isMac ? ['cmd'] : ['alt'],
    'Forward in the Coding stack',
    forwardChord,
    true,
    0,
    STACK_CHORD_WHEN,
  );
  // ── Escape is the layout's own "up": it closes the panel the reader is
  // in (wide) or returns a drill-in to the conversation, and with nothing
  // to close it is still consumed. Left to the app's route-level fallback
  // it went up a level further — out of the layout to the project — from
  // a rail item or a panel head (design audit U6/D5). Inside the composer
  // and other fields the registry never offers Escape to a shortcut, so
  // their own Escape is untouched; editors that own the key keep it.
  const escapeRef = useRef<() => boolean>(() => true);
  const escapeChord = useCallback(
    () => (focusInKeyOwningEditor() ? false : escapeRef.current()),
    [],
  );
  useKeyboardShortcut(
    'codingStack.escape',
    'Escape',
    [],
    'Close the panel, or return to the conversation',
    escapeChord,
    true,
    0,
    STACK_CHORD_WHEN,
  );

  // The Chat page from a drill-in: Back when the entry behind is exactly the
  // Chat page (the stack does not grow), else a push to it.
  const returnToChatPage = useCallback(() => {
    if (pageRef.current !== 'drill-in') return;
    userMoveRef.current = performance.now();
    const entry = navigationStore.adjacentLocation(-1);
    if (
      entry?.pathname === window.location.pathname &&
      !new URLSearchParams(entry.search).has('pane')
    )
      window.history.back();
    else goToChatPage();
  }, [goToChatPage]);

  // ── "Show Chat" from outside the layout (the Chat chord, `showSurface`):
  // go to the Chat page, then focus the composer.
  useEffect(() => {
    if (!centerChat) return;
    return subscribeCenterChatPageRequests(() => {
      returnToChatPage();
      setFocusRequest((request) => request + 1);
    });
  }, [centerChat, returnToChatPage]);
  useEffect(() => {
    if (focusRequest === 0 || page !== 'chat') return;
    // Up to a second of frames: the page stops being inert in this commit,
    // and a composer that is still mounting, or briefly disabled while its
    // conversation settles, refuses focus until it is ready.
    let frame = 0;
    let attempts = 0;
    const tryFocus = () => {
      const composer = chatPageRef.current?.querySelector<HTMLTextAreaElement>(
        '.chat-input textarea',
      );
      composer?.focus();
      if (window.document.activeElement === composer || ++attempts >= 60)
        return;
      frame = requestAnimationFrame(tryFocus);
    };
    frame = requestAnimationFrame(tryFocus);
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, page]);

  // ── A conversation focused from elsewhere (a notification, ⌘1-9, "open in
  // chat") while a pane is on screen: the reader asked for the
  // conversation, so show it. Only a change of `?chat=` on the SAME drill-in
  // counts — landing on a drill-in whose entry carries a different
  // conversation (Forward) is navigation, not a request. Beside Chat (wide)
  // the conversation is already on screen; the session's own panels apply.
  const lastChatFocus = useRef({ activeChat, paneId });
  useEffect(() => {
    const last = lastChatFocus.current;
    lastChatFocus.current = { activeChat, paneId };
    if (
      centerChat &&
      !wide &&
      page === 'drill-in' &&
      paneId === last.paneId &&
      activeChat !== last.activeChat &&
      activeChat !== null
    )
      returnToChatPage();
  }, [activeChat, centerChat, page, paneId, returnToChatPage, wide]);

  // ── The side panel's selection is the URL's `?pane=`, written in place.
  // Neither opening, switching nor closing a tool beside Chat is a history
  // entry: Back is for leaving the layout or the session.
  const replaceSide = useCallback(
    (instanceId: string | null) => {
      navigationStore.updateParams({
        pane: instanceId,
        paneScope: instanceId === null ? null : scopeKey,
        // Closing Files must drop the preview intent it keeps in the URL for
        // its own return trip, as leaving its page does.
        ...(instanceId === null ? clearOpenFilePreviewIntent() : {}),
      });
    },
    [scopeKey],
  );
  const holds = useCallback(
    (instanceId: string | null) =>
      instanceId !== null &&
      instances.some((instance) => instance.instanceId === instanceId),
    [instances],
  );
  /**
   * Which session the panels on screen were applied for. Null until the
   * layout is wide and settled: arrival (a mount, the fold crossed) takes
   * the URL as the fact when it names a tool and remembers it, else restores
   * the session's memory; after that, a change of session restores that
   * session's own memory and a new session starts closed.
   */
  const appliedSession = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!wide || provisional) {
      appliedSession.current = null;
      return;
    }
    const remembered = holds(panels.side) ? panels.side : null;
    if (appliedSession.current === null) {
      appliedSession.current = sessionKey;
      if (sidePaneId) {
        if (sidePaneId !== panels.side) updatePanels({ side: sidePaneId });
      } else if (remembered && location.page === 'chat') {
        replaceSide(remembered);
      }
      return;
    }
    if (appliedSession.current === sessionKey) return;
    appliedSession.current = sessionKey;
    if (remembered !== sidePaneId) replaceSide(remembered);
  }, [
    holds,
    location.page,
    panels.side,
    provisional,
    replaceSide,
    sessionKey,
    sidePaneId,
    updatePanels,
    wide,
  ]);
  // A URL naming the Terminal on a wide screen (a drill-in from before the
  // fold was crossed, a reload on one): the Terminal lives below, so open it
  // there and clear the side.
  useLayoutEffect(() => {
    if (!wide || provisional || terminalId === null) return;
    if (location.page === 'drill-in' && location.paneId === terminalId) {
      replaceSide(null);
      updatePanels({ terminalOpen: true });
    }
  }, [
    location.page,
    location.paneId,
    provisional,
    replaceSide,
    terminalId,
    updatePanels,
    wide,
  ]);
  // The fold crossed the other way with the lower panel open: below it the
  // Terminal is a drill-in, so it becomes the page (in place — the reader
  // did not navigate) rather than vanishing with the lower panel. Its tabs
  // and their server-side processes carry across the remount; xterm's local
  // scrollback does not.
  const wasWide = useRef(wide);
  useLayoutEffect(() => {
    const was = wasWide.current;
    wasWide.current = wide;
    if (!was || wide || provisional || terminalId === null) return;
    if (panels.terminalOpen && location.page === 'chat')
      navigationStore.updateParams({ pane: terminalId, paneScope: scopeKey });
  }, [
    location.page,
    panels.terminalOpen,
    provisional,
    scopeKey,
    terminalId,
    wide,
  ]);

  const drilledIn =
    page === 'drill-in' || sideOpen
      ? instances.find((instance) => instance.instanceId === paneId)
      : undefined;
  const drillInLabel = drilledIn ? paneLabel(drilledIn) : 'Pane';
  // Say where the reader landed, politely, when the page changes (not on
  // arrival, when the route itself is announced).
  const announcedPage = useRef<string | null>(null);
  const wasProvisional = useRef(provisional);
  const pageKey = page === 'chat' ? 'chat' : `drill-in:${paneId}`;
  useEffect(() => {
    const arriving = wasProvisional.current;
    wasProvisional.current = provisional;
    if (announcedPage.current === null || provisional || arriving) {
      announcedPage.current = pageKey;
      return;
    }
    if (announcedPage.current === pageKey) return;
    announcedPage.current = pageKey;
    setAnnouncement(
      page === 'chat'
        ? `Conversation: ${chatTitle}`
        : `Showing ${drillInLabel}`,
    );
  }, [chatTitle, drillInLabel, page, pageKey, provisional]);

  // ── The panels beside and below Chat: open, switch, close, and where
  // focus goes. A keyboard reader lands in the panel they opened and back
  // on the rail item of the one they closed; a pointer reader's focus is
  // left alone.
  const [sideFocusRequest, setSideFocusRequest] = useState(0);
  const [lowerFocusRequest, setLowerFocusRequest] = useState(0);
  const focusRailItem = (instanceId: string) => {
    Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>(
        '.coding-workbench__rail-item[data-rail-item]',
      ) ?? [],
    )
      .find((item) => item.dataset.railItem === instanceId)
      ?.focus();
  };
  const openSide = (instance: WorkspacePaneInstance, viaKeyboard: boolean) => {
    replaceSide(instance.instanceId);
    updatePanels({ side: instance.instanceId });
    setTransition({ page: 'drill-in', kind: 'push' });
    setAnnouncement(`${paneLabel(instance)} beside the conversation`);
    if (viaKeyboard) setSideFocusRequest((request) => request + 1);
  };
  const closeSide = (returnFocus: boolean) => {
    if (!sideOpen) return;
    const closing = sidePaneId;
    const focusWasInside = Boolean(
      drillInPageRef.current &&
        document.activeElement &&
        drillInPageRef.current.contains(document.activeElement),
    );
    replaceSide(null);
    updatePanels({ side: null });
    // So the next open slides in again rather than keeping the last entry.
    setTransition({ page: 'drill-in', kind: null });
    setAnnouncement(`${drillInLabel} closed`);
    if ((returnFocus || focusWasInside) && closing) focusRailItem(closing);
  };
  const [lowerVisited, setLowerVisited] = useState(false);
  if (lowerOpen && !lowerVisited) setLowerVisited(true);
  const toggleLower = (viaKeyboard: boolean) => {
    if (!terminal) return;
    const label = paneLabel(terminal.instance);
    if (lowerOpen) {
      const focusWasInside = Boolean(
        lowerPanelRef.current &&
          document.activeElement &&
          lowerPanelRef.current.contains(document.activeElement),
      );
      updatePanels({ terminalOpen: false });
      setAnnouncement(`${label} closed`);
      if (viaKeyboard || focusWasInside)
        focusRailItem(terminal.instance.instanceId);
      return;
    }
    updatePanels({ terminalOpen: true });
    setAnnouncement(`${label} below the conversation`);
    if (viaKeyboard) setLowerFocusRequest((request) => request + 1);
  };
  useEffect(() => {
    if (sideFocusRequest === 0) return;
    sideHeadingRef.current?.focus();
  }, [sideFocusRequest]);
  useEffect(() => {
    if (lowerFocusRequest === 0) return;
    lowerHeadingRef.current?.focus();
  }, [lowerFocusRequest]);

  const openView = (instance: WorkspacePaneInstance, viaKeyboard: boolean) => {
    if (wide) {
      if (instance.instanceId === terminalId) {
        toggleLower(viaKeyboard);
        return;
      }
      if (instance.instanceId === sidePaneId) closeSide(viaKeyboard);
      else openSide(instance, viaKeyboard);
      return;
    }
    // The drill-in already on screen is not a new page.
    if (page === 'drill-in' && instance.instanceId === paneId) return;
    userMoveRef.current = performance.now();
    navigationStore.setActiveWorkspacePane(instance.instanceId, scopeKey);
  };
  escapeRef.current = () => {
    if (wide) {
      const focused = document.activeElement;
      const within = (element: HTMLElement | null) =>
        Boolean(element && focused && element.contains(focused));
      const onRailItemOf = (instanceId: string | null) =>
        Boolean(
          instanceId &&
            focused instanceof HTMLElement &&
            focused.dataset.railItem === instanceId,
        );
      // Only the panel the reader is in (or whose rail item they are on)
      // closes; from the transcript, the bar or elsewhere Escape is
      // consumed and nothing moves.
      if (
        lowerOpen &&
        (within(lowerPanelRef.current) || onRailItemOf(terminalId))
      )
        toggleLower(true);
      else if (
        sideOpen &&
        (within(drillInPageRef.current) || onRailItemOf(sidePaneId))
      )
        closeSide(true);
      return true;
    }
    if (pageRef.current === 'drill-in') returnToChatPage();
    return true;
  };
  const requestCatalog = () => {
    const document = hostDocument();
    if (!document) return;
    const group =
      workspacePaneHostGroupContaining(
        document.root,
        document.activeInstanceId,
      ) ??
      (document.root.type === 'tabs'
        ? document.root
        : workspacePaneHostGroupContaining(
            document.root,
            document.instances[0]?.instanceId ?? '',
          ));
    if (group) onOpenCatalog({ type: 'add', targetGroupId: group.id });
  };

  // ── Sizes: the room the panels share, the side's width and the lower's
  // height, each clamped so Chat keeps its floor. A drag holds a draft and
  // commits once on release; the keyboard commits each step.
  const pagesRef = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (!wide) return;
    const element = pagesRef.current;
    if (!element) return;
    const read = () => {
      const rect = element.getBoundingClientRect();
      // The viewport stands in for a box that has no size yet, so a resize
      // is a change here too.
      const width = rect.width || window.innerWidth;
      const height = rect.height || window.innerHeight;
      setRoom((current) =>
        current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [wide]);
  // The rail sits beside the pages, in the same room the fold was sized for.
  const roomWidth = (room.width || window.innerWidth) + 44;
  const roomHeight = room.height || window.innerHeight;
  const sideWidth = clampCodingSideWidth(
    panels.sideWidth ?? CODING_SIDE_DEFAULT_WIDTH,
    roomWidth,
  );
  const lowerDefault = codingLowerDefaultHeight(roomHeight);
  const lowerHeight = clampCodingLowerHeight(
    panels.terminalHeight ?? lowerDefault,
    roomHeight,
  );
  // A drag's frames are written to the room's own custom properties, not
  // to React state: nothing re-renders per pointer move, least of all Chat.
  // The release commits the size once, and the render that follows writes
  // the same value back through the style prop.
  const draftRoomSize = useCallback((name: string, px: number) => {
    pagesRef.current?.style.setProperty(name, `${px}px`);
  }, []);
  const sideMax = codingSideMaxWidth(roomWidth);
  const lowerMax = codingLowerMaxHeight(roomHeight);
  /** The room's far edge a panel hangs from (the viewport's when unmeasured). */
  const roomEdge = (edge: 'right' | 'bottom') => {
    const rect = pagesRef.current?.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0))
      return edge === 'right' ? window.innerWidth : window.innerHeight;
    return rect[edge];
  };

  // ── The inbox beside an open tool (#3046 round). A tool that would leave
  // the transcript under its floor folds the inbox for its stay and unfolds
  // it when the tool closes — unless the reader has folded or unfolded it
  // themselves while a tool was open, which is their choice for this
  // session (`panels.inbox`) and is never overridden.
  const inboxOpen = useDeviceSettings().inboxOpen;
  const ownInboxWrite = useRef<boolean | null>(null);
  /**
   * Who folded the inbox is the session record's (`inbox: 'layout'`), not a
   * ref: a reload or a return must know the layout folded it, so that the
   * tool closing — now or on arrival — unfolds it again.
   */
  const layoutFolded = panels.inbox === 'layout';
  const readerChoice = typeof panels.inbox === 'boolean' ? panels.inbox : null;
  const writeInbox = useCallback(
    (value: boolean) => {
      ownInboxWrite.current = value;
      setDeviceSetting('inboxOpen', value);
    },
    [setDeviceSetting],
  );
  const committedSideWidth = panels.sideWidth;
  // The room the fold is judged by follows the measured room after a short
  // settle, so a window being dragged is judged once it rests, not per frame.
  const [foldRoomWidth, setFoldRoomWidth] = useState(roomWidth);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setFoldRoomWidth(roomWidth),
      CODING_FOLD_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [roomWidth]);
  /** The inbox's width when the layout folded it, for judging the unfold (0: unmeasured, the rule applies). */
  const foldedInboxWidth = useRef(0);
  useEffect(() => {
    if (!wide) return;
    if (!sideOpen) {
      // A tool the session remembers is about to be restored (the arrival
      // effect writes the URL a commit later): its fold stands, rather
      // than an unfold now and a fold again — two writes and an inbox
      // mounted for one frame on every reload.
      if (layoutFolded && !holds(panels.side)) {
        updatePanels({ inbox: null });
        if (!inboxOpen) writeInbox(true);
      }
      return;
    }
    // The reader's own choice for this session stands, whatever the room.
    if (readerChoice !== null) return;
    const width = clampCodingSideWidth(
      committedSideWidth ?? CODING_SIDE_DEFAULT_WIDTH,
      foldRoomWidth,
    );
    if (inboxOpen && !layoutFolded) {
      const inbox =
        chatPageRef.current?.querySelector<HTMLElement>('.chat-dock-inbox');
      const measured = inbox?.getBoundingClientRect().width || null;
      const transcript = codingTranscriptWidth(foldRoomWidth, width, measured);
      if (transcript < CODING_TRANSCRIPT_MIN_WIDTH) {
        foldedInboxWidth.current =
          measured ??
          codingTranscriptWidth(foldRoomWidth, width, 0) - transcript;
        updatePanels({ inbox: 'layout' });
        writeInbox(false);
      }
    } else if (!inboxOpen && layoutFolded) {
      // Widened again: the inbox the layout folded comes back once it fits
      // with room to spare, so a width on the line does not flap.
      if (
        codingTranscriptWidth(
          foldRoomWidth,
          width,
          foldedInboxWidth.current || null,
        ) >=
        CODING_TRANSCRIPT_MIN_WIDTH + CODING_FOLD_HYSTERESIS
      ) {
        updatePanels({ inbox: null });
        writeInbox(true);
      }
    } else if (inboxOpen && layoutFolded) {
      // Folded by the layout, open anyway (another tab's write): not ours.
      updatePanels({ inbox: null });
    }
  }, [
    committedSideWidth,
    foldRoomWidth,
    holds,
    inboxOpen,
    layoutFolded,
    panels.side,
    readerChoice,
    sideOpen,
    updatePanels,
    wide,
    writeInbox,
  ]);
  const lastInbox = useRef(inboxOpen);
  useEffect(() => {
    if (lastInbox.current === inboxOpen) return;
    lastInbox.current = inboxOpen;
    if (ownInboxWrite.current === inboxOpen) {
      ownInboxWrite.current = null;
      return;
    }
    // The reader's own move while a tool is beside Chat: theirs to keep.
    if (wide && sideOpen) updatePanels({ inbox: inboxOpen });
  }, [inboxOpen, sideOpen, updatePanels, wide]);
  // The reader's standing choice for a session is applied when the session
  // arrives or returns, as the record promises; the layout's own folds are
  // judged above.
  const choiceAppliedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!wide || provisional) {
      choiceAppliedFor.current = null;
      return;
    }
    if (choiceAppliedFor.current === sessionKey) return;
    choiceAppliedFor.current = sessionKey;
    if (readerChoice !== null && readerChoice !== inboxOpen)
      writeInbox(readerChoice);
  }, [inboxOpen, provisional, readerChoice, sessionKey, wide, writeInbox]);

  // ── One bar: the breadcrumb names the conversation, and Chat's own
  // toolbar (its project context, Open/New, the dock menu) renders into the
  // bar's two slots beside it (#3046) rather than as a second row.
  // The folded inbox's edge: a slim strip on the Chat column's left edge
  // that reopens the inbox (the reader's own choice) and carries the inbox's
  // "Needs you" count so a fold never hides that something is waiting. Fine
  // pointers past the fold only — a coarse pointer has no hover to widen it.
  const [inboxNeedsYou, setInboxNeedsYou] = useState(0);
  const coarsePointer = useDockSlotDevice().coarsePointer;
  const inboxEdge = wide && centerChat && !inboxOpen && !coarsePointer;
  const inboxEdgeName = inboxToggleLabel(false, inboxNeedsYou);
  const chatBar = centerChat && page === 'chat';
  const [barLeading, setBarLeading] = useState<HTMLElement | null>(null);
  const [barTrailing, setBarTrailing] = useState<HTMLElement | null>(null);
  const chatBarSlots = useMemo(
    () => ({ leading: barLeading, trailing: barTrailing, namesPane: true }),
    [barLeading, barTrailing],
  );
  // The panel heads: the pane's own controls join the head row.
  const [sideHeadLeading, setSideHeadLeading] = useState<HTMLElement | null>(
    null,
  );
  const [sideHeadTrailing, setSideHeadTrailing] = useState<HTMLElement | null>(
    null,
  );
  // Beside Chat the same rows go to the pane through the head's slots: a pane
  // with an overflow of its own merges them and the head keeps one ⋯.
  const [sideActionsTaken, setSideActionsTaken] = useState(false);
  const removeDrilledIn = useMemo(
    () =>
      drilledIn && hostOpen?.close && closable?.(drilledIn)
        ? () => void hostOpen.close?.(drilledIn.instanceId)
        : undefined,
    [closable, drilledIn, hostOpen],
  );
  const sideHost = useHostPaneActions({
    instance: drilledIn ?? null,
    label: drillInLabel,
    popOut,
    onClose: removeDrilledIn,
  });
  const sideHeadSlots = useMemo(
    () => ({
      leading: sideHeadLeading,
      trailing: sideHeadTrailing,
      hostActions: sideHost.actions,
      takeHostActions: setSideActionsTaken,
    }),
    [sideHeadLeading, sideHeadTrailing, sideHost.actions],
  );
  const [lowerHeadLeading, setLowerHeadLeading] = useState<HTMLElement | null>(
    null,
  );
  const [lowerHeadTrailing, setLowerHeadTrailing] =
    useState<HTMLElement | null>(null);
  const lowerHeadSlots = useMemo(
    () => ({ leading: lowerHeadLeading, trailing: lowerHeadTrailing }),
    [lowerHeadLeading, lowerHeadTrailing],
  );
  const drillInDetail = drilledIn ? (paneDetail?.(drilledIn) ?? null) : null;
  // A File Preview beside Chat was most likely opened from Files, which it
  // replaced; its head offers the way back (design audit U5).
  const previewBackTo =
    wide &&
    drilledIn?.descriptorId === WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID
      ? (instances.find(
          (instance) =>
            instance.descriptorId ===
            WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID,
        ) ?? null)
      : null;

  const pageState = (candidate: 'chat' | 'drill-in', active: boolean) => ({
    'data-active': active ? 'true' : 'false',
    ...(transition.page === candidate && transition.kind && active
      ? { 'data-enter': transition.kind }
      : {}),
    inert: !active || undefined,
    'aria-hidden': !active || undefined,
  });

  // Diff first, then Files and Terminal, the evidence panes, then whatever
  // else the host holds in its own order (previews, catalog panes).
  const railInstances = [...instances].sort(
    (left, right) => railRank(left.descriptorId) - railRank(right.descriptorId),
  );
  // "Unavailable" is also the host's standing for the moment before its
  // lease resolves; only one that lasts is a problem worth saying.
  const [persistenceProblem, setPersistenceProblem] = useState<
    'contended' | 'unavailable' | null
  >(null);
  useEffect(() => {
    if (persistence === 'owned') {
      setPersistenceProblem(null);
      return;
    }
    if (persistence === 'contended') {
      setPersistenceProblem('contended');
      return;
    }
    const timer = window.setTimeout(
      () => setPersistenceProblem('unavailable'),
      PERSISTENCE_NOTICE_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [persistence]);

  const openInbox = () => {
    setDeviceSetting('inboxOpen', true);
    returnToChatPage();
  };

  const sidePanelId = useId();
  const lowerPanelId = useId();
  const paneMenu =
    drilledIn && (page === 'drill-in' || sideOpen) ? (
      <PaneMoreMenu
        key={drilledIn.instanceId}
        instance={drilledIn}
        label={drillInLabel}
        popOut={popOut}
        onClose={
          hostOpen?.close && closable?.(drilledIn)
            ? () => void hostOpen.close?.(drilledIn.instanceId)
            : undefined
        }
      />
    ) : null;
  const terminalLabel = terminal ? paneLabel(terminal.instance) : 'Terminal';

  return (
    <div
      ref={rootRef}
      className="coding-workbench"
      data-mode={wide ? 'panels' : 'stack'}
      style={
        fittedHeight === null
          ? undefined
          : {
              ...visualViewport.style,
              height: `${fittedHeight}px`,
              maxHeight: `${fittedHeight}px`,
            }
      }
    >
      <div className="coding-workbench__main">
        <div className="coding-workbench__bar">
          {/* The rail is last in the tab order (bar, Chat, the open panel,
              then the rail); a reader who wants a tool first skips to it. */}
          <button
            type="button"
            className="coding-workbench__skip"
            onClick={() => {
              rootRef.current
                ?.querySelector<HTMLElement>(
                  '.coding-workbench__rail-item[data-rail-item]',
                )
                ?.focus();
            }}
          >
            Skip to views
          </button>
          <nav className="coding-workbench__nav" aria-label="Coding navigation">
            <ol className="coding-workbench__crumbs" aria-label="Breadcrumb">
              <li className="coding-workbench__crumb">
                <button
                  type="button"
                  className="coding-workbench__crumb-link"
                  onClick={openInbox}
                >
                  Inbox
                </button>
              </li>
              <li className="coding-workbench__crumb">
                {page === 'drill-in' ? (
                  <button
                    type="button"
                    className="coding-workbench__crumb-link"
                    onClick={returnToChatPage}
                  >
                    {chatTitle}
                  </button>
                ) : (
                  <span
                    className="coding-workbench__crumb-current"
                    aria-current="page"
                  >
                    {chatTitle}
                  </span>
                )}
              </li>
              {page === 'drill-in' ? (
                <li className="coding-workbench__crumb">
                  <span
                    className="coding-workbench__crumb-current"
                    aria-current="page"
                    ref={currentCrumbRef}
                    tabIndex={-1}
                  >
                    {drillInLabel}
                  </span>
                </li>
              ) : null}
            </ol>
          </nav>
          {chatBar ? (
            <div
              className="coding-workbench__bar-leading"
              ref={setBarLeading}
            />
          ) : null}
          <span className="coding-workbench__bar-spacer" />
          {chatBar ? (
            <div
              className="coding-workbench__bar-trailing"
              ref={setBarTrailing}
            />
          ) : null}
          {page === 'drill-in' ? paneMenu : null}
        </div>
        <p className="coding-workbench__announcement" aria-live="polite">
          {announcement}
        </p>
        {notice ? (
          <div className="coding-workbench__state">{notice}</div>
        ) : null}
        {persistenceProblem ? (
          <p className="coding-workbench__notice" role="status">
            {persistenceProblem === 'contended'
              ? 'These views are open in another tab, so changes here are not saved.'
              : 'Changes to these views cannot be saved right now.'}
          </p>
        ) : null}
        <div
          ref={pagesRef}
          className="coding-workbench__pages"
          style={
            {
              '--coding-side-width': `${sideWidth}px`,
              '--coding-lower-height': `${lowerHeight}px`,
            } as CSSProperties
          }
        >
          <div
            className="coding-workbench__row"
            data-side={sideOpen ? 'open' : 'closed'}
          >
            <section
              ref={chatPageRef}
              className="coding-workbench__page coding-workbench__page--chat"
              aria-label="Chat"
              {...pageState('chat', page === 'chat')}
            >
              {centerChat ? (
                <CenterChat
                  slots={chatBarSlots}
                  onScreen={page === 'chat'}
                  onPresentationTitleChange={setChatTitle}
                  onInboxNeedsYouChange={setInboxNeedsYou}
                />
              ) : (
                <DockChatNotice />
              )}
              {inboxEdge ? (
                <Tooltip
                  label={inboxEdgeName}
                  placement="right"
                  className="coding-workbench__inbox-edge-slot"
                >
                  <button
                    type="button"
                    className={`coding-workbench__inbox-edge${inboxNeedsYou > 0 ? ' coding-workbench__inbox-edge--needs-you' : ''}`}
                    data-testid="coding-inbox-edge"
                    // Pointer-only: the bar's inbox toggle is the one
                    // control a keyboard or screen reader meets, with the
                    // same name ("Show inbox, 3 need you"). Two controls
                    // with one name read the same thing twice.
                    aria-hidden="true"
                    tabIndex={-1}
                    // Not `writeInbox`: this is the reader's own move, and
                    // the session remembers it as such.
                    onClick={() => setDeviceSetting('inboxOpen', true)}
                  >
                    <span
                      className="coding-workbench__inbox-edge-glyph"
                      aria-hidden="true"
                    >
                      <ArrowRightGlyph />
                    </span>
                    {inboxNeedsYou > 0 ? (
                      <span
                        className="coding-workbench__inbox-edge-count"
                        aria-hidden="true"
                      >
                        {inboxNeedsYou > 99 ? '99+' : inboxNeedsYou}
                      </span>
                    ) : null}
                  </button>
                </Tooltip>
              ) : null}
            </section>
            {wide && sideOpen ? (
              <PanelSeparator
                orientation="vertical"
                label={`Resize ${drillInLabel} panel`}
                value={sideWidth}
                min={CODING_SIDE_MIN_WIDTH}
                max={sideMax}
                reset={CODING_SIDE_DEFAULT_WIDTH}
                measure={(clientX) => roomEdge('right') - clientX}
                onDraft={(width) =>
                  draftRoomSize(
                    '--coding-side-width',
                    clampCodingSideWidth(width, roomWidth),
                  )
                }
                onCommit={(width) =>
                  updatePanels({
                    sideWidth: clampCodingSideWidth(width, roomWidth),
                  })
                }
              />
            ) : null}
            <section
              ref={drillInPageRef}
              id={sidePanelId}
              className="coding-workbench__page coding-workbench__page--drill-in"
              aria-label={drillInLabel}
              {...pageState('drill-in', page === 'drill-in' || sideOpen)}
            >
              {wide ? (
                <header className="coding-workbench__panel-head">
                  {previewBackTo ? (
                    <Tooltip
                      label={`Back to ${paneLabel(previewBackTo)}`}
                      placement="bottom"
                    >
                      <button
                        type="button"
                        className="coding-workbench__rail-item coding-workbench__panel-back"
                        aria-label={`Back to ${paneLabel(previewBackTo)}`}
                        onClick={(event) =>
                          openSide(previewBackTo, activatedByKeyboard(event))
                        }
                      >
                        <ArrowLeftGlyph />
                      </button>
                    </Tooltip>
                  ) : null}
                  <h2
                    ref={sideHeadingRef}
                    className="coding-workbench__panel-title"
                    title={drillInDetail ?? undefined}
                    tabIndex={-1}
                  >
                    {drillInLabel}
                  </h2>
                  <div
                    className="coding-workbench__head-slot coding-workbench__head-slot--leading"
                    ref={setSideHeadLeading}
                  />
                  <div
                    className="coding-workbench__head-slot"
                    ref={setSideHeadTrailing}
                  />
                  {sideActionsTaken ? (
                    sideHost.notice ? (
                      <span
                        className="coding-workbench__more-notice"
                        role="status"
                      >
                        {sideHost.notice}
                      </span>
                    ) : null
                  ) : (
                    paneMenu
                  )}
                  <Tooltip label={`Close ${drillInLabel}`} placement="bottom">
                    <button
                      type="button"
                      className="coding-workbench__rail-item coding-workbench__panel-close"
                      aria-label={`Close ${drillInLabel}`}
                      onClick={(event) => closeSide(activatedByKeyboard(event))}
                    >
                      <CloseGlyph />
                    </button>
                  </Tooltip>
                </header>
              ) : null}
              <div className="coding-workbench__panel-body">
                {wide ? (
                  <PaneHeadSlotsContext.Provider value={sideHeadSlots}>
                    {children}
                  </PaneHeadSlotsContext.Provider>
                ) : (
                  children
                )}
              </div>
            </section>
          </div>
          {wide && terminal && lowerVisited ? (
            <>
              {lowerOpen ? (
                <PanelSeparator
                  orientation="horizontal"
                  label={`Resize ${terminalLabel} panel`}
                  value={lowerHeight}
                  min={CODING_LOWER_MIN_HEIGHT}
                  max={lowerMax}
                  reset={lowerDefault}
                  measure={(_clientX, clientY) => roomEdge('bottom') - clientY}
                  onDraft={(height) =>
                    draftRoomSize(
                      '--coding-lower-height',
                      clampCodingLowerHeight(height, roomHeight),
                    )
                  }
                  onCommit={(height) =>
                    updatePanels({
                      terminalHeight: clampCodingLowerHeight(
                        height,
                        roomHeight,
                      ),
                    })
                  }
                />
              ) : null}
              <section
                ref={lowerPanelRef}
                id={lowerPanelId}
                className="coding-workbench__lower"
                aria-label={terminalLabel}
                data-active={lowerOpen ? 'true' : 'false'}
                inert={!lowerOpen || undefined}
                aria-hidden={!lowerOpen || undefined}
              >
                <header className="coding-workbench__panel-head">
                  <h2
                    ref={lowerHeadingRef}
                    className="coding-workbench__panel-title"
                    tabIndex={-1}
                  >
                    {terminalLabel}
                  </h2>
                  <div
                    className="coding-workbench__head-slot coding-workbench__head-slot--leading"
                    ref={setLowerHeadLeading}
                  />
                  <div
                    className="coding-workbench__head-slot"
                    ref={setLowerHeadTrailing}
                  />
                  <Tooltip label={`Close ${terminalLabel}`} placement="bottom">
                    <button
                      type="button"
                      className="coding-workbench__rail-item coding-workbench__panel-close"
                      aria-label={`Close ${terminalLabel}`}
                      onClick={(event) =>
                        toggleLower(activatedByKeyboard(event))
                      }
                    >
                      <CloseGlyph />
                    </button>
                  </Tooltip>
                </header>
                <div className="coding-workbench__panel-body">
                  <PaneHeadSlotsContext.Provider value={lowerHeadSlots}>
                    {terminal.render()}
                  </PaneHeadSlotsContext.Provider>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
      <CodingViewRail
        instances={railInstances}
        mode={wide ? 'panels' : 'stack'}
        currentPaneId={page === 'drill-in' ? paneId : null}
        pressed={
          wide
            ? {
                ...(sidePaneId ? { [sidePaneId]: sidePanelId } : {}),
                ...(lowerOpen && terminalId
                  ? { [terminalId]: lowerPanelId }
                  : {}),
              }
            : undefined
        }
        paneLabel={paneLabel}
        paneDetail={paneDetail}
        badges={badges}
        onOpenView={openView}
        onAddPane={hostOpen ? requestCatalog : undefined}
        browserLauncher={
          browserPreviewAvailability ? (
            <BrowserPreviewPaneLauncher
              projectId={projectId}
              projectSlug={projectSlug}
              host={hostOpen}
              availability={browserPreviewAvailability}
            />
          ) : null
        }
      />
    </div>
  );
}

/**
 * The Chat page where Chat is the dock (a bottom-only device): the dock is
 * where the conversation is, so the page points there instead of rendering
 * a second Chat.
 */
function DockChatNotice() {
  const showSurface = useShowSurface();
  return (
    <Empty
      label="Chat is in the dock"
      description="Open the dock to read and reply, or pick a view to drill into."
      action={
        <Button variant="secondary" onClick={() => showSurface('chat')}>
          Show Chat
        </Button>
      }
    />
  );
}

/**
 * A panel's edge: a real separator (`role="separator"`, focusable) that
 * drags with the pointer and nudges with the keyboard
 * (`resizeCodingPanelFromKeyboard`), reporting its value and bounds. A drag
 * drafts on every frame and commits once on release; a double-click, like
 * Enter, returns the panel to its default. `measure` turns a pointer
 * position into the panel's size, since which edge the panel hangs from is
 * the owner's fact.
 */
function PanelSeparator({
  orientation,
  label,
  value,
  min,
  max,
  reset,
  measure,
  onDraft,
  onCommit,
}: {
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  reset: number;
  measure(clientX: number, clientY: number): number;
  onDraft(size: number): void;
  onCommit(size: number): void;
}) {
  // A drag is relative to the press: the press point is not the edge, so
  // the panel moves by the pointer's travel rather than jumping to it, and a
  // press that never travels is a click, not a resize.
  const drag = useRef<{
    pointerId: number;
    origin: number;
    last: number;
    moved: boolean;
  } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      origin: measure(event.clientX, event.clientY) - value,
      last: value,
      moved: false,
    };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const next = measure(event.clientX, event.clientY) - drag.current.origin;
    if (!drag.current.moved && Math.abs(next - value) < DRAG_THRESHOLD_PX)
      return;
    drag.current.moved = true;
    drag.current.last = next;
    onDraft(next);
  };
  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const { last, moved } = drag.current;
    drag.current = null;
    if (moved) onCommit(last);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = resizeCodingPanelFromKeyboard(orientation, value, event.key, {
      shiftKey: event.shiftKey,
      min,
      max,
      reset,
    });
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  };
  return (
    <Tooltip
      // The tip names the edge and no more (quiet chrome). The separator
      // role and its value already tell assistive tech it moves with the
      // arrow keys; Enter and a double-click return it to its default.
      label={label}
      placement={orientation === 'vertical' ? 'left' : 'top'}
      className={`coding-workbench__separator-slot coding-workbench__separator-slot--${orientation}`}
    >
      {/* The suggested <hr> is a decorative rule: not focusable, not
          operable, and unable to carry aria-valuenow. This is a window
          splitter — a real button that resizes with the arrow keys and
          reports its position. */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be a focusable, operable splitter. */}
      <button
        type="button"
        role="separator"
        className={`coding-workbench__separator coding-workbench__separator--${orientation}`}
        aria-label={label}
        aria-orientation={orientation}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={() => onCommit(reset)}
        onKeyDown={onKeyDown}
      />
    </Tooltip>
  );
}

/**
 * The centre's Chat, memoised on its own props so the workbench's geometry
 * (a separator drag, a room measurement, an announcement) does not render
 * Station's one Chat controller: its props are the bar's slot elements, a
 * boolean and two stable setters.
 */
const CenterChat = memo(function CenterChat({
  slots,
  onScreen,
  onPresentationTitleChange,
  onInboxNeedsYouChange,
}: {
  slots: {
    leading: HTMLElement | null;
    trailing: HTMLElement | null;
    namesPane: boolean;
  };
  onScreen: boolean;
  onPresentationTitleChange(title: string): void;
  onInboxNeedsYouChange(count: number): void;
}) {
  return (
    <RegionChromeSlotsContext.Provider value={slots}>
      <ChatWorkspacePane
        placement="fullscreen"
        // The dock's Chat, moved to the centre: the dock's scope (every
        // conversation), not the Chat layout's Project-bound one.
        conversationScope="ambient"
        onScreen={onScreen}
        ownsDockShortcuts={false}
        onPresentationTitleChange={onPresentationTitleChange}
        onInboxNeedsYouChange={onInboxNeedsYouChange}
      />
    </RegionChromeSlotsContext.Provider>
  );
});

/** A glyph per built-in drill-in; anything else draws the generic pane mark. */
function railGlyph(descriptorId: string): ReactNode {
  switch (descriptorId) {
    case WORKSPACE_CODING_DIFF_PANE_DESCRIPTOR_ID:
      return <DiffGlyph />;
    case WORKSPACE_CODING_FILE_BROWSER_PANE_DESCRIPTOR_ID:
      return <FolderGlyph />;
    case WORKSPACE_CODING_TERMINAL_PANE_DESCRIPTOR_ID:
      return <TerminalGlyph />;
    case WORKSPACE_PLAN_PANE_DESCRIPTOR_ID:
      return <TargetGlyph />;
    case WORKSPACE_READINESS_PANE_DESCRIPTOR_ID:
      return <CheckGlyph />;
    case WORKSPACE_TRUST_PANE_DESCRIPTOR_ID:
      return <ShieldGlyph />;
    case WORKSPACE_FILE_PREVIEW_PANE_DESCRIPTOR_ID:
      return <DocumentGlyph />;
    case WORKSPACE_BROWSER_PREVIEW_PANE_DESCRIPTOR_ID:
      return <GlobeGlyph />;
    default:
      return <CodeGlyph />;
  }
}

/**
 * The drill-ins, as a slim icon rail on the workbench's trailing edge: one
 * round icon per pane the host holds, then the Browser launcher and the "+"
 * catalog. Icon-only, so every item carries its name as `aria-label` and a
 * tooltip; the one on screen is the solid one. In `stack` mode it is the
 * drill-in page (`aria-current`, a click pushes it); in `panels` mode each
 * item is a toggle (`aria-pressed`, naming the panel it controls) and a
 * click opens, switches or closes the panel beside or below Chat.
 */
function CodingViewRail({
  instances,
  mode,
  currentPaneId,
  pressed,
  paneLabel,
  paneDetail,
  badges,
  onOpenView,
  onAddPane,
  browserLauncher,
}: {
  instances: readonly WorkspacePaneInstance[];
  mode: 'stack' | 'panels';
  currentPaneId: string | null;
  /** In `panels` mode: the open panes' instance ids, each to its panel's id. */
  pressed?: Readonly<Record<string, string>>;
  paneLabel(instance: WorkspacePaneInstance): string;
  paneDetail?(instance: WorkspacePaneInstance): string | null;
  badges: Readonly<Record<string, number>>;
  onOpenView(instance: WorkspacePaneInstance, viaKeyboard: boolean): void;
  onAddPane?: () => void;
  browserLauncher: ReactNode;
}) {
  return (
    <nav className="coding-workbench__rail" aria-label="Views">
      {instances.map((instance) => {
        const label = paneLabel(instance);
        const count: number | undefined = badges[instance.descriptorId];
        const name =
          count === undefined
            ? label
            : `${label}, ${count} changed ${count === 1 ? 'file' : 'files'}`;
        const panelId = pressed?.[instance.instanceId];
        // The tooltip says the whole of what the name abbreviates (a
        // preview's full path, #3047); the accessible name stays the name.
        const detail = paneDetail?.(instance) ?? null;
        const tip =
          detail === null || detail === label
            ? name
            : count === undefined
              ? detail
              : `${detail} — ${name.slice(label.length + 2)}`;
        return (
          <RailTip key={instance.instanceId} label={tip}>
            <button
              type="button"
              className="coding-workbench__rail-item"
              data-rail-item={instance.instanceId}
              aria-label={name}
              aria-current={
                mode === 'stack' && instance.instanceId === currentPaneId
                  ? 'page'
                  : undefined
              }
              aria-pressed={mode === 'panels' ? Boolean(panelId) : undefined}
              aria-controls={panelId}
              onClick={(event) =>
                onOpenView(instance, activatedByKeyboard(event))
              }
            >
              {railGlyph(instance.descriptorId)}
              {count === undefined ? null : (
                <span
                  className="coding-workbench__rail-count"
                  aria-hidden="true"
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          </RailTip>
        );
      })}
      {browserLauncher ? <BrowserRailItem launcher={browserLauncher} /> : null}
      {onAddPane ? (
        <RailTip label="Add pane">
          <button
            type="button"
            className="coding-workbench__rail-item coding-workbench__rail-item--add"
            aria-label="Add pane"
            onClick={onAddPane}
          >
            <PlusGlyph />
          </button>
        </RailTip>
      ) : null}
    </nav>
  );
}

/**
 * The Browser launcher behind a rail icon: its address field is a form, so
 * it opens as a small labelled panel beside the rail.
 */
/**
 * A rail item's tooltip, drawn on the body to the item's left. The rail
 * scrolls (it must: a workspace can hold more panes than a short window
 * shows), and a tooltip inside a scrolling rail is clipped to it, so the tip
 * is placed from the item's measured box instead, as the Browser flyout is.
 * Shown on hover and keyboard focus, as the kit's tooltip is.
 */
function RailTip({ label, children }: { label: string; children: ReactNode }) {
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const show = (event: { currentTarget: HTMLElement }) => {
    const anchor = event.currentTarget.getBoundingClientRect();
    setPlace({
      position: 'fixed',
      top: `${anchor.top + anchor.height / 2}px`,
      right: `${window.innerWidth - anchor.left + RAIL_FLYOUT_GAP_PX}px`,
      transform: 'translateY(-50%)',
    });
  };
  const hide = () => setPlace(null);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover and focus listeners for the tooltip of the button inside; the span itself is not a control.
    <span
      className="coding-workbench__rail-tip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {place
        ? createPortal(
            <span
              role="tooltip"
              className="tooltip tooltip--left coding-workbench__rail-tip"
              style={place}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function BrowserRailItem({ launcher }: { launcher: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const panelRef = useMenuFocus<HTMLElement>(open, close);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The rail scrolls, so a flyout inside it is clipped to the rail's own
  // 44px (design audit D1). It renders on the overlay layer instead, fixed
  // beside its trigger: top-aligned with it, its right edge a gap from the
  // rail, and never off the top or bottom of the viewport.
  const [place, setPlace] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const height = panel?.getBoundingClientRect().height ?? 0;
      const top = Math.max(
        RAIL_FLYOUT_GUTTER_PX,
        Math.min(
          anchor.top,
          window.innerHeight - height - RAIL_FLYOUT_GUTTER_PX,
        ),
      );
      setPlace({
        position: 'fixed',
        top: `${top}px`,
        right: `${window.innerWidth - anchor.left + RAIL_FLYOUT_GAP_PX}px`,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, panelRef]);
  return (
    <div className="coding-workbench__rail-slot">
      <RailTip label="Open Browser">
        <button
          ref={triggerRef}
          type="button"
          className="coding-workbench__rail-item"
          aria-label="Open Browser pane"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <GlobeGlyph />
        </button>
      </RailTip>
      {open
        ? createPortal(
            <section
              id={panelId}
              ref={panelRef}
              className="coding-workbench__rail-panel"
              aria-label="Browser"
              tabIndex={-1}
              style={place ?? undefined}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.stopPropagation();
                close();
              }}
            >
              {launcher}
            </section>,
            document.body,
          )
        : null}
    </div>
  );
}
const RAIL_FLYOUT_GAP_PX = 8;
const RAIL_FLYOUT_GUTTER_PX = 8;

/**
 * The host's own actions for a drill-in — pop it out (the desktop app) and
 * remove one the reader opened — as overflow rows, with the notice a failed
 * pop-out leaves. No rows when there is nothing to offer. The stack's bar
 * draws them behind one ⋯ (`PaneMoreMenu`); beside Chat the panel head hands
 * them to the pane through `PaneHeadSlots`, so a pane with an overflow of
 * its own merges them and the head has one ⋯, not two.
 */
function useHostPaneActions({
  instance,
  label,
  popOut,
  onClose,
}: {
  instance: WorkspacePaneInstance | null;
  label: string;
  popOut?: WorkspacePaneHostPopOut;
  onClose?: () => void;
}): { actions: readonly OverflowAction[]; notice: string | null } {
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const availability =
    popOut && instance
      ? 'availability' in popOut
        ? popOut.availability(instance)
        : popOut
      : null;
  const canPopOut = availability?.state === 'supported';
  const requestPopOut = useCallback(async () => {
    if (availability?.state !== 'supported' || pending || !instance) return;
    setPending(true);
    try {
      const result = await availability.request(instance);
      setNotice(
        result.status === 'opened' ? null : `${label} could not be popped out.`,
      );
    } catch {
      setNotice(`${label} could not be popped out.`);
    } finally {
      setPending(false);
    }
  }, [availability, instance, label, pending]);
  const actions = useMemo<readonly OverflowAction[]>(
    () => [
      ...(canPopOut
        ? [
            {
              key: 'pop-out',
              label: 'Pop out',
              disabled: pending,
              onSelect: () => void requestPopOut(),
            },
          ]
        : []),
      // "Remove", not "close": the head's × hides the panel and keeps the
      // pane; this takes the pane out of the workspace.
      ...(onClose
        ? [{ key: 'remove-pane', label: 'Remove pane', onSelect: onClose }]
        : []),
    ],
    [canPopOut, onClose, pending, requestPopOut],
  );
  return { actions, notice };
}

function PaneMoreMenu({
  instance,
  label,
  popOut,
  onClose,
}: {
  instance: WorkspacePaneInstance;
  label: string;
  popOut?: WorkspacePaneHostPopOut;
  onClose?: () => void;
}) {
  const { actions, notice } = useHostPaneActions({
    instance,
    label,
    popOut,
    onClose,
  });
  if (actions.length === 0) return null;
  return (
    <div className="coding-workbench__more">
      {notice ? (
        <span className="coding-workbench__more-notice" role="status">
          {notice}
        </span>
      ) : null}
      <ActionOverflowMenu
        label={`More actions for ${label}`}
        triggerClassName="coding-workbench__rail-item coding-workbench__more-trigger"
        actions={actions}
      />
    </div>
  );
}
