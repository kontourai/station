import type { ClientOriginSurface } from '@kontourai/station-contracts/client-origin';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { clientOriginSummary } from '../../utils/clientOrigin';
import { relativeTime } from '../../utils/relativeTime';
import { activeTurnProgress } from '../../utils/session-state';
import { sessionProjectKeys } from '../sessions/sessions-lane-model';

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

export interface ActivityFilterOption {
  value: string;
  label: string;
  count: number;
}

/**
 * Options built from the data actually listed, each with its count, sorted
 * by name. A project an ambiguous session names is counted under each
 * candidate, the same rule `matchesProjectFilter` filters by.
 */
export function activityProjectOptions(
  sessions: readonly OrchestrationSessionSummary[],
): ActivityFilterOption[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    for (const key of sessionProjectKeys(session)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function activityOriginOptions(
  sessions: readonly OrchestrationSessionSummary[],
): ActivityFilterOption[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    const key = activityOriginKey(session);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
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

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(epochMs: number): number {
  const day = new Date(epochMs);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Which dated sub-section a finished session reads under, by the same
 * recency fold the lanes sort by (`sessionRecency`). Calendar days in the
 * reader's local time; "This week" is the five days before yesterday. A
 * session with no parseable stamp (`recency <= 0`) is "Older" — never
 * claimed as recent.
 */
export function datedStreamBucket(
  recency: number,
  now: number,
): DatedStreamBucket {
  if (!Number.isFinite(recency) || recency <= 0) return 'Older';
  const today = startOfLocalDay(now);
  if (recency >= today) return 'Earlier today';
  if (recency >= today - DAY_MS) return 'Yesterday';
  if (recency >= today - 6 * DAY_MS) return 'This week';
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

/**
 * Where "Open in chat" goes for a Station-owned session: the chat dock deep
 * link the server's `sessionOpenHref` and notification activation
 * (`lib/notification-activation.ts`) already produce —
 * `?chat=<id>&dock=open`, under the project page when the session has a
 * local one.
 * The dock resolves `chat` against an open tab's conversation id or a
 * conversation lookup, so the conversation id is preferred when known.
 */
export function activityChatTarget(session: OrchestrationSessionSummary): {
  pathname: string;
  params: Record<string, string>;
} {
  // The LOCAL project attribution only: a delegation's `projectSlug` may be a
  // remote Station's unverified name (archive#1463), not a page here.
  const projectSlug = session.projectSlug;
  return {
    pathname: projectSlug
      ? `/projects/${encodeURIComponent(projectSlug)}`
      : '/',
    params: { chat: session.conversationId ?? session.threadId, dock: 'open' },
  };
}
