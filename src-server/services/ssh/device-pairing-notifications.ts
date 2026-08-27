import type { DevicePairingRequest } from '@kontourai/station-contracts/environment-security';
import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type ScheduleNotificationOpts,
} from '@kontourai/station-contracts/notification';
import type {
  INotificationProvider,
  NotificationStatusUpdate,
} from '../../providers/provider-interfaces.js';

export const DEVICE_PAIRING_NOTIFICATION_SOURCE = 'device-pairing';
export const DEVICE_PAIRING_NOTIFICATION_CATEGORY =
  BLOCKING_NOTIFICATION_CATEGORIES.devicePairing;

interface PairingRequestSource {
  listRequests(): DevicePairingRequest[];
}

/**
 * Surfaces inbound device-pairing requests as notifications.
 *
 * Approving a device used to require already being in the Connections modal:
 * the request appeared there and nowhere else, so a phone could sit on
 * "credential required" while the approving surface gave no signal at all.
 *
 * These notifications are **pointers, not authorisations**. They carry no
 * approve action, and deliberately so — approving a device has to happen from
 * a session the Station already trusts, and putting an approve button on a
 * notification would make the notification itself the authority. Everything a
 * recipient needs to find the request is in the metadata; the decision stays
 * where the trust check is.
 */
export class DevicePairingNotificationProvider
  implements INotificationProvider
{
  readonly id = DEVICE_PAIRING_NOTIFICATION_SOURCE;
  readonly displayName = 'Device pairing';
  readonly categories = [DEVICE_PAIRING_NOTIFICATION_CATEGORY];

  /**
   * Resolved per poll rather than held: the pairing service is created when
   * the environment initialises, and its accessor throws before then. Polling
   * starts at bootstrap, so holding a reference here would either capture
   * nothing or throw inside the poll loop.
   */
  constructor(
    private readonly resolvePairing: () => PairingRequestSource | null,
  ) {}

  async poll(): Promise<ScheduleNotificationOpts[]> {
    const pairing = this.resolvePairing();
    if (!pairing) return [];

    const now = Date.now();
    return (
      pairing
        .listRequests()
        .filter((request) => request.status === 'pending')
        // An expired request cannot be approved, so announcing it would only
        // send someone to a dead end.
        .filter((request) => request.expiresAt > now)
        .map((request) => ({
          category: DEVICE_PAIRING_NOTIFICATION_CATEGORY,
          title: 'A device is asking to pair',
          body: `${request.deviceName} is waiting for approval on this Station.`,
          priority: 'high' as const,
          // The request window is short. Letting the notification outlive it
          // would leave a stale "needs you" pointing at nothing.
          ttl: Math.max(1, request.expiresAt - now),
          // One notification per request, however often this polls.
          dedupeTag: `${DEVICE_PAIRING_NOTIFICATION_SOURCE}:${request.requestId}`,
          metadata: {
            requestId: request.requestId,
            deviceName: request.deviceName,
            expiresAt: request.expiresAt,
            // Where to go to decide. Not a grant.
            surface: 'connections:pairing',
            // Toast "Open" uses navigateTo; surface is the pairing-specific cue.
            navigateTo: { path: '/connections', mode: 'pair-device' },
          },
        }))
    );
  }

  async syncStatus(): Promise<NotificationStatusUpdate[]> {
    const pairing = this.resolvePairing();
    if (!pairing) return [];

    const now = Date.now();
    const updates: NotificationStatusUpdate[] = [];

    const requests = pairing.listRequests();
    for (const request of requests) {
      const dedupeTag = `${DEVICE_PAIRING_NOTIFICATION_SOURCE}:${request.requestId}`;

      if (request.status === 'confirmed') {
        // Pairing was approved — mark notification actioned
        updates.push({
          dedupeTag,
          status: 'actioned',
          actionId: 'allow',
        });
      } else if (request.status === 'denied') {
        // Pairing was denied — mark notification actioned (user took action)
        updates.push({
          dedupeTag,
          status: 'actioned',
          actionId: 'deny',
        });
      } else if (request.status === 'pending' && request.expiresAt <= now) {
        // Request expired — mark notification expired
        updates.push({
          dedupeTag,
          status: 'expired',
        });
      }
    }

    return updates;
  }
}
