import { useEffect, useRef, useState } from 'react';
import { useRowFocusPreservation } from '../../hooks/useRowFocusPreservation';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import {
  PulseStats,
  type PulseStatTarget,
  pulseStats,
} from '../../views/home/blocks/pulse-stats';
import { bucketByRecency } from '../../views/home/blocks/recency-buckets';
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
import { revealHomeRegion } from '../../views/home/home-reveal';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { HomeWorkLanes } from '../../views/home/useHomeWorkLanes';
import type { WorkFactsById } from '../../views/home/work-facts';
import { ReturnGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { Empty, ErrorState, SkeletonList } from '../state';
import { type HomeRowContext, renderHomeWorkRow } from './HomeWorkRow';

const SETTLED_PAGE_SIZE = 5;
const loadSnoozeMenu = () => import('./SnoozeMenu');

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
  snoozeMenuFor: HomeLaneItem | null;
  snoozeTriggerRef: React.RefObject<HTMLButtonElement | null>;
  shelfExpanded: boolean;
  settledVisibleCount: number;
  openSnoozeMenu: (task: HomeLaneItem, trigger: HTMLButtonElement) => void;
  closeSnoozeMenu: () => void;
  toggleShelf: () => void;
  expandShelf: () => void;
  showMoreSettled: () => void;
  detailsFor: string | null;
  setDetailsFor: (id: string | null) => void;
}

function useHomeWorkController(lanes: HomeWorkLanes): HomeWorkController {
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<HomeLaneItem | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement | null>(null);
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
    snoozeMenuFor,
    snoozeTriggerRef,
    shelfExpanded,
    settledVisibleCount,
    openSnoozeMenu: (task, trigger) => {
      snoozeTriggerRef.current = trigger;
      setSnoozeMenuFor(task);
    },
    closeSnoozeMenu: () => setSnoozeMenuFor(null),
    toggleShelf: () => setShelfExpanded((value) => !value),
    expandShelf: () => setShelfExpanded(true),
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
      className="home-view__recent"
      aria-labelledby="recent-work-heading"
      tabIndex={-1}
    >
      <div className="home-view__section-heading">
        <h2 id="recent-work-heading">Recent work</h2>
        <button type="button" onClick={props.onViewActivity}>
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
      {/* The counts caption the lanes below rather than heading the page: at
          full size they outranked the work they describe (station#3122's
          composed variant, the shape the owner chose). They render only in
          this branch, so a count can never be shown — or made activatable —
          for a lane that is not on the page. */}
      <PulseStats
        stats={pulseStats(controller.lanes, statTargets(controller))}
      />
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
        }}
        onOpen={onOpen}
      />
    </>
  );
}

/**
 * What each count reveals, and only where that thing is actually rendered.
 *
 * Every target is a region of THIS page. Nothing outside Home accepts these
 * populations: Activity takes only a session intent and its project filter
 * is component state with no route parameter, so linking a count there would
 * land the reader on the unfiltered global list under a heading promising a
 * filter — see `home-reveal.ts`.
 */
