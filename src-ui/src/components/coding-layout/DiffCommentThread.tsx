import type { DiffComment } from '@kontourai/station-sdk';
import { useState } from 'react';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';

interface DiffCommentThreadProps {
  comments: DiffComment[];
  /** True when the composer should be shown for this line. */
  composing: boolean;
  busy?: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
  onStartReply: () => void;
  onDelete: (id: string) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return '';
  return date.toLocaleString();
}

/**
 * Renders the comment thread anchored to a single diff line: existing comments
 * (each deletable) plus either a "Reply" affordance or, when composing, the
 * comment composer. Presentational — all persistence is driven by the parent
 * DiffPanel via the callbacks.
 */
export function DiffCommentThread({
  comments,
  composing,
  busy,
  onSubmit,
  onCancel,
  onStartReply,
  onDelete,
}: DiffCommentThreadProps) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    onSubmit(body);
    setDraft('');
  };

  return (
    <div className="diff-comment-thread">
      {comments.map((comment) => (
        <div key={comment.id} className="diff-comment">
          <div className="diff-comment__body">{comment.body}</div>
          <div className="diff-comment__meta">
            <span className="diff-comment__time">
              {formatTime(comment.createdAt)}
            </span>
            <button
              type="button"
              className="diff-comment__delete"
              onClick={() => onDelete(comment.id)}
              aria-label="Delete comment"
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      {composing ? (
        <form
          className="diff-comment-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            className="diff-comment-composer__input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Leave a comment…"
            aria-label="Comment"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancel();
              } else if (
                (e.metaKey || e.ctrlKey) &&
                e.key === 'Enter' &&
                !isComposingKeyEvent(e)
              ) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="diff-comment-composer__actions">
            <button
              type="button"
              className="diff-comment-composer__cancel"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="diff-comment-composer__submit"
              disabled={busy || !draft.trim()}
            >
              Comment
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="diff-comment-thread__reply"
          onClick={onStartReply}
        >
          Reply
        </button>
      )}
    </div>
  );
}
