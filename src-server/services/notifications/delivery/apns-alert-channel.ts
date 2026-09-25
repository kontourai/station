/**
 * ApnsAlertChannel (#2589): the `apns-alert` DeliveryChannel. Sends a
 * decided delivery to an iPhone as a regular APNs alert push through the
 * Kontour push gateway (`POST {gateway}/v1/apns/alert`, Station-signed like
 * every other gateway request).
 *
 * - Dormant until a phone sends one: only iOS registrations that carry an
 *   `alertToken` (the app's APNs device token) are listed, so a Station
 *   whose phones registered without one never plans this channel.
 * - Fixed text only: the gateway chooses the visible title and body from a
 *   fixed vocabulary by `kind` (attention, failed, done, or hidden), so no
 *   notification or agent-authored text reaches APNs in clear. The
 *   notification's own title and body travel sealed to the phone (AES-GCM
 *   under the registration's payload key, AAD
 *   `NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX` + registrationId) for the
 *   Notification Service Extension (#2590) to open. Until that extension
 *   exists the fixed text is what shows.
 * - hideContent: `kind: 'hidden'` or, for attention and failures,
 *   `'hidden-urgent'`: the same generic text either way, and the sealed
 *   payload carries no title or body, so a future extension cannot reveal
 *   what the surface asked to hide. Urgency (sound, priority) is decided by
 *   the notification's urgency alone; hiding content never quiets it.
 * - What the Live Activity card already alerts on (`isCardAlerted`:
 *   orchestration approvals, the registry twin of a Station-agent approval,
 *   and finished, stopped and failed orchestration turns) is not carried,
 *   unconditionally: with Live Activities off on the phone those raise no
 *   alert (the inbox keeps them). Other registry approvals are not on the
 *   card, so they are carried.
 * - Retract: not supported (`capabilities.retract: false`). APNs has no call
 *   that removes a delivered notification; only code on the phone can
 *   (`removeDeliveredNotifications`), which needs the app to run: a
 *   background push is throttled and never reaches a force-quit app, and a
 *   Notification Service Extension only rewrites the push it receives. The
 *   one server-side lever is `apns-collapse-id`: each push carries a hash of
 *   the Station and notification id, so a later push for the same
 *   notification (a content edit the router re-delivers) replaces the shown
 *   one instead of stacking. Replacing a read notification with a quiet
 *   "handled" push was rejected: it re-posts to the lock screen to say
 *   there is nothing to see.
 * - Info-level notifications are not carried either: fixed text for them
 *   would say nothing, and the policy's per-surface `minUrgency` still
 *   applies to the rest.
 * - A 410 `unregistered` drops the alert token only (the registration and
 *   its Live Activity stay), and only while it is still the token sent to.
 *   Never throws: every failure is caught and logged without the token.
 */
import { createHash } from 'node:crypto';
import { NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX } from '@kontourai/station-contracts/native-push';
import type {
  Notification,
  NotificationEnvelopeV1,
  NotificationUrgency,
} from '@kontourai/station-contracts/notification';
import { errorMessage } from '../../../utils/error-message.js';
import { sealAgentActivityCard } from '../agent-activity-seal.js';
import type {
  NativePushIosRegistration,
  NativePushRegistration,
} from '../native-push-registration-store.js';
import type { PushSigningKey } from '../push-signing-key-store.js';
import { isCardAlerted } from './card-alerted-categories.js';
import {
  type ChannelTarget,
  type DeliveryChannel,
  type DeliveryOutcome,
  deviceSurfaceId,
  type SurfaceId,
} from './channel.js';

/** The gateway's fixed-text vocabulary (deploy/push-gateway apns-request.ts). */
export type ApnsAlertKind =
  | 'attention'
  | 'failed'
  | 'done'
  | 'hidden'
  | 'hidden-urgent';

/** What sounds and goes out at once; the gateway derives both from `kind`. */
const URGENT: ReadonlySet<NotificationUrgency> = new Set([
  'attention',
  'failed',
]);

const KIND_BY_URGENCY: Partial<Record<NotificationUrgency, ApnsAlertKind>> = {
  attention: 'attention',
  failed: 'failed',
  done: 'done',
};

