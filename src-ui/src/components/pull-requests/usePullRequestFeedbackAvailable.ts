import { PULL_REQUEST_FEEDBACK_PREVIEW_ID } from '@kontourai/station-contracts/pull-request-feedback';
import { readPullRequestFeedbackCapability } from '@kontourai/station-sdk/pull-request-feedback';
import { useQuery } from '@tanstack/react-query';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';

/**
 * Whether this host offers pull request agent feedback: the
 * `pull-request-agent-feedback` preview is on and the host serves it. The
 * capability read shares its cache entry with `usePullRequestFeedback`.
 * `pending` while that read has not answered.
 */
export function usePullRequestFeedbackAvailable(): {
  available: boolean;
  pending: boolean;
} {
  const scope = useHostRequestAuthorityScope();
  const preview = useSurfaceVisibilityFlags().has(
    PULL_REQUEST_FEEDBACK_PREVIEW_ID,
  );
  const capability = useQuery({
    queryKey: ['pull-request-feedback-capability', scope?.apiBase],
    queryFn: () => readPullRequestFeedbackCapability(scope!.apiBase),
    enabled: preview && !!scope?.isCurrent(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return {
    available: preview && capability.data === true,
    pending: preview && capability.isPending,
  };
}
