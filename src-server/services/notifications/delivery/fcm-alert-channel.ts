/**
 * FcmAlertChannel (#2588): the `fcm-alert` DeliveryChannel. Sends a
 * notification the router decided to deliver to an Android phone as a
 * sealed `station_notification` FCM data message, through the same Kontour
 * push gateway, registration and payload key as the agent-activity card
 * (docs/design/notification-delivery.md, "Station contract"). The phone
 * renders it natively (`StationNotifications.kt`), so it arrives with the
 * app closed.
 *
 * - The router decides who and when; this channel only sends. A surface is
 *   a paired device with an Android native push registration, which only a
 *   personal-family device that turned agent activity on holds; the router
 *   still limits it to the record's audience (and to devices that can read
 *   the session it names).
 * - Sealed to the registration's payload key under
 *   `station-notification:v1:<registrationId>`: the gateway and Google see
 *   only routing data and a priority. No collapse key: FCM keeps only four
 *   per offline or dozing device and silently drops the rest, which would
 *   lose alerts and retracts; the phone orders deliveries itself.
 *   `hideContent` replaces the title and body with generic copy before
 *   sealing, so the notification's own text is never sent at all.
 * - Retract: a read or dismiss elsewhere sends a `retract` for the same id,
 *   which cancels the phone's notification. If FCM delivers the alert after
 *   its retract, the phone drops it (`created_at` history). Only an id this
 *   channel actually sent to that phone is retracted (the router records a
 *   delivery when it plans it, not when a send happens): the last
 *   {@link SENT_IDS_PER_PHONE} ids taken for sending are remembered per
 *   phone, and a retract for any other id is not sent. A retract for an
 *   alert still waiting in the queue just removes it.
 * - Paced: shares the per-phone send floor with the agent-activity card
 *   (`native-push-send-floor.ts`). Each phone has one queue of waiting
 *   sends, drained one floor slot at a time:
 *   - what a send says is fixed when it is queued: the title and body (after
 *     the hide-content choice), the urgency, and the session reference. The
 *     rest happens when its slot comes: the push key and registration are
 *     read, `created_at` / `expires_at` are stamped, and it is sealed. A
 *     newer send for an id replaces the waiting one in its place in the
 *     queue;
 *   - a floor slot is taken only for a phone that can be sent to (a
 *     registration pinned to the current push key), so a phone that cannot
 *     receive is never paced;
 *   - at most {@link MAX_PENDING_PER_PHONE} sends wait; past that the
 *     oldest waiting `info` alert is dropped and logged. Attention, failed
 *     and done alerts and retracts are never dropped (the router only
 *     sends those as people's own notifications arrive, so they stay
 *     bounded by what happened);
 *   - once the card, with an update still waiting, has been held back by
 *     these slots `CARD_YIELD_AFTER` times, the queue leaves the next slot
 *     free for it.
 * - No retry: a retryable gateway answer is reported as `retry` and logged,
 *   like Web Push. A 410 clears the registration, as the publisher does.
 * - Session lifecycle categories the card already alerts for (an approval,
 *   a finished or failed turn) are not carried, so one event never raises
 *   two alerts on the same phone.
 */
import {
  isNativePushSessionReference,
  type NativePushNotificationData,
  type NativePushNotificationPlaintext,
} from '@kontourai/station-contracts/native-push';
import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { classifyNotificationCategory } from '@kontourai/station-shared/notification-priority';
import { errorMessage } from '../../../utils/error-message.js';
import type { PushGatewayConfig } from '../agent-activity-publisher.js';
import { sealStationNotification } from '../agent-activity-seal.js';
import type {
  NativePushAndroidRegistration,
  NativePushRegistration,
} from '../native-push-registration-store.js';
import {
  NATIVE_PUSH_MIN_SEND_INTERVAL_MS,
  type NativePushSendFloor,
} from '../native-push-send-floor.js';
import { notificationSessionIdentity } from '../notification-session.js';
import type { PushSigningKey } from '../push-signing-key-store.js';
import {
  type ChannelTarget,
  type DeliveryChannel,
  type DeliveryOutcome,
  deviceSurfaceId,
  type SurfaceId,
} from './channel.js';

/** Notification ids remembered per phone as sent, for retracts. */
const SENT_IDS_PER_PHONE = 256;
/** Waiting sends per phone before `info` alerts are dropped. */
const MAX_PENDING_PER_PHONE = 8;
/** How long a sent alert may still be shown; the gateway's FCM TTL matches. */
export const FCM_ALERT_LIFETIME_MS = 60 * 60_000;
/**
 * The sealed plaintext's budget, as for the card: base64url and the routing
 * fields must stay under the gateway's 3800-byte data limit.
 */
