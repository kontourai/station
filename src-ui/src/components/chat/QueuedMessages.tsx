import { CONTINUATION_WORKSPACE_REFUSAL_CODES } from '@kontourai/station-contracts/execution-target';
import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PendingMessageMetadata } from '../../contexts/active-chats-state';
import {
  PRESENCE_FALLBACK_MS,
  usePresenceList,
} from '../../hooks/usePresenceList';
import { useQueuedMessages } from '../../hooks/useQueuedMessages';
import { useSwipeActions } from '../../hooks/useSwipeActions';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { Button } from '../Button';
import { recordedDeliveryPort } from '../conversation/DeliveryPort';
import {
  ArrowDownGlyph,
  CloseGlyph,
  EditGlyph,
  MoreGlyph,
  OutboxGlyph,
  SendGlyph,
  TrashGlyph,
} from '../icons/Glyph';
import { ConfirmModal } from '../modals/ConfirmModal';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { MessageDeliveryNote } from './message-bubble/MessageDeliveryNote';
import { heldSendsInOrder, pendingMessageCount } from './pendingMessages';
import './QueuedMessages.css';

interface QueuedMessagesProps {
  sessionId: string;
  messages: string[];
  nextFirst?: boolean;
  queueToolbar?: HTMLDivElement | null;
  composerEdit?: {
    target: HTMLDivElement | null;
    text?: string;
    start: (text: string) => void;
    finish: () => void;
    setSaving: (saving: boolean) => void;
  };
  pendingSteerTarget?: HTMLDivElement | null;
  metadata?: PendingMessageMetadata[];
  sendNowPending?: boolean;
  waitingForTools?: boolean;
  onSendMessageNow?: (messageId: string) => Promise<void>;
  canSteer?: boolean;
  steeringUnavailableReason?: string;
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
  onReviewOrigin?: (messageId: string) => void;
  /**
   * #3157: the conversation stopped on a provider usage limit, so the queue
   * does not send on its own; Send now still does.
   */
  heldByUsageLimit?: boolean;
  /**
   * #3868: follow-ups Station holds in this conversation's server inbox,
   * possibly sent from another client. They share this one list; they are
   * managed through the inbox.
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
  updating?: boolean;
  updateError?: boolean;
  onMove?: (key: string, neighbor: string, direction: 'up' | 'down') => void;
  onSteer?: (key: string, message: string) => void;
  onEdit?: (key: string, previous: string, message: string) => Promise<void>;
  onRetry: () => void;
  onResend?: (entry: ConversationInboxEntry) => void;
}

interface QueueRow {
  id: number;
  message: string;
}

/**
 * A polite live region that mounts empty and takes its text after mount.
 * Screen readers announce changes to a region, not what it held when it
 * appeared, so a list that first appears already failed would stay silent.
 */
function PoliteAnnouncement({ text }: { text: string }) {
  const [announced, setAnnounced] = useState('');
  useEffect(() => setAnnounced(text), [text]);
  return (
    <span className="sr-only" aria-live="polite">
      {announced}
    </span>
  );
}

function QueueCardText({
  message,
  disabled,
  onEdit,
}: {
  message: string;
  disabled?: boolean;
  onEdit: () => void;
}) {
  return (
    <button
      type="button"
      className="queue-card-text"
      aria-label={`Edit message: ${message}`}
      disabled={disabled}
      onClick={onEdit}
    >
      <span className="queued-message__body">{message}</span>
    </button>
  );
}

function QueueMore({
  revealed,
  onReveal,
  disabled,
}: {
  revealed: boolean;
  onReveal: (reveal: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="queued-message__btn queued-message__dismiss queue-more"
      disabled={disabled}
      aria-label={revealed ? 'Hide message actions' : 'More message actions'}
      aria-expanded={revealed}
      onClick={() => onReveal(!revealed)}
    >
      <MoreGlyph />
    </button>
  );
}

function QueueSwipeRow({
  children,
  enabled,
  open,
  onOpenChange,
  disabled,
  dismiss,
  onRemove,
}: {
  children: ReactNode;
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  dismiss?: boolean;
  onRemove: () => void;
}) {
  const swipe = useSwipeActions(enabled, {
    open,
    onOpenChange,
    actionWidth: 72,
    triggerSelector: '.queue-card-text',
  });
  return (
    <fieldset
      className="queue-swipe-row"
      ref={swipe.ref}
      style={swipe.style}
      data-dragging={swipe.dragging || undefined}
      onPointerDown={swipe.onPointerDown}
      onPointerMove={swipe.onPointerMove}
      onPointerUp={swipe.onPointerUp}
      onPointerCancel={swipe.onPointerCancel}
      onLostPointerCapture={swipe.onLostPointerCapture}
      onClickCapture={swipe.onClickCapture}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !swipe.open) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget
          .querySelector<HTMLButtonElement>('.queue-more')
          ?.focus();
        swipe.close();
      }}
    >
      {children}
      {enabled && (
        <div
          className="queue-swipe-row__tray"
          hidden={!swipe.actionsVisible}
          aria-hidden={!swipe.open}
          inert={!swipe.open}
        >
          <Button
            type="button"
            variant="ghost"
            className="queue-swipe-row__action"
            disabled={disabled}
            aria-label={dismiss ? 'Dismiss notice' : 'Cancel message'}
            title={dismiss ? 'Dismiss notice' : 'Cancel message'}
            onClick={() => {
              onRemove();
              swipe.close();
            }}
          >
            {dismiss ? <CloseGlyph /> : <TrashGlyph />}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

function QueueMove({
  up,
  down,
  disabled,
}: {
  up?: () => void;
  down?: () => void;
  disabled?: boolean;
}) {
  return (
    <label className="queued-message__btn queue-move">
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M4 5h2v2H4zm6 0h2v2h-2zM4 9h2v2H4zm6 0h2v2h-2z" />
      </svg>
      <select
        aria-label="Move message"
        disabled={disabled || (!up && !down)}
        value=""
        onChange={(event) => {
          if (event.currentTarget.value === 'up') up?.();
          if (event.currentTarget.value === 'down') down?.();
        }}
      >
        <option value="" disabled>
          Move message
        </option>
        <option value="up" disabled={!up}>
          Move up
        </option>
        <option value="down" disabled={!down}>
          Move down
        </option>
      </select>
    </label>
  );
}

export function QueuedMessages({
  sessionId,
  messages,
  nextFirst = false,
  queueToolbar,
  composerEdit,
  pendingSteerTarget,
  metadata,
  sendNowPending,
  waitingForTools,
  onSendMessageNow,
  canSteer = false,
  steeringUnavailableReason,
  onSteer,
  onPendingSettled,
  failure,
  onRetry,
  onReviewOrigin,
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
  const [revealedAction, setRevealedAction] = useState<string | number | null>(
    null,
  );
  const queueId = useId();
  const queueTrigger = useRef<HTMLButtonElement>(null);
  const [reviewSteer, setReviewSteer] = useState<ConversationInboxEntry | null>(
    null,
  );
  const [heldEdit, setHeldEdit] = useState<{
    key: string;
    previous: string;
  } | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const editText = composerEdit?.text;
  const editingInComposer =
    editText !== undefined && (heldEdit !== null || editingIndex !== null);
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
      metadata?.some(
        (entry) => entry.delivery === 'indeterminate' || entry.originUnverified,
      ) ||
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
  const localSendOrder = new Map(
    localRows
      .filter(({ idx }) => !metadata?.[idx]?.originUnverified)
      .map(({ idx }, order) => [idx, heldOrder.size + order + 1]),
  );
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
      key: metadata?.[idx]?.id ? `turn:${metadata[idx].id}` : `local:${row.id}`,
      node: renderLocalRow(row, idx),
    })),
    ...[...heldEntries]
      .filter(
        (entry) =>
          !nextFirst || entry.kind !== 'steer' || heldSendsInOrder(entry),
      )
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          (b.entry.position ?? Number.MAX_SAFE_INTEGER) -
          (a.entry.position ?? Number.MAX_SAFE_INTEGER),
      )
      .map(({ entry, index }) => ({
        key: entry.clientTurnId
          ? `turn:${entry.clientTurnId}`
          : `held:${entry.createdAt}:${index}`,
        node: renderHeldRow(entry),
      })),
  ];
  const queuedFollowUps = [...heldOrder.keys()].filter(
    (entry) => entry.kind === 'follow-up',
  );
  const nextMessage =
    queuedFollowUps[0]?.message ??
    localRows.find(({ idx }) => localSendOrder.has(idx))?.row.message;
  const queuedCount = queuedFollowUps.length + localSendOrder.size;
  const steerUpdates = nextFirst
    ? heldEntries.filter(
        (entry) => entry.kind === 'steer' && !heldSendsInOrder(entry),
      )
    : [];
  const rowPresence = usePresenceList(
    nextFirst ? [...displayRows].reverse() : displayRows,
    (row) => row.key,
    PRESENCE_FALLBACK_MS,
  );

  function renderLocalRow(row: QueueRow, idx: number) {
    const msg = row.message;
    // 1 = next to send, after what Station holds.
    const orderNum = localSendOrder.get(idx);
    const canEditCard = nextFirst && composerEdit;
    const reveal = (show: boolean) =>
      setRevealedAction((current) =>
        show ? row.id : current === row.id ? null : current,
      );
    const rowBusy = sendNowPending || pendingRows.has(row.id);
    const card = (
      <div
        className="queued-message"
        data-queue-head={(nextFirst && orderNum === 1) || undefined}
      >
        {nextFirst && editingIndex !== idx && (
          <QueueMove
            disabled={sendNowPending}
            up={idx > 0 ? () => moveUp(idx) : undefined}
            down={
              idx < messages.length - 1
                ? () => moveDown(idx, messages.length)
                : undefined
            }
          />
        )}
        <span
          className="queued-message__order"
          aria-hidden={orderNum === undefined ? true : undefined}
        >
          {orderNum}
        </span>
        {editingIndex === idx && !composerEdit ? (
          <input
            ref={(node) => {
              editInputRef.current = node;
            }}
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
            onBlur={() => saveEdit()}
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
            <div className="queued-message__text" title={msg}>
              {canEditCard ? (
                <QueueCardText
                  message={msg}
                  disabled={rowBusy || Boolean(metadata?.[idx]?.delivery)}
                  onEdit={() => {
                    startEdit(idx, msg);
                    canEditCard.start(msg);
                    setExpanded(false);
                  }}
                />
              ) : (
                <span className="queued-message__body">{msg}</span>
              )}
              {metadata?.[idx]?.originUnverified && (
                <span className="queued-message__status">
                  Review destination
                </span>
              )}
              {metadata?.[idx]?.mode === 'steer' && (
                <span className="queued-message__status">
                  Steer{waitingForTools ? ' · Waiting for tools to finish' : ''}
                </span>
              )}
              <MessageDeliveryNote
                variant="inline"
                state={
                  metadata?.[idx]?.delivery === 'steering'
                    ? 'sending'
                    : metadata?.[idx]?.delivery
                      ? 'unconfirmed'
                      : metadata?.[idx]?.originUnverified
                        ? 'waiting-for-station'
                        : 'held-on-device'
                }
                port={recordedDeliveryPort}
              />
            </div>
            {metadata?.[idx] &&
              (metadata[idx].originUnverified
                ? onReviewOrigin
                : onSendMessageNow) && (
                <Button
                  variant="ghost"
                  className="queued-message__btn"
                  disabled={
                    !metadata[idx].originUnverified &&
                    (sendNowPending ||
                      pendingRows.has(row.id) ||
                      !!metadata[idx].delivery)
                  }
                  title={
                    metadata[idx].originUnverified
                      ? 'Check the destination and prior delivery before sending this saved input.'
                      : 'Stop the current turn immediately and send this message'
                  }
                  aria-label={
                    metadata[idx].originUnverified
                      ? 'Review and resend'
                      : `Send pending message ${orderNum} now`
                  }
                  onClick={() => {
                    if (metadata[idx].originUnverified) {
                      onReviewOrigin?.(metadata[idx].id);
                      return;
                    }
                    if (!onSendMessageNow || pendingRef.current.has(row.id))
                      return;
                    pendingRef.current.add(row.id);
                    setPendingRows(new Set(pendingRef.current));
                    void onSendMessageNow(metadata[idx].id).finally(() => {
                      pendingRef.current.delete(row.id);
                      setPendingRows(new Set(pendingRef.current));
                    });
                  }}
                >
                  {metadata[idx].originUnverified
                    ? 'Review and resend'
                    : 'Send now'}
                </Button>
              )}
            <div className="queued-message__utilities">
              {!nextFirst && (
                <>
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
                </>
              )}
              {!canEditCard && (
                <button
                  type="button"
                  disabled={rowBusy || Boolean(metadata?.[idx]?.delivery)}
                  onClick={() => startEdit(idx, msg)}
                  className="queued-message__btn"
                  title="Edit (Enter)"
                  aria-label="Edit message"
                >
                  <EditGlyph />
                </button>
              )}
              {nextFirst ? (
                <QueueMore
                  revealed={revealedAction === row.id}
                  onReveal={reveal}
                  disabled={rowBusy}
                />
              ) : (
                <button
                  type="button"
                  disabled={rowBusy}
                  onClick={() => remove(idx)}
                  className="queued-message__btn queued-message__btn--danger"
                  title="Remove (Delete)"
                  aria-label="Remove message"
                >
                  ×
                </button>
              )}
            </div>
            {canSteer && onSteer && !metadata?.[idx]?.originUnverified && (
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
                className="queued-message__btn queued-message__steer"
                aria-label={
                  metadata?.[idx]?.delivery ? 'Retry steering' : 'Send as steer'
                }
              >
                {nextFirst ? (
                  <SendGlyph />
                ) : metadata?.[idx]?.delivery ? (
                  'Retry steering'
                ) : (
                  'Steer'
                )}
              </button>
            )}
          </>
        )}
      </div>
    );
    return nextFirst ? (
      <QueueSwipeRow
        enabled
        open={revealedAction === row.id}
        onOpenChange={reveal}
        disabled={rowBusy}
        onRemove={() => remove(idx)}
      >
        {card}
      </QueueSwipeRow>
    ) : (
      card
    );
  }

  function renderHeldRow(entry: ConversationInboxEntry) {
    const key = entry.clientTurnId;
    const restoreEndedSteer =
      key &&
      entry.ownedByCaller &&
      entry.kind === 'steer' &&
      entry.state === 'refused' &&
      entry.reasonCode === 'steer_turn_ended';
    const removable =
      key && ['queued', 'unconfirmed', 'refused'].includes(entry.state);
    const verb =
      entry.state === 'queued' ? (nextFirst ? 'Cancel' : 'Remove') : 'Dismiss';
    const actionable =
      key &&
      entry.ownedByCaller &&
      entry.kind === 'follow-up' &&
      entry.state === 'queued';
    const busy = held?.removing || held?.updating;
    const neighborAt = (offset: number) =>
      heldEntries.find(
        (item) =>
          entry.position !== undefined &&
          item.position === entry.position + offset &&
          item.kind === 'follow-up' &&
          item.ownedByCaller &&
          item.state === 'queued',
      )?.clientTurnId;
    const previous = neighborAt(-1);
    const next = neighborAt(1);
    const order = heldOrder.get(entry);
    const reveal = (show: boolean) =>
      setRevealedAction((current) =>
        show && key ? key : current === key ? null : current,
      );
    const card = (
      <div
        className="queued-message queued-message--held"
        data-queue-head={
          (nextFirst && order === 1 && entry.state === 'queued') || undefined
        }
      >
        {actionable && held?.onMove && (
          <QueueMove
            disabled={busy}
            up={previous ? () => held.onMove?.(key, previous, 'up') : undefined}
            down={next ? () => held.onMove?.(key, next, 'down') : undefined}
          />
        )}
        <span
          className="queued-message__order"
          aria-hidden={order === undefined ? true : undefined}
        >
          {order}
        </span>
        <div className="queued-message__text" title={entry.message}>
          {actionable && held?.onEdit && composerEdit ? (
            <QueueCardText
              message={entry.message}
              disabled={busy}
              onEdit={() => {
                setHeldEdit({ key, previous: entry.message });
                composerEdit.start(entry.message);
                setExpanded(false);
              }}
            />
          ) : (
            <span className="queued-message__body">{entry.message}</span>
          )}
          {entry.attachments?.length ? (
            <span
              className="queued-message__files"
              title={entry.attachments.map((file) => file.name).join(', ')}
            >
              {entry.attachments.length === 1
                ? entry.attachments[0]!.name
                : `${entry.attachments.length} files`}
            </span>
          ) : null}
          {(!nextFirst || entry.state !== 'queued') && (
            <MessageDeliveryNote
              variant="inline"
              state={
                entry.state === 'queued'
                  ? 'received'
                  : entry.state === 'sending'
                    ? 'sending'
                    : entry.state === 'unconfirmed'
                      ? 'unconfirmed'
                      : entry.state === 'refused'
                        ? 'not-sent'
                        : 'delivered'
              }
              port={{
                ...recordedDeliveryPort,
                ...(entry.state === 'unconfirmed' && held && !held.removing
                  ? {
                      check: async () => {
                        await held.onRetry();
                        return undefined;
                      },
                      canDiscardUnconfirmed: !!removable,
                      discard: async () => {
                        if (key) await held.onRemove(key);
                        return null;
                      },
                    }
                  : {}),
              }}
            />
          )}
          {entry.reason && (
            <span className="queued-message__status">{entry.reason}</span>
          )}
        </div>
        {(restoreEndedSteer ||
          (entry.kind === 'steer' && entry.state === 'unconfirmed')) &&
          held?.onResend && (
            <Button
              variant="ghost"
              disabled={held.removing}
              title={
                restoreEndedSteer
                  ? 'Restore the message to an empty draft'
                  : 'This may duplicate the original steer. Review the text before sending.'
              }
              onClick={() => held.onResend?.(entry)}
            >
              {restoreEndedSteer ? 'Restore to draft' : 'Review and resend'}
            </Button>
          )}

        {removable && entry.state !== 'unconfirmed' && (
          <div className="queued-message__utilities">
            {nextFirst ? (
              <QueueMore
                revealed={revealedAction === key}
                onReveal={reveal}
                disabled={busy}
              />
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => held?.onRemove(key)}
                className="queued-message__btn queued-message__btn--danger"
                title={verb}
                aria-label={`${verb} held message: ${entry.message}`}
              >
                ×
              </button>
            )}
          </div>
        )}
        {actionable &&
          canSteer &&
          held?.onSteer &&
          !entry.attachments?.length && (
            <button
              type="button"
              className="queued-message__btn queued-message__steer"
              disabled={busy}
              aria-label="Steer"
              title="Steer"
              onClick={() => held.onSteer?.(key, entry.message)}
            >
              <SendGlyph />
            </button>
          )}
      </div>
    );
    return nextFirst ? (
      <QueueSwipeRow
        enabled={Boolean(removable && entry.state !== 'unconfirmed')}
        open={revealedAction === key}
        onOpenChange={reveal}
        disabled={busy}
        dismiss={verb === 'Dismiss'}
        onRemove={() => {
          if (key) held?.onRemove(key);
        }}
      >
        {card}
      </QueueSwipeRow>
    ) : (
      card
    );
  }

  const steerBubbles = steerUpdates.map((entry) => {
    const refused = entry.state === 'refused';
    const unknown = entry.state === 'unconfirmed';
    return (
      <article
        key={entry.clientTurnId ?? entry.createdAt}
        className="chat-steer-bubble"
        data-delivery={entry.state}
        aria-label="Steer"
      >
        <span className="chat-steer-mark">Steer</span>
        <div className="chat-steer-bubble__text">{entry.message}</div>
        <div className="chat-steer-bubble__meta">
          <span role="status" title={entry.reason}>
            {refused
              ? 'Not sent'
              : unknown
                ? 'Unconfirmed'
                : entry.state === 'sending'
                  ? 'Steering…'
                  : 'Waiting…'}
          </span>
          {entry.ownedByCaller && held?.onResend && (refused || unknown) && (
            <Button
              type="button"
              variant="ghost"
              disabled={held.removing}
              onClick={() =>
                unknown ? setReviewSteer(entry) : held.onResend?.(entry)
              }
            >
              {unknown ? 'Review resend' : 'Restore draft'}
            </Button>
          )}
          {entry.clientTurnId && (unknown || refused) && (
            <Button
              type="button"
              variant="secondary"
              aria-label="Dismiss steer status"
              disabled={held?.removing}
              onClick={() => held?.onRemove(entry.clientTurnId!)}
            >
              Dismiss
            </Button>
          )}
        </div>
      </article>
    );
  });
  const composerEditControls =
    editingInComposer && composerEdit?.target
      ? createPortal(
          <section className="queue-edit-bar" aria-label="Queue">
            <span role="status">
              {held?.updateError
                ? 'Couldn’t save. The queue changed.'
                : 'Editing queued message'}
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={held?.updating}
              onClick={() => {
                if (heldEdit) setHeldEdit(null);
                else cancelEdit();
                composerEdit.finish();
                setExpanded(true);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={held?.updating || !editText.trim()}
              onClick={async () => {
                if (heldEdit) {
                  composerEdit.setSaving(true);
                  try {
                    await held?.onEdit?.(
                      heldEdit.key,
                      heldEdit.previous,
                      editText,
                    );
                  } catch {
                    composerEdit.setSaving(false);
                    return;
                  }
                  setHeldEdit(null);
                } else {
                  saveEdit(editText);
                }
                composerEdit.finish();
                setExpanded(true);
              }}
            >
              Save
            </Button>
          </section>,
          composerEdit.target,
        )
      : null;
  const listedCount = Math.max(0, pendingCount - steerUpdates.length);
  const panel = (
    <section
      className="queued-messages queued-messages--pending"
      aria-label="Pending messages"
      data-expanded={expanded || undefined}
      data-next-first={nextFirst || undefined}
    >
      {!queueToolbar && (
        <button
          type="button"
          className="queued-messages__toggle"
          aria-expanded={expanded}
          aria-controls={queueId}
          aria-label={
            nextFirst && nextMessage
              ? `${queuedCount} queued. ${nextMessage}`
              : pendingCount > 0
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
          {pendingCount > 0 &&
            (nextFirst && nextMessage ? (
              <span className="queued-messages__count">{queuedCount}</span>
            ) : (
              <span>{pendingCount} pending</span>
            ))}
          {nextFirst && !expanded && nextMessage && (
            <span className="queued-messages__next">{nextMessage}</span>
          )}
          {needsReview && (
            <span className="queued-messages__attention">{attention}</span>
          )}
          <ArrowDownGlyph />
        </button>
      )}
      {/* Outside the collapsible rows, so a send that fails is announced
          while the list is closed. */}
      <PoliteAnnouncement
        text={
          needsReview
            ? notSent
              ? 'A pending message was not sent'
              : 'A pending message needs review'
            : ''
        }
      />
      {held?.unavailable && (
        <div className="queued-messages__hold" role="status">
          <span className="queued-messages__failure-text">
            Couldn’t load inbox entries.
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
        {steeringUnavailableReason && (
          <p role="status">{steeringUnavailableReason}</p>
        )}
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
        {held?.updateError && (
          <p className="queued-messages__failure" role="alert">
            Couldn’t update the queue.
          </p>
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
  if (nextFirst) {
    const reviewed =
      reviewSteer &&
      steerUpdates.find(
        (entry) =>
          entry.clientTurnId === reviewSteer?.clientTurnId &&
          entry.state === 'unconfirmed',
      );
    return (
      <>
        {composerEditControls}
        {steerBubbles.length > 0 &&
          pendingSteerTarget &&
          createPortal(
            <div className="chat-steer-bubbles">{steerBubbles}</div>,
            pendingSteerTarget,
          )}
        {reviewed && (
          <ConfirmModal
            isOpen
            title="Review this steer?"
            message="The agent may already have received it. Sending it again could duplicate the instruction."
            confirmLabel="Restore draft"
            onCancel={() => setReviewSteer(null)}
            onConfirm={() => {
              setReviewSteer(null);
              held?.onResend?.(reviewed);
            }}
          />
        )}
        {queueToolbar
          ? createPortal(
              <>
                {!editingInComposer &&
                  (listedCount > 0 ||
                    held?.unavailable ||
                    heldByUsageLimit) && (
                    <Button
                      ref={queueTrigger}
                      type="button"
                      variant="ghost"
                      className="chat-queue-trigger"
                      aria-label={`Queue · ${listedCount} pending`}
                      aria-haspopup="dialog"
                      aria-expanded={expanded}
                      title="Open queue"
                      onClick={() => setExpanded(true)}
                    >
                      <OutboxGlyph />
                      {listedCount > 0 && <span>{listedCount}</span>}
                    </Button>
                  )}
                {expanded && (
                  <ResponsiveDialogSurface
                    layer="popover"
                    ariaLabel="Queue"
                    onClose={() => setExpanded(false)}
                    anchorRef={queueTrigger}
                    overlayClassName="composer-popover-overlay composer-popover-overlay--end"
                    panelClassName="composer-popover-panel chat-queue-popover"
                  >
                    <ResponsiveDialogHeader
                      title={
                        <span className="chat-queue-heading">
                          <OutboxGlyph />
                          Queue <span>{listedCount}</span>
                        </span>
                      }
                      closeLabel="Close queue"
                      onClose={() => setExpanded(false)}
                    />
                    {listedCount > 0 ||
                    heldEdit ||
                    held?.unavailable ||
                    heldByUsageLimit ? (
                      panel
                    ) : (
                      <p className="chat-queue-empty">Queue is empty</p>
                    )}
                  </ResponsiveDialogSurface>
                )}
              </>,
              queueToolbar,
            )
          : listedCount > 0 || held?.unavailable
            ? panel
            : null}
      </>
    );
  }
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
