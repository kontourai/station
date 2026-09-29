/**
 * Native agent-activity push registration (FCM on Android, Live Activities
 * on iOS), mounted at /api/system
 * beside the Web Push routes (`push-routes.ts`) and held to the same rule:
 * the caller's credential must identify a paired device, and a device can
 * only create or clear its OWN registration. An operator credential alone is
 * refused with 403 device_pairing_required.
 *
 * Registration answers the values the phone checks (`registrationId`,
 * `stationId`, `stationKey`) and the key it opens sealed cards with
 * (`payloadKey`) — docs/design/notification-delivery.md, "Station contract".
 * Creating the first registration is also what creates the Station's push
 * signing key; nothing is minted before a phone asks.
 */
import type { PairedDevice } from '@kontourai/station-contracts';
import type {
  NativePushRegistrationRequest,
  NativePushRegistrationResponse,
} from '@kontourai/station-contracts/native-push';
import { Hono } from 'hono';
import { parseDeviceSessionCookie } from '../../runtime/bootstrap/runtime-http.js';
import { parseStrictBearer } from '../../security/runtime-request-security.js';
import { canReadAgentActivity } from '../../services/notifications/agent-activity-eligibility.js';
import { isValidNativePushRequest } from '../../services/notifications/native-push-registration-store.js';
import { DevicePairingError } from '../../services/ssh/device-pairing-service.js';

interface NativePushRouteDeps {
  /** Hosted mode keeps unbound paired-device registrations unavailable. */
  enabled?: boolean;
  /**
   * False when this Station cannot deliver (an invalid
   * STATION_PUSH_GATEWAY_URL): registering would promise pushes that never
   * come, so the route answers 503 instead.
   */
  deliverable?: boolean;
  identifyDevice: (credential: string) => PairedDevice | null;
  /** Creates the push key on first use; resolves its RFC 7638 thumbprint. */
  loadOrCreateStationKey: () => Promise<string>;
  stationId: () => string;
  setNativePush: (
    deviceId: string,
    request: NativePushRegistrationRequest,
    stationKey: string,
  ) => { registrationId: string; payloadKey: string };
  clearNativePush: (deviceId: string) => void;
  /** Lets the publisher send the current card to a newly registered phone. */
  onRegistered?: () => void;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

function extractCredential(req: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const bearer = parseStrictBearer(req.header('authorization'));
  if (bearer) return bearer;
  return parseDeviceSessionCookie(req.header('cookie'));
}

const UNAVAILABLE = {
  error: 'native_push_unavailable',
  message: 'Agent-activity push is not available on this Station right now.',
} as const;

export function createNativePushRoutes(deps: NativePushRouteDeps) {
  const app = new Hono();

  // Same posture as Web Push: the pairing store does not persist tenant
  // ownership, so hosted mode exposes neither route.
  const hosted = async (
    c: { json: (body: unknown, status: 404) => Response },
    next: () => Promise<void>,
  ) => {
    if (deps.enabled === false)
      return c.json({ success: false, error: 'Native push not found' }, 404);
    await next();
  };
  app.use('/native-push/*', hosted);
  app.use('/native-push', hosted);

  app.post('/native-push/register', async (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
    if (!device) return c.json({ error: 'device_pairing_required' }, 403);
    // Only a device that could list the sessions a card shows may register:
    // a person's device (not another Station's delegation grant) with
    // orchestration:read, not bound to a deployment account. The publisher
    // applies the same rule, so a refused device would never get a card.
    if (!canReadAgentActivity(device))
      return c.json(
        {
          error: 'native_push_not_allowed',
          message:
            'This device cannot read agent sessions, so it cannot receive agent activity.',
        },
        403,
      );
    if (deps.deliverable === false) return c.json(UNAVAILABLE, 503);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    // iOS tokens are hex: their case carries nothing, so they are stored in
    // the one form the gateway and the registration file expect.
    if (
      body &&
      typeof body === 'object' &&
      (body as { platform?: unknown }).platform === 'ios' &&
      typeof (body as { token?: unknown }).token === 'string'
    ) {
      const { alertToken } = body as { alertToken?: unknown };
      body = {
        ...body,
        token: (body as { token: string }).token.toLowerCase(),
        ...(typeof alertToken === 'string'
          ? { alertToken: alertToken.toLowerCase() }
          : {}),
      };
    }
    if (!isValidNativePushRequest(body))
      return c.json({ error: 'invalid_request' }, 400);
    // Only the fields the file keeps; anything else in the body is dropped.
    // No network call here: an iOS registration's broadcast channel is
    // created by the publisher when it first has a card to start.
    const request: NativePushRegistrationRequest =
      body.platform === 'ios'
        ? {
            token: body.token,
            packageName: body.packageName,
            platform: 'ios',
            apnsEnvironment: body.apnsEnvironment,
            // Optional (#2589): the app's device token for alerts.
            ...(body.alertToken !== undefined
              ? { alertToken: body.alertToken }
              : {}),
          }
        : {
            token: body.token,
            packageName: body.packageName,
            platform: 'android',
          };

    // Key first: a registration must never exist that no key can sign for.
    let stationKey: string;
    let registration: { registrationId: string; payloadKey: string };
    try {
      stationKey = await deps.loadOrCreateStationKey();
      registration = deps.setNativePush(device.id, request, stationKey);
    } catch (error) {
      if (error instanceof DevicePairingError) {
        return error.code === 'device_not_found'
          ? c.json({ error: 'device_pairing_required' }, 403)
          : c.json({ error: 'invalid_request' }, 400);
      }
      // A corrupt key or registration file: fail closed, say so, no detail.
      deps.logger?.warn('native push registration unavailable', {
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return c.json(UNAVAILABLE, 503);
    }
    deps.onRegistered?.();
    const response: NativePushRegistrationResponse = {
      registrationId: registration.registrationId,
      stationId: deps.stationId(),
      stationKey,
      payloadKey: registration.payloadKey,
    };
    return c.json(response);
  });

  app.delete('/native-push', (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
    if (!device) return c.json({ error: 'device_pairing_required' }, 403);
    // Scoped to the caller's own identified device only.
    try {
      deps.clearNativePush(device.id);
    } catch {
      return c.json(UNAVAILABLE, 503);
    }
    return c.json({ ok: true });
  });

  return app;
}
