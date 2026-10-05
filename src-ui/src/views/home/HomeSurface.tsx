import {
  HomeActionSection,
  HomeContinueCard,
} from '../../components/home/HomeActionSection';
import { HomeRecentWorkSection } from '../../components/home/HomeRecentWorkSection';
import { HomeStartComposer } from '../../components/home/HomeStartComposer';
import { SkeletonBlock } from '../../components/state';
import { useShowSurfacePage } from '../../contexts/useShowSurface';
import type { NavigationView } from '../../types';
import {
  ActivityBars,
  buildHeatRows,
  type HeatRow,
} from './blocks/activity-bars';
import type { HomeViewNavigation, useHomeViewModel } from './useHomeViewModel';
import { useHomeWorkLanes } from './useHomeWorkLanes';

export type HomeViewModel = ReturnType<typeof useHomeViewModel>;

export interface HomeSurfaceProps {
  /** The shared Home model. This renders it; it does not own it. */
  model: HomeViewModel;
  /** Best safe project continuation, or null when there is nothing to resume. */
  continuation: HomeViewNavigation | null;
  onNavigate: (view: NavigationView) => void;
}

const ACTIVITY_HEADING_ID = 'home-activity-heading';
/** The recent-work section's id: the skip target (U2). */
const RECENT_WORK_SECTION_ID = 'home-recent-work';
/** Continue leads the work, so the skip link lands there when it shows. */
const CONTINUE_SECTION_ID = 'home-continue';

/**
 * The one Home (archive#3122's experiment, concluded).
 *
 * Reading order (design round 2026-10, V1-V6, Q3, U2): the start form, then
 * the work. With recent work on the page the lanes come right after the
 * form and the heading, the action cards and the chart wait below them —
 * someone with work does not need to be asked what they want to work on
 * above it. An empty Station keeps the heading and leads with the cards.
 * The counts that used to caption the lanes are gone: the lane headings
 * carry their counts, and the chart draws only once it has more than one
 * row to compare.
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
}: HomeSurfaceProps) {
  // Derived ONCE, here, and handed down. `HomeRecentWorkSection` used to
  // derive its own; a second `useHomeWorkLanes` instance carries its own
  // snooze snapshot, so the counts and the list they caption could disagree
  // about what is snoozed.
  const lanes = useHomeWorkLanes(model.workItems);
  // #928: Activity is a region surface with no standalone placement. "View
  // Activity" goes to its PAGE — Activity takes `main` in Home's place, the
  // same verb as the sidebar row — rather than docking it beside Home.
  const showSurfacePage = useShowSurfacePage();
  // Lanes, not raw `workItems`: `partitionHomeWorkItems` hides a snoozed
  // item, and reading `workItems` directly here would put every snoozed row
  // back into the chart the counts beside it say is empty.
  const visible = [
    ...lanes.needsYou,
    ...lanes.running,
    ...lanes.idle,
    ...lanes.recentlyFinished,
    ...lanes.settled,
  ];
  const heatRows = buildHeatRows(visible, lanes.now);
  const openProject = projectOpener(model, onNavigate);
  const hasWork = model.workItems.length > 0;

  // The skeleton stands where the cards will stand. It used to sit under the
  // start form, which put a 150px placeholder above the work it had nothing
  // to do with (Q3).
  const actions = model.actionsLoading ? (
    <SkeletonBlock count={1} label="Finding available ways to help" />
  ) : (
    <HomeActionSection
      continuation={continuation}
      model={model}
      onNavigate={onNavigate}
      // With work on the page Continue leads the work (above Recent work,
      // which leaves its item out); an empty page has nothing to continue.
      showPrimary={false}
    />
  );
  // The Continue card shows its item as the full work row; the list beside
  // it leaves that item out rather than show it twice. Counts in the chart
  // still read every item.
  const continued =
    !model.actionsLoading && model.primaryWorkItem
      ? model.primaryWorkItem.id
      : undefined;
  const listedLanes = continued ? withoutItem(lanes, continued) : lanes;
  // With Continue holding the only item, Recent work would be a heading
  // over nothing: it is left out, and View Activity moves beside Continue.
  // Loading, failure and remote notes still need the section.
  const listEmpty =
    Boolean(continued) &&
    !model.workLoading &&
    !model.workDegraded &&
    !model.workError &&
    model.remoteUnavailable.length === 0 &&
    model.remoteAuthenticationRequired.length === 0 &&
    [
      listedLanes.needsYou,
      listedLanes.running,
      listedLanes.idle,
      listedLanes.external ?? [],
      listedLanes.drafts ?? [],
      listedLanes.recentlyFinished,
      listedLanes.snoozed,
      listedLanes.settled,
    ].every((items) => items.length === 0);
  const continueCard =
    !model.actionsLoading && model.primaryWorkItem ? (
      <HomeContinueCard
        model={model}
        id={CONTINUE_SECTION_ID}
        onViewActivity={
          listEmpty ? () => showSurfacePage('activity') : undefined
        }
      />
    ) : null;
  const recentWork = (
    <HomeRecentWorkSection
      id={RECENT_WORK_SECTION_ID}
      lanes={listedLanes}
      workItems={model.workItems}
      workFacts={model.workFacts}
      workLoading={model.workLoading}
      workDegraded={model.workDegraded}
      workError={model.workError}
      agents={model.agents}
      remoteUnavailable={model.remoteUnavailable}
      remoteAuthenticationRequired={model.remoteAuthenticationRequired}
      onOpen={model.continueWork}
      onViewActivity={() => showSurfacePage('activity')}
      onRetry={model.retryWork}
    />
  );
  // One bar is not a comparison. The chart earns its height past one row.
  const chart = heatRows.length > 1 && (
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
  );

  return (
    <>
      {/* U2: the first inbox row sat 35 tab stops in. A keyboard reader lands
          on the work in one. */}
      {hasWork && (
        <a
          className="home-view__skip"
          href={`#${continueCard ? CONTINUE_SECTION_ID : RECENT_WORK_SECTION_ID}`}
        >
          Skip to recent work
        </a>
      )}
      {!hasWork && (
        <header className="home-view__intro">
          <h1>What's next?</h1>
        </header>
      )}
      {/* A plain wrapper: the form is the one "Start work" landmark. A
          section named the same nested a second landmark with one name. */}
      <div
        className={`home-view__start${hasWork ? ' home-view__start--compact' : ''}`}
      >
        <HomeStartComposer compact={hasWork} />
      </div>
      {hasWork ? (
        <>
          {continueCard}
          {!listEmpty && recentWork}
          {actions}
          {chart}
        </>
      ) : (
        <>
          {actions}
          {recentWork}
        </>
      )}
    </>
  );
}

/** The lanes without one item (by id), every other field as derived. */
function withoutItem<
  L extends {
    needsYou: { id: string }[];
    running: { id: string }[];
    idle: { id: string }[];
    external?: { id: string }[];
    drafts?: { id: string }[];
    recentlyFinished: { id: string }[];
    snoozed: { id: string }[];
    settled: { id: string }[];
  },
>(lanes: L, id: string): L {
  const keep = <T extends { id: string }>(items: T[]) =>
    items.filter((item) => item.id !== id);
  return {
    ...lanes,
    needsYou: keep(lanes.needsYou),
    running: keep(lanes.running),
    idle: keep(lanes.idle),
    ...(lanes.external ? { external: keep(lanes.external) } : {}),
    ...(lanes.drafts ? { drafts: keep(lanes.drafts) } : {}),
    recentlyFinished: keep(lanes.recentlyFinished),
    snoozed: keep(lanes.snoozed),
    settled: keep(lanes.settled),
  };
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
