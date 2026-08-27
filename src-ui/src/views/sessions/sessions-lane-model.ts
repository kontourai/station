import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { AgentSummary } from '../../types';
import {
  partitionHomeWorkItems,
  terminalSinceFromRecency,
  withStableIds,
} from '../home/home-lane-model';
import {
  buildOrchestrationItems,
  compareTaskRecency,
  type HomeWorkItem,
} from '../home/home-view-model';

/**
 * State lanes for the Sessions list (station#3027). The owner's decision was
 * "by state yes" — the list stops being grouped by project (which read as a
 * filing cabinet) and groups by what each session wants from you.
 *
 * REUSE, NOT A SECOND CLASSIFIER. Home already answers "is this session still
 * going, just finished, or over?" for these exact sessions, through
 * `partitionHomeWorkItems`. Deriving a parallel answer here from
 * `lifecycleState` is how two surfaces come to disagree about one session —
 * so the sessions are converted to `HomeWorkItem`s by Home's own adapter
 * (`buildOrchestrationItems`) and handed to Home's own partition. Everything
 * lane-specific to this surface is the split of `active` into "Needs you" vs
 * "Active now" and the lane ORDER, both of which are presentation.
 */
export type SessionLaneId =
  | 'needsYou'
  | 'activeNow'
  | 'recentlyFinished'
  | 'earlier';

/** Reading order: what is blocked on you, then what is moving, then history. */
export const SESSION_LANE_ORDER: readonly SessionLaneId[] = [
  'needsYou',
  'activeNow',
  'recentlyFinished',
  'earlier',
];

export const SESSION_LANE_LABELS: Record<SessionLaneId, string> = {
  needsYou: 'Needs you',
  activeNow: 'Active now',
  recentlyFinished: 'Recently finished',
  earlier: 'Earlier',
};

export interface SessionLane {
  id: SessionLaneId;
  label: string;
  /** Rendered heading, count included — an empty lane is never emitted. */
  heading: string;
  sessions: OrchestrationSessionSummary[];
}

/**
 * Home's snooze shelf is backed by a persisted per-item store
 * (`terminal-since-store.ts` / `useHomeWorkLanes`). The Sessions list has no
 * snooze verb and no such store, so this is always empty and the partition's
 * `snoozed` bucket is provably empty here. It is still passed (rather than
 * the partition being forked) so a future snooze on this surface is a wiring
 * change, not a re-derivation — and `snoozed` is folded into Earlier below so
 * a non-empty map could never silently drop rows.
 */
const NO_SNOOZE: ReadonlyMap<string, number> = new Map();

// The fresh-load `terminalSince` proxy (seed from `item.updatedAt` — the max
// of updatedAt/lastEventAt/createdAt that `buildSessionWorkItem` already
// computes) moved to `home-lane-model.ts`'s `terminalSinceFromRecency` when
// the mobile activity groups adopted the same pattern (station#3227 A6), so
// the two store-less surfaces share one seeding rule instead of two copies.

/**
 * "Needs you" is `lifecycleLabel === 'Needs attention'` — the fold
 * `orchestrationLifecycleLabel` already computes from
 * `pendingReview`/`needs_input`/`review_pending`/`blocked`, gated on
 * `answerability` so a session nothing can answer is NOT claimed as yours to
 * act on (it stays in Active now as `'Unanswerable'`, carrying its basis).
 *
 * Deliberately not "delegated sessions that are waiting", which was the
 * shape the ticket sketched: a NON-delegated session sitting on `needs_input`
 * is blocked on the user just as hard, and filing it under "Active now"
 * would be the list telling the reader nothing is waiting when something is.
 * The delegated case is a subset, so the ticket's motivation still lands —
 * `DelegatedTaskCoordinator` renders `tasks[0]` only, so the second waiting
 * delegated session had nowhere to appear before this lane existed.
 */
function needsYou(item: HomeWorkItem): boolean {
  return item.lifecycleLabel === 'Needs attention';
}

/**
 * Lanes in reading order, each internally newest-first, empty lanes omitted.
 *
 * `now` is injected rather than read, so lane membership is testable without
 * faking timers — the same discipline `home-lane-model.ts` uses.
 */
