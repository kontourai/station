import type {
  OrchestrationSessionSummary,
  PullRequestBranchMergeability,
  PullRequestResult,
} from '@kontourai/station-sdk';
import {
  usePullRequestContextQuery,
  usePullRequestMergeabilityQuery,
} from '@kontourai/station-sdk';

import { useEffect, useRef, useState } from 'react';

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
  const marker = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );
  useEffect(() => {
    const element = marker.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    // Observe the row's box: an absent chip has no area of its own.
    const row = element.closest('button') ?? element.parentElement ?? element;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setVisible(entry.isIntersecting);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const project = session.projectSlug ?? '';
  const context = usePullRequestContextQuery(
    { project, thread: session.threadId },
    { ...observed, enabled: visible && Boolean(session.projectSlug) },
  );
  const identity = context.data?.available ? context.data : undefined;
  const mergeability = usePullRequestMergeabilityQuery(
    identity?.provider ?? '',
    identity?.host ?? '',
    identity?.repository.owner ?? '',
    identity?.repository.name ?? '',
    project,
    { ...observed, enabled: visible && Boolean(identity) },
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

  return (
    <span ref={marker}>
      {isConflicted && (
        <span
          className="session-pr-conflict-chip"
          title="The pull request for this session's branch has conflicts"
        >
          PR conflict
        </span>
      )}
    </span>
  );
}
