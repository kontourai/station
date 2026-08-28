import { useEffect, useRef, useState } from 'react';
import { useQueuedMessages } from '../../hooks/useQueuedMessages';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { EditGlyph } from '../icons/Glyph';
import './QueuedMessages.css';

interface QueuedMessagesProps {
  sessionId: string;
  messages: string[];
  canSteer?: boolean;
  onSteer?: (message: string) => Promise<boolean>;
/**
* Why the last attempt to drain the head of this queue failed, as the
* server described it. Rendered beside the message it is holding back and
* persisted with the queue, so a reload does not leave a retained follow-up
* with no explanation.
*/
  failure?: { message: string; code?: string; at: number };
/** Retry the head of the queue now, rather than waiting for the next turn. */
  onRetry?: () => void;
}

interface QueueRow {
  id: number;
  message: string;
}

export function QueuedMessages({
  sessionId,
  messages,
  canSteer = false,
  onSteer,
  failure,
  onRetry,
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
    <div className="queued-messages">
      <div className="queued-messages__label">
        {messages.length} message{messages.length !== 1 ? 's' : ''} queued
      </div>
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
                  <span
                    className="queued-message__text"
                    title={msg}
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {msg}
                  </span>
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
                        void onSteer(msg)
                          .then((sent) => {
                            if (sent) {
                              const currentIndex = rowsRef.current.findIndex(
                                (candidate) => candidate.id === row.id,
                              );
                              if (currentIndex >= 0) remove(currentIndex);
                            }
                          })
                          .finally(() => {
                            pendingRef.current.delete(row.id);
                            setPendingRows(new Set(pendingRef.current));
                          });
                      }}
                      className="queued-message__btn"
                      aria-label="Send as steer"
                    >
                      Steer
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => moveDown(idx, messages.length)}
                    disabled={idx === messages.length - 1}
                    className="queued-message__btn"
                    title="Move up"
                    aria-label="Move message up"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    onClick={() => moveUp(idx)}
                    disabled={idx === 0}
                    className="queued-message__btn"
                    title="Move down"
                    aria-label="Move message down"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(idx, msg)}
                    className="queued-message__btn"
                    title="Edit (Enter)"
                    aria-label="Edit message"
                  >
                    <EditGlyph />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="queued-message__btn queued-message__btn--danger"
                    title="Remove (Delete)"
                    aria-label="Remove message"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
