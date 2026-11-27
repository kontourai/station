/**
 * composeWebPushPayload — archive#1100: builds the Web Push payload (title,
 * body, deep-link url) and the Web Push protocol TTL (seconds, RFC 8030)
 * from one or more pushable notifications, following the attention-ranked,
 * outcome-first design:
 *
 * - Ranking (AC1): when `pending` carries more than one candidate, the
 *   highest-outcome-priority one leads the payload (approval/input > failed
 *   > running > done — `@kontourai/station-shared/notification-priority`),
 *   ties broken by most-recently-updated. `WebPushChannel`'s live call
 *   site always supplies a single-item `pending` (the notification that
 *   just fired) — see that module's header comment for why deliberately not
 *   re-ranking across everything currently pending — but the composer stays
 *   ready for a real batched-summary surface without a rewrite.
 * - TTL (AC2): sized per the lead notification's outcome tier
 *   (`NOTIFICATION_TTL_MS`), returned in seconds for `web-push`'s
 *   `options.TTL`.
 * - Deep link (AC3): the lead notification's `notificationOpenLink`, the
 *   one link every OS channel sends: its envelope or metadata session (the
 *   same resolution `AttentionProjectionService`'s approval projection
 *   uses), else the attention inbox (`/notifications`), with the opened
 *   record and the sending Station's id added.
 *
 * Returns `null` when nothing in `pending` classifies to a known outcome
 * (defensive — `WebPushChannel.accepts` already filters before calling this).
 */
import type { Notification } from '@kontourai/station-contracts/notification';
import {
  classifyNotificationCategory,
  NOTIFICATION_TTL_MS,
  type NotificationOutcome,
  rankNotificationContent,
} from '@kontourai/station-shared/notification-priority';
import { notificationOpenLink } from './notification-deep-link.js';
import {
  osNotificationBody,
  osNotificationTitle,
} from './os-notification-text.js';
import type { WebPushPayload } from './web-push-service.js';

interface ComposedWebPush {
  payload: WebPushPayload;
  ttlSeconds: number;
}

interface RankableNotification {
  notification: Notification;
  outcome: NotificationOutcome;
  updatedAt: string;
}

function toRankable(notification: Notification): RankableNotification | null {
  const outcome = classifyNotificationCategory(notification.category);
  if (!outcome) return null;
  return { notification, outcome, updatedAt: notification.updatedAt };
}

export function composeWebPushPayload(
  notification: Notification,
  pending: readonly Notification[] = [notification],
  /** The sending Station's environment id, carried in the link. */
  stationId?: string,
): ComposedWebPush | null {
  const rankable = pending
    .map(toRankable)
    .filter((entry): entry is RankableNotification => entry !== null);
  const [lead] = rankNotificationContent(rankable);
  if (!lead) return null;

  return {
    payload: {
      title: osNotificationTitle(lead.notification.title),
      body: osNotificationBody(lead.notification.body),
      category: lead.notification.category,
      notificationId: lead.notification.id,
      url: notificationOpenLink(lead.notification, stationId),
    },
    ttlSeconds: Math.round(NOTIFICATION_TTL_MS[lead.outcome] / 1000),
  };
}
