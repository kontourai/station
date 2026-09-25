/**
 * Delivery channels (#2582 §1b, #2586): the ways a stored notification can
 * reach a person beyond the in-app feed, which is the store's own SSE event
 * and is never suppressed.
 *
 * A surface is one place a person reads notifications: a paired device
 * (`device:<id>`) or a local operator client session
 * (`local:<clientSessionId>`). There is no new registry — each channel lists
 * its registrations from the store that already holds them.
 */
import type {
  Notification,
  NotificationEnvelopeV1,
  NotificationUrgency,
  SurfaceId,
} from '@kontourai/station-contracts/notification';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { classifyNotificationCategory } from '@kontourai/station-shared/notification-priority';

export type { SurfaceId };

export type ChannelKind =
  | 'in-app'
  | 'desktop-os'
  | 'web-push'
  | 'fcm-alert'
  | 'apns-alert';

export interface ChannelRegistration {
  kind: ChannelKind;
  ref: string;
}

export interface DeliverySurface {
  id: SurfaceId;
  deviceId?: string;
  /** Principal the surface reads as; absent when the resolver did not need it. */
  principalId?: string;
  channels: ChannelRegistration[];
}

export interface ChannelTarget {
  surface: SurfaceId;
  ref: string;
  /** The surface asked for a generic lock-screen presentation. */
  hideContent: boolean;
}

export type DeliveryOutcome = {
  ref: string;
  result: 'sent' | 'gone' | 'retry' | 'rejected' | 'suppressed';
};

export interface DeliveryChannel {
  readonly kind: ChannelKind;
  readonly capabilities: {
    retract: boolean;
    sealed: boolean;
    wakesClosedApp: boolean;
  };
  /**
   * Whether this channel carries this record at all. A channel that returns
   * false is never asked for registrations for it (web push, for example,
   * has only ever carried categories it can compose).
   */
  accepts?(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
  ): boolean;
  /**
   * Synchronous on purpose: every registration store is in memory, and the
   * router must reach `deliver` inside the bus callback's own turn.
   */
  registrations(): Array<{ surface: SurfaceId; ref: string }>;
  deliver(
    notification: Notification,
    envelope: NotificationEnvelopeV1,
    to: ChannelTarget[],
  ): Promise<DeliveryOutcome[]>;
  retract?(notificationId: string, to: ChannelTarget[]): Promise<void>;
}

const OUTCOME_URGENCY: Record<string, NotificationUrgency> = {
  'needs-input': 'attention',
  failed: 'failed',
  done: 'done',
  running: 'info',
  info: 'info',
};

/**
 * The envelope delivery acts on. A record without a valid envelope is
 * legacy: it goes to the owner at the urgency its category ranks as, with
 * nothing else invented (no agent source, no session audience).
 */
export function deliveryEnvelopeFor(notification: Notification): {
  envelope: NotificationEnvelopeV1;
  legacy: boolean;
} {
  const envelope = readNotificationEnvelope(notification);
  if (envelope) return { envelope, legacy: false };
  const outcome = classifyNotificationCategory(notification.category);
  return {
    envelope: {
      v: 1,
      source: { kind: 'system', subsystem: notification.source },
      audience: { kind: 'owner' },
      urgency: (outcome && OUTCOME_URGENCY[outcome]) ?? 'info',
      interrupt: 'default',
    },
    legacy: true,
  };
}

export function deviceSurfaceId(deviceId: string): SurfaceId {
  return `device:${deviceId}`;
}
