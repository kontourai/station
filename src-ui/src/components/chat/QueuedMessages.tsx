import { CONTINUATION_WORKSPACE_REFUSAL_CODES } from '@kontourai/station-contracts/execution-target';
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { PendingMessageMetadata } from '../../contexts/active-chats-state';
import {
  PRESENCE_FALLBACK_MS,
  usePresenceList,
} from '../../hooks/usePresenceList';
import { useQueuedMessages } from '../../hooks/useQueuedMessages';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { ArrowDownGlyph, EditGlyph } from '../icons/Glyph';
import { heldSendsInOrder, pendingMessageCount } from './pendingMessages';
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
  /**
   * #3868: follow-ups Station holds in this conversation's server inbox,
   * possibly sent from another client. They share this one list; they are
   * removed through the inbox, not edited, reordered or sent from here.
   */
  held?: HeldMessages;
  /**
   * This browser's durable outbox for the chat (sends that failed, got no
   * answer, or wait in a window that closed): its rows join this list, at
   * the top and unnumbered, rather than forming a second list. One that
   * waits on the person marks the collapsed list "Needs review", or "Not
   * sent".
   */
  outbox?: OutboxRows;
}

export interface OutboxRows {
  /** How many outbox messages the rows show. */
  count: number;
  /** One of them needs the person (`outboxNeedsReview`). */
  needsReview: boolean;
  /** One of them was not sent. */
  notSent: boolean;
  node: ReactNode;
}

export interface HeldMessages {
  /** Entries still worth showing (not `sent` or `cancelled`). */
  entries: readonly ConversationInboxEntry[];
  /**
   * The last read showed held messages and the newest read failed: what
   * Station holds is unknown now, which is not the same as none.
   */
  unavailable: boolean;
  removing: boolean;
  /** The last removal was not confirmed by Station. */
  removalError: boolean;
  onRemove: (clientTurnId: string) => void;
  onRetry: () => void;
}