function statTargets(
  controller: HomeWorkController,
): Record<string, PulseStatTarget> {
  const { lanes } = controller;
  const targets: Record<string, PulseStatTarget> = {};
  // A live lane renders only when non-empty (`HomeLiveLane`), so its count
  // links only then; a zero count reads as text.
  for (const lane of LIVE_LANES) {
    if (lanes[lane.id].length > 0) {
      targets[lane.label] = {
        destination: `show the ${lane.label} lane`,
        onActivate: () => revealHomeRegion(lane.headingId),
      };
    }
  }
  if (lanes.recentlyFinished.length > 0) {
    targets['Just finished'] = {
      destination: 'show the Recently finished lane',
      onActivate: () => revealHomeRegion(FINISHED_HEADING_ID),
    };
  }
  if (lanes.snoozed.length > 0) {
    targets.Snoozed = {
      destination: 'open the snoozed shelf',
      onActivate: () => {
        controller.expandShelf();
        revealHomeRegion(SNOOZED_HEADING_ID);
      },
    };
  }
  return targets;
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
 * #1536 C2: Home offered three ways to start a chat with no session — the
 * "Start direct chat" action card, this button, and the dock's own "Start a
 * chat". The card and the dock control both stay; the empty state explains
 * what will appear without claiming an engine is ready.
 */
function RecentWorkEmpty() {
  return (
    <Empty
      variant="prominent"
      label="Your chats and project work will appear here"
    />
  );
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
        <details className="home-view__settled-tail">
          <summary>
            From other apps ({controller.lanes.external.length})
          </summary>
          <p>Conversations started in your coding apps.</p>
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
        </details>
      ) : null}
      {controller.lanes.drafts?.length ? (
        <HomeDraftsSection
          drafts={controller.lanes.drafts}
          agents={agents}
          context={context}
          onOpen={onOpen}
        />
      ) : null}
      <HomeSnoozeMenu controller={controller} />
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
    <details className="home-view__settled-tail">
      <summary>Drafts ({drafts.length})</summary>
      <p>Sessions nothing has been sent to yet.</p>
      <ul className="home-view__task-list">{recent.map(row)}</ul>
      {older.length > 0 && (
        <details className="home-view__older-drafts">
          <summary>{olderDraftsLabel(older.length)}</summary>
          <ul className="home-view__task-list">{older.map(row)}</ul>
        </details>
      )}
    </details>
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
  // Empty live lanes render nothing, like Recently finished: three "(0)"
  // headings would be noise, and the pulse counts already say zero.
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={lane.headingId}>
      {/* `tabIndex={-1}`: the lane's count reveals this lane, and a reveal
          that only scrolls leaves a keyboard reader's focus parked where it
          was. */}
      <h3 id={lane.headingId} className="home-view__group-label" tabIndex={-1}>
        {lane.label} ({items.length})
      </h3>
      <ul className="home-view__task-list">
        {items.map((task) =>
          renderHomeWorkRow({
            task,
            isWoken: controller.lanes.isWoken(task.id),
            agents,
            onOpen,
            onSnooze: controller.openSnoozeMenu,
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
        Recently finished ({lanes.recentlyFinished.length})
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

function HomeSnoozeMenu({ controller }: { controller: HomeWorkController }) {
  const { lanes, snoozeMenuFor, snoozeTriggerRef } = controller;
  if (!snoozeMenuFor) return null;
  return (
    <LazyBoundary
      load={loadSnoozeMenu}
      componentProps={{
        itemTitle: snoozeMenuFor.title,
        now: lanes.now,
        triggerRef: snoozeTriggerRef,
        onSnooze: (wakeAt) => lanes.snooze(snoozeMenuFor.id, wakeAt),
        onClose: controller.closeSnoozeMenu,
      }}
      pending={null}
    />
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
      <button
        type="button"
        id={SNOOZED_HEADING_ID}
        className="home-view__section-toggle"
        aria-expanded={controller.shelfExpanded}
        onClick={controller.toggleShelf}
      >
        <span aria-hidden="true">{controller.shelfExpanded ? '−' : '+'}</span>
        Snoozed ({lanes.snoozed.length})
      </button>
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
  // "Earlier" used to be one flat run of rows. Bucketing the visible page by
  // recency is what the composed variant's "Recently" feed did, absorbed into
  // the list that already exists rather than added beside it as a second one.
  // Buckets are derived from the VISIBLE page, so "Show more" still governs
  // how much of the tail is on screen.
  const buckets = bucketByRecency(visible, controller.lanes.now);
  return (
    <section
      className="home-view__settled-tail"
      aria-labelledby="home-settled-tail-heading"
    >
      <h3 id="home-settled-tail-heading" className="home-view__group-label">
        Earlier
      </h3>
      {buckets.map((bucket) => (
        <div key={bucket.label}>
          <h4 className="home-view__bucket-label">{bucket.label}</h4>
          <ul className="home-view__task-list">
            {bucket.items.map((task) =>
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
        </div>
      ))}
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
