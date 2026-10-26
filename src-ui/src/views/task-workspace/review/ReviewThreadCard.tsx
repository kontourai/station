import {
  TASK_REVIEW_LIMITS,
  type TaskReviewEvidence,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { useEffect, useRef, useState } from 'react';
import { ActionOverflowMenu } from '../../../components/ActionOverflowMenu';
import { Button } from '../../../components/Button';
import {
  CameraGlyph,
  CheckGlyph,
  CloseGlyph,
  CodeGlyph,
  CopyGlyph,
  LinkGlyph,
  OutboxGlyph,
  RefreshGlyph,
  ReopenGlyph,
  ReturnGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../../../components/icons/Glyph';
import { ResponsiveSurfaceActions } from '../../../components/ResponsiveDialogSurface';
import { useCoarsePointer } from '../../../hooks/useCoarsePointer';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { relativeTimeAgo } from '../../../utils/relativeTime';
import { RoomAvatar } from '../../../workspace-panes/ProjectTaskRoomPresence';
import { useReviewContext } from './ReviewContext';
import { copyReviewThreadsForAgent } from './review-copy';
import {
  isReviewThreadSendable,
  type ReviewIdentity,
  type ReviewThreadActions,
} from './review-types';
import { useReviewDraft } from './useReviewDraft';

function Avatar({
  identity,
  agent,
}: {
  identity: ReviewIdentity;
  agent: boolean;
}) {
  return (
    <span
      className="review-avatar"
      title={
        agent && identity.startedBy
          ? `${identity.startedBy.name}'s agent`
          : identity.name
      }
    >
      {identity.avatarUrl ? (
        <img src={identity.avatarUrl} alt="" />
      ) : (
        <RoomAvatar name={identity.name} agent={agent} />
      )}
      {agent && identity.startedBy && (
        <>
          <span className="review-avatar__starter">
            {identity.startedBy.avatarUrl ? (
              <img src={identity.startedBy.avatarUrl} alt="" />
            ) : (
              <RoomAvatar name={identity.startedBy.name.trim().slice(0, 1)} />
            )}
          </span>
          <span className="sr-only">{identity.startedBy.name}'s agent</span>
        </>
      )}
    </span>
  );
}

function Evidence({
  evidence,
  captureSrc,
  onOpenCapture,
  onOpenEvidence,
}: Pick<
  ReviewThreadActions,
  'captureSrc' | 'onOpenCapture' | 'onOpenEvidence'
> & { evidence: TaskReviewEvidence }) {
  return (
    <div className="review-evidence">
      {evidence.commit && (
        <Button
          className="review-chip"
          size="sm"
          variant="ghost"
          title={evidence.commit}
          disabled={!onOpenEvidence}
          onClick={() =>
            onOpenEvidence?.({
              ...evidence,
              gateRefs: undefined,
              receiptRefs: undefined,
              captureId: undefined,
            })
          }
        >
          <CodeGlyph />
          {evidence.commit.slice(0, 7)}
          {!evidence.commitVerified && ' · claimed'}
        </Button>
      )}
      {evidence.gateRefs?.map((ref) => (
        <Button
          key={`${ref.runId}/${ref.gateId}/${ref.evaluationId}`}
          size="sm"
          variant="ghost"
          className={`review-chip ${evidence.gateVerified ? 'review-chip--positive' : ''}`}
          title={`${ref.runId} / ${ref.evaluationId}`}
          disabled={!onOpenEvidence}
          onClick={() =>
            onOpenEvidence?.({
              ...evidence,
              commit: undefined,
              gateRefs: [ref],
              receiptRefs: undefined,
              captureId: undefined,
            })
          }
        >
          {evidence.gateVerified ? <CheckGlyph /> : <WarningGlyph />}
          {ref.gateId} · {evidence.gateVerified ? 'passed' : 'claimed'}
        </Button>
      ))}
      {evidence.receiptRefs?.map((ref) => (
        <Button
          key={ref}
          className="review-chip"
          size="sm"
          variant="ghost"
          disabled={!onOpenEvidence}
          onClick={() =>
            onOpenEvidence?.({
              commitVerified: false,
              gateVerified: false,
              receiptRefs: [ref],
            })
          }
        >
          {ref} · claimed
        </Button>
      ))}
      {evidence.captureId && (
        <span className="review-evidence__screen">
          <Button
            size="sm"
            variant="ghost"
            className="review-chip"
            disabled={!onOpenCapture}
            aria-label="Open evidence capture"
            onClick={() => onOpenCapture?.(evidence.captureId!)}
          >
            <CameraGlyph /> Screen
          </Button>
          {captureSrc?.(evidence.captureId) && (
            <img
              className="review-evidence__preview"
              src={captureSrc(evidence.captureId)}
              alt="Evidence capture preview"
            />
          )}
        </span>
      )}
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  ...actions
}: ReviewThreadActions & {
  thread: TaskReviewThreadView;
}) {
  const { baseState: base, state, outdated } = thread;
  const unconfirmed =
    base === 'sent' && thread.deliveryStatus === 'unconfirmed';
  const queued =
    base === 'sent' &&
    thread.deliveryStatus === 'confirmed' &&
    actions.delivery?.working;
  const lastDelivery = [...thread.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'sent' ||
        event.kind === 'send-failed' ||
        event.kind === 'agent-reply',
    );
  const failure =
    lastDelivery?.kind === 'send-failed' &&
    lastDelivery.deliveryKey === thread.deliveryKey
      ? lastDelivery
      : undefined;
  const label = failure
    ? 'Not sent'
    : state === 'outdated'
      ? 'Outdated'
      : unconfirmed
        ? 'Unconfirmed'
        : queued
          ? 'Queued'
          : {
              open: undefined,
              sent: 'Sent',
              'agent-replied': 'Replied',
              resolved: 'Resolved',
            }[base];
  const Icon =
    failure || state === 'outdated' || unconfirmed
      ? WarningGlyph
      : queued
        ? TimeGlyph
        : base === 'agent-replied'
          ? ReturnGlyph
          : base === 'resolved'
            ? CheckGlyph
            : OutboxGlyph;
  const review = useReviewContext();
  const coarse = useCoarsePointer();
  const {
    body: draft,
    setBody: setDraft,
    saved,
  } = useReviewDraft(
    `${actions.draftScope}:${thread.taskId}:${thread.taskCreatedAt}:${thread.threadId}`,
  );
  const [replying, setReplying] = useState(Boolean(draft));
  const [expandedFor, setExpandedFor] = useState<string>();
  const resolutionKey = `${thread.threadId}:${thread.events.at(-1)?.ordinal}`;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLTextAreaElement>(null);
  const replyTrigger = useRef<HTMLButtonElement>(null);
  const wasReplying = useRef(false);
  useEffect(() => {
    if (replying) input.current?.focus();
    else if (wasReplying.current) replyTrigger.current?.focus();
    wasReplying.current = replying;
  }, [replying]);
  const { guard, DiscardModal } = useUnsavedGuard(Boolean(draft), () => {
    setDraft('');
    return true;
  });
  function discard() {
    setDraft('');
    setReplying(false);
  }
  async function run(action: () => void | Promise<void>, clearDraft = false) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (clearDraft) discard();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Review action failed.',
      );
    } finally {
      setPending(false);
    }
  }
  const sendable = isReviewThreadSendable(thread);
  const first = thread.events.find((event) => 'body' in event);
  const collapsed = base === 'resolved' && expandedFor !== resolutionKey;
  return (
    <article
      id={`review-thread-${thread.threadId}`}
      data-review-thread={thread.threadId}
      tabIndex={-1}
      className="review-thread"
      data-coarse-pointer={coarse || undefined}
      data-review-emphasized={
        review?.emphasizedThread === thread.threadId || undefined
      }
      onMouseEnter={() => review?.emphasize(thread.threadId)}
      onMouseLeave={() => review?.emphasize(undefined)}
      onFocusCapture={() => review?.emphasize(thread.threadId)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          review?.emphasize(undefined);
      }}
      aria-label={`Thread ${thread.ordinal}`}
    >
      {collapsed ? (
        <div className="review-thread__summary">
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Expand resolved thread ${thread.ordinal}`}
            aria-expanded={false}
            onClick={() => setExpandedFor(resolutionKey)}
          >
            <CheckGlyph />
            <span className="review-thread__preview">
              {first && 'body' in first ? first.body : ''}
            </span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Reopen thread ${thread.ordinal}`}
            pending={pending}
            onClick={() => void run(() => actions.onReopen(thread.threadId))}
          >
            <ReopenGlyph />
            Reopen
          </Button>
        </div>
      ) : (
        <>
          {thread.events.map((event) => {
            if (!('body' in event)) return null;
            const identity = actions.resolveAuthor(event.author);
            const opening = event === first;
            return (
              <div className="review-thread__entry" key={event.ordinal}>
                <header className="review-thread__header">
                  <Avatar
                    identity={identity}
                    agent={event.author.kind === 'session'}
                  />
                  <strong>{identity.name}</strong>
                  {opening && thread.anchor.kind === 'region' && (
                    <span className="review-thread__number">
                      #{thread.ordinal}
                    </span>
                  )}
                  <time
                    dateTime={event.createdAt}
                    title={new Date(event.createdAt).toLocaleString()}
                  >
                    {relativeTimeAgo(Date.parse(event.createdAt), Date.now())}
                  </time>
                  {opening && label && (
                    <span
                      className={`review-chip review-thread__state review-chip--${failure ? 'danger' : state === 'outdated' || unconfirmed ? 'caution' : base === 'resolved' ? 'positive' : base === 'agent-replied' ? 'active' : 'neutral'}`}
                      title={
                        failure
                          ? failure.reason
                          : queued
                            ? 'Queued: agent is working'
                            : base === 'sent'
                              ? thread.pendingFollowUp
                                ? 'Unsent follow-up'
                                : actions.delivery
                                  ? `Sent to ${actions.delivery.agentName}`
                                  : 'Sent to agent'
                              : undefined
                      }
                    >
                      <Icon />
                      {label}
                    </span>
                  )}
                </header>
                {opening && outdated === 'unknown' && (
                  <span
                    className="review-freshness"
                    title="Artifact freshness unavailable"
                    role="img"
                    aria-label="Artifact freshness unavailable"
                  >
                    <WarningGlyph />
                  </span>
                )}
                {opening && state === 'outdated' && (
                  <blockquote className="review-thread__quote">
                    <span className="review-quote-label">Original text</span>
                    {thread.quote ??
                      (thread.anchor.kind === 'text-quote'
                        ? thread.anchor.exact
                        : '')}
                  </blockquote>
                )}
                <p className="review-thread__body">{event.body}</p>
                {event.kind === 'agent-reply' && event.evidence && (
                  <Evidence evidence={event.evidence} {...actions} />
                )}
              </div>
            );
          })}
          {!replying && (
            <ResponsiveSurfaceActions className="review-thread__footer">
              {failure && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Retry sending thread ${thread.ordinal}`}
                  pending={pending || actions.sending}
                  disabled={!actions.onSend || !sendable}
                  onClick={() =>
                    void run(() => actions.onSend?.([thread.threadId], 'send'))
                  }
                >
                  <RefreshGlyph /> Retry
                </Button>
              )}
              <Button
                ref={replyTrigger}
                size="sm"
                variant="ghost"
                aria-label={`Write reply to thread ${thread.ordinal}`}
                aria-expanded={replying}
                aria-controls={`review-reply-${thread.threadId}`}
                onClick={() => setReplying((value) => !value)}
              >
                <ReturnGlyph />
                Reply
              </Button>
              <Button
                size="sm"
                variant="ghost"
                pending={pending}
                aria-label={`${base === 'resolved' ? 'Reopen' : 'Resolve'} thread ${thread.ordinal}`}
                onClick={() =>
                  void run(() =>
                    base === 'resolved'
                      ? actions.onReopen(thread.threadId)
                      : actions.onResolve(thread.threadId),
                  )
                }
              >
                {base === 'resolved' ? <ReopenGlyph /> : <CheckGlyph />}
              </Button>
              <ActionOverflowMenu
                label={`Thread ${thread.ordinal} actions`}
                actions={[
                  ...(sendable && actions.onSend
                    ? [
                        {
                          key: 'send',
                          label: 'Send',
                          glyph: <OutboxGlyph />,
                          disabled: pending || actions.sending,
                          onSelect: () =>
                            void run(() =>
                              actions.onSend?.([thread.threadId], 'send'),
                            ),
                        },
                        {
                          key: 'send-resolve',
                          label: 'Send + Resolve',
                          glyph: <CheckGlyph />,
                          disabled: pending || actions.sending,
                          onSelect: () =>
                            void run(() =>
                              actions.onSend?.(
                                [thread.threadId],
                                'send-and-resolve',
                              ),
                            ),
                        },
                      ]
                    : []),
                  {
                    key: 'link',
                    label: 'Copy link',
                    glyph: <LinkGlyph />,
                    onSelect: () =>
                      void run(async () => {
                        if (actions.onCopyLink)
                          await actions.onCopyLink(thread.threadId);
                        else {
                          const url = new URL(window.location.href);
                          url.hash = `review-thread-${thread.threadId}`;
                          await navigator.clipboard.writeText(url.href);
                        }
                      }),
                  },
                  {
                    key: 'copy',
                    label: 'Copy for agent',
                    glyph: <CopyGlyph />,
                    onSelect: () =>
                      void run(async () => {
                        if (actions.onCopyForAgent)
                          await actions.onCopyForAgent([thread.threadId]);
                        else await copyReviewThreadsForAgent([thread]);
                      }),
                  },
                  ...(base === 'resolved'
                    ? [
                        {
                          key: 'collapse',
                          label: 'Collapse',
                          onSelect: () => setExpandedFor(undefined),
                        },
                      ]
                    : []),
                ]}
              />
            </ResponsiveSurfaceActions>
          )}
          <form
            className="review-thread__reply"
            onSubmit={(event) => {
              event.preventDefault();
              if (draft.trim() && !pending)
                void run(
                  () => actions.onReply(thread.threadId, draft.trim()),
                  true,
                );
            }}
          >
            {replying && (
              <div id={`review-reply-${thread.threadId}`}>
                <textarea
                  ref={input}
                  aria-label={`Reply to thread ${thread.ordinal}`}
                  placeholder="Reply…"
                  rows={2}
                  value={draft}
                  maxLength={TASK_REVIEW_LIMITS.bodyChars}
                  disabled={pending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      discard();
                    } else if (
                      event.key === 'Enter' &&
                      (event.metaKey || event.ctrlKey)
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <ResponsiveSurfaceActions className="review-controls">
                  {saved && (
                    <span className="review-draft-status" role="status">
                      draft saved
                    </span>
                  )}
                  <Button
                    size="sm"
                    type="submit"
                    aria-label={`Post reply to thread ${thread.ordinal}`}
                    aria-keyshortcuts="Meta+Enter Control+Enter"
                    disabled={pending || !draft.trim()}
                  >
                    Reply{' '}
                    {!coarse && (
                      <kbd>
                        ⌘<ReturnGlyph />
                      </kbd>
                    )}
                  </Button>
                  <Button
                    size="sm"
                    aria-label={`Cancel reply to thread ${thread.ordinal}`}
                    onClick={() => guard(discard)}
                  >
                    <CloseGlyph />
                  </Button>
                </ResponsiveSurfaceActions>
              </div>
            )}
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <DiscardModal />
    </article>
  );
}
