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
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { subscribeCenterChatPageRequests } from '../../app-shell/chat-placement';
import { useDeviceSettingsActions } from '../../contexts/DeviceSettingsContext';
import {
  type ShortcutWhen,
  useKeyboardShortcuts,
} from '../../contexts/KeyboardShortcutsContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { useMenuFocus } from '../../hooks/useMenuFocus';
import { BrowserPreviewPaneLauncher } from '../../workspace-panes/BrowserPreviewPaneLauncher';
import { useCodingChatPositionEffects } from '../../workspace-panes/CodingChatPane';
import { clearOpenFilePreviewIntent } from '../../workspace-panes/openFilePreviewIntent';
import type {
  WorkspacePaneHostCatalogRequest,
  WorkspacePaneHostPopOut,
} from '../../workspace-panes/WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from '../../workspace-panes/WorkspacePaneHostOpenContext';
import { workspacePaneHostScopeKey } from '../../workspace-panes/workspacePaneHostNavigation';
import { workspacePaneHostGroupContaining } from '../../workspace-panes/workspacePaneHostReducerTree';
import { Button } from '../Button';
import { ChatWorkspacePane } from '../chat-dock/ChatDock';
import {
  CheckGlyph,
  CodeGlyph,
  DiffGlyph,
  DocumentGlyph,
  FolderGlyph,
  GlobeGlyph,
  MoreGlyph,
  PlusGlyph,
  ShieldGlyph,
  TargetGlyph,
  TerminalGlyph,
} from '../icons/Glyph';
import { Empty } from '../state';
import type { CodingStackLocation } from './codingStackPage';
import './CodingWorkbench.css';

/**
 * Only the Chat page's own chords and the composer own text keys, so the
 * stack's Back/Forward chords stay out of a focused composer or terminal
 * (Alt+Arrow is word motion in both).
 */
const STACK_CHORD_WHEN: ShortcutWhen = {
  not: { or: ['composerFocused', 'terminalFocused'] },
};

type StackTransition = 'push' | 'pop' | null;

const readHistoryIndex = () => navigationStore.getHistoryIndex();
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

