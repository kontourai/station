import { useEffect, useRef, useState } from 'react';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useGitLocationByThreadId } from '../../hooks/useGitLocationByThreadId';
import { useProjectAccents } from '../../hooks/useProjectAccents';
import { useProjectIcons } from '../../hooks/useProjectIcons';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import {
  olderDraftsLabel,
  splitDraftsByAge,
} from '../../views/home/draft-lane';
import {
  formatWakeTime,
  type HomeLaneItem,
  LIVE_LANE_LABELS,
  type LiveLaneId,
} from '../../views/home/home-lane-model';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { HomeWorkLanes } from '../../views/home/useHomeWorkLanes';
import type { WorkFactsById } from '../../views/home/work-facts';
import { DisclosureToggle } from '../DisclosureToggle';
import { ReturnGlyph } from '../icons/Glyph';
import { WorkGroupLabel } from '../inbox-row/WorkGroupLabel';
import { Empty, ErrorState, SkeletonList } from '../state';
import { type HomeRowContext, renderHomeWorkRow } from './HomeWorkRow';

const SETTLED_PAGE_SIZE = 5;

/** One heading per live lane (`workStatus`) — the pulse counts reveal them. */
const LIVE_LANES: readonly {
  id: LiveLaneId;
  label: string;
  headingId: string;
}[] = [
  {
    id: 'needsYou',
    label: LIVE_LANE_LABELS.needsYou,
    headingId: 'home-needs-you-heading',
  },
  {
    id: 'running',
    label: LIVE_LANE_LABELS.running,
    headingId: 'home-running-heading',
  },
  { id: 'idle', label: LIVE_LANE_LABELS.idle, headingId: 'home-idle-heading' },
];
const FINISHED_HEADING_ID = 'home-recently-finished-heading';
const SNOOZED_HEADING_ID = 'home-snoozed-shelf-heading';

interface HomeRecentWorkSectionProps {
  /** The section's element id, the page's skip target. */
  id?: string;
  /**
   * The lanes, derived ONCE by the host and shared with everything that
   * counts them. Deriving them a second time here would give the counts
   * their own `useHomeWorkLanes` instance with its own snooze snapshot, so
   * snoozing a row could leave "Snoozed 0" printed above a shelf holding one.
   */
  lanes: HomeWorkLanes;
  /** Whether the host has any work at all — see `HomeWorkContent`. */
  workItems: HomeWorkItem[];
  /** Status facts by item id, derived by the host beside `workItems`. */
  workFacts?: WorkFactsById;
  workLoading: boolean;
  workDegraded: boolean;
  workError: boolean;
  agents: readonly SessionIconAgent[];
  remoteUnavailable: { environmentName: string }[];
  remoteAuthenticationRequired: { environmentName: string }[];
  onOpen: (task: HomeWorkItem) => void;
  onViewActivity: () => void;
  onRetry: () => void;
}

interface HomeWorkController {
  lanes: HomeWorkLanes;
  shelfExpanded: boolean;
  settledVisibleCount: number;
  toggleShelf: () => void;
  showMoreSettled: () => void;
  detailsFor: string | null;
  setDetailsFor: (id: string | null) => void;
}

function useHomeWorkController(lanes: HomeWorkLanes): HomeWorkController {
  const [shelfExpanded, setShelfExpanded] = useState(false);
  const [settledVisibleCount, setSettledVisibleCount] =
    useState(SETTLED_PAGE_SIZE);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  // A sheet belongs to a row that is on screen. A row that leaves the
  // rendered lanes (snoozed, discarded, paged out) clears it, so the sheet
  // cannot reopen unprompted if the row returns.
  const detailsRowRendered =
    detailsFor !== null &&
    [
      ...lanes.needsYou,
      ...lanes.running,
      ...lanes.idle,
      ...lanes.recentlyFinished,
      ...(lanes.external ?? []),
      ...(lanes.drafts ?? []),
      ...lanes.settled.slice(0, settledVisibleCount),
    ].some((item) => item.id === detailsFor);
  useEffect(() => {
    if (detailsFor !== null && !detailsRowRendered) setDetailsFor(null);
  }, [detailsFor, detailsRowRendered]);
  return {
    detailsFor,
    setDetailsFor,
    lanes,
    shelfExpanded,
    settledVisibleCount,
    toggleShelf: () => setShelfExpanded((value) => !value),
    showMoreSettled: () =>
      setSettledVisibleCount((count) => count + SETTLED_PAGE_SIZE),
  };
}