const MAX_PLAINTEXT_BYTES = 2500;
const TITLE_MAX_CHARS = 120;
const BODY_MAX_CHARS = 600;
const REQUEST_TIMEOUT_MS = 10_000;
/** Generic copy for a surface that asked to hide notification content. */
const HIDDEN_TITLE = 'Station';
const HIDDEN_BODY = 'You have a new notification';

/**
 * Categories the agent-activity card already raises its own alert for
 * (approval and input entries, finished and failed turns).
 */
const CARD_ALERTED_CATEGORIES = new Set([
  'approval-request',
  'turn-completed',
  'turn-stopped',
  'turn-failed',
]);

export interface FcmAlertDevicePairing {
  listNativePushRegistrationsByPlatform(): {
    registrations: Array<{
      deviceId: string;
      registration: NativePushRegistration;
    }>;
    unreadable: Array<{ platform: 'android' | 'ios'; error: unknown }>;
  };
  clearNativePush(deviceId: string, expectedToken?: string): unknown;
  environmentId(): string;
}

export interface FcmAlertChannelOptions {
  devicePairing: FcmAlertDevicePairing;
  signingKey: { read(): PushSigningKey | null };
  gateway: Pick<PushGatewayConfig, 'sendUrl' | 'audience'>;
  sendFloor: NativePushSendFloor;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Tests: replaces the unref'd wait for a floor slot. */
  sleep?: (ms: number) => Promise<void>;
}

type SendResult = DeliveryOutcome['result'];

type Content = Omit<
  NativePushNotificationPlaintext,
  'v' | 'user_id' | 'id' | 'created_at' | 'expires_at'
>;

