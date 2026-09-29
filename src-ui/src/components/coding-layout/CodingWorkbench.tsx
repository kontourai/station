import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneAvailability } from '@kontourai/station-contracts/workspace-pane-availability';
import type {
  WorkspacePaneHostDocumentV1,
  WorkspacePaneHostScope,
} from '@kontourai/station-contracts/workspace-pane-host';
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
import type { WorkspacePaneHostCatalogRequest } from '../../workspace-panes/WorkspacePaneHostCommands';
import type { WorkspacePaneHostOpenAction } from '../../workspace-panes/WorkspacePaneHostOpenContext';
import { workspacePaneHostScopeKey } from '../../workspace-panes/workspacePaneHostNavigation';
import { workspacePaneHostGroupContaining } from '../../workspace-panes/workspacePaneHostReducerTree';
import { Button } from '../Button';
import { ChatWorkspacePane } from '../chat-dock/ChatDock';
import {
  ArrowDownGlyph,
  ArrowLeftGlyph,
  ArrowRightGlyph,
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
  /** The drill-in page: the layout's pane host (and its notices). */
  children: ReactNode;
}

/**
 * The Coding layout's main display as a navigation stack (#928 coding
 * stack): the conversation is the Chat page, and each pane — Files, Diff,
 * Terminal, the evidence panes, anything the "+" catalog adds — is a page
 * drilled into from it. A stack bar carries Back/Forward, the breadcrumb
 * (conversation › pane) and the Views menu that drills in.
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
  children,
}: CodingWorkbenchProps) {
  const { page, paneId } = location;
  const pathname = window.location.pathname;
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

  // ── Back / Forward.
  const back = navigationStore.adjacentLocation(-1);
  const forward = navigationStore.adjacentLocation(1);
  // An adjacent entry is "ours" when it is this layout's route: the other
  // page, or another drill-in of the same host.
  const backIsOurs = back?.pathname === pathname;
  const forwardIsOurs = forward?.pathname === pathname;
  const canGoBack = backIsOurs || page === 'drill-in';
  const canGoForward = forwardIsOurs;
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
    const frame = requestAnimationFrame(() => {
      chatPageRef.current
        ?.querySelector<HTMLTextAreaElement>('.chat-input textarea')
        ?.focus();
    });
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

  return (
    <div className="coding-workbench">
      <nav className="coding-workbench__bar" aria-label="Coding navigation">
        <div className="coding-workbench__history">
          <button
            type="button"
            className="coding-workbench__icon-button"
            aria-label="Back"
            title={isMac ? 'Back (⌘[)' : 'Back (Alt+←)'}
            disabled={!canGoBack}
            onClick={goBack}
          >
            <ArrowLeftGlyph />
          </button>
          <button
            type="button"
            className="coding-workbench__icon-button"
            aria-label="Forward"
            title={isMac ? 'Forward (⌘])' : 'Forward (Alt+→)'}
            disabled={!canGoForward}
            onClick={goForward}
          >
            <ArrowRightGlyph />
          </button>
        </div>
        <ol className="coding-workbench__crumbs" aria-label="Breadcrumb">
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
              <span aria-current="page">{chatTitle}</span>
            )}
          </li>
          {page === 'drill-in' ? (
            <li className="coding-workbench__crumb">
              <span aria-current="page">{drillInLabel}</span>
            </li>
          ) : null}
        </ol>
        <CodingViewsMenu
          instances={instances}
          currentPaneId={paneId}
          paneLabel={paneLabel}
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
      </nav>
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
              // The dock's Chat, moved to the centre: the dock's scope (every
              // conversation), not the Chat layout's Project-bound one.
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
 * The drill-in list: every pane the host holds, the "+" catalog, and the
 * Browser launcher. A disclosure of buttons rather than a `menu`, because it
 * carries the launcher's address field and a menu may only hold items.
 */
function CodingViewsMenu({
  instances,
  currentPaneId,
  paneLabel,
  onOpenView,
  onAddPane,
  browserLauncher,
}: {
  instances: readonly WorkspacePaneInstance[];
  currentPaneId: string | null;
  paneLabel(instance: WorkspacePaneInstance): string;
  onOpenView(instance: WorkspacePaneInstance): void;
  onAddPane?: () => void;
  browserLauncher: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const panelRef = useMenuFocus<HTMLElement>(open, close);
  return (
    <div className="coding-workbench__views">
      <button
        type="button"
        className="coding-workbench__views-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Views
        <ArrowDownGlyph />
      </button>
      {open ? (
        <section
          id={panelId}
          ref={panelRef}
          className="coding-workbench__views-panel"
          aria-label="Views"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            close();
          }}
        >
          <ul className="coding-workbench__views-list">
            {instances.map((instance) => (
              <li key={instance.instanceId}>
                <button
                  type="button"
                  className="coding-workbench__view"
                  aria-current={
                    instance.instanceId === currentPaneId ? 'page' : undefined
                  }
                  onClick={() => {
                    close();
                    onOpenView(instance);
                  }}
                >
                  {paneLabel(instance)}
                </button>
              </li>
            ))}
          </ul>
          {onAddPane ? (
            <button
              type="button"
              className="coding-workbench__view coding-workbench__view--add"
              onClick={() => {
                close();
                onAddPane();
              }}
            >
              Add pane…
            </button>
          ) : null}
          {browserLauncher ? (
            <div className="coding-workbench__views-launcher">
              {browserLauncher}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
