import type { Notification } from '@kontourai/station-contracts/notification';
import { useNotificationAnswerability } from '../../hooks/useNotificationAnswerability';
import { Empty } from '../state';
import { NotificationCard } from './NotificationCard';

export function NotificationSection({
  notifications,
  onDismiss,
  filtered = false,
  focusedNotificationId,
}: {
  notifications: Notification[];
  onDismiss: (id: string) => void;
  filtered?: boolean;
  focusedNotificationId?: string;
}) {
  const answerabilityFor = useNotificationAnswerability();
  return (
    <section aria-labelledby="notification-history-heading">
      <h2
        id="notification-history-heading"
        className="notifications-page__section-title"
      >
        Activity
      </h2>
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
        <div className="notifications-page__list">
          {notifications.map((notification) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              answerability={answerabilityFor(notification)}
              onDismiss={onDismiss}
              focused={notification.id === focusedNotificationId}
            />
          ))}
        </div>
      )}
    </section>
  );
}
