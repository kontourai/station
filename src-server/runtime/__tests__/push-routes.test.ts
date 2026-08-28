import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createPushRoutes } from '../../routes/operations/push-routes.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const MASTER_CREDENTIAL = 'master-credential';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const LOOPBACK_PEER = '127.0.0.1';
const REMOTE_PEER = '203.0.113.10';
const REVOKED_CREDENTIAL_REJECTION = {
  status: 401,
  body: { error: { code: 'authentication_required' } },
};
const homes: string[] = [];

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function createHarness() {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-push-routes-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit: vi.fn() } as unknown as EventBus,
    security: {
      verifyCredential: (credential) =>
        credential === MASTER_CREDENTIAL ||
        pairing.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        credential === MASTER_CREDENTIAL
          ? DEFAULT_GRANT_PAIRING_SCOPE
          : pairing.identifyDevice(credential)?.scope,
      allowedOrigins: [],
    },
  });
  app.route(
    '/api/system',
    createPushRoutes({
      getVapidPublicKey: () => 'fake-vapid-public-key',
      identifyDevice: (credential) => pairing.identifyDevice(credential),
      setPushSubscription: (deviceId, subscription) =>
        pairing.setPushSubscription(deviceId, subscription),
      clearPushSubscription: (deviceId) =>
        pairing.clearPushSubscription(deviceId),
    }),
  );

  const request = (
    path: string,
    init: RequestInit = {},
    peer = LOOPBACK_PEER,
  ) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: peer } },
    } as TestBindings);
  const authed = (
    credential: string | undefined,
    body?: unknown,
  ): RequestInit => ({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { pairing, request, authed };
}

async function pairDevice(
  harness: ReturnType<typeof createHarness>,
  name = 'Brian phone',
) {
  const offer = harness.pairing.createOffer({
    endpoint: 'https://station.example.test',
  });
  const req = harness.pairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: name,
  });
  harness.pairing.confirmRequest(req.requestId, {
    kind: 'presented-credential',
  });
  return harness.pairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: req.requestId,
  });
}

