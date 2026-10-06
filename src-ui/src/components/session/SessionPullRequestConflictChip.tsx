import type {
  OrchestrationSessionSummary,
  PullRequestBranchMergeability,
  PullRequestResult,
} from '@kontourai/station-sdk';
import {
  usePullRequestContextQuery,
  usePullRequestMergeabilityQuery,
} from '@kontourai/station-sdk';

/**
 * Conflicts change on the forge's schedule, not this client's; two minutes
 * keeps the indicator honest without spending the operator's forge quota
 * (#2937). A return to the window refetches an answer older than this, and
 * TanStack skips interval fetches while the document is hidden.
 */
export const OBSERVATION_INTERVAL_MS = 120_000;

const observed = {
  refetchInterval: OBSERVATION_INTERVAL_MS,
  refetchOnWindowFocus: true,
  staleTime: OBSERVATION_INTERVAL_MS,
};

/**
 * A live forge observation for one session's recorded worktree. The chip is
 * intentionally absent until both the checkout context and the mergeability
 * answer are available: an old creation-time value would be a false claim.
 *
 * Every row of one repository observes the same repository-keyed query.
 * TanStack re-arms each observer's interval whenever that query updates, so
 * the rows' timers fire together and join one fetch per interval.
 */
export function SessionPullRequestConflictChip({
  session,
}: {
  session: OrchestrationSessionSummary;
}) {
  const project = session.projectSlug ?? '';
  const context = usePullRequestContextQuery(
    { project, thread: session.threadId },
    { ...observed, enabled: Boolean(session.projectSlug) },
  );
  const identity = context.data?.available ? context.data : undefined;
  const mergeability = usePullRequestMergeabilityQuery(
    identity?.provider ?? '',
    identity?.host ?? '',
    identity?.repository.owner ?? '',
    identity?.repository.name ?? '',
    project,
    { ...observed, enabled: Boolean(identity) },
  );
  const result = mergeability.data as
    | PullRequestResult<PullRequestBranchMergeability[]>
    | undefined;
  const isConflicted =
    result?.available === true &&
    result.data?.some(
      (pullRequest) =>
        pullRequest.sourceBranch === identity?.branch &&
        (!identity?.pushTargetOwner ||
          !pullRequest.sourceOwner ||
          identity.pushTargetOwner.toLowerCase() ===
            pullRequest.sourceOwner.toLowerCase()) &&
        pullRequest.mergeability === 'conflicting',
    );

  if (!isConflicted) return null;
  return (
    <span
      className="session-pr-conflict-chip"
      title="The pull request for this session's branch has conflicts"
    >
      PR conflict
    </span>
  );
}
