import type { Notification } from '@kontourai/station-contracts/notification';
import type { ReactNode } from 'react';
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
 * One row of the popover's "Activity" tab.
 *
 * archive#1780: this list renders `notifications minus attention-projected`,
 * so a stranded approval that the attention projection correctly dropped
 * surfaces HERE — and it used to arrive with live Allow/Deny buttons that
 * dispatch into a guaranteed server rejection. The fix is annotation, not a
 * second suppression: the row stays, its actions are disabled, and it says
 * which process observed what, and when. Dismiss stays live because a
 * dismissal is a real user decision, unlike the synthetic `actioned` the
 * old write-time pass recorded on the user's behalf.
 */
export function NotificationHistoryItem({
  notification,
  answerability = NOT_APPLICABLE,
  isActionPending,
  isDismissPending,
  onAction,
  onDismiss,
  context = [],
  feedback,
  menuItems = [],
}: {
  notification: Notification;
  answerability?: AnswerabilityView;
  isActionPending: boolean;
  isDismissPending: boolean;
  onAction: (notificationId: string, actionId: string) => void;
  onDismiss: (notificationId: string) => void;
  /** Station · Project · Chat · Agent · Engine, from `useInboxContext`. */
  context?: readonly InboxContextPart[];
  /** This row's own action outcome (an error with its recovery), if any. */
  feedback?: ReactNode;
  /** Extra items for the row's ⋯ menu (snooze), before its dismiss. */
  menuItems?: readonly RowMenuItem[];
}) {
  const detail = notificationDetail(notification);
  // Only an OBSERVED negative disables anything. `unknown` renders its gap
  // and leaves the buttons alone: a surface that could not look has no
  // standing to gate an action, and enforcement is server-side regardless.
  const unanswerable = answerability.status === 'unanswerable';
  const notice =
    answerability.status === 'unanswerable' ||
    answerability.status === 'unknown'
      ? answerability.notice
      : null;
  // archive#1780: a disabled button announces only "dimmed" to a screen
  // reader. The reason is on screen for a sighted reader and was inaudible to
  // everyone else — the same "renders the basis" contract, one modality over.
  const noticeId = notice
    ? `notification-answerability-${notification.id}`
    : undefined;
  const actions = notification.actions ?? [];
  return (
    <div className="notification-history__item">
      <InboxMarkTile mark={notificationMark(notification)} />
      <div className="notification-history__item-content">
        <div className="notification-history__meta">
          <span className="notification-history__eyebrow">
            {notificationCategoryLabel(notification.category)}
          </span>
          <span className="notification-history__corner">
            <time
              className="notification-history__time"
              dateTime={notification.updatedAt}
            >
              {formatNotificationTime(notification.updatedAt)}
            </time>
            <RowMenu
              items={[
                ...menuItems,
                {
                  id: 'dismiss',
                  label: DISMISS_NOTIFICATION_ACTION.label,
                  disabled: isDismissPending,
                  onSelect: () => onDismiss(notification.id),
                },
              ]}
            />
          </span>
        </div>
        <div className="notification-history__item-title">
          {notification.title}
        </div>
        {notification.body && (
          <div className="notification-history__detail">
            {notification.body}
          </div>
        )}
        {detail && <div className="notification-history__detail">{detail}</div>}
        <NotificationEnvelopeControls
          notification={notification}
          detailClassName="notification-history__detail"
          actionsClassName="notification-history__actions"
          actionClassName="notification-history__action"
        />
        {notice && (
          <div
            id={noticeId}
            className="notification-history__detail notification-history__answerability"
            data-testid="notification-answerability"
          >
            {notice}
          </div>
        )}
        <InboxContextLine parts={context} compact />
        {feedback}
        {actions.length > 0 && (
          <div className="notification-history__footer-row">
            <div className="notification-history__actions">
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="notification-history__action"
                  data-variant={action.variant ?? 'secondary'}
                  onClick={() => onAction(notification.id, action.id)}
                  disabled={isActionPending || unanswerable}
                  aria-describedby={unanswerable ? noticeId : undefined}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
