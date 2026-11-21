import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  describePullRequestFeedbackCategories,
  type PullRequestFeedbackByPullRequest,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import { useState } from 'react';
import { openChatsStore } from '../../contexts/open-chats-store';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { Button } from '../Button';
import { IconButton } from '../IconButton';
import { SettingsGlyph } from '../icons/Glyph';
import { PullRequestFeedbackDialog } from './PullRequestFeedbackDialog';
import { PullRequestChip } from './pull-request-chips';
import { pullRequestFeedbackChip } from './pull-request-feedback-presentation';
import { RelativeTime } from './RelativeTime';
import {
  usePullRequestFeedback,
  usePullRequestFeedbackByPullRequest,
} from './usePullRequestFeedback';
import './PullRequestFeedbackStrip.css';

/**
 * Everything the strip reads, started where the pull request panel starts
 * its own read, so both are in flight together. They still settle apart:
 * when the feedback answers after the review, the line appears under the
 * header a moment later and moves what is below it. Holding the review for
 * a secondary line was judged worse than that shift.
 */
export function usePullRequestFeedbackStrip(
  identity: PullRequestLinkIdentity,
  activeConversationId: string | undefined,
) {
  const byPullRequest = usePullRequestFeedbackByPullRequest(identity);
  const owner = byPullRequest.data?.owner;
  // The chat whose switches the gear opens: the owner when readable, else
  // the open chat, to offer turning it on there. Nothing while unreadable.
  const chatId = owner?.readable
    ? owner.conversationId
    : owner === null
      ? (activeConversationId ?? '')
      : '';
  const chat = usePullRequestFeedback(chatId);
  return { identity, byPullRequest, chat, chatId, activeConversationId };
}

/**
 * One line in the pull request panel saying whether its agent is getting
 * feedback, and from which chat. Honest about the owner: a chat the reader
 * may not read is only "another chat". Nothing at all while loading, on an
 * error, or when no chat gets feedback and the open chat could not.
 */
export function PullRequestFeedbackStrip({
  strip,
  reference,
}: {
  strip: ReturnType<typeof usePullRequestFeedbackStrip>;
  reference: string;
}) {
  const { identity, byPullRequest, chat, chatId, activeConversationId } = strip;
  const [open, setOpen] = useState(false);
  const now = useCoarseNow();
  const data = byPullRequest.data;
  if (!data || byPullRequest.error) return null;
  const view = chatId && chat.available ? chat.viewFor(identity) : undefined;
  const key = pullRequestFeedbackKey(identity);
  const settings = () => setOpen(true);
  let body: React.ReactNode;
  if (data.owner === null) {
    // Off, but this chat could turn it on: it is linked here.
    if (!view) return null;
    body = (
      <>
        <Separator />
        <span>Off</span>
        <Separator />
        {/* An __actions row: the shared touch floor sizes it on phones. */}
        <span className="pr-feedback-strip__actions">
          <Button variant="link" size="sm" onClick={settings}>
            Turn on…
          </Button>
        </span>
      </>
    );
  } else if (!data.owner.readable) {
    body = (
      <>
        <Separator />
        <span>goes to another chat</span>
      </>
    );
  } else {
    body = (
      <ReadableOwner
        data={data}
        owner={data.owner}
        here={data.owner.conversationId === activeConversationId}
        now={now}
        onSettings={settings}
      />
    );
  }
  return (
    <div className="pr-feedback-strip">
      <span className="pr-feedback-strip__label">Agent feedback</span>
      {body}
      {open && (
        <PullRequestFeedbackDialog
          reference={reference}
          headReview={chat.headReview}
          {...(data.owner?.readable &&
          data.owner.conversationId !== activeConversationId
            ? { chatTitle: data.owner.title }
            : {})}
          view={view}
          pending={chat.pending !== null}
          error={chat.error?.key === key ? chat.error.text : undefined}
          conflict={
            chat.conflict?.key === key ? chat.conflict.owner : undefined
          }
          onWrite={(next, move) =>
            void chat.write(identity, next, move).then((ok) => {
              if (ok) void byPullRequest.refetch();
            })
          }
          onSendAgain={() =>
            void chat.sendAgain(identity).then((ok) => {
              if (ok) void byPullRequest.refetch();
            })
          }
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function Separator() {
  return (
    <span className="pr-feedback-strip__dot" aria-hidden="true">
      ·
    </span>
  );
}

function ReadableOwner({
  data,
  owner,
  here,
  now,
  onSettings,
}: {
  data: PullRequestFeedbackByPullRequest;
  owner: { conversationId: string; title: string };
  here: boolean;
  now: number;
  onSettings: () => void;
}) {
  // The pull request rows' own chip, so the panel and the rows agree.
  const chip = data.status
    ? pullRequestFeedbackChip({
        identity: data.identity,
        ownedHere: true,
        owner: null,
        settings: data.settings ?? {
          fixFailingChecks: false,
          addressReviewComments: false,
          reviewEachHead: false,
        },
        status: data.status,
        history: [],
      })
    : undefined;
  const last = data.last?.state === 'sent' ? data.last : undefined;
  // Two rows at every width (the strip lives in a narrow side pane): the
  // status and the gear, then where it goes and what went last. A row the
  // pane cannot hold shortens the chat's title rather than wrapping, so no
  // separator is left dangling at a line's end or start.
  return (
    <>
      {chip && (
        <>
          <Separator />
          <PullRequestChip {...chip} />
        </>
      )}
      {/* An __actions row: the shared touch floor sizes it on phones. */}
      <span className="pr-feedback-strip__actions pr-feedback-strip__gear">
        <IconButton aria-label="Agent feedback settings" onClick={onSettings}>
          <SettingsGlyph />
        </IconButton>
      </span>
      <span className="pr-feedback-strip__detail">
        {here ? (
          <span className="pr-feedback-strip__owner">this chat</span>
        ) : (
          <Button
            variant="link"
            size="sm"
            className="pr-feedback-strip__owner"
            title={`Open “${owner.title}”`}
            onClick={() =>
              void openChatsStore.openConversation(owner.conversationId)
            }
          >
            {owner.title}
          </Button>
        )}
        {last && (
          <span className="pr-feedback-strip__last">
            <Separator />
            <span>
              Sent {describePullRequestFeedbackCategories(last.categories)}
            </span>
            <Separator />
            <RelativeTime iso={last.at} now={now} />
          </span>
        )}
      </span>
    </>
  );
}