/** `POST /v1/apns/alert`: exactly these keys (the gateway refuses others). */
export interface ApnsAlertGatewayRequest {
  bundleId: NativePushIosRegistration['packageName'];
  environment: NativePushIosRegistration['apnsEnvironment'];
  deviceToken: string;
  registrationId: string;
  kind: ApnsAlertKind;
  collapseId: string;
  sealed: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TITLE_CHARS = 200;
const MAX_BODY_CHARS = 1_000;
/** Sealed, this stays under the gateway's 3000-character limit. */
const MAX_PLAINTEXT_BYTES = 2_000;

export interface ApnsAlertDevicePairing {
  /** Joined against active devices; an unreadable file is reported. */
  listNativePushRegistrationsByPlatform(): {
    registrations: Array<{
      deviceId: string;
      registration: NativePushRegistration;
    }>;
    unreadable: Array<{ platform: 'android' | 'ios'; error: unknown }>;
  };
  clearNativePushAlertToken(
    deviceId: string,
    expectedAlertToken: string,
  ): unknown;
  environmentId(): string;
}

export interface ApnsAlertChannelOptions {
  devicePairing: ApnsAlertDevicePairing;
  signingKey: { read(): PushSigningKey | null };
  gateway: { alertUrl: string; audience: string };
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  fetchImpl?: typeof fetch;
  now?: () => number;
}

type IosWithAlert = NativePushIosRegistration & { alertToken: string };

export class ApnsAlertChannel implements DeliveryChannel {
  readonly kind = 'apns-alert' as const;
  readonly capabilities = {
    retract: false,
    sealed: true,
    wakesClosedApp: true,
  };
  /** Registrations as of the last `registrations()`, by device id. */
  #registrations = new Map<string, IosWithAlert>();
  readonly #options: ApnsAlertChannelOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: ApnsAlertChannelOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
    this.#now = options.now ?? Date.now;
  }

  accepts(notification: Notification, envelope: NotificationEnvelopeV1) {
    return (
      KIND_BY_URGENCY[envelope.urgency] !== undefined &&
      !isCardAlerted(notification)
    );
  }

  registrations(): Array<{ surface: SurfaceId; ref: string }> {
    let listing: ReturnType<
      ApnsAlertDevicePairing['listNativePushRegistrationsByPlatform']
    >;
    try {
      listing =
        this.#options.devicePairing.listNativePushRegistrationsByPlatform();
    } catch (error) {
      this.#options.logger.warn('apns-alert: failed to list registrations', {
        error: errorMessage(error),
      });
      this.#registrations = new Map();
      return [];
    }
    if (listing.unreadable.some(({ platform }) => platform === 'ios'))
      this.#options.logger.warn(
        'apns-alert: iOS registrations are unreadable; no alerts',
      );
    this.#registrations = new Map();
    for (const { deviceId, registration } of listing.registrations)
      if (registration.platform === 'ios' && registration.alertToken)
        this.#registrations.set(deviceId, registration as IosWithAlert);
    return [...this.#registrations.keys()].map((deviceId) => ({
      surface: deviceSurfaceId(deviceId),
      ref: deviceId,
    }));
  }

  async deliver(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]> {
    let key: PushSigningKey | null;
    let stationId: string;
    try {
      key = this.#options.signingKey.read();
      stationId = this.#options.devicePairing.environmentId();
    } catch (error) {
      this.#options.logger.warn('apns-alert: push signing key unreadable', {
        error: errorMessage(error),
      });
      return to.map(({ ref }) => ({ ref, result: 'retry' }));
    }
    // A registration exists only after its key was created; without one
    // there is nothing any phone would accept.
    if (!key)
      return to.map(({ ref }) => ({ ref, result: 'rejected' as const }));
    const signingKey = key;
    return Promise.all(
      to.map((target) =>
        this.#deliverOne(notification, envelope, target, signingKey, stationId),
      ),
    );
  }

  async #deliverOne(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    target: ChannelTarget,
    key: PushSigningKey,
    stationId: string,
  ): Promise<DeliveryOutcome> {
    const { ref } = target;
    const registration = this.#registrations.get(ref);
    if (!registration) return { ref, result: 'gone' };
    const kind = apnsAlertKind(envelope.urgency, target.hideContent);
    if (!kind) return { ref, result: 'rejected' };
    // The phone pins the key it was registered under; a push signed by
    // another would fail its check. The publisher drops such registrations.
    if (registration.stationKey !== key.thumbprint)
      return { ref, result: 'rejected' };
    let request: ApnsAlertGatewayRequest;
    try {
      request = {
        bundleId: registration.packageName,
        environment: registration.apnsEnvironment,
        deviceToken: registration.alertToken,
        registrationId: registration.registrationId,
        kind,
        collapseId: apnsAlertCollapseId(stationId, notification.id),
        sealed: sealAgentActivityCard({
          plaintext: composeApnsAlertPlaintext({
            stationId,
            notification,
            urgency: envelope.urgency,
            hideContent: target.hideContent,
            now: this.#now(),
          }),
          payloadKey: registration.payloadKey,
          registrationId: registration.registrationId,
          aadPrefix: NATIVE_PUSH_ALERT_SEALED_AAD_PREFIX,
        }),
      };
    } catch (error) {
      this.#options.logger.warn('apns-alert: alert not sealed', {
        error: errorMessage(error),
      });
      return { ref, result: 'rejected' };
    }
    return this.#send(ref, request, registration.alertToken, key);
  }

  async #send(
    deviceId: string,
    request: ApnsAlertGatewayRequest,
    alertToken: string,
    key: PushSigningKey,
  ): Promise<DeliveryOutcome> {
    const bytes = Buffer.from(JSON.stringify(request), 'utf8');
    let status: number;
    let result: unknown;
    try {
      const authorization = `Station ${key.signRequest(bytes, {
        audience: this.#options.gateway.audience,
        nowMs: this.#now(),
      })}`;
      const response = await this.#fetch(this.#options.gateway.alertUrl, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: bytes,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      const text = await response.text().catch(() => '');
      try {
        result = (JSON.parse(text) as { result?: unknown } | null)?.result;
      } catch {}
    } catch (error) {
      this.#options.logger.warn('apns-alert: gateway request failed', {
        error: errorMessage(error),
      });
      return { ref: deviceId, result: 'retry' };
    }
    if (status >= 200 && status < 300) return { ref: deviceId, result: 'sent' };
    this.#options.logger.warn('apns-alert: gateway did not accept an alert', {
      status,
    });
    if (status === 410 && result === 'unregistered') {
      try {
        this.#options.devicePairing.clearNativePushAlertToken(
          deviceId,
          alertToken,
        );
      } catch (error) {
        this.#options.logger.warn('apns-alert: failed to drop a dead token', {
          error: errorMessage(error),
        });
      }
      this.#registrations.delete(deviceId);
      return { ref: deviceId, result: 'gone' };
    }
    // A 410 naming nothing is not guessed at; 401 can be transient.
    if (status === 410 || status === 401 || status === 429 || status >= 500)
      return { ref: deviceId, result: 'retry' };
    return { ref: deviceId, result: 'rejected' };
  }
}

