import type { ReactNode } from 'react';
import { HomeActionSection } from '../../components/home/HomeActionSection';
import { HomeRecentWorkSection } from '../../components/home/HomeRecentWorkSection';
import type { NavigationView } from '../../types';
import {
  ActivityBars,
  buildHeatRows,
  type HeatRow,
} from './blocks/activity-bars';
import { revealHomeRegion } from './home-reveal';
import type { HomeViewNavigation, useHomeViewModel } from './useHomeViewModel';
import { useHomeWorkLanes } from './useHomeWorkLanes';

export type HomeViewModel = ReturnType<typeof useHomeViewModel>;

export interface HomeSurfaceProps {
  /** The shared Home model. This renders it; it does not own it. */
  model: HomeViewModel;
  /** Best safe project continuation, or null when there is nothing to resume. */
  continuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
  /**
   * Home has no `PageFrame` (`page-frame-registry.ts` maps `home: null`), so
   * there is no page-header action cell for `WorkspacePaneDockAction` to
   * join the way Activity's does (`PageFrameActions`). This is Home's own
   * top-of-content action slot instead: rendered beside the intro rather
   * than stacked above it, so it no longer collides with the `Your work`
   * eyebrow. Optional so a test rendering `HomeSurface`
   * directly is not forced to supply one.
   */
  topAction?: ReactNode;
}

const ACTIVITY_HEADING_ID = 'home-activity-heading';

/**
 * The one Home (archive#3122's experiment, concluded).
 *
 * Reading order: name the question, offer the ways in, show where the work
 * has been, then the work itself. The first two sections are what Home has
 * always shown; the activity chart and the counts captioning recent work are
 * what the composed variant contributed and the owner kept.
 *
 * There is exactly ONE list of recent work on this page, and that is a
 * constraint rather than an accident: the composed variant carried its own
 * recency-bucketed feed of the same rows, which would have rendered every
 * item twice beside the lanes. The lanes won because they carry the
 * affordances the feed had none of — snooze, wake, the snoozed shelf,
 * paging — and the counts above them describe those exact lanes. The feed's
 * recency bucketing was absorbed into the tail of that list instead
 * (`HomeSettledTail`), not added next to it.
 */
export function HomeSurface({
  model,
  continuation,
  onNavigate,
  topAction,
}: HomeSurfaceProps) {
  // Derived ONCE, here, and handed down. `HomeRecentWorkSection` used to
  // derive its own; a second `useHomeWorkLanes` instance carries its own
  // snooze snapshot, so the counts and the list they caption could disagree
  // about what is snoozed.
  const lanes = useHomeWorkLanes(model.workItems);
  // Lanes, not raw `workItems`: `partitionHomeWorkItems` hides a snoozed
  // item, and reading `workItems` directly here would put every snoozed row
  // back into the chart the counts beside it say is empty.
  const visible = [
    ...lanes.active,
    ...lanes.recentlyFinished,
    ...lanes.settled,
  ];
  const heatRows = buildHeatRows(visible, lanes.now);
  const openProject = projectOpener(model, onNavigate);

  return (
    <>
      <div className="home-view__top-row">
        <header className="home-view__intro">
          <p className="home-view__eyebrow">Your work</p>
          <h1>What do you want to work on?</h1>
          <p>Start something focused or continue exactly where you left off.</p>
        </header>
        {topAction && <div className="home-view__top-actions">{topAction}</div>}
      </div>
      <HomeActionSection
        continuation={continuation}
        model={model}
        onNavigate={onNavigate}
      />
      {heatRows.length > 0 && (
        <section
          className="home-view__activity"
          aria-labelledby={ACTIVITY_HEADING_ID}
        >
          <h2
            id={ACTIVITY_HEADING_ID}
            className="home-view__activity-heading"
            tabIndex={-1}
          >
            Where the work has been
          </h2>
          <ActivityBars
            rows={heatRows}
            onOpen={model.continueWork}
            resolveProjectOpen={openProject}
          />
        </section>
      )}
      <HomeRecentWorkSection
        lanes={lanes}
        workItems={model.workItems}
        workLoading={model.workLoading}
        workDegraded={model.workDegraded}
        workError={model.workError}
        agents={model.agents}
        remoteUnavailable={model.remoteUnavailable}
        remoteAuthenticationRequired={model.remoteAuthenticationRequired}
        projectRowCount={heatRows.length}
        onShowProjects={
          heatRows.length > 0
            ? () => revealHomeRegion(ACTIVITY_HEADING_ID)
            : null
        }
        onOpen={model.continueWork}
        onViewActivity={() => onNavigate({ type: 'activity' })}
        onRetry={model.retryWork}
      />
    </>
  );
}

/**
 * Turns a chart row into a project opener, or `null` when it does not name a
 * project this Station has.
 *
 * Two independent conditions, both required, because a row's NAME and a row's
 * SLUG are different facts:
 *
 * - the row's items must agree on one slug (`HeatRow.projectSlug`), and that
 *   slug must exist in the configured project catalog — `/projects/<slug>`
 *   for a slug no project answers to is not a destination;
 * - the row's visible label must be exactly that project's slug or name.
 *   `projectLabel` also carries `sessionProjectLabel`'s caveats — "beacon
 *   (unverified name match)" — and a session can hold a delegated project
 *   slug alongside a different local one. Linking a caveated label to the
 *   local project would answer a question the label explicitly says is open.
 *
 * The destination itself is verified: `{type:'project', slug}` renders
 * `ProjectPage`, whose Live work section filters sessions through
 * `matchesProjectFilter(session, projectSlug)`. It is genuinely project
 * scoped — which `/activity` is not, at any URL.
 */
function projectOpener(
  model: HomeViewModel,
  onNavigate: (view: NavigationView) => void,
): (row: HeatRow) => (() => void) | null {
  // While the catalog is still loading this is empty and no row links. That
  // is the intended answer, not a placeholder: nothing has yet confirmed the
  // project exists. (`useProjectsQuery` is untyped in the SDK, so the two
  // fields this decision reads are named here rather than inferred as `any`.)
  const projects: { slug: string; name?: string }[] = model.projects ?? [];
  return (row) => {
    if (!row.projectSlug) return null;
    const project = projects.find((entry) => entry.slug === row.projectSlug);
    if (!project) return null;
    if (row.project !== project.slug && row.project !== project.name) {
      return null;
    }
    return () => onNavigate({ type: 'project', slug: project.slug });
  };
}
