import type { Notification } from '@kontourai/station-contracts/notification';
import type { ReactNode } from 'react';
import { useNotificationAnswerability } from '../../hooks/useNotificationAnswerability';
import { Empty } from '../state';
import { useInboxContext } from './inboxContext';
import { groupByDay } from './inboxPresentation';
import { NotificationCard } from './NotificationCard';
import { snoozeMenuItems, useInboxSnooze } from './snooze';

export function NotificationSection({
  notifications,
  onDismiss,
  filtered = false,
  focusedNotificationId,
  summary,
}: {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  filtered?: boolean;
  focusedNotificationId?: string;
  /** The page's "showing N of M" line, rendered beside the heading. */
  summary?: ReactNode;
}) {
  const answerabilityFor = useNotificationAnswerability();
  const contextFor = useInboxContext();
  const snooze = useInboxSnooze();
  // Rows arrive newest first (`sortNotifications`), so day groups are runs.
  const days = groupByDay(notifications, (row) => row.updatedAt);
  return (
    <section
      aria-labelledby="notification-history-heading"
      className="notifications-page__section"
    >
      <div className="notifications-page__section-heading">
        <h2
          id="notification-history-heading"
          className="notifications-page__section-title"
        >
          Activity
        </h2>
        {summary}
      </div>
      {notifications.length === 0 ? (
        /* empty-state action: filter reset is adjacent */
        <Empty
          variant="compact"
          label={filtered ? 'No matching activity' : 'No activity yet'}
          description={
            filtered
              ? 'Try changing or clearing the history filters.'
              : undefined
          }
        />
      ) : (
        days.map((day) => (
          <div key={day.label} className="notifications-page__day">
            <h3 className="notifications-page__day-label">{day.label}</h3>
            <div className="notifications-page__list">
              {day.rows.map((notification) => (
                <NotificationCard
                  key={notification.id}
                  notification={notification}
                  answerability={answerabilityFor(notification)}
                  context={contextFor.forNotification(notification)}
                  menuItems={
                    snooze.enabled &&
                    notification.status !== 'dismissed' &&
                    notification.status !== 'actioned'
                      ? snoozeMenuItems(
                          (until) => snooze.notification(notification, until),
                          snooze.pending,
                        )
                      : []
                  }
                  onDismiss={onDismiss}
                  focused={notification.id === focusedNotificationId}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}
