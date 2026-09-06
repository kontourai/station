import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react';
import { useId, useRef, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { ArrowDownGlyph, MenuGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { ProjectSwitcherOverlay } from './ChatDockProjectContext';

const loadChatDockMobileOverflowSheet = () =>
  import('./ChatDockMobileOverflowSheet').then((module) => ({
    default: module.ChatDockMobileOverflowSheet,
  }));

export interface ChatDockMobileOverflowActions {
  onOpenConversation: () => void;
  onToggleHistory: () => void;
  onOpenChatSettings: () => void;
  onOpenProject: (() => void) | null;
  openProjectName: string | null;
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
  agentIdentity: { name: string; slug: string; icon?: string } | null;
  branchLabel: string | null;
  projectScope?: { name: string; onClear: () => void };
  projectSwitcher: ChatDockMobileProjectSwitcher | null;
  activeCount: number;
  unreadCount: number;
  taskSwitcherTriggerRef: RefObject<HTMLButtonElement | null>;
  activityTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenTaskSwitcher: () => void;
  onOpenActivity: () => void;
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
  agentIdentity,
  branchLabel,
  projectScope,
  projectSwitcher,
  activeCount,
  unreadCount,
  taskSwitcherTriggerRef,
  activityTriggerRef,
  onOpenTaskSwitcher,
  onOpenActivity,
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
  return (
    <div
      className="chat-dock__header chat-dock__mobile-header"
      onPointerDown={onDragPointerDown}
      onClickCapture={onDragClickCapture}
      data-dock-drag-surface=""
      data-testid="chat-dock-mobile-header"
    >
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
          <span className="chat-dock__mobile-project-lines">
            <span
              className="chat-dock__mobile-project-caption"
              aria-hidden="true"
            >
              Project
            </span>
            <span className="chat-dock__mobile-project-name">
              {projectSwitcher.projectName}
            </span>
          </span>
        </button>
      )}
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
          agentIdentity ? `Switch task — ${agentIdentity.name}` : 'Switch task'
        }
        aria-describedby={titleDescriptionId}
        onClick={onOpenTaskSwitcher}
      >
        <span className="chat-dock__mobile-identity-lines">
          <span
            className="chat-dock__mobile-title chat-dock__mobile-title-text"
            id={titleDescriptionId}
          >
            {sessionTitle}
          </span>
          {agentIdentity && (
            <span className="chat-dock__mobile-eyebrow" aria-hidden="true">
              {agentIdentity.name}
            </span>
          )}
        </span>
      </button>
      <button
        ref={(node) => {
          chatActionsTriggerRef.current = node;
          activityTriggerRef.current = node;
        }}
        type="button"
        className="app-toolbar__icon-btn chat-dock__mobile-header-icon chat-dock__mobile-overflow-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOverflowOpen}
        aria-label="Chat actions"
        data-no-dock-drag=""
        onClick={() => setIsOverflowOpen((open) => !open)}
      >
        <span aria-hidden="true">⋯</span>
        {(activeCount > 0 || unreadCount > 0) && (
          <span className="chat-dock__mobile-activity-dot" aria-hidden="true" />
        )}
      </button>
      {isOverflowOpen && (
        <LazyBoundary
          load={loadChatDockMobileOverflowSheet}
          pending={null}
          componentProps={{
            overflow,
            projectScope,
            showConnection,
            onNewChat,
            onOpenActivity,
            activeCount,
            branchLabel,
            returnFocusTarget: chatActionsTriggerRef.current,
            onClose: () => setIsOverflowOpen(false),
          }}
        />
      )}
    </div>
  );
}
