import { memo, type RefObject, useRef, useState } from 'react';
import { useNavigationActions } from '../../contexts/NavigationContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { ArrowDownGlyph, FolderGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import './ChatDockProjectContext.css';

const loadChatDockProjectSwitcherSheet = () =>
  import('./ChatDockProjectSwitcherSheet').then((module) => ({
    default: module.ChatDockProjectSwitcherSheet,
  }));

/**
 * Shared by both trigger owners — the desktop badge below and
 * `ChatDockMobileHeader`'s own trigger (kontourai/station#793). Both are
 * eagerly loaded (only the sheet itself code-splits), and each owns its own
 * `isSwitcherOpen` state independently (matching `ApprovalModeChip`'s
 * self-contained trigger+sheet ownership — neither render site benefits from
 * sharing that state). This component only dedupes the identical
 * lazy-import/Suspense/prop-forwarding boilerplate the two would otherwise
 * duplicate in the entry chunk, which `scripts/ui-bundle-budget.mjs`'s
 * ceiling is tight enough to notice.
 */
export function ProjectSwitcherOverlay({
  anchorRef,
  boundProjectSlug,
  projects,
  onOpenProject,
  onSwitchProject,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  boundProjectSlug: string;
  projects: ProjectMetadata[];
  onOpenProject: (projectSlug: string) => void;
  onSwitchProject: (projectSlug: string, projectName: string) => void;
  onClose: () => void;
}) {
  const { navigate } = useNavigationActions();
  return (
    <LazyBoundary
      load={loadChatDockProjectSwitcherSheet}
      componentProps={{
        anchorRef,
        returnFocusTarget: anchorRef.current,
        boundProjectSlug,
        projects,
        onOpenProject,
        onSwitchProject,
        onNewProject: () => navigate('/projects/new'),
        onClose,
      }}
      pending={null}
    />
  );
}

interface ChatDockProjectContextProps {
  /**
   * station#1803 (part 3): `null` when the dock has no project — the control
   * still renders so the picker stays reachable to assign one.
   */
  projectSlug: string | null;
  projectName: string | null;
  /**
   * The directory this destination names, for its tooltip. station#1146: for
   * a started session this is the SESSION's own resolved `cwd` — see
   * `useChatDockViewModel`'s `sessionDisplayCwd`. A path is something you
   * occasionally paste ("Copy project path" in the More menu), not something
   * you read continuously, so it is never a visible segment (#1536 F).
   */
  workingDirectory: string | null;
  projects: ProjectMetadata[];
  onSelectProject: (projectSlug: string) => void;
  /**
   * station#4524: switches the dock's own project binding directly — no
   * navigation, no chat creation.
   */
  onSwitchProject: (projectSlug: string, projectName: string) => void;
  /**
   * When provided, a project chat-scope filter is active and a clear control
   * sits beside the destination.
   */
  onClearProjectScope?: () => void;
}

/**
 * The second half of the dock's New split button: where New starts a chat.
 * It shows the dock's project and opens the project switcher to change it.
 * Changing it only rebinds the dock (#4524); it opens nothing else.
 *
 * It names the destination, not the chat on screen: the chat's own project
 * and directory are the session context card's Workspace row. Sitting on the
 * New button is what says which one this is, so the header no longer needs
 * the "New chats" caption or the "This chat: <project>" contrast it carried
 * while it stood alone (#4525 MED-1).
 */
function ChatDockProjectContextImpl({
  projectSlug,
  projectName,
  workingDirectory,
  projects,
  onSelectProject,
  onSwitchProject,
  onClearProjectScope,
}: ChatDockProjectContextProps) {
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const badgeTriggerRef = useRef<HTMLButtonElement>(null);
  const projectLabel = projectName || projectSlug;
  // Where the directory is unknown rather than absent (a chat-scope filter
  // passes `null` on purpose), the tooltip names the project and claims
  // nothing about its folder.
  const directoryTitle = workingDirectory
    ? `${projectLabel || 'Project'} — ${workingDirectory}`
    : projectLabel
      ? projectLabel
      : '~ (no project folder set — chats start in your home folder)';
  // #1552 D3: no project renders the glyph alone; the button stays, named for
  // what pressing it does, because a dock with no project is the one most
  // likely to need the picker.
  const unboundLabel = 'Choose a project';

  return (
    <div className="chat-dock__project-context">
      <button
        ref={badgeTriggerRef}
        type="button"
        className={`chat-dock__project-badge${
          projectLabel ? '' : ' chat-dock__project-badge--unbound'
        }`}
        aria-haspopup="dialog"
        aria-expanded={isSwitcherOpen}
        aria-label={projectLabel ? `New chats: ${projectLabel}` : unboundLabel}
        title={
          projectLabel ? directoryTitle : `${unboundLabel} — ${directoryTitle}`
        }
        onClick={(event) => {
          // The header row is also the dock's click-to-toggle surface.
          event.stopPropagation();
          setIsSwitcherOpen(true);
        }}
      >
        {projectLabel ? (
          <span className="chat-dock__project-badge-name">{projectLabel}</span>
        ) : (
          <FolderGlyph className="chat-dock__project-badge-glyph" />
        )}
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {isSwitcherOpen && (
        <ProjectSwitcherOverlay
          anchorRef={badgeTriggerRef}
          // No real project ever has an empty slug, so this never falsely
          // flags a row as "Current" — correct for the no-project state.
          boundProjectSlug={projectSlug ?? ''}
          projects={projects}
          onOpenProject={onSelectProject}
          onSwitchProject={onSwitchProject}
          onClose={() => setIsSwitcherOpen(false)}
        />
      )}
      {onClearProjectScope ? (
        <button
          type="button"
          className="chat-dock__project-badge-clear"
          aria-label="Clear project chat scope"
          title="Clear project chat scope"
          onClick={(event) => {
            event.stopPropagation();
            onClearProjectScope();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/**
 * Memoized: the surrounding dock re-renders every animation frame while the
 * bottom/side resize handle is dragged (`liveDragHeight`/width state), and
 * this subtree does not depend on either — skip its render work per frame.
 */
export const ChatDockProjectContext = memo(ChatDockProjectContextImpl);
