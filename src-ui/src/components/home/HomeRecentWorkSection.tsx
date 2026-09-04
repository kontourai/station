import { useRef, useState } from 'react';
import type { SessionIconAgent } from '../../utils/sessionDisplay';
import {
  PulseStats,
  type PulseStatTarget,
  pulseStats,
} from '../../views/home/blocks/pulse-stats';
import { bucketByRecency } from '../../views/home/blocks/recency-buckets';
import {
  formatWakeTime,
  type HomeLaneItem,
} from '../../views/home/home-lane-model';
import { revealHomeRegion } from '../../views/home/home-reveal';
import type { HomeWorkItem } from '../../views/home/home-view-model';
import type { HomeWorkLanes } from '../../views/home/useHomeWorkLanes';
import { ReturnGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { Empty, ErrorState, SkeletonList } from '../state';
import { renderHomeWorkRow } from './HomeWorkRow';

const OPEN_NEW_CHAT_EVENT = 'station:open-new-chat';
const SETTLED_PAGE_SIZE = 5;
const loadSnoozeMenu = () => import('./SnoozeMenu');

const ACTIVE_HEADING_ID = 'home-active-now-heading';
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
  workLoading: boolean;
  workDegraded: boolean;
  workError: boolean;
  agents: readonly SessionIconAgent[];
  remoteUnavailable: { environmentName: string }[];
  remoteAuthenticationRequired: { environmentName: string }[];
  /** Per-project rows the host's activity chart renders — the "Projects"
   *  count, which must describe those rows and not a second population. */
  projectRowCount: number;
  /** Reveals the host's activity chart, or `null` when it is not rendered. */
  onShowProjects: (() => void) | null;
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
}

function useHomeWorkController(lanes: HomeWorkLanes): HomeWorkController {
  const [snoozeMenuFor, setSnoozeMenuFor] = useState<HomeLaneItem | null>(null);
  const snoozeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [shelfExpanded, setShelfExpanded] = useState(false);
  const [settledVisibleCount, setSettledVisibleCount] =
    useState(SETTLED_PAGE_SIZE);
  return {
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
  return (
    <section
      className="home-view__recent"
      aria-labelledby="recent-work-heading"
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
  agents,
  projectRowCount,
  onShowProjects,
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
        stats={pulseStats(
          controller.lanes,
          projectRowCount,
          statTargets(controller, onShowProjects),
        )}
      />
      <HomeWorkLanesContent
        controller={controller}
        agents={agents}
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
  onShowProjects: (() => void) | null,
): Record<string, PulseStatTarget> {
  const { lanes } = controller;
  const targets: Record<string, PulseStatTarget> = {
    // The active lane renders unconditionally inside `HomeWorkLanesContent`,
    // including at zero, so this target always exists in this branch.
    'Active now': {
      destination: 'show the Active now lane',
      onActivate: () => revealHomeRegion(ACTIVE_HEADING_ID),
    },
  };
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
  if (onShowProjects) {
    targets.Projects = {
      destination: 'show where the work has been',
      onActivate: onShowProjects,
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

function RecentWorkEmpty() {
  return (
    <Empty
      variant="prominent"
      label="Ready for your first direct chat"
      description="Start a chat here, or open a local project to create a durable Task."
      action={
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_NEW_CHAT_EVENT))}
        >
          Start your first chat
        </button>
      }
    />
  );
}

function HomeWorkLanesContent({
  controller,
  agents,
  onOpen,
}: {
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
  onOpen: (task: HomeWorkItem) => void;
}) {
  return (
    <>
      <HomeActiveLane controller={controller} agents={agents} onOpen={onOpen} />
      <HomeRecentlyFinishedLane
        lanes={controller.lanes}
        agents={agents}
        onOpen={onOpen}
      />
      <HomeSnoozeMenu controller={controller} />
      <HomeSnoozedShelf controller={controller} />
      <HomeSettledTail
        controller={controller}
        agents={agents}
        onOpen={onOpen}
      />
    </>
  );
}

function HomeActiveLane({
  controller,
  agents,
  onOpen,
}: {
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
  onOpen: (task: HomeWorkItem) => void;
}) {
  const { active } = controller.lanes;
  return (
    <section aria-labelledby={ACTIVE_HEADING_ID}>
      {/* `tabIndex={-1}`: the "Active now" count reveals this lane, and a
          reveal that only scrolls leaves a keyboard reader's focus parked
          where it was. */}
      <h3
        id={ACTIVE_HEADING_ID}
        className="home-view__group-label"
        tabIndex={-1}
      >
        Active now ({active.length})
      </h3>
      {active.length > 0 && (
        <ul className="home-view__task-list">
          {active.map((task) =>
            renderHomeWorkRow({
              task,
              isWoken: controller.lanes.isWoken(task.id),
              agents,
              onOpen,
              onSnooze: controller.openSnoozeMenu,
            }),
          )}
        </ul>
      )}
    </section>
  );
}

function HomeRecentlyFinishedLane({
  lanes,
  agents,
  onOpen,
}: {
  lanes: HomeWorkLanes;
  agents: readonly SessionIconAgent[];
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
          renderHomeWorkRow({ task, isWoken: false, agents, onOpen }),
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
  onOpen,
}: {
  controller: HomeWorkController;
  agents: readonly SessionIconAgent[];
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
              renderHomeWorkRow({ task, isWoken: false, agents, onOpen }),
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
