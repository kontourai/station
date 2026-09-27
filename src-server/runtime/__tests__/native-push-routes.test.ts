import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import {
  NATIVE_PUSH_REGISTER_PATH,
  NATIVE_PUSH_REGISTRATION_PATH,
  type NativePushAndroidRegistrationRequest,
  type NativePushRegistrationRequest,
} from '@kontourai/station-contracts/native-push';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createNativePushRoutes } from '../../routes/operations/native-push-routes.js';
import { NativePushRegistrationStore } from '../../services/notifications/native-push-registration-store.js';
import { PushSigningKeyStore } from '../../services/notifications/push-signing-key-store.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import {
  DevicePairingError,
  DevicePairingService,
} from '../../services/ssh/device-pairing-service.js';
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

function createHarness(
  options: {
    enabled?: boolean;
    deliverable?: boolean;
    setNativePush?: (
      deviceId: string,
      request: NativePushRegistrationRequest,
      stationKey: string,
    ) => { registrationId: string; payloadKey: string };
  } = {},
) {
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
      ...(options.deliverable !== undefined
        ? { deliverable: options.deliverable }
        : {}),
      identifyDevice: (credential) => pairing.identifyDevice(credential),
      loadOrCreateStationKey: async () =>
        (await keys.loadOrCreate()).thumbprint,
      stationId: () => pairing.environmentId(),
      setNativePush:
        options.setNativePush ??
        ((deviceId, request, stationKey) =>
          pairing.setNativePush(deviceId, request, stationKey)),
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
    sidecarPath: join(homeDir, 'security', 'native-push-registrations.json'),
  };
}

