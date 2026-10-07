import { useEffect, useId, useRef, useState } from 'react';
import type { PendingMessageMetadata } from '../../contexts/active-chats-state';
import { useQueuedMessages } from '../../hooks/useQueuedMessages';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { ArrowDownGlyph, EditGlyph } from '../icons/Glyph';
import './QueuedMessages.css';

interface QueuedMessagesProps {
  sessionId: string;
  messages: string[];
  metadata?: PendingMessageMetadata[];
  sendNowPending?: boolean;
  waitingForTools?: boolean;
  onSendMessageNow?: (messageId: string) => Promise<void>;
  canSteer?: boolean;
  onSteer?: (message: string, clientInputId?: string) => Promise<boolean>;
  onPendingSettled?: () => void;
  /**
   * Why the last attempt to drain the head of this queue failed, as the
   * server described it. Rendered beside the message it is holding back and
   * persisted with the queue, so a reload does not leave a retained follow-up
   * with no explanation.
   */
  failure?: { message: string; code?: string; at: number };
  /** Retry the head of the queue now, rather than waiting for the next turn. */
  onRetry?: () => void;
  /**
   * #3157: the conversation stopped on a provider usage limit, so the queue
   * does not send on its own; Send now still does.
   */
  heldByUsageLimit?: boolean;
}

interface QueueRow {
  id: number;
  message: string;
}

