import type { RefObject } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';

export interface ChatDockProjectSwitcherSheetProps {
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusTarget?: HTMLElement | null;
  /** The dock's own bound project (the chat's project), not the workspace
   * currently being viewed — see the row-level "Current" flag below. */
  boundProjectSlug: string;
  projects: ProjectMetadata[];
  onOpenProject: (projectSlug: string) => void;
  onSwitchProject: (projectSlug: string, projectName: string) => void;
  onClose: () => void;
}

/** Local, not the shared Glyph catalog — same entry-chunk reasoning as
 * `ChatDockMobileHeader`'s ProjectSwitcherGlyph (this sheet is lazy, but the
 * shared catalog is an entry-chunk module and the folder icon is otherwise
 * only reachable from other lazy islands). */
function OpenProjectGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 4.5h4l1.3 1.5h5.7v7h-11v-8.5Z" />
      <path d="M9.5 9.5h3M11 8l1.5 1.5L11 11" />
    </svg>
  );
}

/**
 * Shared desktop-popover / mobile-edge-sheet body for the chat-dock's project
 * badge (kontourai/station#793). One `ResponsiveDialogSurface` consumer feeds
 * both render sites — the desktop badge (`ChatDockProjectContext`) anchors it
 * to itself, the mobile header's own trigger opens it un-anchored.
 *
 * Design decision D5 (kontourai-station-793 plan), REVISED by
 * kontourai/station#3319 and again by #4524: D5's substance stands — (a) the
 * bound row is never disabled and (b) both actions exist on every row — but
 * its presentation (two identically-weighted full-text buttons per row) is
 * superseded, twice now. #3319 made the ROW ITSELF a "Continue in <name>"
 * action that started a fresh chat; #4524 reported that coupling as the bug
 * — picking a project from the dock bar opened the New Chat modal on its
 * own, when switching project and starting a chat are two separate acts. The
 * row is now the SWITCH action (aria-label "Switch to <name>"): it rebinds
 * the dock's own project context (`ChatDock.handleSwitchProject` →
 * `DockShell`'s `chrome.setActiveProjectSlug`) and nothing else — no
 * navigation, no chat creation. "Open project" keeps its #3319 shape
 * unchanged: a right-aligned icon-only button (aria-label/title
 * "Open <name>") that navigates to the project's own page and collapses the
 * dock at the `onOpenProject` call site (`ChatDock.handleSelectProject`) so
 * the destination is visible. The bound row is still flagged with
 * `aria-current` and a decorative visual "Current" label, never disabled.
 *
 * No row or button here creates, opens, or moves a chat — starting one in
 * the just-switched project is the New Chat modal's own job (it defaults to
 * whatever this sheet just bound), and no "move"/"transfer" wording appears
 * anywhere in this component (no capability substrate exists for moving an
 * existing chat's context between projects).
 */
export function ChatDockProjectSwitcherSheet({
  anchorRef,
  returnFocusTarget,
  boundProjectSlug,
  projects,
  onOpenProject,
  onSwitchProject,
  onClose,
}: ChatDockProjectSwitcherSheetProps) {
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <ResponsiveDialogSurface
      ariaLabel="Switch project"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={returnFocusTarget}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel chat-dock__project-switcher-panel"
    >
      <ResponsiveDialogHeader
        title="Switch project"
        closeLabel="Close project switcher"
        onClose={onClose}
      />
      {projects.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing here yet"
          description="This Station has no projects to switch to."
        />
      ) : (
        <ul className="chat-dock__project-switcher-list">
          {projects.map((project) => {
            const name = project.name || project.slug;
            const isBound = project.slug === boundProjectSlug;
            return (
              <li
                key={project.slug}
                className={`chat-dock__project-switcher-row${isBound ? ' is-current' : ''}`}
                aria-current={isBound ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="chat-dock__project-switcher-switch"
                  aria-label={`Switch to ${name}`}
                  onClick={() => run(() => onSwitchProject(project.slug, name))}
                >
                  <span className="chat-dock__project-switcher-name">
                    {name}
                    {isBound && (
                      <span
                        className="chat-dock__project-switcher-current"
                        aria-hidden="true"
                      >
                        Current
                      </span>
                    )}
                  </span>
                  <span
                    className="chat-dock__project-switcher-hint"
                    aria-hidden="true"
                  >
                    Switch the dock to this project
                  </span>
                </button>
                <div className="chat-dock__project-switcher-actions">
                  <button
                    type="button"
                    className="chat-dock__project-switcher-open"
                    aria-label={`Open ${name}`}
                    title={`Open ${name}`}
                    // A sibling of the row action, never its child — the
                    // icon's click cannot reach the row (#3319 acceptance),
                    // and stopPropagation keeps that true even if a future
                    // wrapper adds a row-level handler.
                    onClick={(event) => {
                      event.stopPropagation();
                      run(() => onOpenProject(project.slug));
                    }}
                  >
                    <OpenProjectGlyph />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ResponsiveDialogSurface>
  );
}
