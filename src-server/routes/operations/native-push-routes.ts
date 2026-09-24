/**
 * Native (FCM) agent-activity push registration, mounted at /api/system
 * beside the Web Push routes (`push-routes.ts`) and held to the same rule:
 * the caller's credential must identify a paired device, and a device can
 * only create or clear its OWN registration. An operator credential alone is
 * refused with 403 device_pairing_required.
 *
 * Registration answers the three values the phone checks on every push
 * (docs/design/notification-delivery.md, "Station contract"). Creating the
 * first registration is also what creates the Station's push signing key;
 * nothing is minted before a phone asks.
 */
import type { PairedDevice } from '@kontourai/station-contracts';
import type {
  NativePushRegistrationRequest,
  NativePushRegistrationResponse,
} from '@kontourai/station-contracts/native-push';
import { Hono } from 'hono';
import { parseDeviceSessionCookie } from '../../runtime/bootstrap/runtime-http.js';
import { parseStrictBearer } from '../../security/runtime-request-security.js';
import { isValidNativePushRequest } from '../../services/ssh/device-pairing-service.js';

interface NativePushRouteDeps {
  /** Hosted mode keeps unbound paired-device registrations unavailable. */
  enabled?: boolean;
  identifyDevice: (credential: string) => PairedDevice | null;
  /** Creates the push key on first use; resolves its RFC 7638 thumbprint. */
  loadOrCreateStationKey: () => Promise<string>;
  stationId: () => string;
  setNativePush: (
    deviceId: string,
    request: NativePushRegistrationRequest,
  ) => { registrationId: string };
  clearNativePush: (deviceId: string) => void;
  /** Lets the publisher send the current card to a newly registered phone. */
  onRegistered?: () => void;
}

function extractCredential(req: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const bearer = parseStrictBearer(req.header('authorization'));
  if (bearer) return bearer;
  return parseDeviceSessionCookie(req.header('cookie'));
}

export function createNativePushRoutes(deps: NativePushRouteDeps) {
  const app = new Hono();

  // Same posture as Web Push: the pairing store does not persist tenant
  // ownership, so hosted mode exposes neither route.
  app.use('/native-push/*', async (c, next) => {
    if (deps.enabled === false)
      return c.json({ success: false, error: 'Native push not found' }, 404);
    await next();
  });
  app.use('/native-push', async (c, next) => {
    if (deps.enabled === false)
      return c.json({ success: false, error: 'Native push not found' }, 404);
    await next();
  });

  app.post('/native-push/register', async (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
    if (!device) return c.json({ error: 'device_pairing_required' }, 403);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!isValidNativePushRequest(body))
      return c.json({ error: 'invalid_request' }, 400);

    // Key first: a registration must never exist that no key can sign for.
    const stationKey = await deps.loadOrCreateStationKey();
    const { registrationId } = deps.setNativePush(device.id, {
      token: body.token,
      packageName: body.packageName,
      platform: 'android',
    });
    deps.onRegistered?.();
    const response: NativePushRegistrationResponse = {
      registrationId,
      stationId: deps.stationId(),
      stationKey,
    };
    return c.json(response);
  });

  app.delete('/native-push', (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
    if (!device) return c.json({ error: 'device_pairing_required' }, 403);
    // Scoped to the caller's own identified device only.
    deps.clearNativePush(device.id);
    return c.json({ ok: true });
  });

  return app;
}