export function HomeRecentWorkSection(props: HomeRecentWorkSectionProps) {
  const controller = useHomeWorkController(props.lanes);
  const sectionRef = useRef<HTMLElement>(null);
  // A row whose lane changes (or whose lane empties) remounts elsewhere;
  // keep a keyboard user's focus on it. `tabIndex={-1}` is the last-resort
  // fallback target when the row itself is gone.
  useRowFocusPreservation(sectionRef, '.chat-dock-inbox__item');
  return (
    <section
      ref={sectionRef}
      id={props.id}
      className="home-view__recent"
      aria-labelledby="recent-work-heading"
      tabIndex={-1}
    >
      <div className="home-view__section-heading">
        <h2 id="recent-work-heading">Recent work</h2>
        {/* A quiet link, not a bordered button (B6): it goes somewhere. */}
        <button
          type="button"
          className="home-view__link"
          onClick={props.onViewActivity}
        >
          View Activity
        </button>
      </div>
      <RemoteUnavailableNote environments={props.remoteUnavailable} />
      <RemoteAuthenticationRequiredNote
        environments={props.remoteAuthenticationRequired}
      />
      <HomeWorkContent {...props} controller={controller} />
    </section>
  );
}

function RemoteAuthenticationRequiredNote({
  environments,
}: {
  environments: { environmentName: string }[];
}) {
  if (environments.length === 0) return null;
  const subject =
    environments.length === 1
      ? environments[0].environmentName
      : `${environments.length} remote environments`;
  return (
    <p className="home-view__remote-note" role="status">
      {subject} requires a peer credential before remote work can be read. Add
      or replace its pairing credential, then refresh.
    </p>
  );
}

function RemoteUnavailableNote({
  environments,
}: {
  environments: { environmentName: string }[];
}) {
  if (environments.length === 0) return null;
  const message =
    environments.length === 1
      ? `${environments[0].environmentName} is unavailable right now — showing local work only for it.`
      : `${environments.length} remote environments are unavailable right now — showing local work only for them.`;
  return (
    <p className="home-view__remote-note" role="status">
      {message}
    </p>
  );
}

function HomeWorkContent({
  workItems,
  workLoading,
  workDegraded,
  workError,
  workFacts,
  agents,
  onOpen,
  onViewActivity,
  onRetry,
  controller,
}: HomeRecentWorkSectionProps & { controller: HomeWorkController }) {
  // Decided once for every row: hover chrome on a fine pointer, the 44px
  // touch chrome on a coarse one (B5).
  const coarsePointer = useCoarsePointer();
  // The same row facts the dock's inbox reads, from the same derivations.
  const gitLocationByThreadId = useGitLocationByThreadId();
  const projectAccentBySlug = useProjectAccents();
  const projectIconBySlug = useProjectIcons();
  if (workLoading && !workDegraded) {
    return (
      <SkeletonList count={3} withIcon={false} label="Loading recent work" />
    );
  }
  if (workDegraded && workItems.length === 0) {
    return <RecentWorkDegraded onRetry={onRetry} />;
  }
  if (workError && workItems.length === 0) {
    return <RecentWorkError onViewActivity={onViewActivity} />;
  }
  if (workItems.length === 0) return <RecentWorkEmpty />;
  return (
    <>
      <HomeWorkLanesContent
        controller={controller}
        agents={agents}
        // The lanes' own clock (it already ticks), never a `Date.now()` per
        // row render.
        context={{
          now: controller.lanes.now,
          workFacts,
          detailsFor: controller.detailsFor,
          setDetailsFor: controller.setDetailsFor,
          chrome: coarsePointer ? 'touch' : 'hover',
          gitLocationByThreadId,
          projectAccentBySlug,
          projectIconBySlug,
        }}
        onOpen={onOpen}
      />
    </>
  );
}

function RecentWorkDegraded({ onRetry }: { onRetry: () => void }) {
  return (
    <ErrorState
      variant="compact"
      title="Recent work is taking longer than expected"
      description="This view hasn't loaded yet."
      action={
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      }
    />
  );
}

function RecentWorkError({ onViewActivity }: { onViewActivity: () => void }) {
  return (
    <ErrorState
      variant="compact"
      title="Recent work unavailable"
      description="Station could not load recent work. Open Activity to retry."
      action={
        <button type="button" onClick={onViewActivity}>
          Open Activity
        </button>
      }
    />
  );
}