function fakeSubscription(id: string) {
  return {
    endpoint: `https://push.example.test/subscription/${id}`,
    keys: { p256dh: `p256dh-value-${id}`, auth: `auth-value-${id}` },
  };
}

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('push routes', () => {
  test('disabled hosted routes reveal neither VAPID configuration nor pairing controls', async () => {
    const callbacks = {
      getVapidPublicKey: vi.fn(() => 'hosted-vapid-key'),
      identifyDevice: vi.fn(),
      setPushSubscription: vi.fn(),
      clearPushSubscription: vi.fn(),
    };
    const app = new Hono();
    app.route(
      '/api/system',
      createPushRoutes({ ...callbacks, enabled: false }),
    );

    const [key, subscribe, unsubscribe] = await Promise.all([
      app.request('/api/system/vapid-public-key'),
      app.request('/api/system/push-subscribe', {
        method: 'POST',
        body: JSON.stringify(fakeSubscription('a')),
      }),
      app.request('/api/system/push-unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: fakeSubscription('a').endpoint }),
      }),
    ]);

    expect(key.status).toBe(404);
    expect(subscribe.status).toBe(404);
    expect(unsubscribe.status).toBe(404);
    expect(callbacks.getVapidPublicKey).not.toHaveBeenCalled();
    expect(callbacks.identifyDevice).not.toHaveBeenCalled();
    expect(callbacks.setPushSubscription).not.toHaveBeenCalled();
    expect(callbacks.clearPushSubscription).not.toHaveBeenCalled();
  });

  test('serves the VAPID public key to a verified operator credential', async () => {
    const harness = createHarness();
    const response = await harness.request('/api/system/vapid-public-key', {
      headers: { Authorization: `Bearer ${MASTER_CREDENTIAL}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      publicKey: 'fake-vapid-public-key',
    });
  });

  test('protects VAPID public-key discovery with the runtime credential floor', async () => {
    const harness = createHarness();
    const response = await harness.request('/api/system/vapid-public-key');
    expect(response.status).toBe(REVOKED_CREDENTIAL_REJECTION.status);
    expect(await response.json()).toEqual(REVOKED_CREDENTIAL_REJECTION.body);
  });

  test('a paired device can subscribe and its subscription is retrievable for fan-out', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);

    const response = await harness.request(
      '/api/system/push-subscribe',
      harness.authed(paired.credential, fakeSubscription('a')),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(harness.pairing.listPushSubscriptions()).toEqual([
      { deviceId: paired.device.id, subscription: fakeSubscription('a') },
    ]);
  });

  test('an operator-only credential is not enough to subscribe (403 device_pairing_required)', async () => {
    const harness = createHarness();
    const response = await harness.request(
      '/api/system/push-subscribe',
      harness.authed(MASTER_CREDENTIAL, fakeSubscription('a')),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'device_pairing_required',
    });
    expect(harness.pairing.listPushSubscriptions()).toEqual([]);
  });

  test('no credential is rejected at the runtime credential floor', async () => {
    const harness = createHarness();
    const response = await harness.request(
      '/api/system/push-subscribe',
      harness.authed(undefined, fakeSubscription('a')),
    );
    expect(response.status).toBe(REVOKED_CREDENTIAL_REJECTION.status);
    expect(await response.json()).toEqual(REVOKED_CREDENTIAL_REJECTION.body);
  });

  // A revoked credential is now stopped one layer earlier than the other two
  // rejections above. archive#1189 (archive#1123) narrowed the loopback
  // bypass so that a *presented, well-formed* credential always runs the
  // verify path regardless of peer class; a revoked one fails that verify and
  // the gate answers 401 authentication_required, so the request never reaches
  // this route's own device-identity check. The master credential still
  // reaches the route and answers 403 because it verifies but identifies no
  // paired device. Since archive#2051, a caller presenting nothing is rejected by the
  // same credential floor with the same 401 response as a revoked credential.
  //
  // The guarantee this test exists for is unchanged: a revoked device cannot
  // keep or re-establish a push subscription. To assert that with real power,
  // this pairs and *successfully subscribes* first, so there is a live
  // subscription to lose — asserting an empty list against a device that never
  // subscribed would pass no matter which layer denied the request, or even if
  // the auth change were reverted wholesale.
  //
  // What did change is the contract a client reads: 401 tells it to
  // re-authenticate where 403 device_pairing_required told it to re-pair, and
  // re-pairing is the only recovery a revoked device has. The SDK maps both to
  // DevicePairingRequiredError for exactly that reason — see
  // `throwIfDevicePairingRequired` in packages/sdk and its tests. Whether the
  // gate should let clients tell a revoked device apart from one that was
  // never paired is open in archive#1212.
  test('a revoked device credential is rejected identically for loopback and remote peers and cannot resurrect its subscription', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);

    const subscribed = await harness.request(
      '/api/system/push-subscribe',
      harness.authed(paired.credential, fakeSubscription('a')),
    );
    expect(subscribed.status).toBe(200);
    expect(harness.pairing.listPushSubscriptions()).toEqual([
      { deviceId: paired.device.id, subscription: fakeSubscription('a') },
    ]);

    harness.pairing.revokeDevice(paired.device.id, 'operator-credential');
    expect(harness.pairing.listPushSubscriptions()).toEqual([]);

    const outcomes = await Promise.all(
      [LOOPBACK_PEER, REMOTE_PEER].map(async (peer) => {
        const response = await harness.request(
          '/api/system/push-subscribe',
          harness.authed(paired.credential, fakeSubscription('b')),
          peer,
        );
        return { status: response.status, body: await response.json() };
      }),
    );
    for (const outcome of outcomes)
      expect(outcome).toEqual(REVOKED_CREDENTIAL_REJECTION);
    // Negative control for transport-neutral credential rejection: this fails
    // if either peer class starts returning a different status or body.
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(harness.pairing.listPushSubscriptions()).toEqual([]);
  });

  test('rejects a malformed subscription body', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);

    const response = await harness.request(
      '/api/system/push-subscribe',
      harness.authed(paired.credential, { endpoint: 'not-https', keys: {} }),
    );
    expect(response.status).toBe(400);
    expect(harness.pairing.listPushSubscriptions()).toEqual([]);
  });

  test('unsubscribe is scoped to the caller device only, never another device by endpoint', async () => {
    const harness = createHarness();
    const first = await pairDevice(harness, 'First phone');
    const second = await pairDevice(harness, 'Second phone');
    await harness.request(
      '/api/system/push-subscribe',
      harness.authed(first.credential, fakeSubscription('first')),
    );
    await harness.request(
      '/api/system/push-subscribe',
      harness.authed(second.credential, fakeSubscription('second')),
    );
    expect(harness.pairing.listPushSubscriptions()).toHaveLength(2);

    const response = await harness.request(
      '/api/system/push-unsubscribe',
      harness.authed(first.credential, {
        endpoint: fakeSubscription('first').endpoint,
      }),
    );
    expect(response.status).toBe(200);

    const remaining = harness.pairing.listPushSubscriptions();
    expect(remaining).toEqual([
      { deviceId: second.device.id, subscription: fakeSubscription('second') },
    ]);
  });

  test('unsubscribe without a device credential 403s and clears nothing', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    await harness.request(
      '/api/system/push-subscribe',
      harness.authed(paired.credential, fakeSubscription('a')),
    );

    const response = await harness.request(
      '/api/system/push-unsubscribe',
      harness.authed(MASTER_CREDENTIAL, {
        endpoint: fakeSubscription('a').endpoint,
      }),
    );
    expect(response.status).toBe(403);
    expect(harness.pairing.listPushSubscriptions()).toHaveLength(1);
  });
});
