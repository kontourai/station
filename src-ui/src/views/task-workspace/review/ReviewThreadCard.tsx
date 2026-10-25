import type {
  TaskReviewCurrentArtifact,
  TaskReviewEvidence,
  TaskReviewThreadView,
} from '@kontourai/station-contracts/task-review';
import { TASK_REVIEW_LIMITS } from '@kontourai/station-contracts/task-review';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import {
  CheckGlyph,
  CloseGlyph,
  CodeGlyph,
  MessageGlyph,
  OutboxGlyph,
  RefreshGlyph,
  ReturnGlyph,
  TimeGlyph,
  WarningGlyph,
} from '../../../components/icons/Glyph';
import { ResponsiveSurfaceActions } from '../../../components/ResponsiveDialogSurface';
import { useUnsavedGuard } from '../../../hooks/useUnsavedGuard';
import {
  type ReviewIdentity,
  type ReviewThreadActions,
  reviewThreadState,
} from './review-state';

function Avatar({ identity }: { identity: ReviewIdentity }) {
  return (
    <span className="review-avatar" aria-hidden="true">
      {identity.avatarUrl ? (
        <img src={identity.avatarUrl} alt="" />
      ) : (
        identity.name.slice(0, 2).toUpperCase()
      )}
      {identity.startedBy && (
        <span
          className="review-avatar__starter"
          title={`Started by ${identity.startedBy.name}`}
        >
          {identity.startedBy.avatarUrl ? (
            <img src={identity.startedBy.avatarUrl} alt="" />
          ) : (
            identity.startedBy.name.slice(0, 1).toUpperCase()
          )}
        </span>
      )}
    </span>
  );
}

