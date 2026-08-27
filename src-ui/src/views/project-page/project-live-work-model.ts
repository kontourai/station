import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import type { AgentSummary } from '../../types';
import {
  matchesProjectFilter,
  partitionSessionLanes,
  type SessionLane,
  type SessionLaneId,
} from '../sessions/sessions-lane-model';

/**
 * One project's LIVE work — the sidebar badge's number and the section at the
 * top of the project page, from a single derivation (station#3202).
 *
 * THIRD CONSUMER, NOT A THIRD CLASSIFIER. Home partitions these sessions
 * (`partitionHomeWorkItems`), the Sessions list splits that partition into
 * lanes (`partitionSessionLanes`, station#3027), and this scopes those lanes
 * to one project. Nothing here decides what "needs you" or "active" means; if
 * it did, a project badge, a project page and the Sessions list could each
 * report a different number for the same session — which is precisely the
 * defect station#3202 was filed about, one layer down.
 *
 * WHAT IS DELIBERATELY EXCLUDED: `recentlyFinished` and `earlier`. The project
 * page shows what is in flight, not an archive — that is the Sessions list's
 * job, which the section links out to. See the badge-semantics note below for
 * what that costs.
 *
 * BADGE SEMANTICS CHANGED HERE, DELIBERATELY. Until station#3202 the badge folded
 * the conversation INVENTORY and counted, among other things, `(completed |
 * failed) && !acknowledged` — "you have not looked at the result"
 * (station#1781). Live work does not include a finished run, so that leg is no
 * longer part of this number. The unseen-result signal is not lost: Home's own
 * lane model keeps a terminal conversation in "Recently finished" until its
 * rendered version is durably acknowledged (`partitionHomeWorkItems`, the
 * `conversationUpdatedAt`/`acknowledgedAt` branch), and the chat dock's inbox
 * reads the same. What changed is only what the PROJECT badge claims.
 */
export const PROJECT_LIVE_LANE_IDS: readonly SessionLaneId[] = [
  'needsYou',
  'activeNow',
];

export interface ProjectLiveWorkInputs {
  sessions: readonly OrchestrationSessionSummary[];
  agents: AgentSummary[];
  now: number;
}

/**
 * The live lanes for one project, in the Sessions list's own reading order
 * (Needs you, then Active now), each already sorted newest-first and each
 * omitted when empty.
 *
 * Scoped with `matchesProjectFilter`, the Sessions list's project predicate,
 * so an ambiguously-attributed session appears under EVERY candidate project
 * rather than being filed under an arbitrary winner — the same rule the
 * Sessions project filter applies, deliberately reused rather than restated.
 */
export function projectLiveLanes({
  sessions,
  agents,
  projectSlug,
  now,
}: ProjectLiveWorkInputs & { projectSlug: string }): SessionLane[] {
  const scoped = sessions.filter((session) =>
    matchesProjectFilter(session, projectSlug),
  );
  return partitionSessionLanes({ sessions: scoped, agents, now }).filter(
    (lane) => PROJECT_LIVE_LANE_IDS.includes(lane.id),
  );
}

/** The badge's number: the total the section lists, by construction. */
export function projectLiveCount(lanes: readonly SessionLane[]): number {
  return lanes.reduce((total, lane) => total + lane.sessions.length, 0);
}

/**
 * What the badge's number means, in words — the answer to "what does the '6'
 * next to kontour mean?".
 *
 * Composed from the lanes it counts, using the Sessions list's own lane labels
 * (`SESSION_LANE_LABELS`), so the tooltip, the section's headings and the
 * Sessions list all name the same populations with the same words. An empty
 * lane contributes nothing, because `partitionSessionLanes` never emits one.
 */
export function projectLiveLabel(lanes: readonly SessionLane[]): string {
  return lanes
    .map((lane) => `${lane.label}: ${lane.sessions.length}`)
    .join(' · ');
}

/** Per-project lanes for a sidebar that renders many projects at once. */
export function projectLiveLanesBySlug({
  sessions,
  agents,
  projectSlugs,
  now,
}: ProjectLiveWorkInputs & {
  projectSlugs: readonly string[];
}): Map<string, SessionLane[]> {
  const lanesBySlug = new Map<string, SessionLane[]>();
  for (const projectSlug of projectSlugs) {
    lanesBySlug.set(
      projectSlug,
      projectLiveLanes({ sessions, agents, projectSlug, now }),
    );
  }
  return lanesBySlug;
}
