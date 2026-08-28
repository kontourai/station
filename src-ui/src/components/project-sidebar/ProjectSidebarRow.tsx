import {
  useBoardAvailabilityQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { LayoutIcon } from '../icons/LayoutIcon';
import { projectAccent } from './projectAccent';
import type { ProjectRowReorderProps } from './useProjectListReorder';

export function ProjectSidebarRow({
  project,
  isActive,
  activeLayout,
  collapsed,
  onNavigate,
  accent: accentProp,
  liveCount = 0,
  liveLabel = '',
  reorder,
}: {
  project: ProjectMetadata;
  isActive: boolean;
  activeLayout: string | null;
  collapsed: boolean;
  onNavigate?: () => void;
  accent?: string;
  /**
   * Sessions in this project's live lanes — Needs you plus Active now, the
   * Sessions list's own populations scoped to this project (archive#3202).
   */
  liveCount?: number;
  /**
   * What that number means, in the lanes' own words ("Needs you: 2 · Active
   * now: 1"). Supplied by the same derivation that produced `liveCount`, never
   * composed here, so the number and its explanation cannot drift.
   */
  liveLabel?: string;
  /** archive#3315: drag/keyboard reorder wiring from `useProjectListReorder`. */
  reorder?: ProjectRowReorderProps;
}) {
  const [expanded, setExpanded] = useState(isActive);
  const { navigate, setProject, setLayout } = useNavigation();
  // Sidebar rows all mount with the project list. Fetch layouts only for an
  // expanded row so a six-project boot does not create six layouts requests.
  const { data: layouts } = useProjectLayoutsQuery(project.slug, {
    enabled: expanded && !collapsed,
  });
  // Same reason as the layouts read directly above, and the same gate: the
  // Board entry only ever renders inside the expanded row, and the server
  // answers this by scanning the project's workflow sidecar directory — so an
  // ungated read would put one filesystem scan per project on every boot to
  // decide the visibility of a control nobody can see yet.
  const { data: boardAvailability } = useBoardAvailabilityQuery(project.slug, {
    enabled: expanded && !collapsed,
  });
  const hasSessionBoardLayout =
    Array.isArray(layouts) &&
    layouts.some(
      (layout: { type?: string }) => layout.type === 'session-board',
    );

  const handleClick = () => {
    if (collapsed) {
      setProject(project.slug);
      onNavigate?.();
      return;
    }
    setExpanded(true);
    setProject(project.slug);
    onNavigate?.();
  };

  const handleChevronClick = () => {
    setExpanded((prev) => !prev);
  };

  const btnClass = `sidebar__project-btn${
    isActive ? ' sidebar__project-btn--active' : ''
  }`;
  const accent = accentProp ?? projectAccent(project.slug);

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
          title={collapsed ? project.name : undefined}
        >
          <span
            className="sidebar__project-accent"
            style={{ backgroundColor: accent }}
            aria-hidden="true"
          />
          <LayoutIcon layout={project} size={collapsed ? 28 : 18} />
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
        {!collapsed && (
          <button
            type="button"
            className={`sidebar__chevron${
              expanded ? ' sidebar__chevron--open' : ''
            }`}
            onClick={handleChevronClick}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${
              project.name
            } layouts`}
            aria-expanded={expanded}
          >
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
      </div>

      {expanded &&
        !collapsed &&
        Array.isArray(layouts) &&
        layouts.length > 0 && (
          <div className="sidebar__layouts">
            {!hasSessionBoardLayout && boardAvailability?.hasBuilderRun && (
              <button
                type="button"
                className={`sidebar__layout-btn${
                  isActive &&
                  window.location.pathname.endsWith('/session-board')
                    ? ' sidebar__layout-btn--active'
                    : ''
                }`}
                onClick={() => {
                  navigate(`/projects/${project.slug}/session-board`);
                  onNavigate?.();
                }}
              >
                <svg
                  aria-hidden="true"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect x="3" y="4" width="18" height="5" />
                  <rect x="3" y="15" width="18" height="5" />
                </svg>
                <span>Board</span>
              </button>
            )}
            {layouts.map(
              (layout: { slug: string; name: string; type?: string }) => {
                const isLayoutActive = isActive && activeLayout === layout.slug;
                return (
                  <button
                    key={layout.slug}
                    type="button"
                    className={`sidebar__layout-btn${
                      isLayoutActive ? ' sidebar__layout-btn--active' : ''
                    }`}
                    onClick={() => {
                      setLayout(project.slug, layout.slug);
                      onNavigate?.();
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="3" y="3" width="7" height="7" />
                      <rect x="14" y="3" width="7" height="7" />
                      <rect x="14" y="14" width="7" height="7" />
                      <rect x="3" y="14" width="7" height="7" />
                    </svg>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {layout.name}
                    </span>
                  </button>
                );
              },
            )}
          </div>
        )}
    </div>
  );
}
