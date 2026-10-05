import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { workGroupLabelText } from '../../components/inbox-row/work-group-label';
import type { AgentSummary } from '../../types';
import { splitDraftsByAge } from '../home/draft-lane';
import {
  LIVE_LANE_LABELS,
  type LiveLaneId,
  partitionHomeWorkItems,
  terminalSinceFromRecency,
  withStableIds,
} from '../home/home-lane-model';
import {
  buildOrchestrationItems,
  compareTaskRecency,
  type HomeWorkItem,
} from '../home/home-view-model';
import { buildWorkFacts } from '../home/work-facts';
import { type WorkStatus, workStatus } from '../home/work-status';

/**
 * State lanes for the Sessions list (archive#3027). The owner's decision was
 * "by state yes" — the list stops being grouped by project (which read as a
 * filing cabinet) and groups by what each session wants from you.
 *
 * REUSE, NOT A SECOND CLASSIFIER. Home already answers "is this session still
 * going, just finished, or over?" for these exact sessions, through
 * `partitionHomeWorkItems`. Deriving a parallel answer here from
 * `lifecycleState` is how two surfaces come to disagree about one session —
 * so the sessions are converted to `HomeWorkItem`s by Home's own adapter
 * (`buildOrchestrationItems`) and handed to Home's own partition, including
 * its live split into Needs you / Running / Idle (`workStatus`). Everything
 * lane-specific to this surface is the lane ORDER and labels, which are
 * presentation.
 */
export type SessionLaneId =
  | 'external'
  | LiveLaneId
  | 'recentlyFinished'
  | 'drafts'
  | 'earlier';

/**
 * Reading order: what is blocked on you, what is moving, what is idle, what
 * never started, then history — the same order as the chat dock inbox.
 */
export const SESSION_LANE_ORDER: readonly SessionLaneId[] = [
  'needsYou',
  'running',
  'idle',
  'drafts',
  'recentlyFinished',
  'earlier',
  'external',
];

export const SESSION_LANE_LABELS: Record<SessionLaneId, string> = {
  ...LIVE_LANE_LABELS,
  recentlyFinished: 'Just finished',
  drafts: 'Drafts',
  earlier: 'Earlier',
  external: 'From other apps',
};

/**
 * A session's status, in the status ladder's words — the one read every
 * surface that lists `OrchestrationSessionSummary`s directly (the Activity
 * list, the session detail header, the project page's live work) makes.
 * The summary is converted by Home's own adapter and its facts derived
 * beside it, exactly as the inbox rows do, so an Activity row and the dock
 * row for the same session cannot print two words.
 */
export function sessionWorkStatuses(
  sessions: readonly OrchestrationSessionSummary[],
  agents: AgentSummary[],
  now: number,
): Map<string, WorkStatus> {
  const items = buildOrchestrationItems([...sessions], agents);
  const facts = buildWorkFacts({ items, sessions });
  return new Map(
    items.map((item) => [item.id, workStatus(item, now, facts.get(item.id))]),
  );
}

export function sessionWorkStatus(
  session: OrchestrationSessionSummary,
  agents: AgentSummary[],
  now: number,
): WorkStatus {
  const status = sessionWorkStatuses([session], agents, now).get(
    session.threadId,
  );
  if (!status) throw new Error(`no status for session ${session.threadId}`);
  return status;
}

export interface SessionLane {
  id: SessionLaneId;
  label: string;
  /** Rendered heading, count included — an empty lane is never emitted. */
  heading: string;
  sessions: OrchestrationSessionSummary[];
  /**
   * #2312, the Drafts lane only: the members untouched for a day, which the
   * list folds under "N older drafts". Always the lane's trailing members
   * (the lane is newest-first), so the fold is contiguous.
   */
  olderDraftThreadIds?: ReadonlySet<string>;
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
// the mobile activity groups adopted the same pattern (archive#3227 A6), so
// the two store-less surfaces share one seeding rule instead of two copies.

// "Needs you" is `workStatus`'s `Needs attention` lane — the fold
// `orchestrationLifecycleLabel` already computes from `pendingReview`/
// `needs_input`/`review_pending`/`blocked`, gated on `answerability` so a
// session nothing can answer is NOT claimed as yours to act on (it is Idle,
// as `'Unanswerable'`, carrying its basis). A NON-delegated session sitting
// on `needs_input` is blocked on the user just as hard as a delegated one,
// so the lane is not restricted to delegation.

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
    external: resolve(partition.external ?? []),
    needsYou: resolve(partition.needsYou),
    running: resolve(partition.running),
    idle: resolve(partition.idle),
    recentlyFinished: resolve(partition.recentlyFinished),
    // #2310: never-prompted sessions, out of the live lanes but still listed.
    drafts: resolve(partition.drafts ?? []),
    // The snoozed bucket is folded in rather than dropped: this surface has no
    // snooze store today (see NO_SNOOZE), and a bucket that is silently
    // discarded is how rows vanish the day one is introduced.
    earlier: resolve([...partition.settled, ...partition.snoozed]),
  };

  const olderDraftThreadIds = new Set(
    splitDraftsByAge(partition.drafts ?? [], now).older.map((item) => item.id),
  );

  return SESSION_LANE_ORDER.filter(
    (lane) => membership[lane].length > 0,
  ).map<SessionLane>((lane) => ({
    id: lane,
    label: SESSION_LANE_LABELS[lane],
    heading: workGroupLabelText(
      SESSION_LANE_LABELS[lane],
      membership[lane].length,
    ),
    sessions: membership[lane],
    ...(lane === 'drafts' && olderDraftThreadIds.size > 0
      ? { olderDraftThreadIds }
      : {}),
  }));
}

/**
 * Every project this Station can attribute the session to — one key for a
 * settled attribution, ALL named candidates for an ambiguous one, none when
 * nothing is known.
 *
 * Plural is the whole point (archive#1462): a working directory configured as
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
