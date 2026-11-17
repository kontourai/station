import type { Notification } from '@kontourai/station-contracts/notification';
import { relativeTimeFromIso } from './relativeTime';

/**
 * A row's time, in the one compact format (`relativeTime`): relative within a
 * week, then a date — with the year only once it is not this year. The exact
 * instant is on the `<time dateTime>` the callers render it in.
 */
export function formatNotificationTime(
  timestamp: string,
  now = new Date(),
): string {
  return relativeTimeFromIso(timestamp, now.getTime());
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