const HELD_STATE_LABEL: Record<ConversationInboxEntry['state'], string> = {
  queued: 'Held by Station',
  sending: 'Sending',
  unconfirmed: 'May have been sent',
  refused: 'Not sent',
  sent: 'Sent',
  cancelled: 'Removed',
};

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
  held,
  outbox,
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

  const outboxCount = outbox?.count ?? 0;
  const [expanded, setExpanded] = useState(false);
  const queueId = useId();
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

  const heldEntries = held?.entries ?? [];
  const heldKeys = new Set(
    heldEntries.flatMap((entry) =>
      entry.clientTurnId ? [entry.clientTurnId] : [],
    ),
  );
  // A follow-up both queued here and held by Station is one message: the
  // server copy is the one that will be sent, so it is the row shown.
  const localRows = rows.flatMap((row, idx) =>
    metadata?.[idx]?.id && heldKeys.has(metadata[idx].id) ? [] : [{ row, idx }],
  );
  // Every row listed, the same count the chat's context card shows.
  const pendingCount = pendingMessageCount({
    localIds: messages.map((_, idx) => metadata?.[idx]?.id),
    held: heldEntries,
    outboxCount,
  });
  const notSent = Boolean(
    failure ||
      (outboxCount > 0 && outbox?.notSent) ||
      heldEntries.some((entry) => entry.state === 'refused'),
  );
  const needsReview = Boolean(
    notSent ||
      (outboxCount > 0 && outbox?.needsReview) ||
      metadata?.some((entry) => entry.delivery === 'indeterminate') ||
      held?.removalError ||
      held?.unavailable ||
      heldEntries.some((entry) => entry.state === 'unconfirmed'),
  );
  const attention = notSent ? 'Not sent' : 'Needs review';

  // One send order, numbered from 1 = next to send: Station sends what it
  // holds as the turn ends, then this window's own follow-ups go, one per
  // turn. Outbox rows carry no number: they go when the turn ends too, and
  // which lands first is not known ahead.
  const heldOrder = new Map(
    heldEntries
      .filter(heldSendsInOrder)
      .sort(
        (a, b) =>
          (a.position ?? Number.MAX_SAFE_INTEGER) -
          (b.position ?? Number.MAX_SAFE_INTEGER),
      )
      .map((entry, index) => [entry, index + 1]),
  );
  const localOrderStart = heldOrder.size;
  const visible =
    outboxCount > 0 ||
    localRows.length > 0 ||
    heldEntries.length > 0 ||
    Boolean(held?.unavailable);

  // Top to bottom: this browser's outbox (unnumbered, see above), then the
  // send order with its next at the very bottom: local follow-ups newest
  // first, then what Station holds, which it sends itself when the turn ends.
  const displayRows: { key: string; node: ReactNode }[] = [
    ...(outboxCount > 0 && outbox
      ? [{ key: 'outbox', node: outbox.node }]
      : []),
    ...[...localRows].reverse().map(({ row, idx }) => ({
      key: `local:${row.id}`,
      node: renderLocalRow(row, idx),
    })),
    ...[...heldEntries]
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          (b.entry.position ?? Number.MAX_SAFE_INTEGER) -
          (a.entry.position ?? Number.MAX_SAFE_INTEGER),
      )
      .map(({ entry, index }) => ({
        key: `held:${entry.clientTurnId ?? `${entry.createdAt}:${index}`}`,
        node: renderHeldRow(entry),
      })),
  ];
  const rowPresence = usePresenceList(
    displayRows,
    (row) => row.key,
    PRESENCE_FALLBACK_MS,
  );

  function renderLocalRow(row: QueueRow, idx: number) {
    const msg = row.message;
    // 1 = next to send, after what Station holds.
    const orderNum = localOrderStart + idx + 1;
    return (
      <div className="queued-message">
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
              {/* Clamped to two lines; Edit opens the full text. */}
              <span className="queued-message__body">{msg}</span>
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
                  void onSendMessageNow(metadata[idx].id).finally(() => {
                    pendingRef.current.delete(row.id);
                    setPendingRows(new Set(pendingRef.current));
                  });
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
                  metadata?.[idx]?.delivery ? 'Retry steering' : 'Send as steer'
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
  }

  function renderHeldRow(entry: ConversationInboxEntry) {
    const key = entry.clientTurnId;
    const removable =
      key && ['queued', 'unconfirmed', 'refused'].includes(entry.state);
    const verb = entry.state === 'queued' ? 'Remove' : 'Dismiss';
    const order = heldOrder.get(entry);
    return (
      <div className="queued-message queued-message--held">
        <span
          className="queued-message__order"
          aria-hidden={order === undefined ? true : undefined}
        >
          {order}
        </span>
        <span className="queued-message__text" title={entry.message}>
          <span className="queued-message__body">{entry.message}</span>
          <span
            className="queued-message__status"
            title={
              entry.state === 'queued'
                ? 'Sent when the current turn ends, even if you close the app.'
                : undefined
            }
          >
            {HELD_STATE_LABEL[entry.state]}
          </span>
          {entry.reason && (
            <span className="queued-message__status">{entry.reason}</span>
          )}
        </span>
        {removable && (
          <div className="queued-message__utilities">
            <button
              type="button"
              disabled={held?.removing}
              onClick={() => held?.onRemove(key)}
              className="queued-message__btn queued-message__btn--danger"
              title={verb}
              aria-label={`${verb} held message: ${entry.message}`}
            >
              ×
            </button>
          </div>
        )}
      </div>
    );
  }

  const panel = (
    <section
      className="queued-messages queued-messages--pending"
      aria-label="Pending messages"
      data-expanded={expanded || undefined}
    >
      <button
        type="button"
        className="queued-messages__toggle"
        aria-expanded={expanded}
        aria-controls={queueId}
        aria-label={
          pendingCount > 0
            ? `${pendingCount} pending message${pendingCount !== 1 ? 's' : ''}${needsReview ? `, ${attention.toLowerCase()}` : ''}`
            : 'Held messages need review'
        }
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
        {pendingCount > 0 && <span>{pendingCount} pending</span>}
        {needsReview && (
          <span className="queued-messages__attention">{attention}</span>
        )}
        <ArrowDownGlyph />
      </button>
      {/* Outside the collapsible rows, so a send that fails is announced
          while the list is closed. */}
      <span className="sr-only" aria-live="polite">
        {needsReview
          ? notSent
            ? 'A pending message was not sent'
            : 'A pending message needs review'
          : ''}
      </span>
      {held?.unavailable && (
        <div className="queued-messages__hold" role="status">
          <span className="queued-messages__failure-text">
            Couldn’t load held messages.
          </span>
          <button
            type="button"
            onClick={held.onRetry}
            className="queued-message__btn"
          >
            Retry
          </button>
        </div>
      )}
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
                  failure.code === CONTINUATION_WORKSPACE_REFUSAL_CODES[6]
                    ? 'Send the queued message to this conversation as it is'
                    : 'Retry the queued message'
                }
              >
                {/* The label names what the action DOES. A plain "Retry" on an
                    unbound-workspace refusal would resubmit the same workspace
                    and reproduce the same refusal (UX audit T3 review). */}
                {failure.code === CONTINUATION_WORKSPACE_REFUSAL_CODES[6]
                  ? 'Continue as is'
                  : 'Retry'}
              </button>
            )}
          </div>
        )}
        {held?.removalError && (
          <p className="queued-messages__failure" role="alert">
            Removal not confirmed. Check the list, then try again.
          </p>
        )}
        <div className="queued-messages__list">
          {rowPresence.list.map(({ key, item, phase }) => (
            <div
              key={key}
              className="queued-message-presence"
              data-phase={phase}
              aria-hidden={phase === 'exiting' || undefined}
              inert={phase === 'exiting' || undefined}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget)
                  rowPresence.settle(key);
              }}
            >
              <div className="queued-presence__clip">{item.node}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
  const surface = usePresenceList(
    visible ? [{ key: 'surface', node: panel }] : [],
    (entry) => entry.key,
    PRESENCE_FALLBACK_MS,
  );
  const shown = surface.list[0];
  if (!shown) return null;
  return (
    <div
      className="queued-messages-presence"
      data-phase={shown.phase}
      aria-hidden={shown.phase === 'exiting' || undefined}
      inert={shown.phase === 'exiting' || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) surface.settle(shown.key);
      }}
    >
      <div className="queued-presence__clip">
        {shown.phase === 'exiting' ? shown.item.node : panel}
      </div>
    </div>
  );
}
