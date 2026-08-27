import type {
  OrchestrationSessionSummary,
  PullRequest,
  PullRequestResult,
} from '@kontourai/station-sdk';
import {
  usePullRequestContextQuery,
  usePullRequestsQuery,
} from '@kontourai/station-sdk';

const OBSERVATION_INTERVAL_MS = 30_000;

/**
 * A live forge observation for one session's recorded worktree. The chip is
 * intentionally absent until both the checkout context and list response are
 * available: an old creation-time value would be a false claim.
 */
export function SessionPullRequestConflictChip({
  session,
}: {
  session: OrchestrationSessionSummary;
}) {
  const resolvingContext = {
    project: session.projectSlug ?? '',
    thread: session.threadId,
  };
  const context = usePullRequestContextQuery(resolvingContext, {
    enabled: Boolean(session.projectSlug),
    refetchInterval: OBSERVATION_INTERVAL_MS,
  });
  const identity = context.data?.available ? context.data : undefined;
  const pullRequests = usePullRequestsQuery(
    identity?.provider ?? '',
    identity?.host ?? '',
    identity?.repository.owner ?? '',
    identity?.repository.name ?? '',
    resolvingContext,
    { state: 'OPEN' },
    {
      enabled: Boolean(identity),
      refetchInterval: OBSERVATION_INTERVAL_MS,
    },
  );
  const result = pullRequests.data as
    | PullRequestResult<PullRequest[]>
    | undefined;
  const isConflicted =
    result?.available === true &&
    result.data?.some(
      (pullRequest) =>
        pullRequest.sourceBranch === identity?.branch &&
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
