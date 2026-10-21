import {
  type ClientOriginSurface,
  clientOriginSender,
} from '@kontourai/station-contracts/client-origin';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { clientOriginSummary } from '../../utils/clientOrigin';
import { foldConversationTurns } from '../sessions/conversation-groups';
import { groupDelegatedSessionRuns } from '../sessions/run-groups';
import {
  matchesProjectFilter,
  sessionProjectKeys,
} from '../sessions/sessions-lane-model';

/**
 * Pure presentation helpers for the Activity list. None of these classify a
 * session's STATE or word it — that is `partitionSessionLanes` and the status
 * ladder (`sessionWorkStatus`; #3027, #3227). These only answer "which
 * filter bucket" and "which short origin word goes on the row".
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
  if (clientOriginSender(origin)) return 'Agent message';
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

/**
 * #3386: the Project filter's value for a session no project claims — a
 * direct chat started with No project, or a conversation started outside
 * Station in a folder that belongs to no project. The words are the ones Home
 * and the start composer use for the same absence. As a value it cannot be
 * mistaken for a project: a project slug is lowercase with no spaces
 * (`slugifyProjectName`).
 */
const NO_PROJECT_FILTER = 'No project';

/**
 * The Project filter predicate: {@link NO_PROJECT_FILTER} matches exactly the
 * sessions with no project key; anything else is `matchesProjectFilter`. An
 * ambiguous session names projects, so it is never under No project, even
 * when its candidate list was cut short.
 */
export function matchesActivityProject(
  session: OrchestrationSessionSummary,
  filter: string | null,
): boolean {
  if (filter === NO_PROJECT_FILTER)
    return sessionProjectKeys(session).length === 0;
  return matchesProjectFilter(session, filter);
}

function activityProjectKeys(session: OrchestrationSessionSummary): string[] {
  const keys = sessionProjectKeys(session);
  return keys.length > 0 ? keys : [NO_PROJECT_FILTER];
}

export interface ActivityFilters {
  kind: ActivityKindFilter;
  /** A project key from `sessionProjectKeys`, {@link NO_PROJECT_FILTER}, or null for every project. */
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
function foldedActivityPopulation(
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

/**
 * Project options, matched by the same predicate the Project filter uses,
 * with No project listed last whenever a session has none.
 */
export function activityProjectOptions(
  sessions: readonly OrchestrationSessionSummary[],
  pinnedThreadId: string | null = null,
): ActivityFilterOption[] {
  const options = countedOptions(
    sessions,
    activityProjectKeys,
    matchesActivityProject,
    pinnedThreadId,
  );
  // After every named project, not alphabetised among them.
  return [
    ...options.filter((option) => option.value !== NO_PROJECT_FILTER),
    ...options.filter((option) => option.value === NO_PROJECT_FILTER),
  ];
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
