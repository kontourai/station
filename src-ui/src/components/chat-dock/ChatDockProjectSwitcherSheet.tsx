import { type ReactNode, type RefObject, useId, useState } from 'react';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useLongPress } from '../../hooks/useLongPress';
import { useProjectAccents } from '../../hooks/useProjectAccents';
import { CheckGlyph, HomeGlyph } from '../icons/Glyph';
import { ProjectIcon } from '../icons/ProjectIcon';
import { PickerCreateAction } from '../PickerCreateAction';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';

export interface ChatDockProjectSwitcherSheetProps {
  anchorRef: RefObject<HTMLElement | null>;
  returnFocusTarget?: HTMLElement | null;
  /** The dock's own bound project (the chat's project), not the workspace
   * currently being viewed — see the row-level selection check below. */
  boundProjectSlug: string;
  projects: ProjectMetadata[];
  onOpenProject: (projectSlug: string) => void;
  onSwitchProject: (projectSlug: string, projectName: string) => void;
  onNewProject?: () => void;
  onClose: () => void;
}

function SwitchProjectGlyph() {
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
      <path d="M2.5 4.5h10M10 2l2.5 2.5L10 7M13.5 11.5h-10M6 9l-2.5 2.5L6 14" />
    </svg>
  );
}

function ProjectPickerAction({
  className,
  label,
  description,
  onActivate,
  onHelp,
  children,
}: {
  className: string;
  label: string;
  description: string;
  onActivate: () => void;
  onHelp: (description: string | null) => void;
  children: ReactNode;
}) {
  const descriptionId = useId();
  const gesture = useLongPress({
    onLongPress: () => onHelp(description),
    onClick: (event) => {
      event.stopPropagation();
      onActivate();
    },
  });
  return (
    <>
      <button
        {...gesture}
        type="button"
        className={className}
        aria-label={label}
        aria-describedby={descriptionId}
        onFocus={(event) => {
          if (event.currentTarget.matches(':focus-visible'))
            onHelp(description);
        }}
        onBlur={() => onHelp(null)}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') onHelp(description);
        }}
        onPointerLeave={(event) => {
          gesture.onPointerLeave(event);
          if (event.pointerType === 'mouse') onHelp(null);
        }}
      >
        {children}
      </button>
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </>
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
 * `aria-current` and a decorative selection check, never disabled.
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
  onNewProject,
  onClose,
}: ChatDockProjectSwitcherSheetProps) {
  const [help, setHelp] = useState<string | null>(null);
  // The sidebar's allocation, not one over whatever list this sheet is
  // handed: `projectAccents` is set-aware, so allocating over a different
  // list would give a project a different colour here than in the sidebar.
  const accents = useProjectAccents();
  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Projects"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={returnFocusTarget}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel chat-dock__project-switcher-panel"
    >
      <ResponsiveDialogHeader
        title="Projects"
        closeLabel="Close project switcher"
        onClose={onClose}
      />
      {projects.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing here yet"
          description="Use + to create your first project."
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
                <ProjectPickerAction
                  className="chat-dock__project-switcher-switch"
                  label={`Switch to ${name}`}
                  description="Use this project for new chats. Existing chats keep their original project."
                  onActivate={() =>
                    run(() => onSwitchProject(project.slug, name))
                  }
                  onHelp={setHelp}
                >
                  <span
                    className="chat-dock__project-switcher-icon"
                    aria-hidden="true"
                  >
                    {/* The project's icon, else the sidebar's colour bar. */}
                    <ProjectIcon
                      project={project}
                      size={28}
                      accent={accents.get(project.slug)}
                      fallback="bar"
                      swatchClassName="chat-dock__project-switcher-accent"
                    />
                  </span>
                  <span className="chat-dock__project-switcher-name">
                    <span className="chat-dock__project-switcher-label">
                      {name}
                    </span>
                  </span>
                  <span
                    className={
                      isBound
                        ? 'chat-dock__project-switcher-current'
                        : 'chat-dock__project-switcher-cue'
                    }
                    title={isBound ? 'Selected project' : undefined}
                    aria-hidden="true"
                  >
                    {isBound ? <CheckGlyph /> : <SwitchProjectGlyph />}
                  </span>
                </ProjectPickerAction>
                <div className="chat-dock__project-switcher-actions">
                  <ProjectPickerAction
                    className="chat-dock__project-switcher-open"
                    label={`Open ${name}`}
                    description="Open this project's workspace. Your current chat stays open."
                    onActivate={() => run(() => onOpenProject(project.slug))}
                    onHelp={setHelp}
                  >
                    <HomeGlyph />
                  </ProjectPickerAction>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {help && (
        <p className="chat-dock__project-switcher-help" role="tooltip">
          {help}
        </p>
      )}
      {onNewProject && (
        <PickerCreateAction
          label="New project"
          onClick={() => run(onNewProject)}
        />
      )}
    </ResponsiveDialogSurface>
  );
}
