import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  PULL_REQUEST_FEEDBACK_PREVIEW_ID,
  PULL_REQUEST_HEAD_REVIEW_PREVIEW_ID,
  type PullRequestFeedbackOwner,
  type PullRequestFeedbackView,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import {
  getConversationPullRequestFeedback,
  getPullRequestFeedbackByPullRequest,
  pullRequestFeedbackOwnerOf,
  pullRequestHeadReviewRefusal,
  readPullRequestFeedbackCapability,
  reviewPullRequestHeadAgain,
  sendPullRequestFeedbackAgain,
  sendPullRequestHeadReviewFindings,
  turnOffPullRequestFeedback,
  writePullRequestFeedback,
} from '@kontourai/station-sdk/pull-request-feedback';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useSurfaceVisibilityFlags } from '../../hooks/useSurfaceVisibilityFlags';
import { userFacingErrorMessage } from '../../utils/errorText';

/**
 * Just the identity: a link observation carries its source and status too,
 * and the server's strict schema refuses anything extra.
 */
const identityOf = (
  link: PullRequestLinkIdentity,
): PullRequestLinkIdentity => ({
  provider: link.provider,
  host: link.host,
  repository: { owner: link.repository.owner, name: link.repository.name },
  ref: link.ref,
});

/** How often an open Details pane re-reads what Station sent. */
const REFRESH_MS = 30_000;

export type PullRequestFeedbackSwitches = {
  fixFailingChecks: boolean;
  addressReviewComments: boolean;
  /**
   * Absent while the head review preview is off: the server then keeps what
   * the chat stored.
   */
  reviewEachHead?: boolean;
};

/**
 * A chat's pull request agent feedback: what Station sent for each linked
 * pull request, and the switches. Off (and never read) unless the
 * `pull-request-agent-feedback` preview is on and the host serves it.
 */
export function usePullRequestFeedback(conversationId: string) {
  const scope = useHostRequestAuthorityScope();
  const flags = useSurfaceVisibilityFlags();
  const preview = flags.has(PULL_REQUEST_FEEDBACK_PREVIEW_ID);
  const capability = useQuery({
    queryKey: ['pull-request-feedback-capability', scope?.apiBase],
    queryFn: () => readPullRequestFeedbackCapability(scope!.apiBase),
    enabled: preview && !!scope?.isCurrent(),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const available = preview && capability.data === true;
  const headReview =
    available && flags.has(PULL_REQUEST_HEAD_REVIEW_PREVIEW_ID);
  const feedback = useQuery({
    queryKey: [
      'pull-request-feedback',
      scope?.apiBase,
      scope?.authorityKey,
      conversationId,
    ],
    queryFn: ({ signal }) =>
      getConversationPullRequestFeedback(scope!.apiBase, conversationId, {
        signal,
        requestScope: scope!,
      }),
    enabled: available && !!scope?.isCurrent() && !!conversationId,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
  const [pending, setPending] = useState<string | null>(null);
  // `text` is display copy, already passed through userFacingErrorMessage.
  const [error, setError] = useState<{ key: string; text: string } | null>(
    null,
  );
  const [conflict, setConflict] = useState<{
    key: string;
    owner: PullRequestFeedbackOwner;
  } | null>(null);
  const byKey = useMemo(() => {
    const views = new Map<string, PullRequestFeedbackView>();
    for (const view of feedback.data?.pullRequests ?? [])
      views.set(pullRequestFeedbackKey(view.identity), view);
    return views;
  }, [feedback.data]);

  const run = async (
    identity: PullRequestLinkIdentity,
    action: () => Promise<unknown>,
  ): Promise<boolean> => {
    const key = pullRequestFeedbackKey(identity);
    if (!scope?.isCurrent() || pending) return false;
    setPending(key);
    setError(null);
    setConflict(null);
    try {
      await action();
      if (scope.isCurrent()) await feedback.refetch();
      return true;
    } catch (caught) {
      if (!scope.isCurrent()) return false;
      const owner = pullRequestFeedbackOwnerOf(caught);
      // Display text Station composed for a refused Review again or Send.
      const refusalDisplayText = pullRequestHeadReviewRefusal(caught);
      if (owner) setConflict({ key, owner });
      else
        setError({
          key,
          text:
            refusalDisplayText ??
            (caught instanceof Error
              ? userFacingErrorMessage(caught)
              : 'Pull request feedback could not be changed'),
        });
      return false;
    } finally {
      if (scope.isCurrent()) setPending(null);
    }
  };

  return {
    available,
    viewerMayChange:
      available &&
      scope?.isCurrent() === true &&
      !feedback.isError &&
      !feedback.isFetching &&
      feedback.data?.viewerMayChange === true,
    /** Station's review of each head is offered (its preview is on). */
    headReview,
    feedback,
    viewFor: (identity: PullRequestLinkIdentity) =>
      byKey.get(pullRequestFeedbackKey(identity)),
    pending,
    error,
    conflict,
    write: (
      identity: PullRequestLinkIdentity,
      settings: PullRequestFeedbackSwitches,
      move = false,
    ) =>
      run(identity, () =>
        // The last switch off is turning feedback off: the one path the
        // Needs-you item's Turn off agent feedback also takes. "Review each new
        // head" still on keeps the claim.
        !move &&
        !settings.fixFailingChecks &&
        !settings.addressReviewComments &&
        settings.reviewEachHead !== true
          ? turnOffPullRequestFeedback(
              scope!.apiBase,
              conversationId,
              identityOf(identity),
              { requestScope: scope! },
            )
          : writePullRequestFeedback(
              scope!.apiBase,
              conversationId,
              { identity: identityOf(identity), settings, move },
              { requestScope: scope! },
            ),
      ),
    reviewAgain: (identity: PullRequestLinkIdentity) =>
      run(identity, () =>
        reviewPullRequestHeadAgain(
          scope!.apiBase,
          conversationId,
          identityOf(identity),
          { requestScope: scope! },
        ),
      ),
    sendFindings: (identity: PullRequestLinkIdentity) =>
      run(identity, () =>
        sendPullRequestHeadReviewFindings(
          scope!.apiBase,
          conversationId,
          identityOf(identity),
          { requestScope: scope! },
        ),
      ),
    sendAgain: (identity: PullRequestLinkIdentity) =>
      run(identity, () =>
        sendPullRequestFeedbackAgain(
          scope!.apiBase,
          conversationId,
          identityOf(identity),
          {
            requestScope: scope!,
          },
        ),
      ),
  };
}

/**
 * One pull request's feedback, whichever chat is open (the pull request
 * panel's strip and its check rows). Never read unless the preview is on
 * and the host serves it; re-read every 30 s while mounted.
 */
export function usePullRequestFeedbackByPullRequest(
  identity: PullRequestLinkIdentity,
) {
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
  const exact = identityOf(identity);
  return useQuery({
    queryKey: [
      'pull-request-feedback-by-pull-request',
      scope?.apiBase,
      scope?.authorityKey,
      pullRequestFeedbackKey(exact),
    ],
    queryFn: ({ signal }) =>
      getPullRequestFeedbackByPullRequest(scope!.apiBase, exact, {
        signal,
        requestScope: scope!,
      }),
    enabled: preview && capability.data === true && !!scope?.isCurrent(),
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}
