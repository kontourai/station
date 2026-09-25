import type React from 'react';
import { createPortal } from 'react-dom';
import { toastStore } from '../../contexts/ToastContext';
import { useShortcutDisplayLookup } from '../../hooks/useKeyboardShortcut';
import type { DockMode } from '../../types';
import { isSessionWorkActive } from '../../utils/execution';
import { useRegionChromeSlots } from '../../workspace-panes/RegionChromeSlots';
import { LazyBoundary } from '../LazyBoundary';
import {
  ChatDockHeaderMoreMenu,
  type DockMoreAction,
} from './ChatDockHeaderMoreMenu';
import {
  toggleSessionInventoryOccurrence,
  useSessionInventoryHostRegistered,
  useSessionInventoryOccurrence,
} from './sessionInventoryOccurrence';

const loadChatDockSessionInventoryHost = () =>
  import('./ChatDockWorkspaceControls').then((module) => ({
    default: module.ChatDockSessionInventoryHost,
  }));
const loadChatDockWorkspaceActions = () =>
  import('./ChatDockWorkspaceControls').then((module) => ({
    default: module.ChatDockWorkspaceActions,
  }));

interface Session {
  id: string;
  title: string;
  status: string;
  conversationActivity?: import('@kontourai/station-contracts/orchestration').ConversationTurnActivity;
}

/**
 * Session/identity content only Chat has. `undefined` for every non-Chat
 * occupant (Home, Activity) — those simply don't render this cluster
 * (gear, session counter/"Start a chat", activity dropdown, unread badge),
 * rather than a second component carrying a curated subset of it.
 */
export interface ChatDockHeaderChatControls {
  sessions: Session[];
  unreadCount: number;
  focusSession: (id: string) => void;
  /** Starts a new chat — the action the collapsed dock's own label promises. */
  onNewChat: () => void;
  setShowChatSettings: (fn: (prev: boolean) => boolean) => void;
}

/**
 * kontourai/station#3309: the tab strip's controls, absorbed into this one
 * header bar. The desktop dock chrome used to stack a second
 * `.chat-dock__tabs` row (inbox toggle, background tasks, context meter,
 * Open/New) under the header; every pixel of that row was transcript space,
 * and mobile had already absorbed its rows into one bar (#1066). Passed only
 * while the dock pane is open — a collapsed dock keeps its minimal bar.
 */
export interface ChatDockWorkspaceControls {
  /** False in right-dock mode, where the inbox panel does not render. */
  showInboxToggle: boolean;
  isInboxOpen: boolean;
  onToggleInbox: () => void;
  /** station#1301 slice 1: the Background tasks sheet's desktop anchor. */
  backgroundTasksTriggerRef: React.RefObject<HTMLButtonElement | null>;
  backgroundTasksRunningCount: number;
  isBackgroundTasksOpen: boolean;
  /**
   * Whether the row opens the Agents PANE rather than the sheet (#2050).
   * The dialog semantics belong to the sheet alone: a row announcing
   * `haspopup="dialog"` and an expanded state while it places a dock tab
   * would describe an interaction that does not happen.
   */
  backgroundTasksOpensPane?: boolean;
  onToggleBackgroundTasks: () => void;
  sessionInventory?: {
    /**
     * The occurrence store's key for this dock's inventory, owned by the
     * caller: since #1536 F the CONTROL is a row of this header's More menu
     * while the HOST is the lazily mounted `ChatDockSessionInventoryHost`, and
     * the two halves have to name the same host.
     */
    hostId: string;
    chatStoreId: string;
    executionId: string;
    projectId?: string;
    executionRead: 'present' | string;
    mountRef: React.RefObject<HTMLDivElement | null>;
    dockMode: DockMode;
    fullscreen: boolean;
  };
  onOpenConversation: () => void;
  /** New-chat with the single-ready-agent shortcut (opens directly). */
  onNewChat: () => void;
}

