import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { IconButton } from '../IconButton';
import { PlusGlyph, RefreshGlyph } from '../icons/Glyph';
import { SkeletonList } from '../state';
import { LinkPullRequestField } from './LinkPullRequestField';
import { PullRequestRow } from './PullRequestRow';
import { pullRequestStateChip } from './pull-request-chips';
import {
  linkKey,
  useConversationPullRequestLinks,
} from './useConversationPullRequestLinks';
import './ConversationPullRequestLinks.css';

const PROVENANCE: Record<
  ConversationPullRequestLinkObservation['source'],
  string
> = {
  explicit: 'linked',
  'branch-derived': 'from branch',
  'task-declared': 'from a Task',
};

/**
 * A chat's pull request links in a session's Details: quiet rows, a `+` that
 * reveals one field to link another, and a refresh. The pull requests pane
 * reads the same hook and shows the same rows; this is the list on its own.
 */
export function ConversationPullRequestLinks({
  conversationId,
  suggested,
  derived = [],
  onOpen,
  linkFormCollapsed = true,
}: {
  conversationId: string;
  /**
   * Start with the link field shown. Off by default: in a session's Details
   * linking is a rare action, so the section leads with what IS linked.
   */
  linkFormCollapsed?: boolean;
  suggested?: Partial<PullRequestLinkIdentity>;
  derived?: ConversationPullRequestLinkObservation[];
  onOpen?: (link: ConversationPullRequestLinkObservation) => void;
}) {
  const { links, mutate, pending, mutationError, canWrite } =
    useConversationPullRequestLinks(conversationId);
  const [linking, setLinking] = useState(!linkFormCollapsed);
  // One exact PR may have several owners. Keep each provenance visible so
  // explicit unlink cannot erase a branch-derived or Task-kept association.
  const visibleLinks = [...(links.data?.links ?? []), ...derived];

  return (
    <section
      className="conversation-pr-links"
      aria-label="Linked pull requests"
    >
      <header className="conversation-pr-links__bar">
        <h3>Linked pull requests</h3>
        <div className="conversation-pr-links__tools">
          <IconButton
            className="conversation-pr-links__icon"
            aria-label="Link a pull request"
            title="Link a pull request"
            aria-expanded={linking}
            active={linking}
            disabled={!canWrite}
            onClick={() => setLinking((value) => !value)}
          >
            <PlusGlyph />
          </IconButton>
          <IconButton
            className="conversation-pr-links__icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={links.isFetching || !canWrite}
            onClick={() => void links.refetch()}
          >
            <RefreshGlyph />
          </IconButton>
        </div>
      </header>
      {linking && (
        <LinkPullRequestField
          scope={suggested ?? {}}
          pending={pending?.startsWith('link:') ?? false}
          onLink={(link) => {
            void mutate('link', link).then((ok) => {
              if (ok) setLinking(false);
            });
          }}
        />
      )}
      {links.isPending ? (
        <SkeletonList count={1} label="Reading linked pull requests" />
      ) : links.error ? (
        <p className="conversation-pr-links__note" role="alert">
          {userFacingErrorMessage(links.error)}{' '}
          <button
            type="button"
            className="button button--link"
            onClick={() => void links.refetch()}
          >
            Retry
          </button>
        </p>
      ) : visibleLinks.length === 0 ? (
        <p className="conversation-pr-links__note">Nothing linked</p>
      ) : (
        <ul className="conversation-pr-links__list">
          {visibleLinks.map((link) => {
            const status = link.status;
            // The host is part of the identity: the same number on two
            // hosts is two pull requests.
            const reference = `${link.host}/${link.repository.owner}/${link.repository.name} #${link.ref}`;
            return (
              <PullRequestRow
                key={`${link.source}:${linkKey(link)}`}
                title={status.state === 'current' ? status.title : reference}
                reference={reference}
                chips={
                  status.state === 'current'
                    ? [pullRequestStateChip(status.pullRequestState)]
                    : []
                }
                meta={[PROVENANCE[link.source]]}
                note={status.state === 'current' ? undefined : status.reason}
                onOpen={
                  onOpen && status.state === 'current'
                    ? () => onOpen(link)
                    : undefined
                }
                overflow={
                  link.source === 'explicit'
                    ? [
                        {
                          key: 'unlink',
                          label: 'Unlink',
                          disabled: pending !== null,
                          onSelect: () => void mutate('unlink', link),
                        },
                      ]
                    : []
                }
                overflowLabel={`More actions for ${reference}`}
              />
            );
          })}
        </ul>
      )}
      {mutationError && (
        <p className="conversation-pr-links__note" role="alert">
          {mutationError}
        </p>
      )}
    </section>
  );
}
