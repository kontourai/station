import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH } from '@kontourai/station-contracts/environment-security';
import type { NativeDeviceBindingCandidateV1 } from '@kontourai/station-contracts/native-device-proof';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureDevicePairingPublicRoutes } from '../../../runtime/routes/runtime-routes.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  NativeDeviceProofBindingService,
  NativeDeviceProofOperatorAuthority,
} from '../../../services/ssh/native-device-proof-binding-service.js';
import { createNativeDeviceProofBindingRoutes } from '../native-device-proof-binding-routes.js';

const ORIGIN = 'https://station.example.test';
const makeTempDir = trackTempDirs();
type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function publicKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('missing public key coordinates');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } as const;
}

function thumbprint(jwk: ReturnType<typeof publicKey>): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');
}

async function harness() {
  const home = makeTempDir('station-native-binding-route-');
  const security = new EnvironmentSecurityService({ homeDir: home });
  const { credential: operatorCredential, environmentId } =
    await security.initialize();
  const clientInstanceId = randomUUID();
  const deviceOffer = security.devicePairing.createOffer({ endpoint: ORIGIN });
  const request = security.devicePairing.requestPairing({
    offerId: deviceOffer.offerId,
    proof: deviceOffer.challenge,
    deviceName: 'Native shell fixture',
    requesterPosition: 'off-box',
    clientInstanceId,
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'presented-credential',
  });
  const { device, credential: deviceCredential } =
    security.devicePairing.exchange({
      offerId: deviceOffer.offerId,
      proof: deviceOffer.challenge,
      requestId: request.requestId,
      clientInstanceId,
    });
  const bindings = new NativeDeviceProofBindingService({
    homeDir: home,
    pairing: security.devicePairing,
  });
  const app = new Hono<{ Bindings: TestBindings }>();
  app.use('*', async (context, next) => {
    const credential = context.req
      .header('Authorization')
      ?.replace(/^Bearer /, '');
    if (credential && security.verifyOperatorCredential(credential)) {
      setRuntimeAuthenticatedRequestPrincipal(context.req.raw, {
        kind: 'credential',
        credential,
        authority: 'operator-credential',
        source: 'bearer',
      });
    } else if (
      credential &&
      security.devicePairing.identifyDevice(credential)
    ) {
      const device = security.devicePairing.identifyDevice(credential);
      const locality = security.devicePairing.credentialLocality(credential);
      const mintKind = security.devicePairing.credentialMintKind(credential);
      setRuntimeAuthenticatedRequestPrincipal(context.req.raw, {
        kind: 'credential',
        credential,
        authority: 'device-credential',
        source: 'bearer',
        deviceId: device?.id,
        deviceKind: device?.kind,
        ...(device?.source ? { pairingSource: device.source } : {}),
        ...(locality ? { locality } : {}),
        ...(mintKind ? { mintKind } : {}),
      });
    }
    await next();
  });
  const localGrantSecretPath = join(home, 'runtime', 'local-grant.secret');
  configureDevicePairingPublicRoutes(app as never, security.devicePairing, {
    allowedOrigins: [ORIGIN],
    localGrant: { secretPath: localGrantSecretPath },
    startupIdentity: () => ({ instanceId: 'route-test', bootId: 'boot-test' }),
  });
  app.route(
    '/api/pairing/native-device-bindings',
    createNativeDeviceProofBindingRoutes({
      bindings,
      operatorAuthority: new NativeDeviceProofOperatorAuthority(),
      security,
    }),
  );
  const requestRoute = (
    bindingId: string,
    init: RequestInit = {},
    suffix = '/approve',
  ) =>
    app.request(
      `${ORIGIN}/api/pairing/native-device-bindings/${bindingId}${suffix}`,
      init,
    );
  const requestRouteRaw = (bindingId: string, init: RequestInit) => {
    const request = new Request(
      `${ORIGIN}/api/pairing/native-device-bindings/${bindingId}/approve`,
      init,
    );
    return { request, response: app.fetch(request) };
  };
  const mintLocalGrantCredential = async () => {
    const response = await app.request(
      `${ORIGIN}${PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: await readFile(localGrantSecretPath, 'utf8'),
          deviceName: 'Local desktop fixture',
          clientInstanceId: randomUUID(),
        }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as TestBindings,
    );
    if (!response.ok) throw new Error('local-grant fixture could not mint');
    const body = (await response.json()) as { credential: string };
    return body.credential;
  };
  const candidate = (
    bindingId = randomUUID(),
  ): NativeDeviceBindingCandidateV1 => {
    const deviceJwk = publicKey();
    const routeJwk = publicKey();
    return {
      version: 'station-native-device-binding-candidate/v1',
      stationId: environmentId,
      deviceId: device.id,
      bindingId,
      surface: {
        kind: 'station-native',
        appIdentifier: 'station.desktop',
        channel: 'dev',
        clientInstanceId: randomUUID(),
        keyThumbprint: thumbprint(routeJwk),
      },
      deviceProofJwk: deviceJwk,
      deviceProofKeyThumbprint: thumbprint(deviceJwk),
    };
  };
  const bearer = (credential = operatorCredential): RequestInit => ({
    headers: { Authorization: `Bearer ${credential}` },
  });
  return {
    app,
    bindings,
    candidate,
    device,
    deviceCredential,
    mintLocalGrantCredential,
    operatorCredential,
    requestRoute,
    requestRouteRaw,
    security,
    bearer,
  };
}

describe('operator-only native Device proof binding routes', () => {
  test('creates, retries exactly, and reads a public projection with Device-only currentness', async () => {
    const h = await harness();
    const candidate = h.candidate();
    const post = () =>
      h.requestRoute(candidate.bindingId, {
        ...h.bearer(),
        method: 'POST',
        headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'create', candidate }),
      });
    const created = await post();
    expect(created.status).toBe(200);
    expect(created.headers.get('Cache-Control')).toBe('no-store');
    const first = await readJson<{
      data: { binding: Record<string, unknown>; currentDeviceBinding: boolean };
    }>(created);
    expect(first.data.currentDeviceBinding).toBe(true);
    expect(first.data.binding).toMatchObject({
      stationId: candidate.stationId,
      deviceId: candidate.deviceId,
      bindingId: candidate.bindingId,
      deviceProofJwk: candidate.deviceProofJwk,
      deviceProofKeyThumbprint: candidate.deviceProofKeyThumbprint,
      state: 'active',
    });
    expect(first.data.binding).not.toHaveProperty('approvedBy');
    expect(first.data.binding).not.toHaveProperty('deviceScopeAtApproval');
    const retried = await post();
    expect(retried.status).toBe(200);
    expect(await readJson(retried)).toEqual(first);
    const read = await h.requestRoute(candidate.bindingId, h.bearer(), '');
    expect(read.status).toBe(200);
    expect(await readJson(read)).toEqual(first);

    h.security.devicePairing.revokeDevice(h.device.id, 'operator-credential');
    const historical = await h.requestRoute(
      candidate.bindingId,
      h.bearer(),
      '',
    );
    expect(historical.status).toBe(200);
    expect(
      (await readJson<{ data: { currentDeviceBinding: boolean } }>(historical))
        .data.currentDeviceBinding,
    ).toBe(false);
  });

  test('operator revocation preserves the historical record and makes currentness false', async () => {
    const h = await harness();
    const candidate = h.candidate();
    const created = await h.requestRoute(candidate.bindingId, {
      ...h.bearer(),
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create', candidate }),
    });
    expect(created.status).toBe(200);
    await created.body?.cancel();
    const revoked = await h.requestRoute(candidate.bindingId, {
      ...h.bearer(),
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'revoke', candidate }),
    });
    expect(revoked.status).toBe(200);
    const response = await readJson<{
      data: {
        binding: { state: string; revocationReason: string };
        currentDeviceBinding: boolean;
      };
    }>(revoked);
    expect(response.data.binding).toMatchObject({
      state: 'revoked',
      revocationReason: 'operator-revoked',
    });
    expect(response.data.currentDeviceBinding).toBe(false);
  });

  test('rejects forged authority, home-possession-only, malformed candidates and ID/key mismatches', async () => {
    const h = await harness();
    const candidate = h.candidate();
    const withoutCredential = await h.requestRoute(candidate.bindingId, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Station-Operator': 'true',
        'X-Station-Locality': 'home-possession',
        'X-Station-Native-Device-Proof': 'forged-native-proof',
      },
      body: JSON.stringify({ operation: 'create', candidate }),
    });
    expect(withoutCredential.status).toBe(403);
    const forgedOperatorId = await h.requestRoute(candidate.bindingId, {
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: 'create',
        candidate,
        operatorId: 'human:local:operator',
        proof: 'native-proof',
      }),
    });
    expect(forgedOperatorId.status).toBe(400);
    const deviceToken = await h.requestRoute(candidate.bindingId, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.deviceCredential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation: 'create', candidate }),
    });
    expect(deviceToken.status).toBe(403);

    const wrongPath = await h.requestRoute(randomUUID(), {
      ...h.bearer(),
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create', candidate }),
    });
    expect(wrongPath.status).toBe(400);
    const wrongThumbprint = {
      ...candidate,
      deviceProofKeyThumbprint: 'A'.repeat(43),
    };
    const mismatch = await h.requestRoute(candidate.bindingId, {
      ...h.bearer(),
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create', candidate: wrongThumbprint }),
    });
    expect(mismatch.status).toBe(400);
    const privateKey = {
      ...candidate,
      deviceProofJwk: { ...candidate.deviceProofJwk, d: 'secret' },
    };
    const privateMaterial = await h.requestRoute(candidate.bindingId, {
      ...h.bearer(),
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation: 'create', candidate: privateKey }),
    });
    expect(privateMaterial.status).toBe(400);
    expect(
      h.bindings.bindingById({ bindingId: candidate.bindingId }),
    ).toBeNull();
  });

  test('an actual local-grant credential is still only a Device credential here', async () => {
    const h = await harness();
    const candidate = h.candidate();
    const credential = await h.mintLocalGrantCredential();
    expect(
      h.security.devicePairing.identifyDevice(credential)?.id,
    ).toBeDefined();
    expect(h.security.devicePairing.credentialLocality(credential)).toBe(
      'home-possession',
    );
    expect(h.security.devicePairing.credentialMintKind(credential)).toBe(
      'local-grant',
    );
    const denied = await h.requestRoute(candidate.bindingId, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ operation: 'create', candidate }),
    });
    expect(denied.status).toBe(403);
    expect(
      h.bindings.bindingById({ bindingId: candidate.bindingId }),
    ).toBeNull();
  });

  test('rechecks operator credential after the bounded request body finishes', async () => {
    const h = await harness();
    const candidate = h.candidate();
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let release!: () => void;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull(value) {
        controller = value;
        signalEntered();
        return new Promise<void>((resolve) => {
          release = () => {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ operation: 'create', candidate }),
              ),
            );
            controller.close();
            resolve();
          };
        });
      },
    });
    const responsePromise = h.requestRoute(candidate.bindingId, {
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    await entered;
    await h.security.rotateCredential();
    release();
    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect(
      h.bindings.bindingById({ bindingId: candidate.bindingId }),
    ).toBeNull();
  });

  test('cancels malformed UTF-8 before an unfinished body can hold the route open', async () => {
    const h = await harness();
    const candidate = h.candidate();
    let cancelled = false;
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(Uint8Array.of(0xff));
        } else {
          return new Promise<void>(() => {});
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const { request, response } = h.requestRouteRaw(candidate.bindingId, {
      method: 'POST',
      headers: { ...h.bearer().headers, 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);

    const result = await response;
    expect(result.status).toBe(400);
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
    expect(
      h.bindings.bindingById({ bindingId: candidate.bindingId }),
    ).toBeNull();
  });
});
