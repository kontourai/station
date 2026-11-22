/**
 * Web Push routes, mounted at /api/system alongside system.ts.
 *
 * These sit behind the generic runtime auth gate (`configureRuntimeHttp`),
 * which requires a credential for ordinary callers, including loopback and
 * SSH. Every handler independently resolves that credential and requires it
 * to `identifyDevice` to a paired device: even an operator credential is not
 * enough to subscribe or unsubscribe. A caller with no device identity gets
 * 403 device_pairing_required, which is the structural guarantee behind "no
 * pushes to unpaired browsers."
 *
 * Not every refusal reaches this file. Since archive#1123 (archive#1189) the
 * gate verifies any presented, well-formed credential regardless of peer
 * class, so a revoked device is turned away there with 401
 * authentication_required and never gets here. Clients treat both as "pair
 * this device again" — see `throwIfDevicePairingRequired` in the SDK.
 */
import type {
  PairedDevice,
  WebPushSubscription,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { parseDeviceSessionCookie } from '../../runtime/bootstrap/runtime-http.js';
import { parseStrictBearer } from '../../security/runtime-request-security.js';
import { webPushSubscriptions } from '../../telemetry/metrics.js';

const MAX_ENDPOINT_LENGTH = 2048;
const PUSH_ENDPOINT_PATTERN = /^https:\/\/.{1,2000}$/;
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

interface PushRouteDeps {
  /** Hosted mode keeps unbound paired-device subscriptions unavailable. */
  enabled?: boolean;
  getVapidPublicKey: () => string;
  identifyDevice: (credential: string) => PairedDevice | null;
  /**
   * The relay alias id when the credential is a relay alias of a paired
   * device, else undefined. An alias is a read-scoped relay bearer for the
   * same device id that never carries the device's home-possession stamp,
   * so a registration made with it would be filed under a device whose
   * other credential may read as the operator: refused, as a personal
   * access token is.
   */
  credentialAliasId: (credential: string) => string | undefined;
  setPushSubscription: (
    deviceId: string,
    subscription: WebPushSubscription,
  ) => void;
  clearPushSubscription: (deviceId: string, endpoint: string) => void;
  readPushSubscriptionFingerprint?: (deviceId: string) => string | null;
}

function isValidSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.endpoint !== 'string' ||
    record.endpoint.length > MAX_ENDPOINT_LENGTH ||
    !PUSH_ENDPOINT_PATTERN.test(record.endpoint)
  ) {
    return false;
  }
  const keys = record.keys;
  if (!keys || typeof keys !== 'object') return false;
  const keyRecord = keys as Record<string, unknown>;
  return (
    typeof keyRecord.p256dh === 'string' &&
    PUSH_KEY_PATTERN.test(keyRecord.p256dh) &&
    typeof keyRecord.auth === 'string' &&
    PUSH_KEY_PATTERN.test(keyRecord.auth)
  );
}

function extractCredential(
  req: {
    header: (name: string) => string | undefined;
  },
  identifies: (credential: string) => boolean,
): string | undefined {
  const bearer = parseStrictBearer(req.header('authorization'));
  if (bearer) return bearer;
  return parseDeviceSessionCookie(req.header('cookie'), identifies);
}

export function createPushRoutes(deps: PushRouteDeps) {
  const app = new Hono();
  function pairedDevice(req: {
    header: (name: string) => string | undefined;
  }): PairedDevice | null {
    const credential = extractCredential(
      req,
      (value) => deps.identifyDevice(value) !== null,
    );
    if (!credential || deps.credentialAliasId(credential) !== undefined)
      return null;
    const device = deps.identifyDevice(credential);
    return device && device.credentialKind !== 'personal-token' ? device : null;
  }

  // The device-pairing store does not yet persist tenant ownership. Suppress
  // every control and discovery endpoint in hosted mode before any key or
  // pairing callback can be invoked.
  app.use('*', async (c, next) => {
    if (deps.enabled === false) {
      return c.json({ success: false, error: 'Web Push not found' }, 404);
    }
    await next();
  });

  app.get('/vapid-public-key', (c) => {
    const publicKey = deps.getVapidPublicKey();
    if (!deps.readPushSubscriptionFingerprint) return c.json({ publicKey });
    c.header('Cache-Control', 'no-store');
    const device = pairedDevice(c.req);
    return c.json({
      publicKey,
      registration: device
        ? {
            status: 'paired',
            fingerprint: deps.readPushSubscriptionFingerprint(device.id),
          }
        : { status: 'pairing-required' },
    });
  });

  app.post('/push-subscribe', async (c) => {
    const device = pairedDevice(c.req);
    if (!device) {
      webPushSubscriptions.add(1, { op: 'subscribe', outcome: 'denied' });
      return c.json({ error: 'device_pairing_required' }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    if (!isValidSubscription(body)) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    if (pairedDevice(c.req)?.id !== device.id) {
      webPushSubscriptions.add(1, { op: 'subscribe', outcome: 'denied' });
      return c.json({ error: 'device_pairing_required' }, 403);
    }
    deps.setPushSubscription(device.id, body);
    webPushSubscriptions.add(1, { op: 'subscribe', outcome: 'ok' });
    return c.json({ ok: true });
  });

  app.post('/push-unsubscribe', async (c) => {
    const device = pairedDevice(c.req);
    if (!device) {
      webPushSubscriptions.add(1, { op: 'unsubscribe', outcome: 'denied' });
      return c.json({ error: 'device_pairing_required' }, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const record = body as Record<string, unknown> | null;
    if (
      !record ||
      typeof record.endpoint !== 'string' ||
      record.endpoint.length === 0 ||
      record.endpoint.length > MAX_ENDPOINT_LENGTH
    ) {
      return c.json({ error: 'invalid_request' }, 400);
    }

    // Scoped to the caller's own identified device only — never look up by
    // endpoint, which would let one device clear another device's push.
    if (pairedDevice(c.req)?.id !== device.id) {
      webPushSubscriptions.add(1, { op: 'unsubscribe', outcome: 'denied' });
      return c.json({ error: 'device_pairing_required' }, 403);
    }
    deps.clearPushSubscription(device.id, record.endpoint);
    webPushSubscriptions.add(1, { op: 'unsubscribe', outcome: 'ok' });
    return c.json({ ok: true });
  });

  return app;
}
