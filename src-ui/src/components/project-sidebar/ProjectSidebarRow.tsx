import {
  useBoardAvailabilityQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import {
  useNavigation,
  useNavigationActions,
} from '../../contexts/NavigationContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { ProjectIcon } from '../icons/ProjectIcon';
import {
  type ProjectLayoutChip,
  ProjectLayoutChips,
} from './ProjectLayoutChips';
import { sidebarLayoutPaneId } from './pill-region-placement';
import type { ProjectRowReorderProps } from './useProjectListReorder';

/**
 * The synthesized Board entry's chip key. The colon is load-bearing: chip keys
 * are React keys and the chip row's focus-ref map key, and every other key in
 * the list is a layout slug, which goes in a URL path segment. A key a layout
 * could legitimately carry would collide with it.
 */
const BOARD_SHORTCUT_KEY = 'shortcut:board';

export function ProjectSidebarRow({
  project,
  isActive,
  activeLayout,
  collapsed,
  onNavigate,
  accent,
  liveCount = 0,
  liveLabel = '',
  reorder,
}: {
  project: ProjectMetadata;
  isActive: boolean;
  activeLayout: string | null;
  collapsed: boolean;
  onNavigate?: () => void;
  /** The set-aware color `projectAccents` allocates over the sidebar's projects. */
  accent?: string;
  /**
   * Sessions in this project's live lanes — Needs you, Running and Idle, the
   * Sessions list's own populations scoped to this project (archive#3202).
   */
  liveCount?: number;
  /**
   * What that number means, in the lanes' own words ("Needs you: 2 · Running:
   * 1"). Supplied by the same derivation that produced `liveCount`, never
   * composed here, so the number and its explanation cannot drift.
   */
  liveLabel?: string;
  /** archive#3315: drag/keyboard reorder wiring from `useProjectListReorder`. */
  reorder?: ProjectRowReorderProps;
}) {
  const { navigate, setProject, setLayout } = useNavigationActions();
  // The Session Board entry's active styling is keyed to the route, so this
  // row reads exactly one navigation field and re-renders for that alone.
  // The store is the pathname authority (`parseUrl` canonicalizes legacy
  // paths before any consumer sees them); reading `window.location` here
  // instead meant depending on a whole-store subscription to refresh it.
  const pathname = useNavigation((state) => state.pathname);
  /**
   * #2063: the chip row belongs to the project the reader is IN, which is the
   * shape the design record draws (D3) — Campfit carries chips, Ferry and
   * Thread carry only their counts. It also keeps the property the removed
   * `expanded` state existed for: sidebar rows all mount with the project
   * list, so an ungated read would put one layouts request AND one
   * sidecar-directory scan per project on every boot. Selection, not a local
   * disclosure toggle, is now what admits those two reads.
   */
  const showChips = isActive && !collapsed;
  const { data: layouts } = useProjectLayoutsQuery(project.slug, {
    enabled: showChips,
  });
  // Same gate, same reason: the server answers this by scanning the project's
  // workflow sidecar directory, and the entry it decides only exists inside
  // the chip row.
  const { data: boardAvailability } = useBoardAvailabilityQuery(project.slug, {
    enabled: showChips,
  });
  const layoutList = Array.isArray(layouts) ? layouts : [];
  const hasSessionBoardLayout = layoutList.some(
    (layout: { type?: string }) => layout.type === 'session-board',
  );

  const chips: ProjectLayoutChip[] = [];
  if (layoutList.length > 0) {
    if (!hasSessionBoardLayout && boardAvailability?.hasBuilderRun) {
      chips.push({
        key: BOARD_SHORTCUT_KEY,
        name: 'Board',
        current: isActive && pathname.endsWith('/session-board'),
        activate: () => {
          navigate(`/projects/${project.slug}/session-board`);
          onNavigate?.();
        },
      });
    }
    for (const layout of layoutList as Array<{
      id: string;
      slug: string;
      name: string;
      type?: string;
    }>) {
      chips.push({
        key: layout.slug,
        name: layout.name,
        current: isActive && activeLayout === layout.slug,
        /**
         * #2158: this Layout as a dock pane. The project id comes from the
         * row's own `project` — `ProjectMetadata.id` is already here, so the
         * `layout:<projectId>/<layoutId>` grammar needs no second query — and
         * `sidebarLayoutPaneId` answers null for a record whose ids are not
         * the lowercase UUIDs the server mints, which leaves the chip with no
         * placement rows rather than rows that would refuse.
         *
         * The synthesized Board chip above deliberately gets none: it is the
         * project's SESSION board, which is a route, and #2157 declares panes
         * for Boards and project Layouts only.
         */
        dockSurfaceId: sidebarLayoutPaneId({
          kind: 'project',
          projectId: project.id,
          layoutId: layout.id,
        }),
        // The same call the nested layout row made. A layout of kind `chat`
        // is one chip like any other, and this is why: it routes to the same
        // `/projects/<slug>/layouts/<layout>` the tree routed to, so App's
        // `rendersChatWorkspaceLayout` derivation — the only thing that
        // suspends the ambient regions — sees exactly what it saw before.
        activate: () => {
          setLayout(project.slug, layout.slug);
          onNavigate?.();
        },
      });
    }
  }

  const handleClick = () => {
    setProject(project.slug);
    onNavigate?.();
  };

  const btnClass = `sidebar__project-btn${
    isActive ? ' sidebar__project-btn--active' : ''
  }`;

  const showReorderHandle = !collapsed && reorder && reorder.count > 1;

  return (
    <div
      className={`sidebar__project-row${
        reorder?.dragging ? ' sidebar__project-row--dragging' : ''
      }${
        reorder?.dropEdge === 'top'
          ? ' sidebar__project-row--drop-before'
          : reorder?.dropEdge === 'bottom'
            ? ' sidebar__project-row--drop-after'
            : ''
      }`}
      ref={reorder?.registerRow}
    >
      <div className="sidebar__project-row-main">
        <button
          type="button"
          className={btnClass}
          onClick={handleClick}
          title={`Open ${project.name} workspace`}
        >
          <span
            className="sidebar__project-accent"
            style={{ backgroundColor: accent }}
            aria-hidden="true"
          />
          {/* #2150: an initials monogram (`CA`, `FE`) at 18px is a smudge,
              it would land in the accessible name ("CA Campfit"), and the
              design record draws the accent bar beside it for identity -- so
              an icon-less project never shows initials. A project WITH an
              icon keeps the bar AND the icon: the bar is the colour every
              surface shares, the icon is identity the user chose.
              `ProjectIcon` draws only what the icon rule accepts, so a legacy
              remote URL is never hotlinked from here.

              Expanded, every row reserves the icon's slot, so names line up
              whether or not a project has an icon. An icon-less project
              leaves it empty: the bar already carries its colour, and a dot
              there would read as a status or presence dot. The collapsed
              rail has no names to align, so it draws only an icon there. */}
          {collapsed ? (
            <ProjectIcon
              project={project}
              size={28}
              fallback="none"
              className="sidebar__project-icon"
            />
          ) : (
            <span className="sidebar__project-icon-slot" aria-hidden="true">
              <ProjectIcon
                project={project}
                size={18}
                fallback="none"
                className="sidebar__project-icon"
              />
            </span>
          )}
          <span className="sidebar__project-name">{project.name}</span>
          {liveCount > 0 && (
            <>
              {/* archive#3202: the number's meaning was written down and shown
                  ONLY to screen readers — a sighted user got a bare integer
                  with no tooltip and no legend ("what does the 6 next to
                  kontour mean?"). Same string, same source, now also a native
                  tooltip on the number itself. `aria-hidden` stays: `title` is
                  decoration for the sighted reader and the visually-hidden
                  label is the accessible name's contribution, so the sentence
                  is announced once, not twice.

                  TOUCH IS NOT COVERED BY THE TOOLTIP and is not meant to be:
                  `title` never surfaces without a pointer. The touch answer is
                  the tap itself — selecting the row opens the project page,
                  whose Live work section names these same lanes and lists the
                  sessions behind the number. Adding the sentence inline in the
                  rail would be a sidebar redesign, which this change is not.
              */}
              <span
                className="sidebar__project-live-count"
                aria-hidden="true"
                title={liveLabel}
              >
                {liveCount}
              </span>
              <span className="sidebar__project-live-label">{liveLabel}</span>
            </>
          )}
          {/* SEAM — per-project attention count (#2064, design record D4).
              It belongs HERE, after the live-work count, as the "1 needs you"
              half of the row the record draws. #2064 owns the hook and the
              query; this slice deliberately renders nothing, because a count
              with no derivation behind it is a number that means whatever the
              reader assumes.

              SEAM — member avatars (#2066, design record D5). The record
              draws "[J][M]" here, but presence is what it draws: the avatars
              of members PRESENT. No per-project presence authority exists in
              the UI today — the footer presence tray reads a host-wide
              projection (connected clients, not people, and not per project),
              and task-room presence is scoped to a task room. The only
              per-project membership read, `useProjectAccess`, is an
              ADMINISTRATION view that requires `manage-members` and throws for
              everyone else — and a membership list is not presence anyway.
              Rendering stand-in avatars would claim people are here, so this
              renders nothing at all until #2066 ships the authority. */}
        </button>
        {showReorderHandle && (
          <button
            type="button"
            className="sidebar__reorder-handle"
            aria-label={`Reorder ${project.name}`}
            aria-keyshortcuts="ArrowUp ArrowDown"
            title="Drag to reorder; Arrow keys move"
            {...reorder.handleProps}
          >
            <svg
              aria-hidden="true"
              width="10"
              height="12"
              viewBox="0 0 10 12"
              fill="currentColor"
            >
              <circle cx="3" cy="2" r="1" />
              <circle cx="7" cy="2" r="1" />
              <circle cx="3" cy="6" r="1" />
              <circle cx="7" cy="6" r="1" />
              <circle cx="3" cy="10" r="1" />
              <circle cx="7" cy="10" r="1" />
            </svg>
          </button>
        )}
      </div>

      {showChips && chips.length > 0 && (
        <ProjectLayoutChips projectName={project.name} chips={chips} />
      )}
    </div>
  );
}