export function partitionSessionLanes({
  sessions,
  agents,
  now,
}: {
  sessions: readonly OrchestrationSessionSummary[];
  agents: AgentSummary[];
  now: number;
}): SessionLane[] {
  const items = buildOrchestrationItems([...sessions], agents);
  const partition = partitionHomeWorkItems({
    items: withStableIds(items, new Map()),
    now,
    snoozedUntil: NO_SNOOZE,
    terminalSince: terminalSinceFromRecency(items),
  });

  const byThreadId = new Map(
    sessions.map((session) => [session.threadId, session]),
  );
  // `buildOrchestrationItems` keys a local orchestration item by the session's
  // own threadId, so this lookup is total for every item it produced.
  const resolve = (laneItems: readonly HomeWorkItem[]) =>
    [...laneItems]
      .sort(compareTaskRecency)
      .map((item) => byThreadId.get(item.id))
      .filter((session): session is OrchestrationSessionSummary =>
        Boolean(session),
      );

  const membership: Record<SessionLaneId, OrchestrationSessionSummary[]> = {
    needsYou: resolve(partition.active.filter(needsYou)),
    activeNow: resolve(partition.active.filter((item) => !needsYou(item))),
    recentlyFinished: resolve(partition.recentlyFinished),
    // The snoozed bucket is folded in rather than dropped: this surface has no
    // snooze store today (see NO_SNOOZE), and a bucket that is silently
    // discarded is how rows vanish the day one is introduced.
    earlier: resolve([...partition.settled, ...partition.snoozed]),
  };

  return SESSION_LANE_ORDER.filter(
    (lane) => membership[lane].length > 0,
  ).map<SessionLane>((lane) => ({
    id: lane,
    label: SESSION_LANE_LABELS[lane],
    heading: `${SESSION_LANE_LABELS[lane]} · ${membership[lane].length}`,
    sessions: membership[lane],
  }));
}

/**
 * Every project this Station can attribute the session to — one key for a
 * settled attribution, ALL named candidates for an ambiguous one, none when
 * nothing is known.
 *
 * Plural is the whole point (station#1462): a working directory configured as
 * two projects produces a session that genuinely belongs to neither
 * exclusively, and picking a winner here would be the label-without-a-
 * derivation defect. It appears under BOTH candidates' filters instead.
 */
export function sessionProjectKeys(
  session: OrchestrationSessionSummary,
): string[] {
  const delegated = session.delegation?.projectSlug;
  if (delegated) return [delegated];
  if (session.projectSlug) return [session.projectSlug];
  const attribution = session.projectAttribution;
  if (attribution?.state === 'ambiguous') return [...attribution.candidates];
  return [];
}

/**
 * True when the candidate list this Station sent is a bounded PREFIX
 * (`ATTACHED_SESSION_PROJECT_CANDIDATES_MAX`), so the named candidates are not
 * the whole answer.
 */
export function hasTruncatedProjectAttribution(
  session: OrchestrationSessionSummary,
): boolean {
  return (session.projectAttribution?.omittedCandidates ?? 0) > 0;
}

/**
 * The project filter predicate.
 *
 * THE AMBIGUOUS RULE, stated so it can be argued with: a filter never hides a
 * session it cannot prove is unrelated.
 * - A session attributed to exactly one project matches that project only.
 * - An AMBIGUOUS session matches EVERY named candidate — it is visible under
 *   `station` and under `beacon`, not arbitrarily filed under one of them and
 *   missing from the other.
 * - A session whose candidate list was TRUNCATED matches every filter, because
 *   the omitted tail may contain the filtered project and a strict miss would
 *   hide it with no signal. That is fail-open, and it is not silent: the row
 *   keeps its `ambiguous (…, and N more)` pill, so a reader who wonders why it
 *   is in this filter can see the answer on the row.
 * - A session with NO project attribution matches no project filter (it has no
 *   claim to be under one), and is reachable by clearing the filter.
 */
export function matchesProjectFilter(
  session: OrchestrationSessionSummary,
  filter: string | null,
): boolean {
  if (!filter) return true;
  if (sessionProjectKeys(session).includes(filter)) return true;
  return hasTruncatedProjectAttribution(session);
}

/**
 * The project key clicking this session's pill filters to, or `null` when the
 * pill must not be a filter control.
 *
 * `null` for an ambiguous session on purpose: the pill names two candidates,
 * and a single click cannot say which one the user meant. Its pill renders
 * static, and the session still shows up under either candidate's filter (set
 * from an unambiguous row's pill) by `matchesProjectFilter` above.
 */
export function sessionProjectFilterKey(
  session: OrchestrationSessionSummary,
): string | null {
  const keys = sessionProjectKeys(session);
  return keys.length === 1 ? keys[0] : null;
}
