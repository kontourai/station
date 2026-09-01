import type React from 'react';
import { withShortcutHint } from '../../contexts/KeyboardShortcutsContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import type { DockMode } from '../../types';
import { isSessionExecutionActive } from '../../utils/execution';
import { LazyBoundary } from '../LazyBoundary';
import { DockPlacementControl } from './DockPlacementControl';
import type { DockSnap } from './dockSnap';
import { readDockSnap } from './dockSnap';

const loadChatDockWorkspaceControls = () =>
  import('./ChatDockWorkspaceControls').then((module) => ({
    default: module.ChatDockWorkspaceControls,
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
}: ChatDockHeaderProps) {
  const { isDockOpen, isDockMaximized } = useNavigation();
  const toggleDockShortcut = useShortcutDisplay('dock.toggle');
  const maximizeShortcut = useShortcutDisplay('dock.maximize');
  const side =
    effectiveDockSlotPlacement === 'bottom' ? null : effectiveDockSlotPlacement;
  const activeSessions = (chatControls?.sessions ?? []).filter((s) =>
    isSessionExecutionActive(s),
  );

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
        <span className="chat-dock__subtitle">{toggleDockShortcut}</span>
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
        {chatControls && (
          <button
            type="button"
            className="chat-dock__icon-btn"
            onClick={(e) => {
              e.stopPropagation();
              chatControls.setShowChatSettings((prev) => !prev);
            }}
            title="Chat settings"
            aria-label="Chat settings"
          >
            <svg
              aria-hidden="true"
              className="chat-dock__icon-svg"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
          </button>
        )}
        {workspaceControls ? (
          <LazyBoundary
            load={loadChatDockWorkspaceControls}
            pending={null}
            componentProps={workspaceControls}
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
          (chatControls.sessions.length === 0 && !isDockOpen ? (
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
            <span className="chat-dock__counter">
              {chatControls.sessions.length === 0
                ? 'Start a chat'
                : `${chatControls.sessions.length} session${chatControls.sessions.length === 1 ? '' : 's'}`}
            </span>
          ))}
        {chatControls && chatControls.unreadCount > 0 && (
          <span className="chat-dock__badge">{chatControls.unreadCount}</span>
        )}
        {!fullscreen && (
          <>
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
              <span className="chat-dock__subtitle">{maximizeShortcut}</span>
            </button>
            <button
              type="button"
              className="chat-dock__icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDockSnap(
                  isDockOpen
                    ? 'collapsed'
                    : readDockSnap() === 'full'
                      ? 'full'
                      : 'half',
                );
              }}
              title={withShortcutHint(
                !isDockOpen ? 'Show dock region' : 'Hide dock region',
                'dock.toggle',
                () => toggleDockShortcut,
              )}
              aria-label={!isDockOpen ? 'Show dock region' : 'Hide dock region'}
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
