/**
 * wireWebPushDelivery — the decoupled EventBus subscriber that turns a
 * pushable notification delivery (station#1100: approval/input requests and
 * failures — `classifyNotificationCategory`) into a Web Push fan-out to
 * every paired device that has subscribed.
 *
 * Structural degradation guarantee: a push failure must never propagate into
 * notification delivery (the in-app SSE/toast path is completely unaffected).
 * Every layer here — the listener itself, the per-device send, and the
 * self-heal clear — is independently caught, and a subscription answering
 * 404/410 (browser revoked it, uninstalled, etc.) self-heals by clearing it
 * from the paired-device record rather than retrying forever.
 *
 * Payload composition (title/body/deep-link/TTL) is delegated to
 * `composeWebPushPayload` (`push-payload-composer.ts`), which ranks,
 * per-state-TTLs, and deep-links per station#1100's design. This listener
 * always composes from a single-item `pending` list — the notification that
 * just fired — deliberately not re-ranking against every other currently
 * pending notification: doing so could replace a fresh event's own push
 * with a stale re-announcement of an older, higher-priority-tier
 * notification still sitting unresolved (e.g. an unactioned approval from
 * an hour ago suppressing a brand-new job failure's push), which is
 * surprising/spammy behavior nothing here asked for. Ranking across
 * multiple simultaneously-pending items is proven correct at the composer
 * level (unit tests) and is ready for a real batched-summary surface should
 * one land later.
 */
import type {
  Notification,
  ServerEventName,
  WebPushSubscription,
} from '@kontourai/station-contracts';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { classifyNotificationCategory } from '@kontourai/station-shared/notification-priority';
import { webPushSends } from '../../telemetry/metrics.js';
import type { EventBus } from '../orchestration/event-bus.js';
import { composeWebPushPayload } from './push-payload-composer.js';
import type { WebPushService } from './web-push-service.js';

/** The subset of DevicePairingService this subscriber needs. */
export interface WebPushDeliveryDevicePairing {
  listPushSubscriptions(): Array<{
    deviceId: string;
    subscription: WebPushSubscription;
  }>;
  clearPushSubscription(deviceId: string): unknown;
}

interface WebPushDeliveryLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface WebPushDeliveryOptions {
  /**
   * Hosted paired-device records have no durable tenant binding. Keep their
   * delivery listener absent until subscriptions can be tenant-authorized.
   */
  enabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function wireWebPushDelivery(
  eventBus: EventBus,
  devicePairing: WebPushDeliveryDevicePairing,
  webPushService: Pick<WebPushService, 'send'>,
  logger: WebPushDeliveryLogger,
  options: WebPushDeliveryOptions = {},
): () => void {
  // Do not even subscribe in disabled mode: notification payloads (including
  // scheduler and session-completion content/ids) must not reach the global
  // pairing registry or WebPushService before subscriptions are tenant-bound.
  if (options.enabled === false) return () => {};

  async function deliver(notification: Notification): Promise<void> {
    let subscriptions: Array<{
      deviceId: string;
      subscription: WebPushSubscription;
    }>;
    try {
      subscriptions = devicePairing.listPushSubscriptions();
    } catch (error) {
      logger.warn('web-push: failed to list push subscriptions', {
        error: errorMessage(error),
      });
      return;
    }
    if (subscriptions.length === 0) return;

    const composed = composeWebPushPayload(notification);
    // Defensive only — the caller already filters to a classifiable
    // category before invoking deliver().
    if (!composed) return;
    const { payload, ttlSeconds } = composed;

    await Promise.all(
      subscriptions.map(async ({ deviceId, subscription }) => {
        try {
          const result = await webPushService.send(
            subscription,
            payload,
            ttlSeconds,
          );
          webPushSends.add(1, { result });
          if (result === 'gone') {
            try {
              devicePairing.clearPushSubscription(deviceId);
            } catch (error) {
              logger.warn('web-push: failed to self-heal gone subscription', {
                error: errorMessage(error),
              });
            }
          }
        } catch (error) {
          // WebPushService.send() is itself never-throwing, but a bug there
          // must still never take down the fan-out or notification delivery.
          webPushSends.add(1, { result: 'error' });
          logger.warn('web-push: send failed unexpectedly', {
            error: errorMessage(error),
          });
        }
      }),
    );
  }

  return eventBus.subscribe((message) => {
    // EventBus removes a listener that throws synchronously, so every path
    // out of this callback must be a caught no-throw — never just the async
    // continuation.
    try {
      const event: ServerEventName = message.event;
      if (event !== SERVER_EVENTS.NOTIFICATION_DELIVERED) return;
      const notification = message.data as unknown as Notification | undefined;
      if (
        !notification ||
        !classifyNotificationCategory(notification.category)
      ) {
        return;
      }
      void deliver(notification).catch((error) => {
        logger.warn('web-push: delivery failed unexpectedly', {
          error: errorMessage(error),
        });
      });
    } catch (error) {
      logger.warn('web-push: delivery listener failed unexpectedly', {
        error: errorMessage(error),
      });
    }
  });
}
