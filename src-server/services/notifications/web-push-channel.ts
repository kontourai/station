/**
 * WebPushChannel — the Web Push `DeliveryChannel` (#2586): turns a pushable
 * notification delivery (archive#1100: approval/input requests and failures
 * — `classifyNotificationCategory`) into a Web Push send to each paired
 * device the delivery router targets. The router decides who and when
 * (audience, focus, quiet hours, mute, `interrupt: 'silent'`); this channel
 * only sends. It replaces the pre-#2586 `wireWebPushDelivery` listener,
 * which fanned every classified notification out to every subscribed
 * device.
 *
 * Structural degradation guarantee: a push failure must never propagate into
 * notification delivery (the in-app SSE/toast path is completely unaffected).
 * Every layer here — the subscription listing, the per-device send, and
 * the self-heal clear — is independently caught (the router catches the
 * rest), and a subscription answering
 * 404/410 (browser revoked it, uninstalled, etc.) self-heals by clearing it
 * from the paired-device record rather than retrying forever.
 *
 * Payload composition (title/body/deep-link/TTL) is delegated to
 * `composeWebPushPayload` (`push-payload-composer.ts`), which ranks,
 * per-state-TTLs, and deep-links per archive#1100's design. This channel
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
  WebPushSubscription,
} from '@kontourai/station-contracts';
import { type NotificationEnvelopeV1 } from '@kontourai/station-contracts/notification';
import { classifyNotificationCategory } from '@kontourai/station-shared/notification-priority';
import { webPushSends } from '../../telemetry/metrics.js';
import { errorMessage } from '../../utils/error-message.js';
import {
  type ChannelTarget,
  type DeliveryChannel,
  type DeliveryOutcome,
  deviceSurfaceId,
  type SurfaceId,
} from './delivery/channel.js';
import { composeWebPushPayload } from './push-payload-composer.js';
import type { WebPushPayload, WebPushService } from './web-push-service.js';

/** The subset of DevicePairingService this channel needs. */
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

/** Generic copy for a surface that asked to hide notification content. */
const HIDDEN_TITLE = 'Station';
const HIDDEN_BODY = 'You have a new notification';

export class WebPushChannel implements DeliveryChannel {
  readonly kind = 'web-push' as const;
  // RFC 8291 encrypts end to end, but nothing can take a shown push back:
  // the service worker closes a stale one by tag when it next runs.
  readonly capabilities = {
    retract: false,
    sealed: true,
    wakesClosedApp: true,
  };
  /** Subscriptions as of the last `registrations()`, by device id. */
  #subscriptions = new Map<string, WebPushSubscription>();

  constructor(
    private readonly devicePairing: WebPushDeliveryDevicePairing,
    private readonly webPushService: Pick<WebPushService, 'send'>,
    private readonly logger: WebPushDeliveryLogger,
  ) {}

  /** Only categories the composer can rank: the ones Web Push has always carried. */
  accepts(notification: Notification): boolean {
    return classifyNotificationCategory(notification.category) !== undefined;
  }

  registrations(): Array<{ surface: SurfaceId; ref: string }> {
    let subscriptions: Array<{
      deviceId: string;
      subscription: WebPushSubscription;
    }>;
    try {
      subscriptions = this.devicePairing.listPushSubscriptions();
    } catch (error) {
      this.logger.warn('web-push: failed to list push subscriptions', {
        error: errorMessage(error),
      });
      this.#subscriptions = new Map();
      return [];
    }
    this.#subscriptions = new Map(
      subscriptions.map(({ deviceId, subscription }) => [
        deviceId,
        subscription,
      ]),
    );
    return subscriptions.map(({ deviceId }) => ({
      surface: deviceSurfaceId(deviceId),
      ref: deviceId,
    }));
  }

  async deliver(
    notification: Notification,
    _envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]> {
    const composed = composeWebPushPayload(notification);
    if (!composed) return to.map(({ ref }) => ({ ref, result: 'suppressed' }));
    const { payload, ttlSeconds } = composed;
    return Promise.all(
      to.map(
        async ({ ref: deviceId, hideContent }): Promise<DeliveryOutcome> => {
          const subscription = this.#subscriptions.get(deviceId);
          if (!subscription) return { ref: deviceId, result: 'suppressed' };
          try {
            const result = await this.webPushService.send(
              subscription,
              hideContent ? hiddenPayload(payload) : payload,
              ttlSeconds,
            );
            webPushSends.add(1, { result });
            if (result === 'gone') {
              try {
                this.devicePairing.clearPushSubscription(deviceId);
              } catch (error) {
                this.logger.warn(
                  'web-push: failed to self-heal gone subscription',
                  { error: errorMessage(error) },
                );
              }
              return { ref: deviceId, result: 'gone' };
            }
            return {
              ref: deviceId,
              result: result === 'sent' ? 'sent' : 'retry',
            };
          } catch (error) {
            // WebPushService.send() is itself never-throwing, but a bug there
            // must still never take down the fan-out or notification delivery.
            webPushSends.add(1, { result: 'error' });
            this.logger.warn('web-push: send failed unexpectedly', {
              error: errorMessage(error),
            });
            return { ref: deviceId, result: 'retry' };
          }
        },
      ),
    );
  }
}

function hiddenPayload(payload: WebPushPayload): WebPushPayload {
  const { body: _body, ...rest } = payload;
  return { ...rest, title: HIDDEN_TITLE, body: HIDDEN_BODY };
}
