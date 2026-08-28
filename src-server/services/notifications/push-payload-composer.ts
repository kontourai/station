/**
 * composeWebPushPayload — archive#1100: builds the Web Push payload (title,
 * body, deep-link url) and the Web Push protocol TTL (seconds, RFC 8030)
 * from one or more pushable notifications, following the attention-ranked,
 * outcome-first design:
 *
 * - Ranking (AC1): when `pending` carries more than one candidate, the
 *   highest-outcome-priority one leads the payload (approval/input > failed
 *   > running > done — `@kontourai/station-shared/notification-priority`),
 *   ties broken by most-recently-updated. `wireWebPushDelivery`'s live call
 *   site always supplies a single-item `pending` (the notification that
 *   just fired) — see that module's header comment for why deliberately not
 *   re-ranking across everything currently pending — but the composer stays
 *   ready for a real batched-summary surface without a rewrite.
 * - TTL (AC2): sized per the lead notification's outcome tier
 *   (`NOTIFICATION_TTL_MS`), returned in seconds for `web-push`'s
 *   `options.TTL`.
 * - Deep link (AC3): resolves the lead notification's exact-session
 *   `openHref` the same way `AttentionProjectionService`'s approval
 *   projection does (`resolveNotificationOpenHref`), falling back to the
 *   generic attention inbox (`/notifications`) when metadata doesn't carry
 *   enough to resolve one — the same fallback
 *   `docs/guides/web-push-notifications.md`'s manual checklist documents.
 *
 * Returns `null` when nothing in `pending` classifies to a known outcome
 * (defensive — `wireWebPushDelivery` already filters before calling this).
 */
import type { Notification } from '@kontourai/station-contracts/notification';
import {
  classifyNotificationCategory,
  NOTIFICATION_TTL_MS,
  type NotificationOutcome,
  rankNotificationContent,
} from '@kontourai/station-shared/notification-priority';
import { resolveNotificationOpenHref } from './notification-deep-link.js';
import type { WebPushPayload } from './web-push-service.js';

const NOTIFICATIONS_DEEP_LINK = '/notifications';

export interface ComposedWebPush {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function composeWebPushPayload(
  notification: Notification,
  pending: readonly Notification[] = [notification],
): ComposedWebPush | null {
  const rankable = pending
    .map(toRankable)
    .filter((entry): entry is RankableNotification => entry !== null);
  const [lead] = rankNotificationContent(rankable);
  if (!lead) return null;

  const metadata = lead.notification.metadata ?? {};
  const sessionId =
    stringValue(metadata.sessionId) ?? stringValue(metadata.conversationId);
  const sessionKind = stringValue(metadata.sessionKind);
  const url =
    resolveNotificationOpenHref(metadata, sessionId, sessionKind) ??
    NOTIFICATIONS_DEEP_LINK;

  return {
    payload: {
      title: lead.notification.title,
      body: lead.notification.body,
      category: lead.notification.category,
      notificationId: lead.notification.id,
      url,
    },
    ttlSeconds: Math.round(NOTIFICATION_TTL_MS[lead.outcome] / 1000),
  };
}
