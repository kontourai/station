import { useEffect, useRef, useState } from 'react';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { isWorkspaceRefusedTurn } from '../../lib/workspaceRefusal';
import type { FileAttachment } from '../../types';
import { EditGlyph } from '../icons/Glyph';
import {
  AWAITING_CONFIRMATION_LABEL,
  MAY_HAVE_REACHED_LABEL,
} from './deliveryLabels';
import {
  UnconfirmedDiscardConfirm,
  useUnconfirmedDiscardDisclosure,
} from './UnconfirmedDiscardConfirm';
import './QueuedMessages.css';

interface OutboundQueuedTurn {
  clientTurnId: string;
  content: string;
  attachments?: FileAttachment[];
  createdAt?: number;
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  lastError?: string;
  mergedTurns?: readonly { content: string }[];
  /** Written for another Station (its address): waits for that Station. */
  waitingForStation?: string;
  /** Held by another window or a closed one; sent only on Send. */
  heldElsewhere?: true;
  /** The window holding this copy is proven closed. */
  heldByClosedWindow?: true;
  /** Pending behind an earlier row of its chat that was not sent. */
  behindUnsent?: true;
  /** No answer came back; Station's delivery lookup decides it. */
  awaitingLookup?: true;
  /** Claimed by a window that is still running: its send is under way there. */
  sendUnderWay?: true;
}

/**
 * An `invoking` row is only "Sending" while the window that claimed it is
 * proven running. A closed or crashed window's claim, or one released with
 * no answer, waits for Station's delivery lookup like its bubble says.
 */
function sendingElsewhere(turn: OutboundQueuedTurn): boolean {
  return (
    turn.status === 'invoking' &&
    turn.sendUnderWay === true &&
    !turn.awaitingLookup
  );
}

function awaitingConfirmation(turn: OutboundQueuedTurn): boolean {
  return turn.status === 'invoking' && !sendingElsewhere(turn);
}

interface OutboundQueuedMessagesProps {
  sessionId: string;
  turns: readonly OutboundQueuedTurn[];
  messages?: readonly {
    role?: 'user' | 'assistant' | 'system';
    timestamp?: number;
  }[];
  onError: (message: string) => void;
  /**
   * After a queued turn was discarded, with how many remain. The caller drops
   * what only that turn explained (the "queued to retry" notice).
   */
  onDiscarded?: (remaining: number) => void;
  onRetry: (clientTurnId: string) => Promise<void>;
  onStartNewChat: (
    message: string,
    attachments: FileAttachment[] | undefined,
    clientTurnId: string,
  ) => void | Promise<void>;
  /**
   * Send on a held copy. The caller may queue it behind this window's own
   * follow-ups instead of releasing it to the outbox (see `ChatDockBody`).
   * Without it, Send releases it (`sendHeld`).
   */
  onSendHeld?: (turn: OutboundQueuedTurn) => Promise<void>;
}

/**
 * Rows for the persisted offline queue; accepted rows have already executed.
 * They render inside the one pending-message list above the composer
 * (`QueuedMessages`), which owns the frame, the count, the order numbers
 * and the disclosure.
 */
