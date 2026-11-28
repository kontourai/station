import {
  type Notification,
  TURN_COMPLETION_NOTIFICATION_SOURCE,
} from '@kontourai/station-contracts/notification';
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

/** Replace IDs in legacy Station-generated records still in notification history. */
export function notificationBody(
  notification: Pick<Notification, 'body' | 'source' | 'metadata'>,
): string | undefined {
  const { body, source, metadata } = notification;
  const threadId = metadata?.threadId;
  if (
    source === TURN_COMPLETION_NOTIFICATION_SOURCE &&
    typeof threadId === 'string' &&
    body?.endsWith(` in session ${threadId}`)
  )
    return 'Open the chat for details.';
  return body;
}

export function notificationSessionTitle(
  notification: Pick<Notification, 'category' | 'metadata'>,
): string | undefined {
  if (
    !['turn-completed', 'turn-failed', 'turn-stopped'].includes(
      notification.category,
    )
  )
    return;
  const title = notification.metadata?.chatTitle;
  return typeof title === 'string' && title.trim() ? title : undefined;
}