export function QueuedMessages({
  sessionId,
  messages,
  metadata,
  sendNowPending,
  waitingForTools,
  onSendMessageNow,
  canSteer = false,
  onSteer,
  onPendingSettled,
  failure,
  onRetry,
  heldByUsageLimit,
}: QueuedMessagesProps) {
  const {
    editingIndex,
    editValue,
    setEditValue,
    startEdit,
    cancelEdit,
    saveEdit,
    remove,
    moveUp,
    moveDown,
  } = useQueuedMessages(sessionId);

  const [expanded, setExpanded] = useState(false);
  const queueId = useId();
  const needsReview = Boolean(
    failure || metadata?.some((entry) => entry.delivery === 'indeterminate'),
  );
  const editInputRef = useRef<HTMLInputElement>(null);
  const nextRowId = useRef(0);
  const rowsRef = useRef<QueueRow[]>([]);
  const pendingRef = useRef(new Set<number>());
  const [pendingRows, setPendingRows] = useState<Set<number>>(() => new Set());

  const unmatched = [...rowsRef.current];
  const rows = messages.map((message) => {
    const matchIndex = unmatched.findIndex((row) => row.message === message);
    if (matchIndex >= 0) return unmatched.splice(matchIndex, 1)[0];
    return { id: nextRowId.current++, message };
  });
  rowsRef.current = rows;

  useEffect(() => {
    if (editingIndex !== null && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingIndex]);

  if (messages.length === 0) return null;

  return (
    <div
      className="queued-messages queued-messages--pending"
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        className="queued-messages__toggle"
        aria-expanded={expanded}
        aria-controls={queueId}
        aria-label={`${messages.length} pending message${messages.length !== 1 ? 's' : ''}${needsReview ? ', needs review' : ''}`}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M4 5h16M4 12h12M4 19h8" />
        </svg>
        <span>{messages.length} pending</span>
        {needsReview && (
          <span className="queued-messages__attention">Needs review</span>
        )}
        <ArrowDownGlyph />
      </button>
      {heldByUsageLimit && (
        <div className="queued-messages__hold" role="status">
          <span className="queued-messages__failure-text">
            Held because of the usage limit. Send now to send anyway.
          </span>
        </div>
      )}
      <div id={queueId} className="queued-messages__content" hidden={!expanded}>
        {failure && (
          <div className="queued-messages__failure" role="status">
            <span className="queued-messages__failure-text">
              {failure.message}
            </span>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="queued-message__btn"
                aria-label={
                  failure.code === 'continuation_workspace_unbound'
                    ? 'Send the queued message to this conversation as it is'
                    : 'Retry the queued message'
                }
              >
                {/* The label names what the action DOES. A plain "Retry" on an
                  unbound-workspace refusal would resubmit the same workspace
                  and reproduce the same refusal (UX audit T3 review). */}
                {failure.code === 'continuation_workspace_unbound'
                  ? 'Continue as is'
                  : 'Retry'}
              </button>
            )}
          </div>
        )}
        <div className="queued-messages__list">
          {[...rows].reverse().map((row, displayIdx) => {
            const msg = row.message;
            const idx = messages.length - 1 - displayIdx; // actual index in array
            const orderNum = idx + 1; // 1-based order (1 = next to send)
            return (
              <div key={row.id} className="queued-message">
                <span className="queued-message__order">{orderNum}</span>
                {editingIndex === idx ? (
                  <input
                    ref={editInputRef}
                    type="text"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
                        e.preventDefault();
                        saveEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onBlur={saveEdit}
                    style={{
                      flex: 1,
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--accent-primary)',
                      borderRadius: '3px',
                      padding: '2px 6px',
                      fontSize: '13px',
                      color: 'var(--text-primary)',
                      outline: 'none',
                    }}
                  />
                ) : (
                  <>
                    <span className="queued-message__text" title={msg}>
                      {msg}
                      <span className="queued-message__status">
                        {metadata?.[idx]?.delivery
                          ? metadata[idx].delivery === 'steering'
                            ? 'Steer · Sending steering'
                            : 'Steer · Delivery not confirmed; retry steering'
                          : metadata?.[idx]?.mode === 'steer'
                            ? waitingForTools
                              ? 'Steer · Waiting for tools to finish'
                              : 'Steer · Waiting for this turn to finish'
                            : 'Queue · Queued for next turn'}
                      </span>
                    </span>
                    {onSendMessageNow && metadata?.[idx] && (
                      <button
                        type="button"
                        className="queued-message__btn"
                        disabled={
                          sendNowPending ||
                          pendingRows.has(row.id) ||
                          !!metadata?.[idx]?.delivery
                        }
                        title="Stop the current turn immediately and send this message"
                        aria-label={`Send pending message ${orderNum} now`}
                        onClick={() => {
                          if (pendingRef.current.has(row.id)) return;
                          pendingRef.current.add(row.id);
                          setPendingRows(new Set(pendingRef.current));
                          void onSendMessageNow(metadata[idx].id).finally(
                            () => {
                              pendingRef.current.delete(row.id);
                              setPendingRows(new Set(pendingRef.current));
                            },
                          );
                        }}
                      >
                        Send now
                      </button>
                    )}
                    {/* The list renders reversed (newest on top, next-to-drain
                      at the bottom), so the VISUAL up direction corresponds
                      to a HIGHER real array index (drains later): ▲ calls
                      moveDown(realIdx) and ▼ calls moveUp(realIdx). Review
                      #613-1 caught the inverted wiring. */}
                    {canSteer && onSteer && (
                      <button
                        type="button"
                        disabled={pendingRows.has(row.id)}
                        onClick={() => {
                          if (pendingRef.current.has(row.id)) return;
                          pendingRef.current.add(row.id);
                          setPendingRows(new Set(pendingRef.current));
                          void onSteer(msg, metadata?.[idx]?.id).finally(() => {
                            pendingRef.current.delete(row.id);
                            setPendingRows(new Set(pendingRef.current));
                            onPendingSettled?.();
                          });
                        }}
                        className="queued-message__btn"
                        aria-label={
                          metadata?.[idx]?.delivery
                            ? 'Retry steering'
                            : 'Send as steer'
                        }
                      >
                        {metadata?.[idx]?.delivery ? 'Retry steering' : 'Steer'}
                      </button>
                    )}
                    <div className="queued-message__utilities">
                      <button
                        type="button"
                        onClick={() => moveDown(idx, messages.length)}
                        disabled={sendNowPending || idx === messages.length - 1}
                        className="queued-message__btn"
                        title="Move up"
                        aria-label="Move message up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => moveUp(idx)}
                        disabled={sendNowPending || idx === 0}
                        className="queued-message__btn"
                        title="Move down"
                        aria-label="Move message down"
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        disabled={
                          sendNowPending ||
                          pendingRows.has(row.id) ||
                          !!metadata?.[idx]?.delivery
                        }
                        onClick={() => startEdit(idx, msg)}
                        className="queued-message__btn"
                        title="Edit (Enter)"
                        aria-label="Edit message"
                      >
                        <EditGlyph />
                      </button>
                      <button
                        type="button"
                        disabled={sendNowPending || pendingRows.has(row.id)}
                        onClick={() => remove(idx)}
                        className="queued-message__btn queued-message__btn--danger"
                        title="Remove (Delete)"
                        aria-label="Remove message"
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
