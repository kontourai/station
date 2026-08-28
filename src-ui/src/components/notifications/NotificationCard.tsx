import type { Notification } from '@kontourai/station-contracts/notification';
import { useEffect, useRef } from 'react';
import {
  type AnswerabilityView,
  NOT_APPLICABLE,
} from '../../utils/answerability';
import {
  formatNotificationTime,
  notificationDetail,
} from '../../utils/notifications';
import { DISMISS_NOTIFICATION_ACTION } from '../attention/notificationRowActions';

/**
 * The full notifications page's row. archive#1780: the same annotation
 * the popover renders, on the same join, so the two surfaces cannot tell
 * different stories about one approval. This card offers no Allow/Deny of
 * its own (only Dismiss), so there is nothing here to disable — the
 * annotation is the whole change, and it is still required: a reader who
 * opens "View all" must not see a request presented as live when the popover
 * has already said nothing can answer it.
 *
 * `onDismiss` keeps its name because it is the caller's mutation handle
 * (`useAttentionInbox.dismiss` → `DELETE /notifications/:id`); what the
 * user reads comes from the action model, not from this prop.
 */
export function NotificationCard({
  notification,
  answerability = NOT_APPLICABLE,
  onDismiss,
  focused = false,
}: {
  notification: Notification;
  answerability?: AnswerabilityView;
  onDismiss: (id: string) => void;
  focused?: boolean;
}) {
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) cardRef.current?.focus();
  }, [focused]);
  const detail = notificationDetail(notification);
  const notice =
    answerability.status === 'unanswerable' ||
    answerability.status === 'unknown'
      ? answerability.notice
      : null;
  return (
    <article
      ref={cardRef}
      className={`notification-card${focused ? ' notification-card--focused' : ''}`}
      data-testid="notification-card"
      tabIndex={focused ? -1 : undefined}
    >
      <header className="notification-card__header">
        <div className="notification-card__content">
          <div className="notification-card__message">{notification.title}</div>
          {notification.body && (
            <div className="notification-card__detail">{notification.body}</div>
          )}
          {detail && <div className="notification-card__detail">{detail}</div>}
          {notice && (
            <div
              className="notification-card__detail notification-card__answerability"
              data-testid="notification-answerability"
            >
              {notice}
            </div>
          )}
        </div>
        <time className="notification-card__time">
          {formatNotificationTime(notification.updatedAt)}
        </time>
      </header>
      {/*
       * archive#1912: this used to gate on `status === 'delivered'` only,
       * so an `expired` or still-`pending` notification — exactly the shape
       * a stale pairing request or a not-yet-delivered scheduled one takes —
       * rendered with NO way to dismiss it at all. `dismissed`/`actioned`
       * are the only genuinely terminal statuses (the user, or the system on
       * the user's behalf, already resolved those); every other status is
       * still something to clear.
       */}
      {notification.status !== 'dismissed' &&
        notification.status !== 'actioned' && (
          <div className="notification-card__actions">
            {/*
             * archive#3779: the label is read from the shared action model,
             * not written here. `DELETE /notifications/:id` does NOT delete —
             * it sets `status: 'dismissed'` and keeps the record — so the word
             * stays "Dismiss"; see `notificationRowActions` for the measured
             * mechanism and why a second verb is an owner decision.
             */}
            <button
              type="button"
              className="notification-card__action notification-card__action--ghost"
              onClick={() => onDismiss(notification.id)}
            >
              {DISMISS_NOTIFICATION_ACTION.label}
            </button>
          </div>
        )}
    </article>
  );
}