export interface CodingWorkbenchProps {
  projectId: string;
  projectSlug: string;
  /**
   * Whether this layout's centre shows Chat (`resolveLayoutChatPlacement`'s
   * `center`). False on a bottom-only device, whose Chat is the dock: the
   * Chat page then opens the dock instead of rendering Chat a second time.
   */
  centerChat: boolean;
  location: CodingStackLocation;
  scope: WorkspacePaneHostScope;
  /** The panes a drill-in can show, in the host's document order. */
  instances: readonly WorkspacePaneInstance[];
  /** The host's live document, for the catalog's target group. */
  hostDocument: () => WorkspacePaneHostDocumentV1;
  paneLabel(instance: WorkspacePaneInstance): string;
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
  location,
  scope,
  instances,
  hostDocument,
  paneLabel,
  hostOpen,
  onOpenCatalog,
  browserPreviewAvailability,
  badges = NO_BADGES,
  popOut,
  persistence = 'owned',
  closable,
  children,
}: CodingWorkbenchProps) {
  const { setDeviceSetting } = useDeviceSettingsActions();
  const { page, paneId } = location;
  const scopeKey = workspacePaneHostScopeKey(scope);
  const { isMac } = useKeyboardShortcuts();
  const historyIndex = useSyncExternalStore(
    navigationStore.subscribe,
    readHistoryIndex,
    readHistoryIndex,
  );
  const [chatTitle, setChatTitle] = useState('Chat');
  const chatPageRef = useRef<HTMLElement>(null);
  const pageRef = useRef(page);
  pageRef.current = page;

  useCodingChatPositionEffects({
    projectId,
    projectSlug,
    // A File Preview deep link is the Chat position's to open, as it was the
    // Coding tab's: on a drill-in the Files pane that wrote the intent has
    // already opened its own preview, and opening it here too would open it
    // twice.
    paneHostOpen: page === 'chat' ? hostOpen : null,
    // A phone's Chat is the dock, maximized while the Chat page is the page.
    ownsMobileDock: page === 'chat',
  });

  // ── Transitions: the entering page slides in from the side it came from —
  // a push (drill-in) from the trailing edge, a pop (Back) from the leading
  // edge. Direction is the history index delta, not the page kind, so
  // Forward onto the Chat page still reads as forward.
  const [transition, setTransition] = useState<{
    page: 'chat' | 'drill-in';
    kind: StackTransition;
  }>({ page, kind: null });
  const previous = useRef({ page, historyIndex });
  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = { page, historyIndex };
    if (last.page === page) return;
    setTransition({
      page,
      kind: historyIndex < last.historyIndex ? 'pop' : 'push',
    });
  }, [page, historyIndex]);

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
  const goBack = useCallback(() => {
    const entry = navigationStore.adjacentLocation(-1);
    if (entry?.pathname === window.location.pathname) {
      window.history.back();
      return;
    }
    // Arrived on a drill-in from elsewhere (a link, a reload): its parent is
    // the Chat page, reached forward rather than by leaving the layout.
    if (page === 'drill-in') goToChatPage();
  }, [goToChatPage, page]);
  const goForward = useCallback(() => {
    const entry = navigationStore.adjacentLocation(1);
    if (entry?.pathname === window.location.pathname) window.history.forward();
  }, []);
  useKeyboardShortcut(
    'codingStack.back',
    isMac ? '[' : 'ArrowLeft',
    isMac ? ['cmd'] : ['alt'],
    'Back in the Coding stack',
    goBack,
    true,
    0,
    STACK_CHORD_WHEN,
  );
  useKeyboardShortcut(
    'codingStack.forward',
    isMac ? ']' : 'ArrowRight',
    isMac ? ['cmd'] : ['alt'],
    'Forward in the Coding stack',
    goForward,
    true,
    0,
    STACK_CHORD_WHEN,
  );

  // The Chat page from a drill-in: Back when the entry behind is exactly the
  // Chat page (the stack does not grow), else a push to it.
  const returnToChatPage = useCallback(() => {
    if (pageRef.current !== 'drill-in') return;
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
  const [focusRequest, setFocusRequest] = useState(0);
  useEffect(() => {
    if (!centerChat) return;
    return subscribeCenterChatPageRequests(() => {
      returnToChatPage();
      setFocusRequest((request) => request + 1);
    });
  }, [centerChat, returnToChatPage]);
  useEffect(() => {
    if (focusRequest === 0 || page !== 'chat') return;
    // A few frames at most: the page stops being inert in this commit, and a
    // composer that is still mounting takes a frame to exist.
    let frame = 0;
    let attempts = 0;
    const tryFocus = () => {
      const composer = chatPageRef.current?.querySelector<HTMLTextAreaElement>(
        '.chat-input textarea',
      );
      composer?.focus();
      if (window.document.activeElement === composer || ++attempts >= 10)
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
  // conversation (Forward) is navigation, not a request.
  const activeChat = useSyncExternalStore(
    navigationStore.subscribe,
    () => navigationStore.getSnapshot().activeChat,
    () => navigationStore.getSnapshot().activeChat,
  );
  const lastChatFocus = useRef({ activeChat, paneId });
  useEffect(() => {
    const last = lastChatFocus.current;
    lastChatFocus.current = { activeChat, paneId };
    if (
      centerChat &&
      page === 'drill-in' &&
      paneId === last.paneId &&
      activeChat !== last.activeChat &&
      activeChat !== null
    )
      returnToChatPage();
  }, [activeChat, centerChat, page, paneId, returnToChatPage]);

  const drilledIn =
    page === 'drill-in'
      ? instances.find((instance) => instance.instanceId === paneId)
      : undefined;
  const drillInLabel = drilledIn ? paneLabel(drilledIn) : 'Pane';

  const openView = (instance: WorkspacePaneInstance) =>
    navigationStore.setActiveWorkspacePane(instance.instanceId, scopeKey);
  const requestCatalog = () => {
    const document = hostDocument();
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

  const pageState = (candidate: 'chat' | 'drill-in') => ({
    'data-active': page === candidate ? 'true' : 'false',
    ...(transition.page === candidate && transition.kind && page === candidate
      ? { 'data-enter': transition.kind }
      : {}),
    inert: page !== candidate || undefined,
    'aria-hidden': page !== candidate || undefined,
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

  return (
    <div className="coding-workbench">
      <div className="coding-workbench__main">
        <nav className="coding-workbench__bar" aria-label="Coding navigation">
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
                >
                  {drillInLabel}
                </span>
              </li>
            ) : null}
          </ol>
          {page === 'drill-in' && drilledIn ? (
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
          ) : null}
        </nav>
        {persistenceProblem ? (
          <p className="coding-workbench__notice" role="status">
            {persistenceProblem === 'contended'
              ? 'These views are open in another tab, so changes here are not saved.'
              : 'Changes to these views cannot be saved right now.'}
          </p>
        ) : null}
        <div className="coding-workbench__pages">
          <section
            ref={chatPageRef}
            className="coding-workbench__page coding-workbench__page--chat"
            aria-label="Chat"
            {...pageState('chat')}
          >
            {centerChat ? (
              <ChatWorkspacePane
                placement="fullscreen"
                // The dock's Chat, moved to the centre: the dock's scope
                // (every conversation), not the Chat layout's Project-bound one.
                conversationScope="ambient"
                onScreen={page === 'chat'}
                ownsDockShortcuts={false}
                onPresentationTitleChange={setChatTitle}
              />
            ) : (
              <DockChatNotice />
            )}
          </section>
          <section
            className="coding-workbench__page coding-workbench__page--drill-in"
            aria-label={drillInLabel}
            {...pageState('drill-in')}
          >
            {children}
          </section>
        </div>
      </div>
      <CodingViewRail
        instances={railInstances}
        currentPaneId={page === 'drill-in' ? paneId : null}
        paneLabel={paneLabel}
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
 * tooltip; the drill-in on screen is the solid one (`aria-current`). A click
 * pushes that drill-in onto the stack.
 */
function CodingViewRail({
  instances,
  currentPaneId,
  paneLabel,
  badges,
  onOpenView,
  onAddPane,
  browserLauncher,
}: {
  instances: readonly WorkspacePaneInstance[];
  currentPaneId: string | null;
  paneLabel(instance: WorkspacePaneInstance): string;
  badges: Readonly<Record<string, number>>;
  onOpenView(instance: WorkspacePaneInstance): void;
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
        return (
          <Tooltip key={instance.instanceId} label={name} placement="left">
            <button
              type="button"
              className="coding-workbench__rail-item"
              aria-label={name}
              aria-current={
                instance.instanceId === currentPaneId ? 'page' : undefined
              }
              onClick={() => onOpenView(instance)}
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
          </Tooltip>
        );
      })}
      {browserLauncher ? <BrowserRailItem launcher={browserLauncher} /> : null}
      {onAddPane ? (
        <Tooltip label="Add pane" placement="left">
          <button
            type="button"
            className="coding-workbench__rail-item coding-workbench__rail-item--add"
            aria-label="Add pane"
            onClick={onAddPane}
          >
            <PlusGlyph />
          </button>
        </Tooltip>
      ) : null}
    </nav>
  );
}

/**
 * The Browser launcher behind a rail icon: its address field is a form, so
 * it opens as a small labelled panel beside the rail.
 */
function BrowserRailItem({ launcher }: { launcher: ReactNode }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const panelRef = useMenuFocus<HTMLElement>(open, close);
  return (
    <div className="coding-workbench__rail-slot">
      <Tooltip label="Open Browser" placement="left">
        <button
          type="button"
          className="coding-workbench__rail-item"
          aria-label="Open Browser pane"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <GlobeGlyph />
        </button>
      </Tooltip>
      {open ? (
        <section
          id={panelId}
          ref={panelRef}
          className="coding-workbench__rail-panel"
          aria-label="Browser"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
          }}
        >
          {launcher}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The drill-in's own actions, behind one ⋯ on the breadcrumb row: what the
 * pane host's command menu offered that still matters on a page that is just
 * the pane — pop it out (the desktop app) and close one the reader opened.
 * Absent when there is nothing to offer.
 */
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
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const menuRef = useMenuFocus<HTMLDivElement>(open, close);
  const availability = popOut
    ? 'availability' in popOut
      ? popOut.availability(instance)
      : popOut
    : null;
  const canPopOut = availability?.state === 'supported';
  if (!canPopOut && !onClose) return null;
  const requestPopOut = async () => {
    if (availability?.state !== 'supported' || pending) return;
    setPending(true);
    close();
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
  };
  return (
    <div className="coding-workbench__more">
      {notice ? (
        <span className="coding-workbench__more-notice" role="status">
          {notice}
        </span>
      ) : null}
      <button
        type="button"
        className="coding-workbench__rail-item"
        aria-label={`More actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreGlyph />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="coding-workbench__more-menu"
          role="menu"
          aria-label={`Actions for ${label}`}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
          }}
        >
          {canPopOut ? (
            <button
              type="button"
              role="menuitem"
              className="coding-workbench__more-item"
              disabled={pending}
              onClick={() => void requestPopOut()}
            >
              Pop out
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              role="menuitem"
              className="coding-workbench__more-item"
              onClick={() => {
                close();
                onClose();
              }}
            >
              Close {label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
