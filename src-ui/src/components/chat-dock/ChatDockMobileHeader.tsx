import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useId, useRef, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import {
  ArrowDownGlyph,
  FolderGlyph,
  MenuGlyph,
  NewChatGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import '../NewChatAction.css';
import type { DockMoreAction } from './ChatDockHeaderMoreMenu';
import { ProjectSwitcherOverlay } from './ChatDockProjectContext';
import { MobileSheetPending } from './MobileSheetPending';

const loadChatDockMobileOverflowSheet = () =>
  import('./ChatDockMobileOverflowSheet').then((module) => ({
    default: module.ChatDockMobileOverflowSheet,
  }));

export interface ChatDockMobileOverflowActions {
  onOpenConversation: () => void;
  onToggleHistory: () => void;
  onOpenChatSettings: () => void;
  onOpenConversationHistory?: () => void;
  /**
   * Desktop More-menu parity: the dock header's clipboard rows (Copy thread
   * ID, Copy session ID once diverged, Copy project path) from
   * `useDockCopyActions`. A coarse device has no hover tooltip to carry these
   * identities, so the sheet is their only home. Absent: no rows.
   */
  copyActions?: DockMoreAction[];
  onOpenProject: (() => void) | null;
  openProjectName: string | null;
  inputOriginLabel?: string;
  onOpenProfile: () => void;
  onOpenAppSettings: () => void;
  sessionInventory?: {
    sessionId: string;
    chatStoreId: string;
  };
  onCollapseDock: () => void;
  onExpandDock: () => void;
  onRestoreDock: () => void;
  isDockMaximized: boolean;
  dockControls?: boolean;
  /**
   * The panes of the region this dock renders, in tab order, the selected
   * one marked (#2046 2b, `DockShellChrome.regionPanes`). The sheet lists
   * every OTHER pane as a switch row — the coarse device's stand-in for the
   * tab strip. Absent or one pane: no rows.
   */
  regionPanes?: readonly { id: string; title: string; selected: boolean }[];
  onSelectRegionPane?: (surfaceId: string) => void;
  /**
   * #2510: the sheet's entry to the dock's Background tasks surface, routed
   * by ChatDock's `showBackgroundTasks` (the sheet on a bottom-only device,
   * the Agents pane where a side region exists). It OPENS rather than
   * toggles: the overflow sheet dismisses itself on the tap, so there is no
   * open state for it to toggle against.
   * Absent: no row (ChatDock omits it when there is no chat for the sheet to
   * read).
   */
  onOpenBackgroundTasks?: () => void;
  backgroundTasksRunningCount?: number;
}

export interface ChatDockMobileProjectSwitcher {
  projectSlug: string;
  projectName: string;
  projects: ProjectMetadata[];
  onOpenProject: (projectSlug: string) => void;
  onSwitchProject: (projectSlug: string, projectName: string) => void;
}

export interface ChatDockMobileDockToggle {
  state: 'collapsed' | 'open';
  onExpand: () => void;
  onCollapse: () => void;
}

interface ChatDockMobileHeaderProps {
  showDrawerToggle: boolean;
  showConnection: boolean;
  sessionTitle: string;
  routeLabel?: string;
  sessionProjectMismatchLabel?: string | null;
  agentIdentity: { name: string; slug: string; icon?: string } | null;
  branchLabel: string | null;
  projectScope?: { name: string; onClear: () => void };
  projectSwitcher: ChatDockMobileProjectSwitcher | null;
  activeCount: number;
  unreadCount: number;
  taskSwitcherTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenTaskSwitcher: () => void;
  onToggleSidebar: (trigger: HTMLElement) => void;
  onDragPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onDragClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  dockToggle: ChatDockMobileDockToggle | null;
  onNewChat: () => void;
  overflow: ChatDockMobileOverflowActions;
}

/** Project and conversation context stay directly operable; secondary actions use the sheet. */
export function ChatDockMobileHeader({
  showDrawerToggle,
  showConnection,
  sessionTitle,
  routeLabel,
  sessionProjectMismatchLabel,
  agentIdentity,
  branchLabel,
  projectScope,
  projectSwitcher,
  activeCount,
  unreadCount,
  taskSwitcherTriggerRef,
  onOpenTaskSwitcher,
  onToggleSidebar,
  onDragPointerDown,
  onDragClickCapture,
  dockToggle,
  onNewChat,
  overflow,
}: ChatDockMobileHeaderProps) {
  const [isOverflowOpen, setIsOverflowOpen] = useState(false);
  const [isProjectOpen, setIsProjectOpen] = useState(false);
  const projectTriggerRef = useRef<HTMLButtonElement>(null);
  const chatActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const titleDescriptionId = useId();
  const activityDescriptionId = useId();
  // The dot on ⋯ used to be decoration only: an unexplained orange mark on
  // the chat-actions button. It means chats (this one included) are working
  // or have unread replies — the sheet's Chats row is where they are — so it
  // says so, as the button's description rather than its name.
  const activitySummary = [
    activeCount > 0
      ? `${activeCount} ${activeCount === 1 ? 'chat' : 'chats'} working`
      : null,
    unreadCount > 0 ? `${unreadCount} unread` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div
      className="chat-dock__header chat-dock__mobile-header"
      onPointerDown={onDragPointerDown}
      onClickCapture={onDragClickCapture}
      data-dock-drag-surface=""
      data-testid="chat-dock-mobile-header"
    >
      <div className="chat-dock__mobile-leading">
        {showDrawerToggle ? (
          <button
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
            aria-label="Toggle menu"
            aria-controls="mobile-navigation"
            data-no-dock-drag=""
            onClick={(event) => onToggleSidebar(event.currentTarget)}
          >
            <MenuGlyph />
          </button>
        ) : dockToggle ? (
          <button
            type="button"
            className="app-toolbar__icon-btn chat-dock__mobile-header-icon"
            aria-label={
              dockToggle.state === 'collapsed' ? 'Expand chat' : 'Collapse chat'
            }
            data-no-dock-drag=""
            onClick={
              dockToggle.state === 'collapsed'
                ? dockToggle.onExpand
                : dockToggle.onCollapse
            }
          >
            <ArrowDownGlyph />
          </button>
        ) : null}
        {projectSwitcher && (
          <button
            ref={projectTriggerRef}
            type="button"
            className="chat-dock__mobile-project"
            aria-label={`Switch project — ${projectSwitcher.projectName}`}
            aria-haspopup="dialog"
            aria-expanded={isProjectOpen}
            data-dock-drag-passthrough=""
            onClick={() => setIsProjectOpen(true)}
          >
            {/* Too narrow for words (a long chat title takes the bar), the
                control shows only its glyph; its aria-label still names the
                project. The CSS container query decides which shows. */}
            <span
              className="chat-dock__mobile-project-glyph"
              aria-hidden="true"
            >
              <FolderGlyph />
            </span>
            <span className="chat-dock__mobile-project-lines">
              <span
                className="chat-dock__mobile-project-caption"
                aria-hidden="true"
              >
                New chats
              </span>
              <span className="chat-dock__mobile-project-name">
                {projectSwitcher.projectName}
              </span>
            </span>
          </button>
        )}
      </div>
      {isProjectOpen && projectSwitcher && (
        <ProjectSwitcherOverlay
          anchorRef={projectTriggerRef}
          boundProjectSlug={projectSwitcher.projectSlug}
          projects={projectSwitcher.projects}
          onOpenProject={projectSwitcher.onOpenProject}
          onSwitchProject={projectSwitcher.onSwitchProject}
          onClose={() => setIsProjectOpen(false)}
        />
      )}
      <button
        ref={taskSwitcherTriggerRef}
        type="button"
        className="chat-dock__mobile-identity"
        data-dock-drag-passthrough=""
        aria-label={
          agentIdentity
            ? `Chats and tasks — ${agentIdentity.name}${routeLabel ? ` · via ${routeLabel}` : ''}`
            : 'Chats and tasks'
        }
        aria-describedby={titleDescriptionId}
        onClick={onOpenTaskSwitcher}
      >
        <span className="chat-dock__mobile-identity-lines">
          <span
            className="chat-dock__mobile-title chat-dock__mobile-title-text"
            id={titleDescriptionId}
            title={sessionTitle}
          >
            {sessionTitle}
          </span>
          {agentIdentity && (
            <span className="chat-dock__mobile-eyebrow" aria-hidden="true">
              {agentIdentity.name}
              {routeLabel ? ` · via ${routeLabel}` : ''}
              {sessionProjectMismatchLabel &&
                ` · ${sessionProjectMismatchLabel}`}
            </span>
          )}
        </span>
      </button>
      <div className="chat-dock__mobile-actions">
        <button
          ref={chatActionsTriggerRef}
          type="button"
          className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-overflow-trigger"
          aria-haspopup="dialog"
          aria-expanded={isOverflowOpen}
          aria-label="Chat actions"
          aria-describedby={activitySummary ? activityDescriptionId : undefined}
          title={
            activitySummary ? `Chat actions — ${activitySummary}` : undefined
          }
          data-no-dock-drag=""
          onClick={() => setIsOverflowOpen((open) => !open)}
        >
          <span aria-hidden="true">⋯</span>
          {activitySummary && (
            <>
              <span
                className="chat-dock__mobile-activity-dot"
                aria-hidden="true"
              />
              <span id={activityDescriptionId} className="sr-only">
                {activitySummary}
              </span>
            </>
          )}
        </button>
        <button
          type="button"
          className="app-toolbar__icon-btn new-chat-action new-chat-action--icon chat-dock__mobile-header-icon chat-dock__mobile-new"
          aria-label="New chat"
          title="New chat"
          data-no-dock-drag=""
          onClick={onNewChat}
        >
          <NewChatGlyph />
        </button>
      </div>
      {isOverflowOpen && (
        <LazyBoundary
          load={loadChatDockMobileOverflowSheet}
          pending={
            <MobileSheetPending
              label="Chat actions"
              onClose={() => setIsOverflowOpen(false)}
              returnFocusTarget={chatActionsTriggerRef.current}
            />
          }
          componentProps={{
            overflow,
            projectScope,
            showConnection,
            onNewChat,
            branchLabel,
            returnFocusTarget: chatActionsTriggerRef.current,
            onClose: () => setIsOverflowOpen(false),
          }}
        />
      )}
    </div>
  );
}
