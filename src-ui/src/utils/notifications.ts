import type { Notification } from '@kontourai/station-contracts/notification';
import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';

/**
 * A row's time, as short as stays unambiguous: relative within a day, then a
 * date — with the year only once it is not this year. The exact instant is on
 * the `<time dateTime>` the callers render it in.
 */
export function formatNotificationTime(
  timestamp: string,
  now = new Date(),
): string {
  const date = new Date(timestamp);
  const diffMins = Math.floor((now.getTime() - date.getTime()) / MS_PER_MINUTE);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function sortNotifications(
  notifications: Notification[],
): Notification[] {
  return [...notifications].sort(
    (left, right) =>
      Date.parse(right.updatedAt || right.createdAt) -
      Date.parse(left.updatedAt || left.createdAt),
  );
}

export function isApprovalNotification(notification: Notification): boolean {
  return notification.category === 'approval-request';
}

export function notificationDetail(
  notification: Notification,
): string | undefined {
  const detail = notification.metadata?.detail;
  return typeof detail === 'string' ? detail : undefined;
}