export function OutboundQueuedMessages({
  sessionId,
  turns,
  messages = [],
  onError,
  onDiscarded,
  onRetry,
  onStartNewChat,
  onSendHeld,
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

  const reorder = (clientTurnId: string, direction: 'up' | 'down') =>
    void import('../../lib/outboundQueue')
      .then(({ outboundDispatch }) =>
        outboundDispatch.reorder(clientTurnId, direction),
      )
      .catch((error) =>
        onError(
          `Could not reorder queued message: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

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

  const rows = (
    <>
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
        // A held copy is only sent or discarded here (see `heldCopyRefusal`).
        const canMergeWithNext =
          turn.status === 'pending' &&
          nextTurn?.status === 'pending' &&
          !turn.heldElsewhere &&
          !nextTurn.heldElsewhere;
        const showingMergePreview =
          mergePreviewId === turn.clientTurnId && canMergeWithNext;
        return (
          <div className="queued-message" key={turn.clientTurnId}>
            {/* No number: the outbox sends when the turn ends, alongside the
                list's own follow-ups, and which lands first is not known
                ahead; a held copy or a failed send is in no order at all.
                The column stays so the rows line up. */}
            <span className="queued-message__order" aria-hidden="true" />
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
                {/* Clamped to two lines; the title (and Edit) carry it all. */}
                <span className="queued-message__body">{turn.content}</span>
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
            <StationWaitNote waitingForStation={turn.waitingForStation} />
            <HeldCopyNotice turn={turn} onError={onError} onSend={onSendHeld} />
            {turn.status === 'may-have-started' ||
            turn.status === 'invoking' ? (
              <span
                className={`queued-messages__label${
                  // Another window's send under way is not a caution.
                  sendingElsewhere(turn)
                    ? ' queued-messages__label--sending'
                    : ' queued-messages__label--unconfirmed'
                }`}
              >
                {sendingElsewhere(turn)
                  ? 'Sending'
                  : awaitingConfirmation(turn)
                    ? AWAITING_CONFIRMATION_LABEL
                    : MAY_HAVE_REACHED_LABEL}
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
                        The conversation moved on — this may have been answered
                        from the original workspace
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
              <span className="queued-messages__label queued-messages__label--accepted">
                Accepted · waiting for the agent to finish
              </span>
            ) : null}
            <UnconfirmedRowActions
              sessionId={sessionId}
              turn={turn}
              onDiscarded={() => onDiscarded?.(turns.length - 1)}
              onError={onError}
            />
            {turn.status !== 'accepted' &&
            turn.status !== 'invoking' &&
            turn.status !== 'may-have-started' &&
            editingId !== turn.clientTurnId ? (
              <>
                {turn.status === 'pending' && !turn.heldElsewhere ? (
                  <>
                    <button
                      type="button"
                      onClick={() => reorder(turn.clientTurnId, 'up')}
                      disabled={index === 0}
                      className="queued-message__btn"
                      aria-label="Move message up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => reorder(turn.clientTurnId, 'down')}
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
                {turn.heldElsewhere ? null : (
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
                )}
                <button
                  type="button"
                  onClick={() =>
                    void import('../../lib/outboundQueue')
                      .then(async ({ outboundDispatch }) => {
                        await outboundDispatch.discard(turn.clientTurnId);
                        onDiscarded?.(turns.length - 1);
                      })
                      .catch((error) =>
                        onError(
                          `Could not discard the durable offline turn: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                      )
                  }
                  className="queued-message__btn queued-message__btn--danger"
                  title={workspaceRefused ? 'Dismiss' : 'Discard'}
                  aria-label={workspaceRefused ? 'Dismiss' : 'Discard message'}
                >
                  {workspaceRefused ? 'Dismiss' : '×'}
                </button>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
  // Announcements live outside the collapsed list (`QueuedMessages`), which
  // a live region in here could not make while hidden.
  return (
    <div className="queued-messages--outbox queued-messages__outbox">
      {rows}
    </div>
  );
}

/**
 * A copy held for after a reply by another window, or by one that closed: it
 * is sent only when the user says so (`sendHeld`), with its own key.
 */
function HeldCopyNotice({
  turn,
  onError,
  onSend,
}: {
  turn: OutboundQueuedTurn;
  onError: (message: string) => void;
  onSend?: (turn: OutboundQueuedTurn) => Promise<void>;
}) {
  if (!turn.heldElsewhere) return null;
  const { clientTurnId } = turn;
  return (
    <span
      className="queued-messages__label queued-messages__label--held"
      title={
        turn.heldByClosedWindow
          ? 'Queued in a window that closed. It is sent only when you press Send; messages after it still send.'
          : 'Queued in another open window, which sends it when this turn ends. Send sends it from here instead.'
      }
    >
      {turn.heldByClosedWindow
        ? 'From a closed window. Not sent.'
        : 'Queued in another window.'}{' '}
      <button
        type="button"
        onClick={() =>
          void (
            onSend
              ? onSend(turn)
              : import('../../lib/outboundQueue').then(({ outboundDispatch }) =>
                  outboundDispatch.sendHeld(clientTurnId),
                )
          ).catch((error: unknown) =>
            onError(
              `Could not send this message: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      >
        Send
      </button>
    </span>
  );
}

/** Asks Station again what became of a possibly-started message; never resends. */
function RecheckDeliveryButton({
  clientTurnId,
  onError,
}: {
  clientTurnId: string;
  onError: (message: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        void import('../../lib/deliveryLookup')
          .then(({ recheckOutboundTurn }) => recheckOutboundTurn(clientTurnId))
          .catch((error: unknown) =>
            onError(
              `Could not check this message: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      }
    >
      Check
    </button>
  );
}

/**
 * The user's explicit way out of a message that may have reached the agent
 * (#3596): never automatic, and only after the risk is stated. A row still
 * `invoking` has no such action: its send may still be under way.
 */
function UnconfirmedRowActions({
  sessionId,
  turn,
  onDiscarded,
  onError,
}: {
  sessionId: string;
  turn: OutboundQueuedTurn;
  onDiscarded: () => void;
  onError: (message: string) => void;
}) {
  const disclosure = useUnconfirmedDiscardDisclosure();
  if (turn.status !== 'may-have-started' && turn.status !== 'invoking')
    return null;
  // Under way in a running window: its answer is coming there, and a Check
  // here would find nothing to ask.
  if (sendingElsewhere(turn)) return null;
  const { clientTurnId } = turn;
  const discardable =
    turn.status === 'may-have-started' || turn.awaitingLookup === true;
  return (
    <>
      <span className="queued-message__actions">
        {turn.waitingForStation ? null : (
          <RecheckDeliveryButton
            clientTurnId={clientTurnId}
            onError={onError}
          />
        )}
        {discardable ? (
          <button type="button" {...disclosure.triggerProps}>
            Discard…
          </button>
        ) : null}
      </span>
      {discardable && disclosure.open ? (
        <span className="queued-message__confirm">
          <UnconfirmedDiscardConfirm
            {...disclosure.confirmProps}
            onConfirm={() =>
              void import('../../lib/messageDeliveryActions')
                .then(({ discardMessage }) =>
                  discardMessage(sessionId, clientTurnId, 'unconfirmed'),
                )
                .then(onDiscarded)
                .catch((error: unknown) =>
                  onError(
                    `Could not discard this message: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                )
            }
          />
        </span>
      ) : null}
    </>
  );
}

/** A row written for another Station waits for that one; it is never sent elsewhere. */
function StationWaitNote({
  waitingForStation,
}: {
  waitingForStation?: string;
}) {
  if (!waitingForStation) return null;
  return (
    <span className="queued-messages__label">
      Waiting for {waitingForStation}; it is only sent there
    </span>
  );
}