/**
 * Chat's OWN toolbar (#2046 2b): the identity, context meter, project
 * context, session counter, unread badge and More menu of the Chat pane.
 * Inside a region host it renders into the region bar's two slots
 * (`RegionChromeSlots`) so the dock keeps one chrome bar; the region's own
 * controls — placement grab, tab strip, maximize, visibility, the click
 * surface that collapses the bar — are `RegionChromeBar`'s, rendered by the
 * host from the shell's chrome, and no longer live here. The full-screen
 * placement has no region bar and renders this as its own `.chat-dock__header`.
 */
interface ChatDockHeaderProps {
  /** Absent for a non-Chat occupant — see `ChatDockHeaderChatControls`. */
  chatControls?: ChatDockHeaderChatControls;
  /**
   * The active chat's project context, rendered inline in this row rather
   * than as a third chrome bar below it. The desktop dock used to stack
   * header / identity+actions / project-context; the header's left side was
   * mostly empty and the project NAME was already shown as a badge in the
   * identity row, so the third row cost a row of vertical space to repeat
   * one label (#1064).
   */
  projectContext?: React.ReactNode;
  /** Active conversation title + engine/Flow identity, sharing this row. */
  chatIdentity?: React.ReactNode;
  /** Full-screen layout placement: no region bar, so this renders its own. */
  fullscreen?: boolean;
  /** #3309: tab-strip controls folded into this bar. Absent while collapsed. */
  workspaceControls?: ChatDockWorkspaceControls;
  /** The active session's compact context meter, rendered beside identity. */
  contextMeter?: React.ReactNode;
  /**
   * Whether the region is showing: a collapsed bar offers "Start a chat" in
   * place of the open pane's own CTA (#800).
   */
  regionVisible: boolean;
  /**
   * Extra rows for the More menu, supplied by the caller because their subject
   * is the active conversation rather than the dock's chrome — Copy thread ID,
   * Copy project path, Open code layout (#1536 F). Appended after the header's
   * own rows.
   */
  moreActions?: readonly DockMoreAction[];
}

