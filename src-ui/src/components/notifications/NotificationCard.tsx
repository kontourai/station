import type { Notification } from '@kontourai/station-contracts/notification';
import { useEffect, useRef } from 'react';
import {
  type AnswerabilityView,
  NOT_APPLICABLE,
} from '../../utils/answerability';
import { notificationCategoryLabel } from '../../utils/notificationLabels';
import {
  formatNotificationTime,
  notificationDetail,
} from '../../utils/notifications';
import { DISMISS_NOTIFICATION_ACTION } from '../attention/notificationRowActions';
import { InboxContextLine, type InboxContextPart } from './inboxContext';
import { InboxMarkTile, notificationMark } from './inboxPresentation';
import { NotificationEnvelopeControls } from './NotificationEnvelopeControls';
import { RowMenu, type RowMenuItem } from './RowMenu';

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
  context = [],
  menuItems = [],
}: {
  notification: Notification;
  answerability?: AnswerabilityView;
  onDismiss: (id: string) => void;
  focused?: boolean;
  /** Station · Project · Chat · Agent · Engine, from `useInboxContext`. */
  context?: readonly InboxContextPart[];
  /** Extra items for the card's ⋯ menu (snooze), before its dismiss. */
  menuItems?: readonly RowMenuItem[];
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
  const dismissible =
    notification.status !== 'dismissed' && notification.status !== 'actioned';
  return (
    <article
      ref={cardRef}
      className={`notification-card${focused ? ' notification-card--focused' : ''}`}
      data-testid="notification-card"
      tabIndex={focused ? -1 : undefined}
    >
      <InboxMarkTile mark={notificationMark(notification)} />
      <div className="notification-card__content">
        <div className="notification-card__meta">
          <span className="notification-card__type">
            {notificationCategoryLabel(notification.category)}
          </span>
          <span className="notification-card__corner">
            <time
              className="notification-card__time"
              dateTime={notification.updatedAt}
            >
              {formatNotificationTime(notification.updatedAt)}
            </time>
            {/*
             * archive#1912: every status but the terminal `dismissed` /
             * `actioned` is still something to clear — an `expired` or
             * still-`pending` notification included.
             *
             * archive#3779: the label is read from the shared action model.
             * `DELETE /notifications/:id` does NOT delete — it sets `status:
             * 'dismissed'` and keeps the record — so the word stays "Dismiss".
             */}
            <RowMenu
              items={[
                ...menuItems,
                ...(dismissible
                  ? [
                      {
                        id: 'dismiss',
                        label: DISMISS_NOTIFICATION_ACTION.label,
                        onSelect: () => onDismiss(notification.id),
                      },
                    ]
                  : []),
              ]}
            />
          </span>
        </div>
        <div className="notification-card__message">{notification.title}</div>
        {notification.body && (
          <div className="notification-card__detail">{notification.body}</div>
        )}
        {detail && <div className="notification-card__detail">{detail}</div>}
        <NotificationEnvelopeControls
          notification={notification}
          detailClassName="notification-card__detail"
          actionsClassName="notice-actions"
          actionClassName="notice-action--ghost"
        />
        {notice && (
          <div
            className="notification-card__detail notification-card__answerability"
            data-testid="notification-answerability"
          >
            {notice}
          </div>
        )}
        <InboxContextLine parts={context} />
      </div>
    </article>
  );
}
