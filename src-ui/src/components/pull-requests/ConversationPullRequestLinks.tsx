import type {
  ConversationPullRequestLinkObservation,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey as feedbackKeyOf } from '@kontourai/station-contracts/pull-request-feedback';
import { useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { IconButton } from '../IconButton';
import { PlusGlyph, RefreshGlyph } from '../icons/Glyph';
import { SkeletonList } from '../state';
import { LinkPullRequestField } from './LinkPullRequestField';
import { PullRequestFeedbackDialog } from './PullRequestFeedbackDialog';
import { PullRequestRow } from './PullRequestRow';
import { pullRequestStateChip } from './pull-request-chips';
import {
  pullRequestFeedbackChip,
  pullRequestFeedbackLine,
} from './pull-request-feedback-presentation';
import { RelativeTime } from './RelativeTime';
import {
  linkKey,
  useConversationPullRequestLinks,
} from './useConversationPullRequestLinks';
import { usePullRequestFeedback } from './usePullRequestFeedback';
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
  const feedback = usePullRequestFeedback(conversationId);
  const [feedbackFor, setFeedbackFor] =
    useState<ConversationPullRequestLinkObservation | null>(null);
  const now = Date.now();
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
            // Agent feedback is per pull request, not per provenance: only
            // the person-linked or Task-kept rows carry it.
            const view =
              feedback.available && link.source !== 'branch-derived'
                ? feedback.viewFor(link)
                : undefined;
            const feedbackChip = pullRequestFeedbackChip(view);
            const feedbackLine = pullRequestFeedbackLine(view);
            return (
              <PullRequestRow
                key={`${link.source}:${linkKey(link)}`}
                title={status.state === 'current' ? status.title : reference}
                reference={reference}
                chips={[
                  ...(status.state === 'current'
                    ? [pullRequestStateChip(status.pullRequestState)]
                    : []),
                  ...(feedbackChip ? [feedbackChip] : []),
                ]}
                detail={
                  feedbackLine ? (
                    <>
                      <span>{feedbackLine.text}</span>
                      {feedbackLine.at && (
                        <span className="pull-request-row__detail-time">
                          <span aria-hidden="true">· </span>
                          <RelativeTime iso={feedbackLine.at} now={now} />
                        </span>
                      )}
                    </>
                  ) : undefined
                }
                meta={[PROVENANCE[link.source]]}
                note={status.state === 'current' ? undefined : status.reason}
                onOpen={
                  onOpen && status.state === 'current'
                    ? () => onOpen(link)
                    : undefined
                }
                overflow={[
                  ...(view
                    ? [
                        {
                          key: 'agent-feedback',
                          label: 'Agent feedback…',
                          onSelect: () => setFeedbackFor(link),
                        },
                      ]
                    : []),
                  ...(link.source === 'explicit'
                    ? [
                        {
                          key: 'unlink',
                          label: 'Unlink',
                          disabled: pending !== null,
                          onSelect: () => void mutate('unlink', link),
                        },
                      ]
                    : []),
                ]}
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
      {feedbackFor && (
        <PullRequestFeedbackDialog
          reference={`${feedbackFor.repository.owner}/${feedbackFor.repository.name} #${feedbackFor.ref}`}
          view={feedback.viewFor(feedbackFor)}
          pending={feedback.pending !== null}
          error={
            feedback.error && feedback.error.key === feedbackKeyOf(feedbackFor)
              ? feedback.error.message
              : undefined
          }
          conflict={
            feedback.conflict &&
            feedback.conflict.key === feedbackKeyOf(feedbackFor)
              ? feedback.conflict.owner
              : undefined
          }
          onWrite={(settings, move) =>
            void feedback.write(feedbackFor, settings, move)
          }
          onSendAgain={() => void feedback.sendAgain(feedbackFor)}
          onClose={() => setFeedbackFor(null)}
        />
      )}
    </section>
  );
}
