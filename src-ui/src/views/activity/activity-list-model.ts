import type { ClientOriginSurface } from '@kontourai/station-contracts/client-origin';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { clientOriginSummary } from '../../utils/clientOrigin';
import { relativeTime } from '../../utils/relativeTime';
import { activeTurnProgress } from '../../utils/session-state';
import { foldConversationTurns } from '../sessions/conversation-groups';
import { groupDelegatedSessionRuns } from '../sessions/run-groups';
import {
  matchesProjectFilter,
  sessionProjectKeys,
} from '../sessions/sessions-lane-model';

/**
 * Pure presentation helpers for the Activity list. None of these classify a
 * session's STATE — that stays `partitionSessionLanes` /
 * `orchestrationLifecycleLabel` (#3027, #3227). These only answer "which
 * filter bucket" and "what short words go on the row".
 */

function isAttached(session: OrchestrationSessionSummary): boolean {
  return session.controlMode === 'read-only-attached';
}

function attachedEngineName(session: OrchestrationSessionSummary): string {
  return engineDisplayLabel(session.provider) ?? 'another app';
}

/**
 * The "Started from" filter bucket: the recorded turn origin as
 * `clientOriginSummary` words it, "Started in <engine>" for an attached
 * transcript, and an explicit "Origin not recorded" otherwise — never a
 * guessed origin (the summary's `turnOrigin` is absent when the latest turn
 * carried none).
 */
export function activityOriginKey(
  session: OrchestrationSessionSummary,
): string {
  const origin = session.turnOrigin?.latest;
  if (origin) return clientOriginSummary(origin);
  if (isAttached(session)) return `Started in ${attachedEngineName(session)}`;
  return 'Origin not recorded';
}

const SHORT_SURFACE_LABELS: Record<ClientOriginSurface, string | null> = {
  web: 'Browser',
  desktop: 'Desktop app',
  mobile: 'Mobile app',
  cli: 'CLI',
  mcp: 'MCP client',
  unknown: null,
};

/**
 * The row's short origin word ("CLI", "Browser", "Claude Code"), or `null`
 * when nothing was recorded — the row omits the segment rather than printing
 * "unknown". No device NAME reaches this seam (the origin carries only a
 * device id), so a paired device reads by its surface.
 */
export function activityOriginShortLabel(
  session: OrchestrationSessionSummary,
): string | null {
  const origin = session.turnOrigin?.latest;
  if (origin) return SHORT_SURFACE_LABELS[origin.reported.surface] ?? null;
  if (isAttached(session)) return attachedEngineName(session);
  return null;
}

export type ActivityKindFilter = 'all' | 'conversations' | 'tasks';

export const ACTIVITY_KIND_OPTIONS: ReadonlyArray<{
  value: ActivityKindFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'tasks', label: 'Tasks' },
];

export interface ActivityFilters {
  kind: ActivityKindFilter;
  /** A project key from `sessionProjectKeys`, or null for every project. */
  project: string | null;
  /** An `activityOriginKey` value, or null for every origin. */
  origin: string | null;
}

export const NO_ACTIVITY_FILTERS: ActivityFilters = {
  kind: 'all',
  project: null,
  origin: null,
};

export function hasActiveActivityFilters(filters: ActivityFilters): boolean {
  return (
    filters.kind !== 'all' ||
    filters.project !== null ||
    filters.origin !== null
  );
}

/** A delegated session is a "task"; everything else is a conversation. */
export function matchesActivityKind(
  session: OrchestrationSessionSummary,
  kind: ActivityKindFilter,
): boolean {
  if (kind === 'all') return true;
  return kind === 'tasks' ? Boolean(session.delegation) : !session.delegation;
}

export function matchesActivityOrigin(
  session: OrchestrationSessionSummary,
  origin: string | null,
): boolean {
  return origin === null || activityOriginKey(session) === origin;
}

/**
 * The sessions the list actually shows as rows: delegated runs kept whole,
 * sibling turn-sessions of one conversation folded to their representative
 * (`foldConversationTurns`, with the list's own `pinnedThreadId`). Lane
 * headings count this population, so filter option counts must too — a
 * three-turn chat is one row, not three.
 */
export function foldedActivityPopulation(
  sessions: readonly OrchestrationSessionSummary[],
  pinnedThreadId: string | null = null,
): OrchestrationSessionSummary[] {
  return foldConversationTurns(groupDelegatedSessionRuns(sessions), {
    pinnedThreadId,
  }).presentations.flatMap((presentation) =>
    presentation.kind === 'run'
      ? [...presentation.run.members]
      : [presentation.session],
  );
}