/**
 * The gateway kind for a notification: its urgency's own kind, or with
 * hideContent the neutral text at the same urgency. Undefined for urgencies
 * this channel does not carry.
 */
function apnsAlertKind(
  urgency: NotificationUrgency,
  hideContent: boolean,
): ApnsAlertKind | undefined {
  const kind = KIND_BY_URGENCY[urgency];
  if (!kind || !hideContent) return kind;
  return URGENT.has(urgency) ? 'hidden-urgent' : 'hidden';
}

/**
 * The same id for every push about one notification from one Station, so
 * the phone shows only the newest: base64url SHA-256, 43 characters.
 */
export function apnsAlertCollapseId(
  stationId: string,
  notificationId: string,
): string {
  return createHash('sha256')
    .update(`station-alert:${stationId}:${notificationId}`)
    .digest('base64url');
}

/**
 * The sealed notification: one JSON object of strings. `title` and `body`
 * are left out when the surface hides content, and shortened (body first)
 * to keep the plaintext within {@link MAX_PLAINTEXT_BYTES}.
 */
export function composeApnsAlertPlaintext(input: {
  stationId: string;
  notification: Pick<Notification, 'id' | 'title' | 'body'>;
  urgency: NotificationUrgency;
  hideContent: boolean;
  now: number;
}): string {
  const base: Record<string, string> = {
    user_id: input.stationId,
    notification_id: input.notification.id,
    urgency: input.urgency,
    issued_at: String(input.now),
  };
  if (input.hideContent) return JSON.stringify(base);
  let title = clip(input.notification.title ?? '', MAX_TITLE_CHARS);
  let body = clip(input.notification.body ?? '', MAX_BODY_CHARS);
  const compose = () =>
    JSON.stringify({ ...base, title, ...(body ? { body } : {}) });
  let plaintext = compose();
  while (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    if (body) body = clip(body, Math.floor([...body].length / 2) - 1);
    else if (title) title = clip(title, Math.floor([...title].length / 2) - 1);
    else break;
    plaintext = compose();
  }
  return plaintext;
}

/** At most `max` code points; an ellipsis marks a cut. */
function clip(value: string, max: number): string {
  const points = [...value];
  if (points.length <= max) return value;
  return max <= 0 ? '' : `${points.slice(0, max - 1).join('')}…`;
}
