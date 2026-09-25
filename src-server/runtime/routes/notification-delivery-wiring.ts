/**
 * The production composition of notification delivery (#2586): the
 * preferences store, the audience resolver over the pairing registry and
 * the orchestration read check, the Web Push and desktop-host channels, and
 * the router. Extracted from `configureRuntimeSupportServices` so a test can
 * drive the REAL wiring (which read authority a device resolves to, which
 * store the escalation re-check reads) rather than only its parts.
 */
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import type { Notification } from '@kontourai/station-contracts/notification';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import {
  createPairingAudienceResolver,
  isPersonalFamilyDevice,
} from '../../services/notifications/delivery/audience-resolver.js';
import { DesktopHostChannel } from '../../services/notifications/delivery/desktop-host-channel.js';
import {
  type FocusSource,
  type InAppLiveness,
  type NotificationDeliveryRouter,
  wireNotificationDeliveryRouter,
} from '../../services/notifications/delivery/router.js';
import { NotificationPreferencesStore } from '../../services/notifications/notification-preferences.js';
import {
  WebPushChannel,
  type WebPushDeliveryDevicePairing,
} from '../../services/notifications/web-push-channel.js';
import type { WebPushService } from '../../services/notifications/web-push-service.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { pairedDevicePrincipal } from '../bootstrap/orchestration-request-principal.js';

export interface NotificationDeliveryWiringDeps {
  /** Off exactly where Web Push is: hosted pairing records are unbound. */
  enabled: boolean;
  homeDir: string;
  eventBus: EventBus;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  devicePairing: WebPushDeliveryDevicePairing & {
    listDevices(): PairedDevice[];
  };
  webPushService: Pick<WebPushService, 'send'>;
  canUserReadSession(
    sessionId: string,
    authority: SessionReadAuthority,
  ): boolean;
  /** The store's records; the escalation re-check reads one back. */
  listNotifications(): Promise<Notification[]>;
  /** #2585 focus presence and its in-app liveness; inert until wired. */
  focus?: FocusSource;
  inAppLiveness?: InAppLiveness;
}

export interface NotificationDeliveryWiring {
  preferences: NotificationPreferencesStore;
  router: NotificationDeliveryRouter;
  /** Absent when delivery is off. */
  desktopHostChannel?: DesktopHostChannel;
  /** Whether a paired device may hold a delivery feed (personal family). */
  isFeedDevice(deviceId: string): boolean;
}

export function wireNotificationDelivery(
  deps: NotificationDeliveryWiringDeps,
): NotificationDeliveryWiring {
  const preferences = new NotificationPreferencesStore(
    deps.homeDir,
    deps.logger,
  );
  const isFeedDevice = (deviceId: string) => {
    const device = deps.devicePairing
      .listDevices()
      .find((candidate) => candidate.id === deviceId);
    return device !== undefined && isPersonalFamilyDevice(device);
  };
  if (!deps.enabled)
    return {
      preferences,
      router: { stop: () => {}, pendingEscalations: () => [] },
      isFeedDevice,
    };
  // The desktop app's native host reads its decided alerts from a feed;
  // inert until a host polls it.
  const desktopHostChannel = new DesktopHostChannel();
  const router = wireNotificationDeliveryRouter({
    eventBus: deps.eventBus,
    channels: [
      new WebPushChannel(deps.devicePairing, deps.webPushService, deps.logger),
      desktopHostChannel,
    ],
    resolver: createPairingAudienceResolver({
      listDevices: () => deps.devicePairing.listDevices(),
      devicePrincipalId: (device) => pairedDevicePrincipal(device).id,
      operatorPrincipalId: LOCAL_OPERATOR_PRINCIPAL_ID,
      // Personal mode only (delivery is off in hosted mode), minted the way
      // the session-list route mints a device's authority.
      canPrincipalReadSession: (sessionId, principalId) =>
        deps.canUserReadSession(
          sessionId,
          sessionReadAuthorityFromRequest(principalId, undefined, undefined),
        ),
      logger: deps.logger,
    }),
    preferences,
    logger: deps.logger,
    ...(deps.focus ? { focus: deps.focus } : {}),
    ...(deps.inAppLiveness ? { inAppLiveness: deps.inAppLiveness } : {}),
    // The store has no by-id read; escalations are rare (one per deferred
    // attention/failed notification), so a whole-store read is acceptable.
    readNotification: async (id) =>
      (await deps.listNotifications()).find(
        (notification) => notification.id === id,
      ),
  });
  return { preferences, router, desktopHostChannel, isFeedDevice };
}
