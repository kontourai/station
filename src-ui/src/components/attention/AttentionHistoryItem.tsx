import type { AttentionItem } from '@kontourai/station-sdk';
import { useAcknowledgeAttentionItemMutation } from '@kontourai/station-sdk';
import {
  attentionKindLabel,
  isApprovalLivePending,
  sessionFailedIdentity,
  sessionFailureCause,
} from '../../utils/attention';
import {
  acknowledgeThenOpen,
  isPlainLeftClick,
  navigateToAttentionTarget,
} from '../../utils/attentionOpen';
import { formatNotificationTime } from '../../utils/notifications';
import {
  ACKNOWLEDGE_ATTENTION_ACTION,
  DISMISS_NOTIFICATION_ACTION,
} from './notificationRowActions';

type SessionFailedItem = Extract<AttentionItem, { kind: 'session-failed' }>;

export function AttentionHistoryItem({
  item,
  isPending,
  isDismissPending,
  onAction,
  onClose,
  onDismiss,
}: {
  item: AttentionItem;
  isPending: boolean;
  isDismissPending: boolean;
  onAction: (notificationId: string, actionId: string) => void;
  onClose: () => void;
  onDismiss: (notificationId: string) => void;
}) {
  /*
   * archive#3203: this row used to be the kind eyebrow and the title, and
   * nothing else — so the projection's `body` (the failure's own cause) and
   * `updatedAt` were both carried to this surface and dropped, and the tray
   * the owner reported showed three rows reading "Session failed / Session
   * failed" with no way to tell which session each was. The body and the time
   * are the same fields `AttentionCard` and `NotificationHistoryItem` already
   * render; the classes and layout are `NotificationHistoryItem`'s, so the two
   * kinds of row in one popover cannot drift apart visually.
   */
  return (
    <div className="notification-history__item notification-history__item--timed">
      <div className="notification-history__item-content">
        <div className="notification-history__eyebrow">
          {attentionKindLabel(item.kind)}
        </div>
        <div>{item.title}</div>
        {item.kind === 'session-failed' ? (
          <SessionFailedDetail item={item} />
        ) : (
          item.body && (
            <div className="notification-history__detail">{item.body}</div>
          )
        )}
        <div className="notification-history__actions">
          {item.kind === 'approval' &&
            item.actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="notification-history__action"
                onClick={() => onAction(item.source.notificationId, action.id)}
                disabled={isPending}
              >
                {action.label}
              </button>
            ))}
          {item.kind === 'session-failed' ? (
            <FailedSessionOpenLink item={item} onClose={onClose} />
          ) : (
            item.openHref && (
              <a
                className="notification-history__action"
                href={item.openHref}
                onClick={onClose}
              >
                {openLinkLabel(item.kind)}
              </a>
            )
          )}
          {/*
           * Non-actionable/terminal approvals get a plain dismiss; a
           * genuinely-pending approval (live actions + resolvable session)
           * keeps dismiss available but visually de-emphasized (`--quiet`)
           * so approve/deny stay primary — mirrors AttentionCard.
           */}
          {/* archive#3779: label from the shared model, not written here. */}
          {item.kind === 'approval' && (
            <button
              type="button"
              className={
                isApprovalLivePending(item)
                  ? 'notification-history__action notification-history__action--quiet'
                  : 'notification-history__action'
              }
              onClick={() => onDismiss(item.source.notificationId)}
              disabled={isDismissPending}
            >
              {DISMISS_NOTIFICATION_ACTION.label}
            </button>
          )}
          {item.kind === 'session-failed' && <SessionFailedAck item={item} />}
        </div>
      </div>
      <time className="notification-history__time">
        {formatNotificationTime(item.updatedAt)}
      </time>
    </div>
  );
}

/**
 * archive#3203: the cause, then who ran it. The cause renders even when the
 * projection carried no `body` — "no failure detail was recorded" is a fact
 * about the session, and it is the answer to "what happened"; silence is not.
 */
function SessionFailedDetail({ item }: { item: SessionFailedItem }) {
  const identity = sessionFailedIdentity(item);
  return (
    <>
      <div
        className="notification-history__detail notification-history__detail--cause"
        data-testid="attention-cause"
      >
        {sessionFailureCause(item)}
      </div>
      {identity && (
        <div
          className="notification-history__detail"
          data-testid="attention-identity"
        >
          {identity}
        </div>
      )}
    </>
  );
}

/**
 * archive#3203: opening a `session-failed` row records the same
 * acknowledgement its Dismiss does, so the badge decrements for the row the
 * user actually acted on — and only that row.
 *
 * Its own component so the acknowledge mutation is only constructed for the
 * one kind that can use it. Every other kind keeps the plain anchor above:
 * none of them has an acknowledgement to record, and the projection discards
 * one recorded against them (`decorateAcknowledgement` returns early), so
 * firing it there would be a write that claims the row was seen and changes
 * nothing.
 */
function FailedSessionOpenLink({
  item,
  onClose,
}: {
  item: SessionFailedItem;
  onClose: () => void;
}) {
  const mutation = useAcknowledgeAttentionItemMutation();
  const href = item.openHref;
  return (
    <a
      className="notification-history__action"
      href={href}
      onClick={(event) => {
        onClose();
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        void acknowledgeThenOpen({
          acknowledge: () => mutation.mutateAsync(item.id),
          navigate: () => navigateToAttentionTarget(href),
        });
      }}
    >
      {openLinkLabel(item.kind)}
    </a>
  );
}

/**
 * archive#1914: `session-failed` has no notification behind it to dismiss —
 * see `AttentionCard.tsx`'s `SessionFailedAction` for the full rationale.
 * Self-contained rather than routed through the popover's `onDismiss` prop:
 * that prop drives `NotificationHistory`'s undo-window + notification-delete
 * flow, which does not apply here (there is no notification id, and nothing
 * to undo into — an ack is idempotent and safe to fire immediately).
 */
function SessionFailedAck({ item }: { item: SessionFailedItem }) {
  const mutation = useAcknowledgeAttentionItemMutation();
  return (
    <button
      type="button"
      className="notification-history__action"
      onClick={() => mutation.mutate(item.id)}
      disabled={mutation.isPending}
    >
      {ACKNOWLEDGE_ATTENTION_ACTION.label}
    </button>
  );
}

function openLinkLabel(kind: AttentionItem['kind']): string {
  switch (kind) {
    case 'gate-route-back':
    case 'gate-blocked':
    case 'gate-exception':
      return 'Open flow console';
    default:
      return 'Open session';
  }
}