/** A send waiting for its phone's next floor slot. */
interface PendingSend {
  id: string;
  content: Content;
  /** Attention and failed alerts go at high priority. */
  urgent: boolean;
  resolve(result: SendResult): void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export class FcmAlertChannel implements DeliveryChannel {
  readonly kind = 'fcm-alert' as const;
  readonly capabilities = {
    retract: true,
    sealed: true,
    wakesClosedApp: true,
  };
  readonly #options: FcmAlertChannelOptions;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  /** Waiting sends per phone; present while that phone's queue drains. */
  readonly #queues = new Map<string, PendingSend[]>();
  /** Per phone: ids taken for sending, oldest first (a bounded LRU). */
  readonly #sentIds = new Map<string, Set<string>>();

  constructor(options: FcmAlertChannelOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#sleep = options.sleep ?? defaultSleep;
  }

  accepts(notification: Notification): boolean {
    if (CARD_ALERTED_CATEGORIES.has(notification.category)) return false;
    return (
      readNotificationEnvelope(notification) !== undefined ||
      classifyNotificationCategory(notification.category) !== undefined
    );
  }

  registrations(): Array<{ surface: SurfaceId; ref: string }> {
    return this.#android().map(({ deviceId }) => ({
      surface: deviceSurfaceId(deviceId),
      ref: deviceId,
    }));
  }

  async deliver(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]> {
    const urgent =
      envelope.urgency === 'attention' || envelope.urgency === 'failed';
    const route = sessionReference(notification, envelope);
    return this.#sendAll(notification.id, to, urgent, (hideContent) => ({
      kind: 'alert',
      ...fitContent(
        hideContent ? HIDDEN_TITLE : notification.title,
        hideContent ? HIDDEN_BODY : notification.body,
      ),
      urgency: envelope.urgency,
      ...route,
    }));
  }

  async retract(notificationId: string, to: ChannelTarget[]): Promise<void> {
    await this.#sendAll(notificationId, to, false, () => ({ kind: 'retract' }));
  }

  #sendAll(
    notificationId: string,
    to: ChannelTarget[],
    urgent: boolean,
    content: (hideContent: boolean) => Content,
  ): Promise<DeliveryOutcome[]> {
    return Promise.all(
      to.map(
        ({ ref: deviceId, hideContent }) =>
          new Promise<DeliveryOutcome>((resolve) =>
            this.#enqueue(deviceId, {
              id: notificationId,
              content: content(hideContent),
              urgent,
              resolve: (result) => resolve({ ref: deviceId, result }),
            }),
          ),
      ),
    );
  }

  #enqueue(deviceId: string, send: PendingSend): void {
    const existing = this.#queues.get(deviceId);
    const index =
      existing?.findIndex((pending) => pending.id === send.id) ?? -1;
    const waitingAlert =
      index >= 0 && existing?.[index]?.content.kind === 'alert';
    if (send.content.kind === 'retract' && !this.#wasSent(deviceId, send.id)) {
      // The phone never got this id: nothing to take back. An alert for it
      // still waiting is simply not sent.
      if (existing && waitingAlert) {
        existing.splice(index, 1)[0]?.resolve('suppressed');
      }
      send.resolve('suppressed');
      return;
    }
    let queue = existing;
    const draining = queue !== undefined;
    if (!queue) {
      queue = [];
      this.#queues.set(deviceId, queue);
    }
    if (index >= 0) {
      // The newer send for this id takes the older one's place.
      queue[index]?.resolve('suppressed');
      queue[index] = send;
    } else queue.push(send);
    while (queue.length > MAX_PENDING_PER_PHONE) {
      const oldestInfo = queue.findIndex(
        (pending) =>
          pending.content.kind === 'alert' &&
          pending.content.urgency === 'info',
      );
      if (oldestInfo < 0) break;
      const [dropped] = queue.splice(oldestInfo, 1);
      dropped?.resolve('suppressed');
      this.#options.logger.warn(
        'fcm-alert: dropped a waiting info notification (too many queued for one phone)',
        { pending: queue.length },
      );
    }
    if (!draining)
      this.#drain(deviceId, queue).catch((error) => {
        this.#options.logger.warn('fcm-alert: a send queue failed', {
          error: errorMessage(error),
        });
      });
  }

  #wasSent(deviceId: string, id: string): boolean {
    return this.#sentIds.get(deviceId)?.has(id) === true;
  }

  /** An alert taken for sending is remembered; a retract forgets its id. */
  #markTaken(deviceId: string, send: PendingSend): void {
    let ids = this.#sentIds.get(deviceId);
    if (!ids) {
      ids = new Set();
      this.#sentIds.set(deviceId, ids);
    }
    ids.delete(send.id);
    if (send.content.kind === 'retract') return;
    ids.add(send.id);
    while (ids.size > SENT_IDS_PER_PHONE) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
  }

  /** Sends a phone's queue one floor slot at a time. */
  async #drain(deviceId: string, queue: PendingSend[]): Promise<void> {
    try {
      while (queue.length > 0) {
        const floor = this.#options.sendFloor;
        // A phone that cannot be sent to takes no slot.
        const refused = this.#sendability(deviceId);
        if (refused) {
          queue.shift()?.resolve(refused);
          continue;
        }
        if (floor.takeCardYield(deviceId)) {
          // Leave the next slot to the card: wait one interval past it.
          const last = floor.lastSendAt(deviceId) ?? this.#now();
          const skip =
            last + 2 * NATIVE_PUSH_MIN_SEND_INTERVAL_MS - this.#now();
          if (skip > 0) await this.#sleep(skip);
        }
        const slot = floor.reserve(deviceId, this.#now());
        const wait = slot - this.#now();
        if (wait > 0) await this.#sleep(wait);
        // Taken only now: a newer send for the same id may have replaced it.
        const next = queue.shift();
        if (!next) break;
        this.#markTaken(deviceId, next);
        let result: SendResult;
        try {
          result = await this.#sendNow(deviceId, next);
        } catch (error) {
          this.#options.logger.warn('fcm-alert: send failed unexpectedly', {
            error: errorMessage(error),
          });
          result = 'retry';
        }
        next.resolve(result);
      }
    } catch (error) {
      this.#options.logger.warn('fcm-alert: a send queue failed', {
        error: errorMessage(error),
      });
    } finally {
      this.#queues.delete(deviceId);
      const left = queue.splice(0);
      if (left.length > 0)
        this.#options.logger.warn(
          'fcm-alert: dropped waiting notifications after a queue failure',
          { dropped: left.length },
        );
      for (const send of left) send.resolve('suppressed');
    }
  }

  /** Why a phone cannot be sent to now, or undefined when it can. */
  #sendability(deviceId: string): SendResult | undefined {
    let key: PushSigningKey | null;
    try {
      key = this.#options.signingKey.read();
    } catch {
      return 'retry';
    }
    const registration = this.#android().find(
      (candidate) => candidate.deviceId === deviceId,
    )?.registration;
    return key && registration && registration.stationKey === key.thumbprint
      ? undefined
      : 'suppressed';
  }

  async #sendNow(deviceId: string, send: PendingSend): Promise<SendResult> {
    let key: PushSigningKey | null;
    let stationId: string;
    try {
      key = this.#options.signingKey.read();
      stationId = this.#options.devicePairing.environmentId();
    } catch (error) {
      this.#options.logger.warn(
        'fcm-alert: push key unavailable; not sending',
        { error: errorMessage(error) },
      );
      return 'retry';
    }
    const registration = this.#android().find(
      (candidate) => candidate.deviceId === deviceId,
    )?.registration;
    // No key, gone, or pinned to a key this Station no longer holds (the
    // phone would drop it; the publisher forgets that registration).
    if (!key || !registration || registration.stationKey !== key.thumbprint)
      return 'suppressed';
    // Stamped at the send, after any wait for the floor.
    const at = this.#now();
    const plaintext: NativePushNotificationPlaintext = {
      v: '1',
      user_id: stationId,
      id: send.id,
      ...send.content,
      created_at: String(at),
      expires_at: String(at + FCM_ALERT_LIFETIME_MS),
    };
    let bytes: Buffer;
    try {
      const data: NativePushNotificationData = {
        station_kind: 'station_notification',
        device_id: registration.registrationId,
        sealed: sealStationNotification({
          plaintext: JSON.stringify(plaintext),
          payloadKey: registration.payloadKey,
          registrationId: registration.registrationId,
        }),
      };
      bytes = Buffer.from(
        JSON.stringify({
          token: registration.token,
          packageName: registration.packageName,
          data,
          ...(send.urgent ? {} : { priority: 'normal' }),
        }),
        'utf8',
      );
    } catch (error) {
      this.#options.logger.warn('fcm-alert: could not seal a notification', {
        error: errorMessage(error),
      });
      return 'rejected';
    }
    let status: number;
    try {
      const response = await this.#fetch(this.#options.gateway.sendUrl, {
        method: 'POST',
        headers: {
          authorization: `Station ${key.signRequest(bytes, {
            audience: this.#options.gateway.audience,
            nowMs: this.#now(),
          })}`,
          'content-type': 'application/json',
        },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      status = response.status;
    } catch (error) {
      this.#options.logger.warn('fcm-alert: gateway request failed', {
        error: errorMessage(error),
      });
      return 'retry';
    }
    if (status >= 200 && status < 300) return 'sent';
    this.#options.logger.warn(
      'fcm-alert: gateway did not accept a notification',
      {
        status,
      },
    );
    if (status === 410) {
      try {
        this.#options.devicePairing.clearNativePush(
          deviceId,
          registration.token,
        );
      } catch (error) {
        this.#options.logger.warn(
          'fcm-alert: failed to clear a dead registration',
          {
            error: errorMessage(error),
          },
        );
      }
      return 'gone';
    }
    return status === 401 || status === 429 || status >= 500
      ? 'retry'
      : 'rejected';
  }

  #android(): Array<{
    deviceId: string;
    registration: NativePushAndroidRegistration;
  }> {
    try {
      const { registrations } =
        this.#options.devicePairing.listNativePushRegistrationsByPlatform();
      return registrations.flatMap(({ deviceId, registration }) =>
        registration.platform === 'android' ? [{ deviceId, registration }] : [],
      );
    } catch (error) {
      this.#options.logger.warn('fcm-alert: registrations are unreadable', {
        error: errorMessage(error),
      });
      return [];
    }
  }
}

