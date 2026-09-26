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
 *   its retract, the phone drops it (`created_at` history). The router
 *   records a delivery when it plans it, not when a send happens, so the
 *   channel keeps, per phone, the ids it DROPPED without ever taking a
 *   version of them for sending in this process: an `info` alert dropped at
 *   the queue cap, or a waiting alert a retract removed. A retract for such
 *   an id is not sent (the phone never got it). Every other retract is
 *   sent, including one for an id this process has never seen (after a
 *   restart). An id leaves the set when a version of it is taken for
 *   sending. Per phone, at most {@link TRACKED_IDS_PER_PHONE} dropped ids
 *   and as many ids taken for sending are kept (oldest forgotten first); a
 *   phone's sets are forgotten the next time registrations are listed (on
 *   every routed notification) after it has no Android registration; a
 *   listing that could not read the Android registrations forgets nothing,
 *   so a transient read failure does not turn sent alerts unretractable. A
 *   retract for an alert still waiting removes that alert; it is still sent
 *   when an earlier version of the id was taken for sending. A retract that
 *   empties the queue gives the floor slot its drain was waiting for back.
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
 * - Notifications the card already alerts for (an orchestration session's
 *   approval, or its finished, stopped or failed turn; see
 *   `isCardAlerted`) are not carried, so one event never raises two alerts
 *   on the same phone. Registry approvals are carried.
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

