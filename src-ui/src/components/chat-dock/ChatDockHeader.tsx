import type React from 'react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { toastStore } from '../../contexts/ToastContext';
import {
  useShortcutDisplay,
  useShortcutDisplayLookup,
} from '../../hooks/useKeyboardShortcut';
import type { DockMode } from '../../types';
import { isSessionWorkActive } from '../../utils/execution';
import { useRegionChromeSlots } from '../../workspace-panes/RegionChromeSlots';
import { LazyBoundary } from '../LazyBoundary';
import { NewChatAction } from '../NewChatAction';
import {
  ChatDockHeaderMoreMenu,
  type DockMoreAction,
} from './ChatDockHeaderMoreMenu';
import { inboxToggleLabel, workingChatsLabel } from './inbox-toggle-label';
import {
  toggleSessionInventoryOccurrence,
  useSessionInventoryHostRegistered,
  useSessionInventoryOccurrence,
} from './sessionInventoryOccurrence';
import './ChatDockHeader.css';

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
 * (gear, the collapsed New chat action, activity dropdown, unread badge),
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
  /** The inbox's "Needs you" count, named on the toggle while it is hidden. */
  inboxNeedsYouCount?: number;
  /**
   * The inbox's Running rows (`useInboxWorkingCount`): the "N working" the
   * toggle wears is the count of exactly those rows.
   */
  inboxWorkingCount?: number;
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
    /**
     * A phone presents the inventory as its full-height sheet. The desktop
     * header never mounts on a phone, so only the dock's own phone host
     * sets this.
     */
    isMobile?: boolean;
    /**
     * Where focus goes when the inventory closes and the element that opened
     * it is gone (#3882: the session context card folds while the inventory
     * is open, taking its Chat inventory button with it).
     */
    restoreFocusFallback?: () => void;
  };
  onOpenConversation: () => void;
  /** Opens the New Chat picker, where installed Skills appear too (#3170). */
  onNewChat: () => void;
}

/**
 * Chat's OWN toolbar (#2046 2b). What belongs here is the chat on screen and
 * the dock's primary verbs: the identity (title, agent, engine, on one line),
 * the inbox toggle, New with its destination project, and ONE overflow menu
 * that holds everything else — the working chats, the chat's commands, and
 * the region's own commands when the region host offers them
 * (`RegionMenu`). The context meter lives in the composer beside the model
 * it measures; branch and directory facts live in the session context card.
 * See docs/design/placement.md, "What the dock header holds".
 *
 * Inside a region host it renders into the region bar's two slots
 * (`RegionChromeSlots`) so the dock keeps one chrome bar; the region's
 * placement grab, tab strip and visibility chevron are `RegionChromeBar`'s.
 * The full-screen placement has no region bar and renders this as its own
 * `.chat-dock__header`.
 */
interface ChatDockHeaderProps {
  /** Absent for a non-Chat occupant — see `ChatDockHeaderChatControls`. */
  chatControls?: ChatDockHeaderChatControls;
  /**
   * Where New starts a chat: the dock's project, as the second half of the
   * New split button (`ChatDockProjectContext`). It changes the destination
   * only; switching never opens or creates a chat (#4524).
   */
  projectContext?: React.ReactNode;
  /** Active conversation title + engine/Flow identity, sharing this row. */
  chatIdentity?: React.ReactNode;
  /** Imported chats keep their origin visible when no composer owns that context. */
  retainIdentityInNamedPane?: boolean;
  /** Full-screen layout placement: no region bar, so this renders its own. */
  fullscreen?: boolean;
  /** #3309: tab-strip controls folded into this bar. Absent while collapsed. */
  workspaceControls?: ChatDockWorkspaceControls;
  /**
   * Whether the region is showing: a collapsed bar offers the icon-only New
   * chat action in place of the open pane's own CTA (#800).
   */
  regionVisible: boolean;
  /**
   * Extra rows for the More menu, supplied by the caller because their subject
   * is the active conversation rather than the dock's chrome — Copy thread ID,
   * Copy project path, Open in Coding (#1536 F). Appended after the header's
   * own rows.
   */
  moreActions?: readonly DockMoreAction[];
  /**
   * The session context card's chip, shown while the dock is too narrow for
   * the card itself. Absent while the card is beside the transcript.
   */
  sessionContextChip?: React.ReactNode;
  /**
   * The session context card carries the background-task count while it is
   * beside the transcript, so the More trigger does not repeat it.
   */
  backgroundTasksBadgeHidden?: boolean;
}