/**
 * The session a tap opens: the one the record names (the same identity the
 * audience was limited by), unless its target is a path, which the phone
 * cannot open. Only references in the contract grammar travel.
 */
function sessionReference(
  notification: Notification,
  envelope: NotificationEnvelopeV1,
): Pick<NativePushNotificationPlaintext, 'session_id' | 'project_slug'> {
  if (envelope.target?.kind === 'path') return {};
  const sessionId = notificationSessionIdentity(notification, envelope);
  if (!isNativePushSessionReference(sessionId)) return {};
  const projectSlug = notification.metadata?.projectSlug;
  return {
    session_id: sessionId,
    ...(isNativePushSessionReference(projectSlug)
      ? { project_slug: projectSlug }
      : {}),
  };
}

/**
 * Title and body, cut to the plaintext budget: the body shortens first,
 * then the title. Cuts are by code point, so no surrogate pair is split.
 */
function fitContent(
  title: string,
  body: string | undefined,
): Pick<NativePushNotificationPlaintext, 'title' | 'body'> {
  let titleChars = [...title].slice(0, TITLE_MAX_CHARS);
  let bodyChars = [...(body ?? '')].slice(0, BODY_MAX_CHARS);
  const size = () =>
    Buffer.byteLength(
      JSON.stringify({ title: titleChars.join(''), body: bodyChars.join('') }),
      'utf8',
    );
  // Leaves room for the fixed fields (ids, times, route) around them.
  const budget = MAX_PLAINTEXT_BYTES - 700;
  while (size() > budget && bodyChars.length > 0)
    bodyChars = bodyChars.slice(0, Math.floor(bodyChars.length * 0.9));
  while (size() > budget && titleChars.length > 1)
    titleChars = titleChars.slice(0, Math.floor(titleChars.length * 0.9));
  const fittedBody = bodyChars.join('');
  return {
    title: titleChars.join(''),
    ...(fittedBody ? { body: fittedBody } : {}),
  };
}
