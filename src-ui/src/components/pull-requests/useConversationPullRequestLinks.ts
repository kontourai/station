import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  getConversationPullRequestLinks,
  linkConversationPullRequest,
  unlinkConversationPullRequest,
} from '@kontourai/station-sdk/conversation-pull-request-links';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { userFacingErrorMessage } from '../../utils/errorText';

export const linkKey = (link: PullRequestLinkIdentity) =>
  JSON.stringify([
    link.provider,
    link.host,
    link.repository.owner,
    link.repository.name,
    link.ref,
  ]);

/**
 * A chat's pull request links, and the two writes on them. One hook for the
 * pull requests pane and a session's Details, so both read one cache entry
 * and a link made in one is seen by the other on its next read.
 */
export function useConversationPullRequestLinks(conversationId: string) {
  const scope = useHostRequestAuthorityScope();
  const [pending, setPending] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const links = useQuery({
    queryKey: [
      'conversation-pull-request-links',
      scope?.apiBase,
      scope?.authorityKey,
      conversationId,
    ],
    queryFn: ({ signal }) =>
      getConversationPullRequestLinks(scope!.apiBase, conversationId, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent() && !!conversationId,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutate = async (
    action: 'link' | 'unlink',
    identity: PullRequestLinkIdentity,
  ): Promise<boolean> => {
    if (!scope?.isCurrent() || pending) return false;
    setPending(`${action}:${linkKey(identity)}`);
    setMutationError(null);
    try {
      if (action === 'link')
        await linkConversationPullRequest(
          scope.apiBase,
          conversationId,
          identity,
          { requestScope: scope },
        );
      else
        await unlinkConversationPullRequest(
          scope.apiBase,
          conversationId,
          identity,
          { requestScope: scope },
        );
      if (scope.isCurrent()) await links.refetch();
      return true;
    } catch (error) {
      if (scope.isCurrent())
        setMutationError(
          error instanceof Error
            ? userFacingErrorMessage(error)
            : 'Pull request link failed',
        );
      return false;
    } finally {
      if (scope.isCurrent()) setPending(null);
    }
  };
  return {
    links,
    mutate,
    pending,
    mutationError,
    canWrite: !!scope?.isCurrent(),
  };
}