export function ChatDockHeader({
  chatIdentity,
  retainIdentityInNamedPane = false,
  projectContext,
  chatControls,
  fullscreen = false,
  workspaceControls,
  regionVisible,
  moreActions,
  sessionContextChip,
  backgroundTasksBadgeHidden = false,
}: ChatDockHeaderProps) {
  const isDockOpen = regionVisible;
  const slots = useRegionChromeSlots();
  // One hook for a variable number of per-session rows: `useShortcutDisplay`
  // is a hook and cannot be called inside the activity map.
  const shortcutDisplay = useShortcutDisplayLookup();
  const openShortcut = useShortcutDisplay('dock.openConversation');
  const activeSessions = (chatControls?.sessions ?? []).filter((s) =>
    isSessionWorkActive(s),
  );
  const unreadCount = chatControls?.unreadCount ?? 0;
  const regionMenu = slots && !fullscreen ? slots.regionMenu : undefined;
  const absorbRegionActions = regionMenu?.absorb;
  // While this toolbar is in the bar, the region's commands are rows of its
  // More menu and the bar drops its own buttons for them.
  useEffect(() => absorbRegionActions?.(), [absorbRegionActions]);
  const showInboxToggle = Boolean(workspaceControls?.showInboxToggle);
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
    // The working chats, first: the quick jump the bar's "N chats working"
    // dropdown used to be. Their count rides the inbox toggle (or, without
    // one, this menu's trigger); the per-chat chords still work everywhere.
    ...activeSessions.map((session) => {
      const index = (chatControls?.sessions ?? []).findIndex(
        (item) => item.id === session.id,
      );
      const shortcut =
        index >= 0 && index < 9
          ? shortcutDisplay(`dock.session${index + 1}`)
          : '';
      return {
        key: `working-${session.id}`,
        label: session.title,
        glyph: <span className="chat-dock__working-glyph" aria-hidden="true" />,
        ...(shortcut ? { shortcut } : {}),
        onSelect: (trigger: HTMLElement) => {
          trigger.focus();
          chatControls?.focusSession(session.id);
        },
      };
    }),
    // B1: "Open" was the bar's second labelled button for the same noun as
    // "New". It is the menu's first row, with its chord where the tooltip
    // used to carry it.
    ...(workspaceControls
      ? [
          {
            key: 'open-chat',
            label: withShortcutHint(
              'Open chat…',
              'dock.openConversation',
              () => openShortcut,
            ),
            onSelect: () => workspaceControls.onOpenConversation(),
          },
        ]
      : []),
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
              ? 'Chat inventory'
              : 'Chat inventory — loading',
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
                  full: true,
                  hostId: inventory.hostId,
                  projectId: inventory.projectId,
                  executionRead: inventory.executionRead,
                  trigger,
                })
              )
                toastStore.show(
                  'Chat inventory is not ready for this chat yet.',
                );
            },
          },
        ]
      : []),
    ...(moreActions ?? []),
    ...(regionMenu?.actions ?? []),
  ].map((action, index, rows) =>
    // The commands after the working chats start their own group.
    index > 0 &&
    rows[index - 1]?.key.startsWith('working-') &&
    !action.key.startsWith('working-')
      ? { ...action, separatorBefore: true }
      : action,
  );
  // The same fact the inbox rows show when the dock has it; the open chat
  // tabs only without one (a dock with no inbox behind it).
  const workingCount =
    workspaceControls?.inboxWorkingCount ?? activeSessions.length;
  const workingLabel = workingChatsLabel(workingCount, unreadCount);
  const backgroundTasksCount = backgroundTasksBadgeHidden
    ? 0
    : (workspaceControls?.backgroundTasksRunningCount ?? 0);
  const backgroundTasksLabel =
    backgroundTasksCount > 0
      ? `${backgroundTasksCount} background task${backgroundTasksCount === 1 ? '' : 's'} running`
      : undefined;
  // The inbox toggle shows the working count as a number.
  const toggleWearsNumber = showInboxToggle && workingCount > 0;

  // No "Chat Dock" label: the dock is the only thing this chrome can belong
  // to, and the row's space is worth more to the project context than to
  // restating the surface's own name (owner call, #1064). Mobile renders
  // ChatDockMobileHeader instead of this component, so mobile-only branches
  // here are unreachable (#1066).
  //
  // #1536 F: the chat-settings gear, Background tasks,
  // Session inventory and the bare ⌘D keycap that sat here are rows of the
  // More menu in the actions cluster now. #1529 (#928 C2b) took the occupant
  // picker with the legacy docked-Home path. #2046 2b took the placement grab
  // too: it moved to the region bar with the tab strip, since it moves the
  // REGION and not this pane. What is left is the pane's own identity.
  const leading = (
    <>
      {chatIdentity && (!slots?.namesPane || retainIdentityInNamedPane) ? (
        <div
          className={`chat-dock__header-identity${slots?.namesPane ? ' chat-dock__header-identity--pane' : ''}`}
        >
          {chatIdentity}
        </div>
      ) : null}
      {sessionContextChip ?? null}
    </>
  );

  const trailing = (
    <>
      {inventory ? (
        <button
          type="button"
          className="chat-dock__inventory-button"
          aria-label="Chat inventory"
          title="Messages, tool results, decisions and outputs in this chat"
          aria-expanded={Boolean(inventoryOccurrence)}
          disabled={!inventoryReady}
          onClick={(event) =>
            dockMoreActions
              .find((action) => action.key === 'session-inventory')
              ?.onSelect(event.currentTarget)
          }
        >
          Inventory
        </button>
      ) : null}
      {showInboxToggle && workspaceControls ? (
        <button
          type="button"
          className="chat-dock__icon-btn chat-dock__inbox-toggle"
          aria-label={inboxToggleLabel(
            workspaceControls.isInboxOpen,
            workspaceControls.inboxNeedsYouCount,
            workingCount,
            unreadCount,
          )}
          title={inboxToggleLabel(
            workspaceControls.isInboxOpen,
            workspaceControls.inboxNeedsYouCount,
            workingCount,
            unreadCount,
          )}
          aria-pressed={workspaceControls.isInboxOpen}
          data-unread={unreadCount > 0 ? '' : undefined}
          onClick={workspaceControls.onToggleInbox}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
          >
            <rect
              x="2"
              y="2"
              width="12"
              height="12"
              rx="2"
              stroke="currentColor"
            />
            <path d="M6 2v12" stroke="currentColor" />
            <path
              d={
                workspaceControls.isInboxOpen ? 'm10 6-2 2 2 2' : 'm9 6 2 2-2 2'
              }
              stroke="currentColor"
            />
          </svg>
          {workingCount > 0 ? (
            <span className="chat-dock__inbox-working" aria-hidden="true">
              {workingCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {workspaceControls ? (
        <div className="chat-dock__new-split">
          <LazyBoundary
            load={loadChatDockWorkspaceActions}
            pending={null}
            componentProps={{
              ...workspaceControls,
              iconOnly: Boolean(slots?.namesPane),
            }}
          />
          {projectContext && !slots?.namesPane ? projectContext : null}
        </div>
      ) : null}
      {/* #800: the COLLAPSED bar's one affordance, a real action: the same
          New chat action every other chrome uses, icon-only and named, so
          the bar no longer offers a second worded way to start ("Start a
          chat" beside "New chat"). It opens the dock's start composer. */}
      {chatControls &&
        !slots?.namesPane &&
        !isDockOpen &&
        !chatIdentity &&
        chatControls.sessions.length === 0 && (
          <NewChatAction
            iconOnly
            className="chat-dock__collapsed-new"
            title={withShortcutHint('New chat', 'dock.newChat', () =>
              shortcutDisplay('dock.newChat'),
            )}
            onClick={(event) => {
              event.stopPropagation();
              chatControls.onNewChat();
            }}
          />
        )}
      {/* The working chats are rows of this menu, so choosing one may hand
          focus on to that chat's composer (`useWorkingChatFocus`). */}
      <span className="chat-dock__more" data-working-chat-origin="">
        <ChatDockHeaderMoreMenu
          actions={dockMoreActions.filter(
            (action) => action.key !== 'session-inventory',
          )}
          // With no inbox toggle on the bar (a side dock, a collapsed bar),
          // the working and unread counts ride this trigger instead, the way
          // the phone's Chat actions trigger carries them. While the toggle
          // wears its own number, the background-task count rides here as a
          // dot (still named in the trigger), so the bar never shows two
          // number badges side by side.
          status={
            showInboxToggle
              ? toggleWearsNumber
                ? backgroundTasksLabel
                : undefined
              : workingLabel
          }
          // The Background tasks sheet anchors to the control that opened it,
          // and since #1536 F that control is this menu's trigger.
          triggerRef={workspaceControls?.backgroundTasksTriggerRef}
          // Folding Background tasks into the menu took its running-count badge
          // off the bar with it, and a count that only exists inside a closed
          // menu is not a signal. It rides the trigger instead.
          badgeCount={toggleWearsNumber ? 0 : backgroundTasksCount}
          badgeLabel={toggleWearsNumber ? undefined : backgroundTasksLabel}
        />
      </span>
    </>
  );

  // Inside a region host the bar is the region's (`RegionChromeBar`), and
  // this pane's toolbar renders INTO it: one chrome bar per dock, not a pane
  // bar under a region bar. Portalled, so the DOM order is the bar's — the
  // strip, then this identity, then the region controls — while React
  // ownership (the More menu's anchor ref, the lazy chunks) stays here. A
  // slot that has not mounted yet renders nothing for that render rather
  // than flashing an inline bar first.
  //
  // A full-screen placement has no region bar and ignores a region's slots —
  // except a bar that names the pane itself (the Coding layout's
  // breadcrumb, #3046), which it joins: its own bar would repeat the title.
  if (slots && (!fullscreen || slots.namesPane)) {
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
