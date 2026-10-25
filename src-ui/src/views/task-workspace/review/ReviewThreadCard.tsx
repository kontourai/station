import {
  TASK_REVIEW_LIMITS,
  type TaskReviewEvidence,
  type TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import {
  ArrowUpGlyph,
  CheckGlyph,
  CloseGlyph,
  CodeGlyph,
  CopyGlyph,
  MessageGlyph,
  RefreshGlyph,
  ReturnGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../../../components/icons/Glyph';
import { ResponsiveSurfaceActions } from '../../../components/ResponsiveDialogSurface';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import { relativeTimeAgo } from '../../../utils/relativeTime';
import { RoomAvatar } from '../../../workspace-panes/ProjectTaskRoomPresence';
import { ReviewSendControl } from './ReviewSendControl';
import type { ReviewIdentity, ReviewThreadActions } from './review-types';
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
              <RoomAvatar name={identity.startedBy.name} />
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
        <Button
          size="sm"
          variant="ghost"
          disabled={!onOpenCapture}
          aria-label="Open evidence capture"
          onClick={() => onOpenCapture?.(evidence.captureId!)}
        >
          {captureSrc?.(evidence.captureId) ? (
            <img
              className="review-evidence__capture"
              src={captureSrc(evidence.captureId)}
              alt="Evidence capture"
            />
          ) : (
            'Capture'
          )}
        </Button>
      )}
    </div>
  );
}

export function ReviewThreadCard({
  thread,
  selected = false,
  onSelect,
  ...actions
}: ReviewThreadActions & {
  thread: TaskReviewThreadView;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
}) {
  const { baseState: base, state, outdated } = thread;
  const unconfirmed =
    base === 'sent' && thread.deliveryStatus === 'unconfirmed';
  const label =
    state === 'outdated'
      ? 'Outdated'
      : unconfirmed
        ? 'Send unconfirmed'
        : {
            open: 'Open',
            sent: 'Sent',
            'agent-replied': 'Replied',
            resolved: 'Resolved',
          }[base];
  const Icon =
    state === 'outdated' || unconfirmed
      ? WarningGlyph
      : {
          open: MessageGlyph,
          sent: ArrowUpGlyph,
          'agent-replied': ReturnGlyph,
          resolved: CheckGlyph,
        }[base];
  const {
    body: draft,
    setBody: setDraft,
    saved,
  } = useReviewDraft(
    `${thread.taskId}:${thread.taskCreatedAt}:${thread.threadId}`,
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
        cause instanceof Error
          ? cause.message
          : 'Could not save review comment.',
      );
    } finally {
      setPending(false);
    }
  }
  const sendable =
    (base === 'open' || base === 'agent-replied') && state !== 'outdated';
  const first = thread.events.find((event) => 'body' in event);
  const collapsed = base === 'resolved' && expandedFor !== resolutionKey;
  return (
    <article
      id={`review-thread-${thread.threadId}`}
      data-review-thread={thread.threadId}
      tabIndex={-1}
      className="review-thread"
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
            Resolved
            <span className="review-thread__preview">
              {first && 'body' in first ? first.body : ''}
            </span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Reopen thread ${thread.ordinal}`}
            onClick={() => void run(() => actions.onReopen(thread.threadId))}
          >
            <RefreshGlyph />
          </Button>
        </div>
      ) : (
        <>
          {thread.events.map((event) => {
            if (!('body' in event))
              return event.kind === 'send-failed' ? (
                <p
                  role="status"
                  className="review-delivery__feedback"
                  key={event.ordinal}
                >
                  {event.reason}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void run(() =>
                        actions.onSend?.([thread.threadId], 'send'),
                      )
                    }
                    disabled={!actions.onSend}
                  >
                    <RefreshGlyph />
                    Retry
                  </Button>
                </p>
              ) : null;
            const identity = actions.resolveAuthor(event.author);
            const opening = event === first;
            return (
              <div className="review-thread__entry" key={event.ordinal}>
                <header className="review-thread__header">
                  {opening && onSelect && sendable && (
                    <label className="review-thread__select">
                      <input
                        type="checkbox"
                        aria-label={`Select thread ${thread.ordinal}`}
                        checked={selected}
                        onChange={(event) => onSelect(event.target.checked)}
                      />
                    </label>
                  )}
                  <Avatar
                    identity={identity}
                    agent={event.author.kind === 'session'}
                  />
                  <strong>{identity.name}</strong>
                  {opening && (
                    <span
                      className={`review-chip review-chip--${state === 'outdated' || unconfirmed ? 'caution' : base === 'resolved' ? 'positive' : base === 'agent-replied' ? 'active' : 'neutral'}`}
                    >
                      <Icon />
                      {label}
                    </span>
                  )}
                  {opening && event.body === 'Approved.' && (
                    <span className="review-chip review-chip--positive">
                      Approve
                    </span>
                  )}
                  <time
                    dateTime={event.createdAt}
                    title={new Date(event.createdAt).toLocaleString()}
                  >
                    {relativeTimeAgo(Date.parse(event.createdAt), Date.now())}
                  </time>
                  {opening && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="review-thread__resolve"
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
                      {base === 'resolved' ? <RefreshGlyph /> : <CheckGlyph />}
                    </Button>
                  )}
                </header>
                {opening && outdated === 'unknown' && (
                  <span
                    className="review-chip"
                    title="Artifact freshness unavailable"
                  >
                    <TimeGlyph />
                    Unknown
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
          {base === 'sent' && thread.deliveryStatus === 'confirmed' && (
            <p className="review-delivery__feedback" role="status">
              {actions.delivery?.working
                ? 'Queued: agent is working'
                : actions.delivery
                  ? `Sent to ${actions.delivery.agentName}`
                  : 'Sent to agent'}
            </p>
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
                    disabled={pending || !draft.trim()}
                  >
                    <ArrowUpGlyph />
                    <kbd>⌘Enter</kbd>
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
            <ResponsiveSurfaceActions className="review-controls">
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Copy link to thread ${thread.ordinal}`}
                onClick={() =>
                  void run(async () => {
                    if (actions.onCopyLink)
                      await actions.onCopyLink(thread.threadId);
                    else {
                      const url = new URL(window.location.href);
                      url.hash = `review-thread-${thread.threadId}`;
                      await navigator.clipboard.writeText(url.href);
                    }
                  })
                }
              >
                <CopyGlyph />
              </Button>
              {sendable && (
                <ReviewSendControl ids={[thread.threadId]} {...actions} />
              )}
              {base === 'resolved' && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Collapse resolved thread ${thread.ordinal}`}
                  onClick={() => setExpandedFor(undefined)}
                >
                  Collapse
                </Button>
              )}
            </ResponsiveSurfaceActions>
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <DiscardModal />
    </article>
  );
}