export interface ActivityFilterOption {
  value: string;
  label: string;
  count: number;
}

/**
 * One option per value, counted the way the list would show it: the list
 * filters SESSIONS by the option and then folds, so each count is
 * `fold(sessions matching the option).length` — never "fold, then bucket the
 * representatives", which files a conversation that ran turns from two
 * origins under only its newest one and makes the other option vanish even
 * though choosing it shows a row.
 */
function countedOptions(
  sessions: readonly OrchestrationSessionSummary[],
  keysOf: (session: OrchestrationSessionSummary) => readonly string[],
  matches: (session: OrchestrationSessionSummary, value: string) => boolean,
  pinnedThreadId: string | null,
): ActivityFilterOption[] {
  const values = new Set(sessions.flatMap((session) => [...keysOf(session)]));
  return [...values]
    .map((value) => ({
      value,
      label: value,
      count: foldedActivityPopulation(
        sessions.filter((session) => matches(session, value)),
        pinnedThreadId,
      ).length,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Project options, matched by the same predicate the Project filter uses. */
export function activityProjectOptions(
  sessions: readonly OrchestrationSessionSummary[],
  pinnedThreadId: string | null = null,
): ActivityFilterOption[] {
  return countedOptions(
    sessions,
    sessionProjectKeys,
    (session, value) => matchesProjectFilter(session, value),
    pinnedThreadId,
  );
}

export function activityOriginOptions(
  sessions: readonly OrchestrationSessionSummary[],
  pinnedThreadId: string | null = null,
): ActivityFilterOption[] {
  return countedOptions(
    sessions,
    (session) => [activityOriginKey(session)],
    (session, value) => matchesActivityOrigin(session, value),
    pinnedThreadId,
  );
}

export type DatedStreamBucket =
  | 'Earlier today'
  | 'Yesterday'
  | 'This week'
  | 'Older';

export const DATED_STREAM_ORDER: readonly DatedStreamBucket[] = [
  'Earlier today',
  'Yesterday',
  'This week',
  'Older',
];

/** Local midnight `daysBack` calendar days before `now`'s day. */
function localMidnight(now: number, daysBack: number): number {
  const day = new Date(now);
  // setDate/setHours step by CALENDAR day in local time, so a day that is
  // 23 or 25 hours long (a DST change) still starts at its own midnight;
  // subtracting a fixed 24h does not.
  day.setDate(day.getDate() - daysBack);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Which dated sub-section a finished session reads under, by the same
 * recency fold the lanes sort by (`sessionRecency`). Calendar days in the
 * reader's local time: today, yesterday, the five days before yesterday
 * ("This week"), then older. A stamp in the future (clock skew) reads as
 * today; a session with no parseable stamp (`recency <= 0`) is "Older" —
 * never claimed as recent.
 */
export function datedStreamBucket(
  recency: number,
  now: number,
): DatedStreamBucket {
  if (!Number.isFinite(recency) || recency <= 0) return 'Older';
  if (recency >= localMidnight(now, 0)) return 'Earlier today';
  if (recency >= localMidnight(now, 1)) return 'Yesterday';
  if (recency >= localMidnight(now, 6)) return 'This week';
  return 'Older';
}

/**
 * The running detail a Running row adds to its state word: how long the
 * open turn has run ("for 3m") and what it is doing ("using Bash", or when
 * no tool is in flight, "last progress 2m ago"). Every fact is read from the
 * summary's own projections — `conversationActivity.openTurn`/`runningTools`
 * (the same fold as `hasActiveTurn`) and `activeTurnProgress`'s
 * applicability gate — and any missing or sub-minute one is omitted, never
 * defaulted: a fresh turn reads plain "Running".
 */
export function activityRunningDetail(
  session: OrchestrationSessionSummary,
  now: number,
): { duration: string | null; activity: string | null } {
  if (!session.hasActiveTurn) return { duration: null, activity: null };
  const activity = session.conversationActivity;
  const minutesSince = (stamp: string | undefined) => {
    const at = Date.parse(stamp ?? '');
    if (!Number.isFinite(at) || at <= 0) return null;
    const compact = relativeTime(at, now);
    return compact === 'now' ? null : compact;
  };
  const duration = minutesSince(activity?.openTurn?.startedAt);
  const runningTool = activity?.runningTools?.at(-1)?.name;
  if (runningTool) return { duration, activity: `using ${runningTool}` };
  const progress = minutesSince(
    activeTurnProgress(session)?.lastProgressEventAt,
  );
  return {
    duration,
    activity: progress ? `last progress ${progress} ago` : null,
  };
}
