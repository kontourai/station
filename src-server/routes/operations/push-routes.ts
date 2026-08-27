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
 * Not every refusal reaches this file. Since station#1123 slice 3 (#1189) the
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

export interface PushRouteDeps {
  /** Hosted mode keeps unbound paired-device subscriptions unavailable. */
  enabled?: boolean;
  getVapidPublicKey: () => string;
  identifyDevice: (credential: string) => PairedDevice | null;
  setPushSubscription: (
    deviceId: string,
    subscription: WebPushSubscription,
  ) => void;
  clearPushSubscription: (deviceId: string) => void;
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

function extractCredential(req: {
  header: (name: string) => string | undefined;
}): string | undefined {
  const bearer = parseStrictBearer(req.header('authorization'));
  if (bearer) return bearer;
  return parseDeviceSessionCookie(req.header('cookie'));
}

export function createPushRoutes(deps: PushRouteDeps) {
  const app = new Hono();

  // The device-pairing store does not yet persist tenant ownership. Suppress
  // every control and discovery endpoint in hosted mode before any key or
  // pairing callback can be invoked.
  app.use('*', async (c, next) => {
    if (deps.enabled === false) {
      return c.json({ success: false, error: 'Web Push not found' }, 404);
    }
    await next();
  });

  app.get('/vapid-public-key', (c) =>
    c.json({ publicKey: deps.getVapidPublicKey() }),
  );

  app.post('/push-subscribe', async (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
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

    deps.setPushSubscription(device.id, body);
    webPushSubscriptions.add(1, { op: 'subscribe', outcome: 'ok' });
    return c.json({ ok: true });
  });

  app.post('/push-unsubscribe', async (c) => {
    const credential = extractCredential(c.req);
    const device = credential ? deps.identifyDevice(credential) : null;
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
    deps.clearPushSubscription(device.id);
    webPushSubscriptions.add(1, { op: 'unsubscribe', outcome: 'ok' });
    return c.json({ ok: true });
  });

  return app;
}