/**
 * #1536 C2 / V6: one line, no second door. The start form above this
 * section is the action; the empty state only says there is nothing yet.
 */
function RecentWorkEmpty() {
  return <Empty variant="compact" label="Nothing here yet" />;
}

function HomeWorkLanesContent({
  controller,
  agents,
  context,
  onOpen,
}: {
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
  context: HomeRowContext;
  onOpen: (task: HomeWorkItem) => void;
}) {
  return (
    <>
      {LIVE_LANES.map((lane) => (
        <HomeLiveLane
          key={lane.id}
          lane={lane}
          controller={controller}
          agents={agents}
          context={context}
          onOpen={onOpen}
        />
      ))}
      <HomeRecentlyFinishedLane
        lanes={controller.lanes}
        agents={agents}
        context={context}
        onOpen={onOpen}
      />
      {controller.lanes.external?.length ? (
        <HomeFoldedLane
          label="From other apps"
          count={controller.lanes.external.length}
          headingId="home-external-heading"
        >
          <ul className="home-view__task-list">
            {controller.lanes.external.map((task) =>
              renderHomeWorkRow({
                task,
                isWoken: false,
                agents,
                onOpen,
                context,
              }),
            )}
          </ul>
        </HomeFoldedLane>
      ) : null}
      {controller.lanes.drafts?.length ? (
        <HomeDraftsSection
          drafts={controller.lanes.drafts}
          agents={agents}
          context={context}
          onOpen={onOpen}
        />
      ) : null}
      <HomeSnoozedShelf controller={controller} />
      <HomeSettledTail
        controller={controller}
        agents={agents}
        context={context}
        onOpen={onOpen}
      />
    </>
  );
}

/**
 * A lane folded by default (Drafts, From other apps), behind the shared
 * disclosure toggle; the Snoozed shelf and the dock's folded sections use
 * the same one (C13).
 */
function HomeFoldedLane({
  label,
  count,
  headingId,
  children,
}: {
  label: string;
  count: number;
  headingId: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="home-view__settled-tail" aria-labelledby={headingId}>
      <DisclosureToggle
        id={headingId}
        className="home-view__section-toggle"
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
      >
        <WorkGroupLabel label={label} count={count} />
      </DisclosureToggle>
      {open && children}
    </section>
  );
}

/**
 * #2312: Drafts, each discardable (a server delete). Drafts untouched for a
 * day fold under their own "N older drafts" disclosure — presentation only;
 * nothing ages out of existence.
 */
function HomeDraftsSection({
  drafts,
  agents,
  context,
  onOpen,
}: {
  drafts: readonly HomeLaneItem[];
  agents: readonly SessionIconAgent[];
  context: HomeRowContext;
  onOpen: (task: HomeWorkItem) => void;
}) {
  const { recent, older } = splitDraftsByAge(drafts, Date.now());
  const [olderOpen, setOlderOpen] = useState(false);
  const row = (task: HomeLaneItem) =>
    renderHomeWorkRow({
      task,
      isWoken: false,
      agents,
      onOpen,
      discardDraft: true,
      context,
    });
  return (
    <HomeFoldedLane
      label="Drafts"
      count={drafts.length}
      headingId="home-drafts-heading"
    >
      <ul className="home-view__task-list">{recent.map(row)}</ul>
      {older.length > 0 && (
        <div className="home-view__older-drafts">
          <DisclosureToggle
            className="home-view__section-toggle"
            expanded={olderOpen}
            onToggle={() => setOlderOpen((value) => !value)}
          >
            {olderDraftsLabel(older.length)}
          </DisclosureToggle>
          {olderOpen && (
            <ul className="home-view__task-list">{older.map(row)}</ul>
          )}
        </div>
      )}
    </HomeFoldedLane>
  );
}