export function ChatDockHeader({
  chatIdentity,
  projectContext,
  chatControls,
  fullscreen = false,
  workspaceControls,
  contextMeter,
  regionVisible,
  moreActions,
}: ChatDockHeaderProps) {
  const isDockOpen = regionVisible;
  const slots = useRegionChromeSlots();
  // One hook for a variable number of per-session rows: `useShortcutDisplay`
  // is a hook and cannot be called inside the activity map.
  const shortcutDisplay = useShortcutDisplayLookup();
  const activeSessions = (chatControls?.sessions ?? []).filter((s) =>
    isSessionWorkActive(s),
  );
  const inventory = workspaceControls?.sessionInventory;
  const inventoryOccurrence = useSessionInventoryOccurrence(
    inventory?.hostId ?? '',
  );
  // The host arrives with a lazily loaded chunk, so the row is not pressable
  // the instant it renders — and the chunk can fail to arrive at all. Derived
  // from the registration the host writes, never from a timer.
  const inventoryReady = useSessionInventoryHostRegistered(
    inventory?.hostId ?? '',
  );
  /**
   * #1536 F: the bar carried thirteen controls in 40px and the conversation
   * title got about one character of what was left. These are the commands
   * that are not the dock's primary verbs — every one still reachable, none of
   * them holding width the title needs.
   */
  const dockMoreActions: DockMoreAction[] = [
    ...(chatControls
      ? [
          {
            key: 'chat-settings',
            label: 'Chat settings',
            onSelect: () =>
              chatControls.setShowChatSettings((previous) => !previous),
          },
        ]
      : []),
    ...(workspaceControls?.showInboxToggle
      ? [
          {
            key: 'chat-list',
            label: workspaceControls.isInboxOpen
              ? 'Collapse chat list'
              : 'Expand chat list',
            checked: workspaceControls.isInboxOpen,
            onSelect: () => workspaceControls.onToggleInbox(),
          },
        ]
      : []),
    ...(workspaceControls
      ? [
          {
            key: 'background-tasks',
            label:
              workspaceControls.backgroundTasksRunningCount > 0
                ? `Background tasks — ${workspaceControls.backgroundTasksRunningCount} running`
                : 'Background tasks',
            ...(workspaceControls.backgroundTasksOpensPane
              ? {}
              : {
                  haspopup: 'dialog' as const,
                  expanded: workspaceControls.isBackgroundTasksOpen,
                }),
            onSelect: () => workspaceControls.onToggleBackgroundTasks(),
          },
        ]
      : []),
    ...(inventory
      ? [
          {
            key: 'session-inventory',
            label: inventoryReady
              ? 'Session inventory'
              : 'Session inventory — loading',
            haspopup: 'dialog' as const,
            expanded: Boolean(inventoryOccurrence),
            disabled: !inventoryReady,
            onSelect: (trigger: HTMLElement) => {
              // The backstop, not the mechanism: the row is disabled until the
              // registration exists, so this refusal means the host went away
              // between render and click (or its chunk never resolved). A
              // refusal nobody can see is the defect being closed here, so it
              // gets words. `toastStore` rather than `useToast`: this component
              // renders in surfaces with no ToastProvider above it, and the
              // store is the same one the provider reads (`OverflowMenu` takes
              // the same route).
              if (
                !toggleSessionInventoryOccurrence({
                  hostId: inventory.hostId,
                  projectId: inventory.projectId,
                  executionRead: inventory.executionRead,
                  trigger,
                })
              )
                toastStore.show(
                  'Session inventory is not ready for this chat yet.',
                );
            },
          },
        ]
      : []),
    ...(moreActions ?? []),
  ];

  // No "Chat Dock" label: the dock is the only thing this chrome can belong
  // to, and the row's space is worth more to the project context than to
  // restating the surface's own name (owner call, #1064). Mobile renders
  // ChatDockMobileHeader instead of this component, so mobile-only branches
  // here are unreachable (#1066).
  //
  // #1536 F: the chat-settings gear, the chat-list toggle, Background tasks,
  // Session inventory and the bare ⌘D keycap that sat here are rows of the
  // More menu in the actions cluster now. #1529 (#928 C2b) took the occupant
  // picker with the legacy docked-Home path. #2046 2b took the placement grab
  // too: it moved to the region bar with the tab strip, since it moves the
  // REGION and not this pane. What is left is the invisible inventory host
  // and the pane's own identity.
  const leading = (
    <>
      {inventory ? (
        <LazyBoundary
          load={loadChatDockSessionInventoryHost}
          pending={null}
          componentProps={{ sessionInventory: inventory }}
        />
      ) : null}
      {chatIdentity ? (
        <div className="chat-dock__header-identity">{chatIdentity}</div>
      ) : null}
      {contextMeter ? (
        <div className="chat-dock__header-meter">{contextMeter}</div>
      ) : null}
      {projectContext ? (
        <div className="chat-dock__header-context">{projectContext}</div>
      ) : null}
    </>
  );

  const trailing = (
    <>
      {workspaceControls ? (
        <LazyBoundary
          load={loadChatDockWorkspaceActions}
          pending={null}
          componentProps={workspaceControls}
        />
      ) : null}
      {activeSessions.length > 0 && (
        <div className="chat-dock__activity">
          <button type="button" className="chat-dock__activity-btn">
            <span className="loading-dots">
              <span>●</span>
              <span>●</span>
              <span>●</span>
            </span>
            {activeSessions.length}
          </button>
          <div className="chat-dock__activity-dropdown">
            {activeSessions.map((session) => {
              const idx = (chatControls?.sessions ?? []).findIndex(
                (s) => s.id === session.id,
              );
              return (
                <button
                  type="button"
                  key={session.id}
                  className="chat-dock__activity-item"
                  onClick={() => chatControls?.focusSession(session.id)}
                >
                  <span className="chat-dock__activity-label">
                    {session.title}
                  </span>
                  {/*
                      `dock.session1`…`dock.session9` are Cmd-N on macOS and
                      Ctrl-N everywhere else; the literal `⌘{n}` that used to
                      sit here named a chord no Windows or Linux user could
                      press (#1649). `getDisplay` returns '' for a session
                      index nothing has registered, and
                      `.chat-dock__subtitle:empty` hides the badge rather than
                      drawing an empty keycap.
                    */}
                  {idx < 9 && (
                    <span className="chat-dock__subtitle">
                      {shortcutDisplay(`dock.session${idx + 1}`)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {chatControls &&
        (!chatIdentity || chatControls.sessions.length > 0) &&
        (chatControls.sessions.length === 0 ? (
          !isDockOpen ? (
            // #800: this read "Start a chat" and carried a pointer cursor,
            // but was inert text — clicking it only toggled the dock open
            // (the header's own handler) and left the user hunting for
            // "New". It does what it says now.
            <button
              type="button"
              className="chat-dock__counter chat-dock__counter-action"
              onClick={(event) => {
                event.stopPropagation();
                chatControls.onNewChat();
              }}
            >
              Start a chat
            </button>
          ) : (
            <span className="chat-dock__counter">Start a chat</span>
          )
        ) : chatControls.sessions.length > 1 ? (
          // #1536 F: "1 session" is not a count anyone reads — it is the
          // state you are always in with one chat open, priced in a bar that
          // could not fit the conversation's own title. A real count (more
          // than one) still earns its words; the chat list rail is what
          // enumerates them either way.
          <span className="chat-dock__counter">
            {`${chatControls.sessions.length} sessions`}
          </span>
        ) : null)}
      {chatControls && chatControls.unreadCount > 0 && (
        <span className="chat-dock__badge">{chatControls.unreadCount}</span>
      )}
      <ChatDockHeaderMoreMenu
        actions={dockMoreActions}
        // The Background tasks sheet anchors to the control that opened it,
        // and since #1536 F that control is this menu's trigger.
        triggerRef={workspaceControls?.backgroundTasksTriggerRef}
        // Folding Background tasks into the menu took its running-count badge
        // off the bar with it, and a count that only exists inside a closed
        // menu is not a signal. It rides the trigger instead.
        badgeCount={workspaceControls?.backgroundTasksRunningCount ?? 0}
        badgeLabel={
          workspaceControls && workspaceControls.backgroundTasksRunningCount > 0
            ? `${workspaceControls.backgroundTasksRunningCount} background task${
                workspaceControls.backgroundTasksRunningCount === 1 ? '' : 's'
              } running`
            : undefined
        }
      />
    </>
  );

  // Inside a region host the bar is the region's (`RegionChromeBar`), and
  // this pane's toolbar renders INTO it: one chrome bar per dock, not a pane
  // bar under a region bar. Portalled, so the DOM order is the bar's — the
  // strip, then this identity, then the region controls — while React
  // ownership (the More menu's anchor ref, the lazy chunks) stays here. A
  // slot that has not mounted yet renders nothing for that render rather
  // than flashing an inline bar first.
  if (!fullscreen && slots) {
    return (
      <>
        {slots.leading ? createPortal(leading, slots.leading) : null}
        {slots.trailing ? createPortal(trailing, slots.trailing) : null}
      </>
    );
  }

  return (
    <div className="chat-dock__header">
      <div className="chat-dock__title">
        {leading}
        {/* The row's growth, on an empty element rather than inside any of the
            labels above: the identity and the project context used to grow
            themselves, which spread them to opposite ends and made one bar read
            as three fragments (#1536 F). */}
        <span className="chat-dock__title-spacer" />
      </div>
      <div className="chat-dock__header-actions">{trailing}</div>
    </div>
  );
}
