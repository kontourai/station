import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  getConversationPullRequestLinks,
  linkConversationPullRequest,
  unlinkConversationPullRequest,
} from '@kontourai/station-sdk/conversation-pull-request-links';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { ErrorState, SkeletonList } from '../state';
import './ConversationPullRequestLinks.css';

const EMPTY: PullRequestLinkIdentity = {
  provider: '',
  host: '',
  repository: { owner: '', name: '' },
  ref: '',
};
const key = (link: PullRequestLinkIdentity) =>
  JSON.stringify([
    link.provider,
    link.host,
    link.repository.owner,
    link.repository.name,
    link.ref,
  ]);

export function ConversationPullRequestLinks({
  conversationId,
  suggested,
  derived = [],
  onOpen,
}: {
  conversationId: string;
  suggested?: Partial<PullRequestLinkIdentity>;
  derived?: ConversationPullRequestLinkObservation[];
  onOpen?: (link: ConversationPullRequestLinkObservation) => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const [draft, setDraft] = useState<PullRequestLinkIdentity>(() => ({
    ...EMPTY,
    ...suggested,
    repository: { ...EMPTY.repository, ...suggested?.repository },
  }));
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
  ) => {
    if (!scope?.isCurrent() || pending) return;
    setPending(`${action}:${key(identity)}`);
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
    } catch (error) {
      if (scope.isCurrent())
        setMutationError(
          error instanceof Error ? error.message : 'Pull request link failed',
        );
    } finally {
      if (scope.isCurrent()) setPending(null);
    }
  };
  const canLink =
    !pending &&
    Object.values({
      provider: draft.provider,
      host: draft.host,
      owner: draft.repository.owner,
      repository: draft.repository.name,
      ref: draft.ref,
    }).every((value) => value.trim().length > 0);
  const visibleLinks = [
    ...(links.data?.links ?? []),
    ...derived.filter(
      (candidate) =>
        !(links.data?.links ?? []).some((link) => key(link) === key(candidate)),
    ),
  ];

  return (
    <section
      className="conversation-pr-links"
      aria-label="Linked pull requests"
    >
      <header>
        <h3>Linked pull requests</h3>
        <Button
          size="sm"
          disabled={links.isFetching || !scope?.isCurrent()}
          onClick={() => void links.refetch()}
        >
          Refresh
        </Button>
      </header>
      <p>
        Explicit links are conversation navigation. Branch-derived matches and
        Task-declared outputs keep their existing provenance and are not changed
        here.
      </p>
      {links.isPending ? (
        <SkeletonList count={1} label="Reading linked pull requests" />
      ) : links.error ? (
        <ErrorState
          variant="compact"
          title="Linked pull requests unavailable"
          description={links.error.message}
        />
      ) : (
        <ul>
          {visibleLinks.map((link) => (
            <li key={`${link.source}:${key(link)}`}>
              <div>
                <strong>
                  {link.host}/{link.repository.owner}/{link.repository.name} #
                  {link.ref}
                </strong>
                <span>
                  {link.source === 'explicit'
                    ? 'Explicit'
                    : link.source === 'branch-derived'
                      ? 'Derived from the current branch'
                      : 'Declared by a Task'}{' '}
                  · observed {new Date(link.observedAt).toLocaleString()}
                  {Date.now() - Date.parse(link.observedAt) > 5 * 60_000
                    ? ' · stale'
                    : ''}
                </span>
                <span>
                  {link.status.state === 'current'
                    ? `${link.status.title} · ${link.status.pullRequestState}${link.status.head ? ` · ${link.status.head}` : ' · head unavailable'}`
                    : `${link.status.state}: ${link.status.reason}`}
                </span>
              </div>
              <ResponsiveSurfaceActions className="conversation-pr-links__actions">
                {onOpen && link.status.state === 'current' && (
                  <Button size="sm" onClick={() => onOpen(link)}>
                    Review
                  </Button>
                )}
                {link.source === 'explicit' && (
                  <Button
                    size="sm"
                    pending={pending === `unlink:${key(link)}`}
                    pendingLabel="Unlinking"
                    onClick={() => void mutate('unlink', link)}
                  >
                    Unlink
                  </Button>
                )}
              </ResponsiveSurfaceActions>
            </li>
          ))}
        </ul>
      )}
      <div className="conversation-pr-links__form">
        <label>
          Provider
          <input
            className="editor-input"
            value={draft.provider}
            onChange={(event) =>
              setDraft({ ...draft, provider: event.target.value })
            }
          />
        </label>
        <label>
          Host
          <input
            className="editor-input"
            value={draft.host}
            onChange={(event) =>
              setDraft({ ...draft, host: event.target.value })
            }
          />
        </label>
        <label>
          Owner
          <input
            className="editor-input"
            value={draft.repository.owner}
            onChange={(event) =>
              setDraft({
                ...draft,
                repository: { ...draft.repository, owner: event.target.value },
              })
            }
          />
        </label>
        <label>
          Repository
          <input
            className="editor-input"
            value={draft.repository.name}
            onChange={(event) =>
              setDraft({
                ...draft,
                repository: { ...draft.repository, name: event.target.value },
              })
            }
          />
        </label>
        <label>
          Pull request number
          <input
            className="editor-input"
            inputMode="numeric"
            value={draft.ref}
            onChange={(event) =>
              setDraft({ ...draft, ref: event.target.value })
            }
          />
        </label>
        <Button
          disabled={!canLink}
          pending={pending?.startsWith('link:')}
          pendingLabel="Linking"
          onClick={() => void mutate('link', draft)}
        >
          Link pull request
        </Button>
      </div>
      {mutationError && <p role="alert">{mutationError}</p>}
    </section>
  );
}