function HomeLiveLane({
  lane,
  controller,
  agents,
  context,
  onOpen,
}: {
  lane: (typeof LIVE_LANES)[number];
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
  context: HomeRowContext;
  onOpen: (task: HomeWorkItem) => void;
}) {
  const items = controller.lanes[lane.id];
  // Empty live lanes render nothing, like Just finished: three "(0)"
  // headings would be noise.
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={lane.headingId}>
      {/* `tabIndex={-1}`: the lane's count reveals this lane, and a reveal
          that only scrolls leaves a keyboard reader's focus parked where it
          was. */}
      <h3 id={lane.headingId} className="home-view__group-label" tabIndex={-1}>
        <WorkGroupLabel label={lane.label} count={items.length} />
      </h3>
      <ul className="home-view__task-list">
        {items.map((task) =>
          renderHomeWorkRow({
            task,
            isWoken: controller.lanes.isWoken(task.id),
            agents,
            onOpen,
            onSnooze: (task, wakeAt) =>
              controller.lanes.snooze(task.id, wakeAt),
            context,
          }),
        )}
      </ul>
    </section>
  );
}

function HomeRecentlyFinishedLane({
  lanes,
  agents,
  context,
  onOpen,
}: {
  lanes: HomeWorkLanes;
  agents: readonly SessionIconAgent[];
  context: HomeRowContext;
  onOpen: (task: HomeWorkItem) => void;
}) {
  if (lanes.recentlyFinished.length === 0) return null;
  return (
    <section
      className="home-view__settled-tail"
      aria-labelledby={FINISHED_HEADING_ID}
    >
      <h3
        id={FINISHED_HEADING_ID}
        className="home-view__group-label"
        tabIndex={-1}
      >
        <WorkGroupLabel
          label="Just finished"
          count={lanes.recentlyFinished.length}
        />
      </h3>
      <ul className="home-view__task-list">
        {lanes.recentlyFinished.map((task) =>
          renderHomeWorkRow({
            task,
            isWoken: false,
            agents,
            onOpen,
            context,
          }),
        )}
      </ul>
    </section>
  );
}

function HomeSnoozedShelf({ controller }: { controller: HomeWorkController }) {
  const { lanes } = controller;
  if (lanes.snoozed.length === 0) return null;
  return (
    <section
      className="home-view__snoozed-shelf"
      aria-labelledby={SNOOZED_HEADING_ID}
    >
      <DisclosureToggle
        id={SNOOZED_HEADING_ID}
        className="home-view__section-toggle"
        expanded={controller.shelfExpanded}
        onToggle={controller.toggleShelf}
      >
        <WorkGroupLabel label="Snoozed" count={lanes.snoozed.length} />
      </DisclosureToggle>
      {controller.shelfExpanded && <HomeSnoozedRows controller={controller} />}
    </section>
  );
}

function HomeSnoozedRows({ controller }: { controller: HomeWorkController }) {
  const { lanes } = controller;
  return (
    <ul className="home-view__snoozed-list">
      {lanes.snoozed.map((task) => (
        <li key={task.stableId}>
          <span className="home-view__task-copy">
            <strong>{task.title}</strong>
            <small>
              Wakes{' '}
              {formatWakeTime(
                lanes.snoozedUntil.get(task.id) ?? lanes.now,
                lanes.now,
              )}
            </small>
          </span>
          <button
            type="button"
            className="home-view__row-action"
            aria-label={`Wake ${task.title}`}
            onClick={() => lanes.wake(task.id)}
          >
            <ReturnGlyph />
          </button>
        </li>
      ))}
    </ul>
  );
}

function HomeSettledTail({
  controller,
  agents,
  context,
  onOpen,
}: {
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
  context: HomeRowContext;
  onOpen: (task: HomeWorkItem) => void;
}) {
  const { settled } = controller.lanes;
  if (settled.length === 0) return null;
  const visible = settled.slice(0, controller.settledVisibleCount);
  // One flat list, newest first (the lane's own order), as on Activity and
  // in the dock: each row's time ("3h", "2d", "Sep 12") already says when, so
  // dated sub-headings ("Today", "Yesterday", ...) would be a second set of
  // names for one lane (design round 2026-10, C2).
  return (
    <section
      className="home-view__settled-tail"
      aria-labelledby="home-settled-tail-heading"
    >
      <h3 id="home-settled-tail-heading" className="home-view__group-label">
        <WorkGroupLabel label="Earlier" />
      </h3>
      <ul className="home-view__task-list">
        {visible.map((task) =>
          renderHomeWorkRow({
            task,
            isWoken: false,
            agents,
            onOpen,
            size: 'slim',
            context,
          }),
        )}
      </ul>
      {controller.settledVisibleCount < settled.length && (
        <button
          type="button"
          className="home-view__show-more"
          onClick={controller.showMoreSettled}
        >
          Show more
        </button>
      )}
    </section>
  );
}