/** Ids remembered per phone as dropped, and as taken for sending. */
const TRACKED_IDS_PER_PHONE = 256;
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
 * Whether the agent-activity card already announces this notification, so
 * this channel skips it and one event is not alerted twice on a phone.
 *
 * MIRROR of `isCardAlerted` in
 * `src-server/services/notifications/delivery/card-alerted-categories.ts`
 * (#2589, the iOS alert channel); the two are to be unified at merge. Same
 * rule: the card is built from orchestration sessions only and alerts on an
 * approval or input entry and a finished, stopped or failed turn, so a
 * record is card-alerted only when its category is one of those AND the
 * record itself says it is about an orchestration session
 * (`metadata.sessionKind === 'runtime'` with a `metadata.sessionId`, and
 * `metadata.requestKind`, when present, is `'orchestration'`). A registry
 * approval (`sessionKind: 'managed'`, `requestKind: 'registry'`) never
 * appears on the card and must still alert; so does anything the record
 * does not identify as orchestration-backed (a duplicate beats a silenced
 * alert).
 */
const CARD_ALERTED_CATEGORIES: ReadonlySet<string> = new Set([
  'approval-request',
  'turn-completed',
  'turn-stopped',
  'turn-failed',
]);

function isCardAlerted(
  notification: Pick<Notification, 'category' | 'metadata'>,
): boolean {
  if (!CARD_ALERTED_CATEGORIES.has(notification.category)) return false;
  const { sessionKind, sessionId, requestKind } = (notification.metadata ??
    {}) as Record<string, unknown>;
  return (
    sessionKind === 'runtime' &&
    typeof sessionId === 'string' &&
    sessionId.length > 0 &&
    (requestKind === undefined || requestKind === 'orchestration')
  );
}

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
  /** Per phone: ids dropped with no version ever taken for sending. */
  readonly #dropped = new Map<string, Set<string>>();
  /** Per phone: ids a version of which was taken for sending. */
  readonly #taken = new Map<string, Set<string>>();
  /** Per phone: the floor slot its drain holds while it waits for it. */
  readonly #reserved = new Map<string, { slot: number; before?: number }>();

  constructor(options: FcmAlertChannelOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#sleep = options.sleep ?? defaultSleep;
  }

  accepts(notification: Notification): boolean {
    if (isCardAlerted(notification)) return false;
    return (
      readNotificationEnvelope(notification) !== undefined ||
      classifyNotificationCategory(notification.category) !== undefined
    );
  }

  registrations(): Array<{ surface: SurfaceId; ref: string }> {
    const android = this.#android();
    // Unreadable: no surfaces now, and nothing is known to be unregistered.
    if (!android) return [];
    // A phone no longer registered keeps no bookkeeping (unpaired, cleared).
    const live = new Set(android.map(({ deviceId }) => deviceId));
    for (const sets of [this.#dropped, this.#taken])
      for (const deviceId of [...sets.keys()])
        if (!live.has(deviceId)) sets.delete(deviceId);
    return android.map(({ deviceId }) => ({
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
    if (send.content.kind === 'retract') {
      const waiting = index >= 0 ? existing?.[index] : undefined;
      if (existing && waiting?.content.kind === 'alert') {
        // The waiting alert is not sent.
        existing.splice(index, 1);
        waiting.resolve('suppressed');
        if (!this.#has(this.#taken, deviceId, send.id))
          this.#remember(this.#dropped, deviceId, send.id);
        if (existing.length === 0) this.#releaseSlot(deviceId);
      }
      if (this.#has(this.#dropped, deviceId, send.id)) {
        // No version of it ever reached the phone: nothing to take back.
        send.resolve('suppressed');
        return;
      }
    }
    let queue = this.#queues.get(deviceId);
    const draining = queue !== undefined;
    if (!queue) {
      queue = [];
      this.#queues.set(deviceId, queue);
    }
    const at = queue.findIndex((pending) => pending.id === send.id);
    if (at >= 0) {
      // The newer send for this id takes the older one's place.
      queue[at]?.resolve('suppressed');
      queue[at] = send;
    } else queue.push(send);
    while (queue.length > MAX_PENDING_PER_PHONE) {
      const oldestInfo = queue.findIndex(
        (pending) =>
          pending.content.kind === 'alert' &&
          pending.content.urgency === 'info',
      );
      if (oldestInfo < 0) break;
      const [dropped] = queue.splice(oldestInfo, 1);
      if (!dropped) break;
      dropped.resolve('suppressed');
      if (!this.#has(this.#taken, deviceId, dropped.id))
        this.#remember(this.#dropped, deviceId, dropped.id);
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

  #has(sets: Map<string, Set<string>>, deviceId: string, id: string) {
    return sets.get(deviceId)?.has(id) === true;
  }

  /** Adds an id to a phone's bounded set, newest last. */
  #remember(sets: Map<string, Set<string>>, deviceId: string, id: string) {
    let ids = sets.get(deviceId);
    if (!ids) {
      ids = new Set();
      sets.set(deviceId, ids);
    }
    ids.delete(id);
    ids.add(id);
    while (ids.size > TRACKED_IDS_PER_PHONE) {
      const oldest = ids.values().next().value;
      if (oldest === undefined) break;
      ids.delete(oldest);
    }
  }

  /** A version of this id is going to the phone: a retract for it is due. */
  #markTaken(deviceId: string, send: PendingSend): void {
    this.#dropped.get(deviceId)?.delete(send.id);
    if (send.content.kind === 'alert')
      this.#remember(this.#taken, deviceId, send.id);
  }

  /**
   * Nothing is left to send: give back the slot the drain is waiting for,
   * so the card is not held back by a send that will not happen.
   */
  #releaseSlot(deviceId: string): void {
    const held = this.#reserved.get(deviceId);
    if (!held) return;
    this.#reserved.delete(deviceId);
    this.#options.sendFloor.release(deviceId, held.slot, held.before);
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
          // A retract may have emptied the queue meanwhile.
          if (queue.length === 0) break;
        }
        const before = floor.lastSendAt(deviceId);
        const slot = floor.reserve(deviceId, this.#now());
        this.#reserved.set(deviceId, {
          slot,
          ...(before === undefined ? {} : { before }),
        });
        const wait = slot - this.#now();
        if (wait > 0) await this.#sleep(wait);
        // Released while waiting (the queue emptied): reserve afresh for
        // anything queued since.
        if (this.#reserved.get(deviceId)?.slot !== slot) continue;
        this.#reserved.delete(deviceId);
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
      this.#reserved.delete(deviceId);
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
    } catch (error) {
      this.#options.logger.warn(
        'fcm-alert: push key unavailable; not sending',
        { error: errorMessage(error) },
      );
      return 'retry';
    }
    const registration = this.#android()?.find(
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
    const registration = this.#android()?.find(
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

  /**
   * The Android registrations, or undefined when they could not be read
   * (the listing threw, or reported the Android file unreadable): unknown,
   * not "none".
   */
  #android():
    | Array<{
        deviceId: string;
        registration: NativePushAndroidRegistration;
      }>
    | undefined {
    try {
      const { registrations, unreadable } =
        this.#options.devicePairing.listNativePushRegistrationsByPlatform();
      const failed = unreadable.find(({ platform }) => platform === 'android');
      if (failed) throw failed.error;
      return registrations.flatMap(({ deviceId, registration }) =>
        registration.platform === 'android' ? [{ deviceId, registration }] : [],
      );
    } catch (error) {
      this.#options.logger.warn('fcm-alert: registrations are unreadable', {
        error: errorMessage(error),
      });
      return undefined;
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
