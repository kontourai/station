import { useEffect, useRef, useState } from 'react';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { isWorkspaceRefusedTurn } from '../../lib/workspaceRefusal';
import type { FileAttachment } from '../../types';
import { EditGlyph } from '../icons/Glyph';
import './QueuedMessages.css';

interface OutboundQueuedTurn {
  clientTurnId: string;
  content: string;
  attachments?: FileAttachment[];
  createdAt?: number;
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  lastError?: string;
  mergedTurns?: readonly { content: string }[];
}

interface OutboundQueuedMessagesProps {
  sessionId: string;
  turns: readonly OutboundQueuedTurn[];
  messages?: readonly {
    role?: 'user' | 'assistant' | 'system';
    timestamp?: number;
  }[];
  onError: (message: string) => void;
  onRetry: (clientTurnId: string) => Promise<void>;
  onStartNewChat: (
    message: string,
    attachments: FileAttachment[] | undefined,
    clientTurnId: string,
  ) => void | Promise<void>;
}

/** Controls for the persisted offline queue; accepted rows have already executed. */
export function OutboundQueuedMessages({
  sessionId,
  turns,
  messages = [],
  onError,
  onRetry,
  onStartNewChat,
}: OutboundQueuedMessagesProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [mergePreviewId, setMergePreviewId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue('');
  };

  const waitingCount = turns.filter((turn) => turn.status === 'pending').length;
  const failedCount = turns.filter((turn) => turn.status === 'failed').length;
  const acceptedCount = turns.filter(
    (turn) => turn.status === 'accepted',
  ).length;
  const uncertainCount = turns.filter(
    (turn) => turn.status === 'invoking' || turn.status === 'may-have-started',
  ).length;
  const summary = [
    waitingCount
      ? `${waitingCount} message${waitingCount === 1 ? '' : 's'} waiting to send`
      : undefined,
    failedCount
      ? `${failedCount} message${failedCount === 1 ? '' : 's'} need action`
      : undefined,
    acceptedCount
      ? `${acceptedCount} accepted and waiting for completion`
      : undefined,
    uncertainCount
      ? `${uncertainCount} delivery-uncertain; inspect this session`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  const saveEdit = async () => {
    if (!editingId) return;
    const content = editValue.trim();
    if (!content) return;
    const clientTurnId = editingId;
    cancelEdit();
    try {
      const { outboundDispatch } = await import('../../lib/outboundQueue');
      await outboundDispatch.edit(clientTurnId, content);
    } catch (error) {
      onError(
        `Could not edit the durable offline turn: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <div className="queued-messages" aria-live="polite">
      <div className="queued-messages__label">{summary}</div>
      <div className="queued-messages__list">
        {turns.map((turn, index) => {
          const workspaceRefused = isWorkspaceRefusedTurn(turn);
          const refusedAt = turn.createdAt;
// 'May have been answered' requires an ANSWER: only a newer
// assistant message counts as advancement — a system event or the
// user's own later message must not produce the claim (
// finding). Equal timestamps stay conservative (not advanced).
          const threadAdvanced =
            workspaceRefused &&
            typeof refusedAt === 'number' &&
            messages.some(
              (message) =>
                message.role === 'assistant' &&
                typeof message.timestamp === 'number' &&
                message.timestamp > refusedAt,
            );
          const nextTurn = turns[index + 1];
          const canMergeWithNext =
            turn.status === 'pending' && nextTurn?.status === 'pending';
          const showingMergePreview =
            mergePreviewId === turn.clientTurnId && canMergeWithNext;
          return (
            <div className="queued-message" key={turn.clientTurnId}>
              <span className="queued-message__order">{index + 1}</span>
              {editingId === turn.clientTurnId ? (
                <input
                  ref={editInputRef}
                  type="text"
                  aria-label="Edit queued message"
                  className="queued-message__edit-input"
                  value={editValue}
                  onChange={(event) => setEditValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isComposingKeyEvent(event)) {
                      event.preventDefault();
                      void saveEdit();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelEdit();
                    }
                  }}
                  onBlur={() => void saveEdit()}
                />
              ) : (
                <span className="queued-message__text" title={turn.content}>
                  {turn.content}
                </span>
              )}
              {showingMergePreview && nextTurn ? (
                <div className="queued-message__merge-preview">
                  <span>Merge preview</span>
                  <pre>{`${turn.content}\n\n${nextTurn.content}`}</pre>
                  <button type="button" onClick={() => setMergePreviewId(null)}>
                    Keep separate
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void import('../../lib/outboundQueue')
                        .then(({ outboundDispatch }) =>
                          outboundDispatch.merge(
                            turn.clientTurnId,
                            nextTurn.clientTurnId,
                          ),
                        )
                        .then(() => setMergePreviewId(null))
                        .catch((error) =>
                          onError(
                            `Could not merge queued messages: ${error instanceof Error ? error.message : String(error)}`,
                          ),
                        );
                    }}
                  >
                    Merge messages
                  </button>
                </div>
              ) : null}
              {turn.status === 'may-have-started' ||
              turn.status === 'invoking' ? (
                <span className="queued-messages__label">
                  May have started; inspect this session before sending again
                </span>
              ) : turn.status === 'failed' ? (
                <span className="queued-messages__label">
                  {workspaceRefused ? (
                    <>
                      Refused{' '}
                      <button
                        type="button"
                        onClick={() =>
// A failed discard leaves the row actionable on
// purpose — the draft exists either way; surfacing
// the error beats a silent duplicate-capable state.
                          void Promise.resolve(
                            onStartNewChat(
                              turn.content,
                              turn.attachments,
                              turn.clientTurnId,
                            ),
                          ).catch((error: unknown) =>
                            onError(
                              error instanceof Error &&
                                error.name === 'NewChatUnavailableError'
                                ? error.message
                                : `New chat created; old queued turn kept: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                          )
                        }
                      >
                        New chat
                      </button>
                      {threadAdvanced ? (
                        <span className="queued-message__advanced-context">
                          The conversation moved on — this may have been
                          answered from the original workspace
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      Needs retry{' '}
                      <button
                        type="button"
                        onClick={() => void onRetry(turn.clientTurnId)}
                      >
                        Retry
                      </button>
                    </>
                  )}
                </span>
              ) : turn.status === 'accepted' ? (
                <span className="queued-messages__label">
                  Accepted; waiting for completion
                </span>
              ) : null}
              {turn.status !== 'accepted' &&
              turn.status !== 'invoking' &&
              turn.status !== 'may-have-started' &&
              editingId !== turn.clientTurnId ? (
                <>
                  {turn.status === 'pending' ? (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void import('../../lib/outboundQueue')
                            .then(({ outboundDispatch }) =>
                              outboundDispatch.reorder(turn.clientTurnId, 'up'),
                            )
                            .catch((error) =>
                              onError(
                                `Could not reorder queued message: ${error instanceof Error ? error.message : String(error)}`,
                              ),
                            )
                        }
                        disabled={index === 0}
                        className="queued-message__btn"
                        aria-label="Move message up"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void import('../../lib/outboundQueue')
                            .then(({ outboundDispatch }) =>
                              outboundDispatch.reorder(
                                turn.clientTurnId,
                                'down',
                              ),
                            )
                            .catch((error) =>
                              onError(
                                `Could not reorder queued message: ${error instanceof Error ? error.message : String(error)}`,
                              ),
                            )
                        }
                        disabled={index === turns.length - 1}
                        className="queued-message__btn"
                        aria-label="Move message down"
                      >
                        ▼
                      </button>
                      {canMergeWithNext ? (
                        <button
                          type="button"
                          onClick={() => setMergePreviewId(turn.clientTurnId)}
                          className="queued-message__btn"
                          aria-label="Preview merge"
                        >
                          Merge
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  {turn.mergedTurns?.length ? (
                    <button
                      type="button"
                      onClick={() =>
                        void import('../../lib/outboundQueue')
                          .then(({ outboundDispatch }) =>
                            outboundDispatch.unmerge(turn.clientTurnId),
                          )
                          .catch((error) =>
                            onError(
                              `Could not undo queued-message merge: ${error instanceof Error ? error.message : String(error)}`,
                            ),
                          )
                      }
                      className="queued-message__btn"
                    >
                      Undo merge
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(turn.clientTurnId);
                      setEditValue(turn.content);
                    }}
                    className="queued-message__btn"
                    title="Edit"
                    aria-label="Edit message"
                  >
                    <EditGlyph />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void import('../../lib/outboundQueue')
                        .then(({ outboundDispatch }) =>
                          outboundDispatch.discard(turn.clientTurnId),
                        )
                        .catch((error) =>
                          onError(
                            `Could not discard the durable offline turn: ${error instanceof Error ? error.message : String(error)}`,
                          ),
                        )
                    }
                    className="queued-message__btn queued-message__btn--danger"
                    title={workspaceRefused ? 'Dismiss' : 'Delete'}
                    aria-label={workspaceRefused ? 'Dismiss' : 'Delete message'}
                  >
                    {workspaceRefused ? 'Dismiss' : '×'}
                  </button>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
      <span className="sr-only">Offline queue for session {sessionId}</span>
    </div>
  );
}
