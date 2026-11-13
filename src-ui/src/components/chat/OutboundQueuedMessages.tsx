import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { outboundStationIdentity } from '../../connections/station-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { isWorkspaceRefusedTurn } from '../../lib/workspaceRefusal';
import type { FileAttachment } from '../../types';
import { outboxTurnDeliveryState } from '../../utils/messageDeliveryState';
import { describeStationFailure } from '../../utils/stationFailure';
import { useDockDeliveryPort } from '../chat-dock/useDockDeliveryPort';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import { EditGlyph } from '../icons/Glyph';
import { MessageDeliveryNote } from './message-bubble/MessageDeliveryNote';
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
  /** Absent when this caller may not start a chat: the refused row then
   * offers no "New chat". */
  onStartNewChat?: (
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
  const station = useOptionalConversationConnection()?.station;
  const conversationId = useSyncExternalStore(
    activeChatsStore.subscribe,
    () => activeChatsStore.getSnapshot()[sessionId]?.conversationId,
  );
  const queueScope = (): readonly [
    station?: ReturnType<typeof outboundStationIdentity>,
    conversationId?: string,
  ] => {
    if (!station) return [] as const;
    if (!station.isCurrent())
      throw new Error('Reconnect to this chat’s Station.');
    return [outboundStationIdentity(station), conversationId] as const;
  };
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(
    null,
  );
  const editingId = editing?.id;
  const editValue = editing?.value ?? '';
  const [savingId, setSavingId] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const [mergePreviewId, setMergePreviewId] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const cancelEdit = () => {
    setEditing(null);
  };

  const reorder = (clientTurnId: string, direction: 'up' | 'down') =>
    void import('../../lib/outboundQueue')
      .then(({ outboundDispatch }) =>
        outboundDispatch.reorder(clientTurnId, direction, ...queueScope()),
      )
      .catch((error) =>
        onError(
          `Could not reorder queued message: ${describeStationFailure(error).body}`,
        ),
      );

  const saveEdit = async () => {
    if (!editing || saveInFlight.current) return;
    const content = editing.value.trim();
    if (!content) return;
    saveInFlight.current = true;
    setSavingId(editing.id);
    try {
      const { outboundDispatch } = await import('../../lib/outboundQueue');
      await outboundDispatch.edit(editing.id, content, ...queueScope());
      setEditing((current) => (current === editing ? null : current));
    } catch (error) {
      onError(
        `Couldn't edit the offline message: ${describeStationFailure(error).body}`,
      );
    } finally {
      saveInFlight.current = false;
      setSavingId(null);
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
                readOnly={savingId === editingId}
                aria-busy={savingId === editingId}
                onChange={(event) => {
                  const value = event.target.value;
                  setEditing((current) =>
                    current ? { ...current, value } : current,
                  );
                }}
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
                          ...queueScope(),
                        ),
                      )
                      .then(() => setMergePreviewId(null))
                      .catch((error) =>
                        onError(
                          `Could not merge queued messages: ${describeStationFailure(error).body}`,
                        ),
                      );
                  }}
                >
                  Merge messages
                </button>
              </div>
            ) : null}
            <HeldCopyNotice turn={turn} />
            <OutboundDeliveryNote
              sessionId={sessionId}
              turn={turn}
              onRetry={onRetry}
              onSendHeld={onSendHeld}
              onEdit={() =>
                setEditing({ id: turn.clientTurnId, value: turn.content })
              }
              onDiscarded={() => onDiscarded?.(turns.length - 1)}
            />
            {workspaceRefused && (
              <span className="queued-messages__label">
                {' '}
                {onStartNewChat ? (
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
                            : `New chat created; old queued turn kept: ${describeStationFailure(error).body}`,
                        ),
                      )
                    }
                  >
                    New chat
                  </button>
                ) : null}
                {threadAdvanced ? (
                  <span className="queued-message__advanced-context">
                    The conversation moved on — this may have been answered from
                    the original workspace
                  </span>
                ) : null}
              </span>
            )}
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
                          outboundDispatch.unmerge(
                            turn.clientTurnId,
                            ...queueScope(),
                          ),
                        )
                        .catch((error) =>
                          onError(
                            `Could not undo queued-message merge: ${describeStationFailure(error).body}`,
                          ),
                        )
                    }
                    className="queued-message__btn"
                  >
                    Undo merge
                  </button>
                ) : null}
                {turn.heldElsewhere || turn.status === 'failed' ? null : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing({
                        id: turn.clientTurnId,
                        value: turn.content,
                      });
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
                        await outboundDispatch.discard(
                          turn.clientTurnId,
                          ...queueScope(),
                        );
                        onDiscarded?.(turns.length - 1);
                      })
                      .catch((error) =>
                        onError(
                          `Couldn't discard the offline message: ${describeStationFailure(error).body}`,
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
function HeldCopyNotice({ turn }: { turn: OutboundQueuedTurn }) {
  if (!turn.heldElsewhere) return null;
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
        ? 'From a closed window.'
        : 'Queued in another window.'}{' '}
    </span>
  );
}

/** The queue adapts the same bound actions used by the message bubble. */
function OutboundDeliveryNote({
  sessionId,
  turn,
  onRetry,
  onEdit,
  onDiscarded,
  onSendHeld,
}: {
  sessionId: string;
  turn: OutboundQueuedTurn;
  onRetry: (key: string) => Promise<void>;
  onEdit: () => void;
  onDiscarded: () => void;
  onSendHeld?: (turn: OutboundQueuedTurn) => Promise<void>;
}) {
  const target = useOptionalConversationConnection();
  const state =
    turn.status === 'pending' && turn.heldByClosedWindow
      ? 'held-for-send'
      : turn.status === 'invoking' && turn.sendUnderWay && !turn.awaitingLookup
        ? 'sending'
        : (outboxTurnDeliveryState(turn) ?? 'unanswered');
  const uncertain =
    turn.status === 'may-have-started' || turn.awaitingLookup === true;
  const port = useDockDeliveryPort(
    sessionId,
    turn.clientTurnId,
    turn.content,
    state,
    uncertain,
  );
  return (
    <MessageDeliveryNote
      variant="inline"
      state={state}
      port={{
        ...port,
        savedOnDevice: true,
        release:
          turn.heldElsewhere && turn.status === 'pending'
            ? async () => {
                if (
                  target?.station &&
                  (!target.station.isCurrent() ||
                    target.station.capabilities.send.state !== 'allowed')
                )
                  throw new Error('Reconnect to this chat’s Station.');
                if (onSendHeld) await onSendHeld(turn);
                else {
                  const { outboundDispatch } = await import(
                    '../../lib/outboundQueue'
                  );
                  if (target?.station)
                    await outboundDispatch.sendHeld(
                      turn.clientTurnId,
                      outboundStationIdentity(target.station),
                      activeChatsStore.getSnapshot()[sessionId]?.conversationId,
                    );
                  else await outboundDispatch.sendHeld(turn.clientTurnId);
                }
              }
            : undefined,
        canRetry: !isWorkspaceRefusedTurn(turn),
        retry: () => onRetry(turn.clientTurnId),
        edit:
          state === 'not-sent'
            ? async () => {
                onEdit();
                return null;
              }
            : uncertain
              ? port.edit
              : undefined,
        check:
          !turn.waitingForStation &&
          (uncertain || state === 'awaiting-confirmation')
            ? port.check
            : undefined,
        canDiscardUnconfirmed: uncertain,
        discard: port.discard
          ? async () => {
              const outcome = await port.discard!();
              onDiscarded();
              return outcome;
            }
          : undefined,
      }}
    />
  );
}