function Evidence({
  evidence,
  captureSrc,
  onOpenCapture,
}: {
  evidence: TaskReviewEvidence;
  captureSrc?: ReviewThreadActions['captureSrc'];
  onOpenCapture?: ReviewThreadActions['onOpenCapture'];
}) {
  const src = evidence.captureId && captureSrc?.(evidence.captureId);
  return (
    <div className="review-evidence">
      {evidence.commit && (
        <span className="review-chip" title={evidence.commit}>
          <CodeGlyph />
          {evidence.commit.slice(0, 7)}
          {!evidence.commitVerified && ' · claimed'}
        </span>
      )}
      {evidence.gateRefs?.map((ref) => (
        <span
          key={`${ref.runId}/${ref.gateId}/${ref.evaluationId}`}
          className={`review-chip ${evidence.gateVerified ? 'review-chip--positive' : ''}`}
          title={`${ref.runId} / ${ref.evaluationId}`}
        >
          {evidence.gateVerified ? <CheckGlyph /> : <WarningGlyph />}
          {ref.gateId} · {evidence.gateVerified ? 'passed' : 'claimed'}
        </span>
      ))}
      {evidence.receiptRefs?.map((ref) => (
        <span className="review-chip" key={ref}>
          {ref} · claimed
        </span>
      ))}
      {evidence.captureId && (
        <Button
          size="sm"
          variant="ghost"
          disabled={!onOpenCapture}
          onClick={() => onOpenCapture?.(evidence.captureId!)}
          aria-label="Open evidence capture"
        >
          {src ? (
            <img
              className="review-evidence__capture"
              src={src}
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
  current,
  selected = false,
  onSelect,
  resolveAuthor,
  captureSrc,
  onOpenCapture,
  onReply,
  onResolve,
  onReopen,
}: ReviewThreadActions & {
  thread: TaskReviewThreadView;
  current: TaskReviewCurrentArtifact;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
}) {
  const { base, outdated, filter } = reviewThreadState(thread, current);
  const unconfirmed =
    base === 'sent' && thread.deliveryStatus === 'unconfirmed';
  const label =
    filter === 'outdated'
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
    filter === 'outdated' || unconfirmed
      ? WarningGlyph
      : {
          open: MessageGlyph,
          sent: OutboxGlyph,
          'agent-replied': ReturnGlyph,
          resolved: CheckGlyph,
        }[base];
  const [draft, setDraft] = useState('');
  const [replying, setReplying] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const { guard, DiscardModal } = useUnsavedGuard(draft.length > 0, () => {
    setDraft('');
    return true;
  });

  async function run(action: () => void | Promise<void>, clearDraft = false) {
    setPending(true);
    setError(undefined);
    try {
      await action();
      if (clearDraft) {
        setDraft('');
        setReplying(false);
      }
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

  return (
    <article className="review-thread" aria-label={`Thread ${thread.ordinal}`}>
      <header className="review-thread__header">
        {onSelect && base === 'open' && filter === 'open' && (
          <label className="review-thread__select">
            <input
              type="checkbox"
              aria-label={`Select thread ${thread.ordinal}`}
              checked={selected}
              onChange={(event) => onSelect(event.target.checked)}
            />
          </label>
        )}
        <span
          className={`review-chip review-chip--${filter === 'outdated' || unconfirmed ? 'caution' : base === 'resolved' ? 'positive' : base === 'agent-replied' ? 'active' : 'neutral'}`}
        >
          <Icon />
          {label}
        </span>
        {outdated === 'unknown' && (
          <span className="review-chip" title="Artifact freshness unavailable">
            <TimeGlyph />
            Unknown
          </span>
        )}
        {thread.currentRevision &&
          thread.currentRevision !== thread.artifact.revision && (
            <span className="review-chip">
              {thread.artifact.revision} → {thread.currentRevision}
            </span>
          )}
      </header>
      {filter === 'outdated' &&
        (thread.quote || thread.anchor.kind === 'text-quote') && (
          <blockquote className="review-thread__quote">
            {thread.quote ??
              (thread.anchor.kind === 'text-quote' ? thread.anchor.exact : '')}
          </blockquote>
        )}
      {thread.events.map((event) => {
        if (!('body' in event))
          return event.kind === 'send-failed' ? (
            <p role="status" key={event.ordinal}>
              {event.reason}
            </p>
          ) : null;
        const identity = resolveAuthor(event.author);
        return (
          <div className="review-thread__entry" key={event.ordinal}>
            <div className="review-thread__author">
              <Avatar identity={identity} />
              <strong>{identity.name}</strong>
              {event.author.kind === 'session' && identity.startedBy && (
                <span className="review-sr-only">
                  Started by {identity.startedBy.name}
                </span>
              )}
            </div>
            <p className="review-thread__body">{event.body}</p>
            {event.kind === 'agent-reply' && event.evidence && (
              <Evidence
                evidence={event.evidence}
                captureSrc={captureSrc}
                onOpenCapture={onOpenCapture}
              />
            )}
          </div>
        );
      })}
      <form
        className="review-thread__reply"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() && !pending)
            void run(() => onReply(thread.threadId, draft.trim()), true);
        }}
      >
        {replying && (
          <textarea
            aria-label={`Reply to thread ${thread.ordinal}`}
            placeholder="Reply…"
            value={draft}
            maxLength={TASK_REVIEW_LIMITS.bodyChars}
            disabled={pending}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
          />
        )}
        <ResponsiveSurfaceActions className="review-controls">
          {!replying ? (
            <Button
              size="sm"
              aria-label={`Write reply to thread ${thread.ordinal}`}
              aria-expanded={false}
              onClick={() => setReplying(true)}
            >
              <ReturnGlyph />
              Reply
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                disabled={pending || !draft.trim()}
                type="submit"
                aria-label={`Post reply to thread ${thread.ordinal}`}
              >
                <ReturnGlyph />
                Reply
              </Button>
              <Button
                size="sm"
                aria-label={`Cancel reply to thread ${thread.ordinal}`}
                onClick={() =>
                  guard(() => {
                    setDraft('');
                    setReplying(false);
                  })
                }
              >
                <CloseGlyph />
              </Button>
            </>
          )}
          <Button
            size="sm"
            pending={pending}
            onClick={() =>
              void run(() =>
                base === 'resolved'
                  ? onReopen(thread.threadId)
                  : onResolve(thread.threadId),
              )
            }
          >
            {base === 'resolved' ? <RefreshGlyph /> : <CheckGlyph />}
            {base === 'resolved' ? 'Reopen' : 'Resolve'}
          </Button>
        </ResponsiveSurfaceActions>
      </form>
      {error && <p role="alert">{error}</p>}
      <DiscardModal />
    </article>
  );
}