async function pairDevice(
  harness: ReturnType<typeof createHarness>,
  name = 'Pixel',
  offerOptions: { kind?: 'device' | 'delegation'; scope?: string } = {},
) {
  const offer = harness.pairing.createOffer({
    endpoint: 'https://station.example.test',
    ...offerOptions,
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

const IOS_TOKEN = 'ab'.repeat(40);
const iosBody = (
  token = IOS_TOKEN,
  packageName = 'io.kontourai.station',
  apnsEnvironment = 'production',
) => ({ token, packageName, platform: 'ios', apnsEnvironment });

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
      'payloadKey',
      'registrationId',
      'stationId',
      'stationKey',
    ]);
    // 32 CSPRNG bytes, base64url without padding.
    expect(body.payloadKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(body.payloadKey ?? '', 'base64url')).toHaveLength(32);
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
          payloadKey: body.payloadKey,
          stationKey: body.stationKey,
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

    // Persisted in the 0600 sidecar, and never in the device registry an
    // older Station would refuse whole.
    const registry = readFileSync(harness.registryPath, 'utf8');
    for (const secret of [TOKEN_A, registrationId, 'nativePush', 'payloadKey'])
      expect(registry).not.toContain(secret);
    expect(readFileSync(harness.sidecarPath, 'utf8')).toContain(TOKEN_A);
    if (process.platform !== 'win32')
      expect(statSync(harness.sidecarPath).mode & 0o777).toBe(0o600);
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
    expect(readFileSync(harness.sidecarPath, 'utf8')).not.toContain(TOKEN_A);
    expect(
      (await harness.register(paired.credential, androidBody(TOKEN_A))).status,
    ).toBe(401);
  });

  test('a new registration after delete gets a new payload key; rotation keeps it', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const first = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    const rotated = (await (
      await harness.register(paired.credential, androidBody(TOKEN_B))
    ).json()) as Record<string, string>;
    expect(rotated.payloadKey).toBe(first.payloadKey);
    await harness.unregister(paired.credential);
    const again = (await (
      await harness.register(paired.credential, androidBody(TOKEN_A))
    ).json()) as Record<string, string>;
    expect(again.payloadKey).not.toBe(first.payloadKey);
  });

  test('a registry written by the pre-release build (nativePush on the device) still loads, and the field is dropped at once', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    const registry = JSON.parse(readFileSync(harness.registryPath, 'utf8'));
    registry.devices[0].nativePush = {
      token: TOKEN_A,
      packageName: 'io.kontourai.station',
      platform: 'android',
      registrationId: 'r'.repeat(22),
      updatedAt: 1,
    };
    writeFileSync(harness.registryPath, JSON.stringify(registry), {
      mode: 0o600,
    });
    const reloaded = new DevicePairingService({
      homeDir: harness.homeDir,
      environmentId: ENVIRONMENT_ID,
    });
    // Rewritten on load, before any other call (identifyDevice itself
    // writes usage), not left for some unrelated later write: an older
    // Station reading this file next must find it clean.
    expect(readFileSync(harness.registryPath, 'utf8')).not.toContain(
      'nativePush',
    );
    expect(reloaded.identifyDevice(paired.credential)?.id).toBe(
      paired.device.id,
    );
  });

  test('an invalid gateway URL makes registration unavailable (503), not a silent promise', async () => {
    const harness = createHarness({ deliverable: false });
    const paired = await pairDevice(harness);
    const response = await harness.register(
      paired.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'native_push_unavailable',
    });
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
  });

  test('a corrupt push key file answers 503 and registers nothing', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    writeFileSync(harness.keyPath, '{ not json', { mode: 0o600 });
    const response = await harness.register(
      paired.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: 'native_push_unavailable',
    });
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
    expect(readFileSync(harness.keyPath, 'utf8')).toBe('{ not json');
  });

  test('a pairing refusal from the store is a 4xx, not a 500', async () => {
    const harness = createHarness({
      setNativePush: () => {
        throw new DevicePairingError('device_not_found');
      },
    });
    const paired = await pairDevice(harness);
    const response = await harness.register(
      paired.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'device_pairing_required' });
  });

  test('the store itself refuses a revoked device', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    harness.pairing.revokeDevice(paired.device.id, 'operator-credential');
    expect(() =>
      harness.pairing.setNativePush(
        paired.device.id,
        androidBody(TOKEN_A) as NativePushRegistrationRequest,
        'k'.repeat(43),
      ),
    ).toThrow(DevicePairingError);
  });
  test('a registration left behind for a revoked device is never listed', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    harness.pairing.revokeDevice(paired.device.id, 'operator-credential');
    // As if dropping it had failed: the entry is still in the sidecar.
    new NativePushRegistrationStore(harness.homeDir).upsert(
      paired.device.id,
      androidBody(TOKEN_A) as NativePushAndroidRegistrationRequest,
      'k'.repeat(43),
      1,
    );
    expect(readFileSync(harness.sidecarPath, 'utf8')).toContain(TOKEN_A);
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
  });
  test('a device that cannot read sessions cannot register (the publisher would never read for it)', async () => {
    const harness = createHarness();
    const paired = await pairDevice(harness);
    // Operate is what the route table demands; reading sessions needs read.
    harness.pairing.setDeviceScope(
      paired.device.id,
      ['orchestration:operate'],
      { kind: 'presented-credential' },
    );
    const response = await harness.register(
      paired.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'native_push_not_allowed',
    });
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
    expect(existsSync(harness.keyPath)).toBe(false);
  });

  test('another Station’s delegation grant cannot register', async () => {
    const harness = createHarness();
    const delegation = await pairDevice(harness, 'Peer Station', {
      kind: 'delegation',
    });
    expect(delegation.device.kind).toBe('delegation');
    const response = await harness.register(
      delegation.credential,
      androidBody(TOKEN_A),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'native_push_not_allowed',
    });
    expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
  });

  describe('iOS (Live Activities)', () => {
    const iosPath = (harness: ReturnType<typeof createHarness>) =>
      join(harness.homeDir, 'security', 'native-push-ios-registrations.json');

    test('registers into its own file, answers the same shape, and leaves the Android file alone', async () => {
      const harness = createHarness();
      const paired = await pairDevice(harness, 'iPhone');
      const response = await harness.register(
        paired.credential,
        // Extra keys are dropped, not stored; uppercase hex is normalized.
        { ...iosBody(IOS_TOKEN.toUpperCase()), channelId: 'x'.repeat(20) },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, string>;
      expect(Object.keys(body).sort()).toEqual([
        'payloadKey',
        'registrationId',
        'stationId',
        'stationKey',
      ]);
      expect(harness.onRegistered).toHaveBeenCalledTimes(1);
      expect(existsSync(harness.sidecarPath)).toBe(false);
      const file = JSON.parse(readFileSync(iosPath(harness), 'utf8'));
      expect(file).toEqual({
        schemaVersion: 1,
        registrations: {
          [paired.device.id]: {
            token: IOS_TOKEN,
            packageName: 'io.kontourai.station',
            platform: 'ios',
            apnsEnvironment: 'production',
            registrationId: body.registrationId,
            payloadKey: body.payloadKey,
            stationKey: body.stationKey,
            updatedAt: expect.any(Number),
          },
        },
      });
      if (process.platform !== 'win32')
        expect(statSync(iosPath(harness)).mode & 0o777).toBe(0o600);
    });

    test('an alert token (#2589) is stored lower-cased beside the push-to-start token; without one nothing changes', async () => {
      const harness = createHarness();
      const paired = await pairDevice(harness, 'iPhone');
      const alertToken = 'cd'.repeat(32);
      const response = await harness.register(paired.credential, {
        ...iosBody(),
        alertToken: alertToken.toUpperCase(),
      });
      expect(response.status).toBe(200);
      const first = (await response.json()) as Record<string, string>;
      const stored = () =>
        JSON.parse(readFileSync(iosPath(harness), 'utf8')).registrations[
          paired.device.id
        ];
      expect(stored()).toMatchObject({ token: IOS_TOKEN, alertToken });
      // The answer is the same shape: the alert token is not echoed.
      expect(Object.keys(first).sort()).toEqual([
        'payloadKey',
        'registrationId',
        'stationId',
        'stationKey',
      ]);
      // Re-registering without one keeps the registration and drops it.
      const again = await harness.register(paired.credential, iosBody());
      expect(again.status).toBe(200);
      const second = (await again.json()) as Record<string, string>;
      expect(second.registrationId).toBe(first.registrationId);
      expect(stored()).not.toHaveProperty('alertToken');
    });

    test.each([
      ['not hex', 'zz'.repeat(32)],
      ['shorter than 32 bytes', 'cd'.repeat(31)],
      ['not a string', 42],
    ])('refuses an alert token that is %s', async (_label, alertToken) => {
      const harness = createHarness();
      const paired = await pairDevice(harness);
      const response = await harness.register(paired.credential, {
        ...iosBody(),
        alertToken,
      });
      expect(response.status).toBe(400);
      expect(existsSync(iosPath(harness))).toBe(false);
    });

    test('an Android registration never stores an alert token', async () => {
      const harness = createHarness();
      const paired = await pairDevice(harness);
      const response = await harness.register(paired.credential, {
        ...androidBody(TOKEN_A),
        alertToken: 'cd'.repeat(32),
      });
      expect(response.status).toBe(200);
      expect(readFileSync(harness.sidecarPath, 'utf8')).not.toContain(
        'alertToken',
      );
    });

    test('a device that moves from Android to iOS keeps one registration', async () => {
      const harness = createHarness();
      const paired = await pairDevice(harness);
      await harness.register(paired.credential, androidBody(TOKEN_A));
      expect(
        (await harness.register(paired.credential, iosBody())).status,
      ).toBe(200);
      expect(
        harness.pairing
          .listNativePushRegistrations()
          .map((entry) => entry.registration.platform),
      ).toEqual(['ios']);
      expect(readFileSync(harness.sidecarPath, 'utf8')).not.toContain(TOKEN_A);
    });

    test.each([
      [
        'a bundle the gateway does not deliver to',
        iosBody(IOS_TOKEN, 'io.kontourai.station.debug'),
      ],
      [
        'a missing APNs environment',
        {
          token: IOS_TOKEN,
          packageName: 'io.kontourai.station',
          platform: 'ios',
        },
      ],
      [
        'an unknown APNs environment',
        iosBody(IOS_TOKEN, 'io.kontourai.station', 'development'),
      ],
      ['a token that is not hex', iosBody(`zz${IOS_TOKEN.slice(2)}`)],
      ['a token shorter than 32 bytes', iosBody('ab'.repeat(31))],
      ['a token longer than 100 bytes', iosBody('ab'.repeat(101))],
      ['a token of odd length', iosBody(`${IOS_TOKEN}a`)],
      ['an FCM token', iosBody(TOKEN_A)],
    ])('rejects %s without storing anything', async (_label, body) => {
      const harness = createHarness();
      const paired = await pairDevice(harness);
      const response = await harness.register(paired.credential, body);
      expect(response.status).toBe(400);
      expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
      expect(existsSync(iosPath(harness))).toBe(false);
      expect(existsSync(harness.keyPath)).toBe(false);
    });

    test('delete and revoke clear the iOS file too', async () => {
      const harness = createHarness();
      const a = await pairDevice(harness, 'A');
      const b = await pairDevice(harness, 'B');
      await harness.register(a.credential, iosBody());
      await harness.register(b.credential, iosBody('cd'.repeat(40)));
      expect((await harness.unregister(a.credential)).status).toBe(200);
      harness.pairing.revokeDevice(b.device.id, 'operator-credential');
      expect(harness.pairing.listNativePushRegistrations()).toEqual([]);
      const file = readFileSync(iosPath(harness), 'utf8');
      expect(file).not.toContain(IOS_TOKEN);
      expect(file).not.toContain('cd'.repeat(40));
    });
  });
});
