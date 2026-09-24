import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import {
  NATIVE_PUSH_REGISTER_PATH,
  NATIVE_PUSH_REGISTRATION_PATH,
} from '@kontourai/station-contracts/native-push';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createNativePushRoutes } from '../../routes/operations/native-push-routes.js';
import { PushSigningKeyStore } from '../../services/notifications/push-signing-key-store.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { DevicePairingService } from '../../services/ssh/device-pairing-service.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const MASTER_CREDENTIAL = 'master-credential';
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const LOOPBACK_PEER = '127.0.0.1';
const TOKEN_A = `fcm-token-a-${'a'.repeat(40)}`;
const TOKEN_B = `fcm-token-b-${'b'.repeat(40)}`;
const homes: string[] = [];

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function logger(): Logger {
  return {
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
}

function createHarness(options: { enabled?: boolean } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-native-push-routes-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const pairing = new DevicePairingService({
    homeDir,
    environmentId: ENVIRONMENT_ID,
  });
  const keys = new PushSigningKeyStore(homeDir, () => pairing.environmentId());
  const onRegistered = vi.fn();
  const app = new Hono<{ Bindings: TestBindings }>();
  // The real runtime credential gate. The leaves' pairing-scope declaration
  // is proven by pairing-route-scopes.test.ts's leaf scan, not here: the
  // `/api/system` family rule would admit an undeclared leaf.
  configureRuntimeHttp({
    app: app as never,
    logger: logger(),
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
    createNativePushRoutes({
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      identifyDevice: (credential) => pairing.identifyDevice(credential),
      loadOrCreateStationKey: async () =>
        (await keys.loadOrCreate()).thumbprint,
      stationId: () => pairing.environmentId(),
      setNativePush: (deviceId, request) =>
        pairing.setNativePush(deviceId, request),
      clearNativePush: (deviceId) => {
        pairing.clearNativePush(deviceId);
      },
      onRegistered,
    }),
  );
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, init, {
      incoming: { socket: { remoteAddress: LOOPBACK_PEER } },
    } as TestBindings);
  const call = (
    method: 'POST' | 'DELETE',
    path: string,
    credential: string | undefined,
    body?: unknown,
  ) =>
    request(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const register = (credential: string | undefined, body: unknown) =>
    call('POST', NATIVE_PUSH_REGISTER_PATH, credential, body);
  const unregister = (credential: string | undefined) =>
    call('DELETE', NATIVE_PUSH_REGISTRATION_PATH, credential);
  return {
    homeDir,
    pairing,
    keys,
    onRegistered,
    register,
    unregister,
    keyPath: join(homeDir, 'security', 'push-signing-key.json'),
    registryPath: join(homeDir, 'security', 'paired-devices.json'),
  };
}

async function pairDevice(
  harness: ReturnType<typeof createHarness>,
  name = 'Pixel',
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

const androidBody = (token: string, packageName = 'io.kontourai.station') => ({
  token,
  packageName,
  platform: 'android',
});

afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

describe('native push routes', () => {
  test('a paired device registers, and the key is created by that registration and not before', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    expect(existsSync(harness.keyPath)).toBe(false);

    const response = await harness.register(
      paired.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual([
      'registrationId',
      'stationId',
      'stationKey',
    ]);
    expect(body.stationId).toBe(ENVIRONMENT_ID);
    expect(body.stationKey).toBe(harness.keys.read()?.thumbprint);
    // 128 random bits, base64url.
    expect(body.registrationId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(existsSync(harness.keyPath)).toBe(true);
    expect(harness.onRegistered).toHaveBeenCalledTimes(1);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([
      {
        deviceId: paired.device.id,
        registration: expect.objectContaining({
          token: TOKEN_A,
          packageName: 'io.kontourai.station',
          platform: 'android',
          registrationId: body.registrationId,
        }),
      },
    ]);
  });

  test('re-registering after token rotation keeps the registrationId and the key', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const first = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    const second = (await (
      await harness.register(
        paired.credential,
        androidBody(TOKEN_B, 'io.kontourai.station.nightly'),
      )
    ).json()) as Record<string, string>;
    expect(second).toEqual(first);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([
      {
        deviceId: paired.device.id,
        registration: expect.objectContaining({
          token: TOKEN_B,
          packageName: 'io.kontourai.station.nightly',
          registrationId: first.registrationId,
        }),
      },
    ]);
  });

  test('two devices get distinct registrationIds', async () => {
    const harness = createHarness();
    const a = await pairDevice(harness, 'A');
    const b = await pairDevice(harness, 'B');
    const ra = (await (
      await harness.register(a.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    const rb = (await (
      await harness.register(b.credential, androidBody(TOKEN_B))
    ).json()) as Record<string, string>;
    expect(ra.registrationId).not.toBe(rb.registrationId);
    expect(ra.stationKey).toBe(rb.stationKey);
  });

  test('an operator credential is not a paired device (403) and creates no key', async () => {
    const harness = createHarness();
    const response = await harness.register(
      MASTER_CREDENTIAL,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'device_pairing_required' });
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);

    const cleared = await harness.unregister(MASTER_CREDENTIAL);
    expect(cleared.status).toBe(403);
  });

  test('no credential is refused at the runtime floor', async () => {
    const harness = createHarness();
    const response = await harness.register(undefined, androidBody(TOKEN_A));
    expect(response.status).toBe(401);
    expect(existsSync(harness.keyPath)).toBe(false);
  });

  test.each([
    [
      'a package the gateway does not deliver to',
      androidBody(TOKEN_A, 'com.example.other'),
    ],
    ['a token with whitespace', androidBody(`${TOKEN_A} x`)],
    ['a short token', androidBody('short-token')],
    ['an oversized token', androidBody('x'.repeat(4097))],
    ['a non-android platform', { ...androidBody(TOKEN_A), platform: 'ios' }],
    [
      'a missing token',
      { packageName: 'io.kontourai.station', platform: 'android' },
    ],
  ])('rejects %s without storing anything', async (_label, body) => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const response = await harness.register(paired.credential, body);
    expect(response.status).toBe(400);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
    expect(existsSync(harness.keyPath)).toBe(false);
  });

  test('delete clears only the caller’s own registration', async () => {
    const harness = createHarness();
    const a = await pairDevice(harness, 'A');
    const b = await pairDevice(harness, 'B');
    await harness.register(a.credential, androidBody(TOKEN_A));
    await harness.register(b.credential, androidBody(TOKEN_B));

    const response = await harness.unregister(a.credential);
    expect(response.status).toBe(200);
    expect(
      harness.pairing
        .listNativePushRegistrations()
        .map((entry) => entry.deviceId),
    ).toEqual([b.device.id]);

    // Idempotent.
    expect((await harness.unregister(a.credential)).status).toBe(200);
  });

  test('a new registration after delete gets a new registrationId', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const first = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    await harness.unregister(paired.credential);
    const second = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    expect(second.registrationId).not.toBe(first.registrationId);
  });

  test('hosted mode answers 404 and touches nothing', async () => {
    const harness = createHarness({ enabled: false });
    const paired = await pairDevice(harness);
    expect(
      (await harness.register(paired.credential, androidBody(TOKEN_A))).status,
    ).toBe(404);
    expect((await harness.unregister(paired.credential)).status).toBe(404);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(harness.onRegistered).not.toHaveBeenCalled();
  });

  test('the registration is private: no device listing carries it, and it survives a reload', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const { registrationId } = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;

    const listed = JSON.stringify([
      harness.pairing.listDevices(),
      harness.pairing.identifyDevice(paired.credential),
    ]);
    expect(listed).not.toContain(TOKEN_A);
    expect(listed).not.toContain(registrationId);
    expect(listed).not.toContain('nativePush');

    // Persisted, and a fresh reader accepts the stored shape.
    expect(readFileSync(harness.registryPath, 'utf8')).toContain(TOKEN_A);
    const reloaded = new DevicePairingService({
      homeDir: harness.homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    expect(reloaded.listNativePushRegistrations()).toEqual([
      {
        deviceId: paired.device.id,
        registration: expect.objectContaining({
          token: TOKEN_A,
          registrationId,
        }),
      },
    ]);
  });

  test('revoking the device drops its registration', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    await harness.register(paired.credential, androidBody(TOKEN_A));
    harness.pairing.revokeDevice(paired.device.id, 'operator-credential');
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
    // Severed on disk, not just hidden from the listing.
    expect(readFileSync(harness.registryPath, 'utf8')).not.toContain(TOKEN_A);
    expect(
      (await harness.register(paired.credential, androidBody(TOKEN_A))).status,
    ).toBe(401);
  });
});
