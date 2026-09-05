import type React from 'react';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { toastStore } from '../../contexts/ToastContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import type { DockMode } from '../../types';
import { isSessionExecutionActive } from '../../utils/execution';
import { LazyBoundary } from '../LazyBoundary';
import {
  ChatDockHeaderMoreMenu,
  type DockMoreAction,
} from './ChatDockHeaderMoreMenu';
import { DockPlacementControl } from './DockPlacementControl';
import type { DockSnap } from './dockSnap';
import { readDockSnap } from './dockSnap';
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

function RegionExtentGlyph({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className="chat-dock__extent-svg"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      {expanded ? (
        <path d="M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6" />
      ) : (
        <path d="M3 9h6V3m12 6h-6V3M3 15h6v6m12-6h-6v6" />
      )}
    </svg>
  );
}

interface Session {
  id: string;
  title: string;
  status: string;
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

interface ChatDockHeaderProps {
  /** Absent for a non-Chat occupant — see `ChatDockHeaderChatControls`. */
  chatControls?: ChatDockHeaderChatControls;
  isDragging: boolean;
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
  /** Single owner for the persisted snap + navigation maximize state. */
  onDockSnap: (snap: DockSnap) => void;
  /** Full-screen layout placement keeps ambient dock controls out of its chrome. */
  fullscreen?: boolean;
  /** #3309: tab-strip controls folded into this bar. Absent while collapsed. */
  workspaceControls?: ChatDockWorkspaceControls;
  /** The active session's compact context meter, rendered beside identity. */
  contextMeter?: React.ReactNode;
  availableDockSlotPlacements: readonly DockMode[];
  effectiveDockSlotPlacement: DockMode;
  onDockPlacementChange: (placement: DockMode) => void;
  /**
   * A pre-rendered `DockOccupantPicker`, not `{current, onChoose}` data
   * (station#4460 review M4): this component is imported by the EAGER entry
   * path (`ChatDock.tsx` → `App.tsx`), and `DockOccupantPicker` pulls in
   * `ambientDockOccupants.ts` plus all three pane-descriptor contracts
   * modules — real weight that belongs in the ambient host's LAZY chunk,
   * which is the only place that still imports `DockOccupantPicker` and
   * builds this node. Absent only for the full-screen Chat layout
   * placement, which has no ambient occupant to switch away from.
   */
  occupantPicker?: React.ReactNode;
  regionVisible: boolean;
  shellMaximized: boolean;
  /** Registered visibility shortcut for the shell's surface. */
  surfaceShortcutId?: string;
  /** Registered title for a non-Chat shell's visibility action. */
  surfaceTitle?: string;
  /** Whether this shell owns the Chat-only maximize state. */
  canMaximize?: boolean;
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
  isDragging,
  onDockSnap,
  fullscreen = false,
  workspaceControls,
  contextMeter,
  availableDockSlotPlacements,
  effectiveDockSlotPlacement,
  onDockPlacementChange,
  occupantPicker,
  regionVisible,
  shellMaximized,
  surfaceShortcutId = 'dock.toggle',
  surfaceTitle,
  canMaximize = true,
  moreActions,
}: ChatDockHeaderProps) {
  const isDockOpen = regionVisible;
  const isDockMaximized = shellMaximized;
  const toggleDockShortcut = useShortcutDisplay(surfaceShortcutId);
  const maximizeShortcut = useShortcutDisplay('dock.maximize');
  const visibilityLabel = surfaceTitle
    ? `${isDockOpen ? 'Hide' : 'Show'} ${surfaceTitle}`
    : `${isDockOpen ? 'Hide' : 'Show'} dock region`;
  const side =
    effectiveDockSlotPlacement === 'bottom' ? null : effectiveDockSlotPlacement;
  const activeSessions = (chatControls?.sessions ?? []).filter((s) =>
    isSessionExecutionActive(s),
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
            haspopup: 'dialog' as const,
            expanded: workspaceControls.isBackgroundTasksOpen,
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

  const handleHeaderClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (fullscreen) return;
    /**
     * The header row toggles the dock, but it now also hosts the project
     * context and identity (#1064), whose interactive descendants must not
     * double as a toggle. Deciding that here — rather than making each child
     * stop propagation — leaves non-interactive context text available as a
     * toggle when its conditional path handler is absent, and avoids making a
     * wrapper `<div onClick>` a static element with a mouse handler and no
     * keyboard equivalent.
     */
    if (
      event.target instanceof Element &&
      event.target.closest(
        'a, button, [role="button"], [role="link"], input, select, textarea',
      )
    ) {
      return;
    }
    onDockSnap(isDockOpen ? 'collapsed' : 'half');
  };

  const handleMaximize = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isDockMaximized) {
      onDockSnap('half');
    } else {
      onDockSnap('full');
    }
  };

  return (
    // A convenience click surface that duplicates the labelled Expand/Collapse
    // button below, which is already the keyboard path. Giving the bar its own
    // role and tab stop would add a second, unlabelled way to do the same
    // thing — and it wraps the dock's other controls, so it would nest
    // interactive content inside an interactive element.
    // biome-ignore lint/a11y/noStaticElementInteractions: convenience mouse surface; keyboard path is the Expand/Collapse button.
    // biome-ignore lint/a11y/useKeyWithClickEvents: same — duplicating a labelled control, not adding one.
    <div
      className={`chat-dock__header ${isDockMaximized ? 'is-maximized' : ''} ${isDragging ? 'is-dragging' : ''}`}
      onClick={handleHeaderClick}
    >
      <div className="chat-dock__title">
        {/* No "Chat Dock" label: the dock is the only thing this chrome can
            belong to, and the row's space is worth more to the project
            context than to restating the surface's own name (owner call,
            #1064). Mobile renders ChatDockMobileHeader instead of this
            component, so mobile-only branches here are unreachable (#1066). */}
        {!fullscreen ? (
          <DockPlacementControl
            availablePlacements={availableDockSlotPlacements}
            effectivePlacement={effectiveDockSlotPlacement}
            onPlacementChange={onDockPlacementChange}
          />
        ) : null}
        {/* station#4460: every ambient occupant carries the SAME switcher —
            Chat is one entry in the menu, not a special case with no way
            back in. Replaces the old fixed "Dock this pane"/"return to
            Chat" idea entirely: choosing THIS occupant again is a no-op
            (`DockOccupantPicker` itself guards that), so there is no
            meaningful second control to suppress. Pre-rendered by the
            caller — see the `occupantPicker` prop doc. */}
        {!fullscreen ? occupantPicker : null}
        {/* #1536 F: the chat-settings gear, the chat-list toggle, Background
            tasks, Session inventory and the bare ⌘D keycap that sat here are
            rows of the More menu in the actions cluster now. The keycap is
            gone rather than moved: `withShortcutHint` already puts the chord
            in the visibility control's tooltip, which is where every other
            shortcut in this bar lives. */}
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
        {/* The row's growth, on an empty element rather than inside any of the
            labels above: the identity and the project context used to grow
            themselves, which spread them to opposite ends and made one bar read
            as three fragments (#1536 F). */}
        <span className="chat-dock__title-spacer" />
      </div>
      {/* An event shield, not a control: its only handler stops the click
          from reaching the collapse surface above. There is no action here to
          give a keyboard user — the real controls are its children. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: event shield with no action of its own. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: nothing to activate; children carry the actions. */}
      <div
        className="chat-dock__header-actions"
        onClick={(e) => e.stopPropagation()}
      >
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
                    {idx < 9 && (
                      <span className="chat-dock__subtitle">⌘{idx + 1}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {chatControls &&
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
            workspaceControls &&
            workspaceControls.backgroundTasksRunningCount > 0
              ? `${workspaceControls.backgroundTasksRunningCount} background task${
                  workspaceControls.backgroundTasksRunningCount === 1 ? '' : 's'
                } running`
              : undefined
          }
        />
        {!fullscreen && (
          <>
            {canMaximize ? (
              <button
                type="button"
                className="chat-dock__maximize-btn"
                onClick={handleMaximize}
                title={
                  isDockMaximized
                    ? withShortcutHint(
                        'Restore dock region size',
                        'dock.maximize',
                        () => maximizeShortcut,
                      )
                    : withShortcutHint(
                        'Expand dock region to workspace',
                        'dock.maximize',
                        () => maximizeShortcut,
                      )
                }
                aria-label={
                  isDockMaximized
                    ? 'Restore dock region size'
                    : 'Expand dock region to workspace'
                }
              >
                <RegionExtentGlyph expanded={isDockMaximized} />
              </button>
            ) : null}
            <button
              type="button"
              className="chat-dock__icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDockSnap(
                  isDockOpen
                    ? 'collapsed'
                    : canMaximize && readDockSnap() === 'full'
                      ? 'full'
                      : 'half',
                );
              }}
              title={withShortcutHint(
                visibilityLabel,
                surfaceShortcutId,
                () => toggleDockShortcut,
              )}
              aria-label={visibilityLabel}
            >
              <svg
                aria-hidden="true"
                className={`chat-dock__chevron-svg ${side ? `is-${side}-${isDockOpen ? 'open' : 'closed'}` : isDockOpen ? 'is-open' : 'is-closed'}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
