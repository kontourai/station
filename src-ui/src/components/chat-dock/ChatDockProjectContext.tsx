import { memo, type RefObject, useRef, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { GitBadge } from '../badges/GitBadge';
import { FolderGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';

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
   *
   * #1536 F: it is the badge's `title` now, not a visible segment. A 110-char
   * worktree path left the conversation title beside it about one character
   * wide, and a path is a thing you occasionally need to paste rather than one
   * you read continuously — "Copy project path" in the dock header's More menu
   * is the other half of this change.
   */
  workingDirectory: string | null;
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
  gitStatus,
  sessionProjectMismatchLabel,
  projects,
  onSelectProject,
  onSwitchProject,
  onClearProjectScope,
}: ChatDockProjectContextProps) {
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const badgeTriggerRef = useRef<HTMLButtonElement>(null);
  // The concrete path answer survives as the hover/assistive detail, including
  // for the no-directory case, whose sentence #765 F8 wrote and which used to
  // be `HomeFolderLabel`'s own tooltip.
  //
  // That sentence is a claim about the PROJECT, and this row has one state where
  // it would be false: a project chat-scope filter passes `workingDirectory:
  // null` deliberately (a scope filter has never shown session-specific facts —
  // station#1146/#4525), so a badge naming a real project would have asserted
  // that project has no folder set. Where the directory is unknown rather than
  // absent, the tooltip names the project and claims nothing about its folder.
  const projectLabel = projectName || projectSlug;
  const directoryTitle = workingDirectory
    ? `${projectLabel || 'Project'} — ${workingDirectory}`
    : projectLabel
      ? projectLabel
      : '~ (no project folder set — chats start in your home folder)';
  /**
   * #1552 D3: no project bound renders the glyph ALONE — no visible label.
   *
   * The retired monospace "No project" was a name for the absence of a name,
   * printed in a family nothing else in this bar uses, and it competed with the
   * conversation title for the same pixels while saying nothing the empty state
   * did not already say.
   *
   * The BUTTON stays, which is the part that is not negotiable: station#1803
   * part 3 made this row render precisely so a chat with no project can still
   * reach the picker, and a chat with no project is the one most likely to need
   * it. So the label goes and the affordance does not — the glyph is the target,
   * and it names itself for anyone who cannot see it.
   */
  const unboundLabel = 'Choose a project';
  // The action, and then #765 F8's own sentence about where a projectless chat
  // starts — verbatim, because dropping the visible "No project" must not also
  // drop the one place that answered "so where DO my chats run?". `directoryTitle`
  // above already words that state; this only prefixes what the button does.
  const unboundTitle = `${unboundLabel} — ${directoryTitle}`;

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
        title={projectLabel ? directoryTitle : unboundTitle}
        // The accessible name is the visible label where there is one (the
        // glyph is decorative), and the unbound button's only name is this —
        // the case where nothing visible names it.
        {...(projectLabel ? {} : { 'aria-label': unboundLabel })}
        onClick={(event) => {
          // This row is also the dock's click-to-toggle surface since #1064
          // folded the project context into the header; without this,
          // opening the switcher also collapses/expands the dock. Every
          // other control in that row guards the same way.
          event.stopPropagation();
          setIsSwitcherOpen(true);
        }}
      >
        {/* The folder glyph, from the one factory, at the family's single stroke
            weight — so the chip reads as a project rather than as an
            underlined run of monospace text (#1552 D3). */}
        <FolderGlyph className="chat-dock__project-badge-glyph" />
        {projectLabel ? (
          <span className="chat-dock__project-badge-name">{projectLabel}</span>
        ) : null}
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
