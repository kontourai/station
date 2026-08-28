import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type AnswerabilityView,
  NOT_APPLICABLE,
} from '../../utils/answerability';
import { notificationCategoryLabel } from '../../utils/notificationLabels';
import {
  formatNotificationTime,
  isApprovalNotification,
  notificationDetail,
} from '../../utils/notifications';

/**
 * One row of "Recent activity".
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
}: {
  notification: Notification;
  answerability?: AnswerabilityView;
  isActionPending: boolean;
  isDismissPending: boolean;
  onAction: (notificationId: string, actionId: string) => void;
  onDismiss: (notificationId: string) => void;
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
  return (
    <div className="notification-history__item notification-history__item--timed">
      <div className="notification-history__item-content">
        {isApprovalNotification(notification) && (
          <div className="notification-history__eyebrow">
            {notificationCategoryLabel(notification.category)}
          </div>
        )}
        <div>{notification.title}</div>
        {notification.body && (
          <div className="notification-history__detail">
            {notification.body}
          </div>
        )}
        {detail && <div className="notification-history__detail">{detail}</div>}
        {notice && (
          <div
            id={noticeId}
            className="notification-history__detail notification-history__answerability"
            data-testid="notification-answerability"
          >
            {notice}
          </div>
        )}
        <div className="notification-history__actions">
          {notification.actions?.map((action) => (
            <button
              key={action.id}
              type="button"
              className="notification-history__action"
              onClick={() => onAction(notification.id, action.id)}
              disabled={isActionPending || unanswerable}
              aria-describedby={unanswerable ? noticeId : undefined}
            >
              {action.label}
            </button>
          ))}
          <button
            type="button"
            className="notification-history__action"
            onClick={() => onDismiss(notification.id)}
            disabled={isDismissPending}
          >
            Dismiss
          </button>
        </div>
      </div>
      <time className="notification-history__time">
        {formatNotificationTime(notification.updatedAt)}
      </time>
    </div>
  );
}
