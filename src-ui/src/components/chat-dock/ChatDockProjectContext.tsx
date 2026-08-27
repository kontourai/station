import { memo, type RefObject, useRef, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { activatable } from '../../utils/activatable';
import { GitBadge } from '../badges/GitBadge';
import { LazyBoundary } from '../LazyBoundary';
import { splitWorkingDirectoryPath } from './chat-dock-utils';

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
        onClose,
      }}
      pending={null}
    />
  );
}

interface ChatDockProjectContextProps {
  /**
   * station#1803 (part 3): `null` for a chat opened with no workspace — the
   * row still renders (see the badge fallback below) so the picker stays
   * reachable to assign one. Previously the caller (`ChatDock.tsx`) hid
   * this whole row whenever there was no bound project, which is exactly
   * backwards: a chat with no project is the one most likely to need the
   * picker.
   */
  projectSlug: string | null;
  projectName: string | null;
  /**
   * The directory this row names. station#1146: for a started session this is
   * the SESSION's own resolved `cwd`, not the project's `workingDirectory` —
   * see `useChatDockViewModel`'s `sessionDisplayCwd` for the resolution order
   * and for why `gitStatus` below deliberately did NOT move with it.
   */
  workingDirectory: string | null;
  codingLayoutSlug: string | null;
  /** The PROJECT's git state — see `workingDirectory`'s note. */
  gitStatus?: any;
  /**
   * station#4525 review MED-1 (owner design ruling): non-null ONLY when the
   * active session's own project differs from this badge's bound project —
   * see `resolveSessionProjectMismatchLabel`. The badge still always names
   * the BOUND project (unchanged); this is the muted lead-in the facts row
   * (directory/git) shows in that case, so the header never implies the
   * visible transcript belongs to the badge's project.
   */
  sessionProjectMismatchLabel?: string | null;
  projects: ProjectMetadata[];
  onSelectProject: (projectSlug: string) => void;
  onOpenLayout: (projectSlug: string, layoutSlug: string) => void;
  /**
   * station#4524: switches the dock's own project binding directly — no
   * navigation, no chat creation. Renamed from `onContinueInProject`: the
   * row used to always start a fresh chat in the picked project, which was
   * exactly the coupling #4524 reported (picking a project opened the New
   * Chat modal on its own).
   */
  onSwitchProject: (projectSlug: string, projectName: string) => void;
  /**
   * When provided, the project badge becomes the single clearable
   * project-context affordance (a chat scope filter is active). Renders a
   * clear control next to the badge instead of the retired
   * "Project chats: <name>" scope block (chat-dock-maximize-readiness).
   */
  onClearProjectScope?: () => void;
}

function ChatDockProjectContextImpl({
  projectSlug,
  projectName,
  workingDirectory,
  codingLayoutSlug,
  gitStatus,
  sessionProjectMismatchLabel,
  projects,
  onSelectProject,
  onOpenLayout,
  onSwitchProject,
  onClearProjectScope,
}: ChatDockProjectContextProps) {
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const badgeTriggerRef = useRef<HTMLButtonElement>(null);
  const { parentPath, leafName, hasWorkingDirectory } =
    splitWorkingDirectoryPath(workingDirectory);

  return (
    <div className="chat-dock__project-context">
      <button
        ref={badgeTriggerRef}
        type="button"
        className="chat-dock__project-badge"
        aria-haspopup="dialog"
        aria-expanded={isSwitcherOpen}
        onClick={(event) => {
          // This row is also the dock's click-to-toggle surface since #1064
          // folded the project context into the header; without this,
          // opening the switcher also collapses/expands the dock. Every
          // other control in that row guards the same way.
          event.stopPropagation();
          setIsSwitcherOpen(true);
        }}
      >
        {projectName || projectSlug || 'No project'}
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
      {sessionProjectMismatchLabel && (
        <span className="chat-dock__project-session-name">
          {sessionProjectMismatchLabel} ·
        </span>
      )}
      {hasWorkingDirectory && (
        <span
          className={`chat-dock__project-dir${codingLayoutSlug ? ' chat-dock__project-dir--link' : ''}`}
          {...activatable(
            // A coding layout always belongs to a real project, so
            // `projectSlug` is non-null whenever `codingLayoutSlug` is —
            // guarded explicitly anyway since the prop is now nullable.
            codingLayoutSlug && projectSlug
              ? (event) => {
                  event.stopPropagation();
                  onOpenLayout(projectSlug, codingLayoutSlug);
                }
              : undefined,
            { role: 'link' },
          )}
        >
          {/* The parent span is `direction: rtl` purely so text-overflow
              truncates the START of a long path. Without bidi isolation that
              reorders leading neutral characters — `~/dev/github/` rendered
              as `/dev/github/~`, splicing the tilde mid-path (#304). The
              inner `dir="ltr"` isolate keeps character order intact while
              the outer rtl keeps the ellipsis on the left. */}
          <span className="chat-dock__project-dir-parent">
            <span dir="ltr" className="chat-dock__project-dir-parent-text">
              {parentPath}
            </span>
          </span>
          <span className="chat-dock__project-dir-leaf">{leafName}</span>
        </span>
      )}
      {!hasWorkingDirectory && (
        <span className="chat-dock__project-dir chat-dock__project-dir--fallback">
          ~ (defaults to home)
        </span>
      )}
      {gitStatus?.isRepo && <GitBadge git={gitStatus} />}
    </div>
  );
}

/**
 * Memoized: the surrounding dock re-renders every animation frame while the
 * bottom/side resize handle is dragged (`liveDragHeight`/width state), and
 * this subtree does not depend on either — skip its render work per frame.
 */
export const ChatDockProjectContext = memo(ChatDockProjectContextImpl);
