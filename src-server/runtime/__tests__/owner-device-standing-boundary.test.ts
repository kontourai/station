/**
 * Owner-device standing through the real auth boundary (owner decision
 * 2026-11-02): the runtime HTTP middleware, the device-pairing host routes,
 * and the orchestration principal resolver, all over a real Station home.
 * The owner's own standard device pairs a phone and resolves to the owner;
 * a read-only device keeps every refusal.
 */
import type { HttpBindings } from '@hono/node-server';
import { pairingScopePresetString } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { DEVICE_WITHOUT_HOST_SHELL } from '../../__test-utils__/owner-standing.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  isBoundRuntimeLocalOperator,
  isBoundRuntimeOwner,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';
import { createOrchestrationRequestPrincipalResolver } from '../bootstrap/orchestration-request-principal.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';
import { configureDevicePairingHostRoutes } from '../routes/runtime-routes.js';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
};

const makeTempDir = trackTempDirs();

async function harness() {
  const homeDir = makeTempDir('station-owner-boundary-');
  const security = new EnvironmentSecurityService({ homeDir, environment: {} });
  await security.initialize();
  const pairing = security.devicePairing;
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger: silentLogger,
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      allowedOrigins: [],
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      recognizeCredential: (credential) =>
        security.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
      resolveCredentialAuthority: (credential) =>
        security.verifyOperatorCredential(credential)
          ? 'operator-credential'
          : security.identifyDevice(credential)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (credential) =>
        security.identifyDevice(credential)?.id,
      resolveCredentialDeviceKind: (credential) =>
        security.identifyDevice(credential)?.kind,
      resolveCredentialLocality: (credential) =>
        security.credentialLocality(credential),
      resolveCredentialMintKind: (credential) =>
        security.credentialMintKind(credential),
      resolveCredentialOwnerStanding: (credential) =>
        security.credentialHasOwnerStanding(credential),
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const resolvePrincipal = createOrchestrationRequestPrincipalResolver({
    environmentSecurityService: security,
  });
  // A probe behind the real boundary: what this request resolved to.
  app.get('/api/orchestration/sessions', (c) =>
    c.json({
      owner: isBoundRuntimeOwner(c.req.raw),
      local: isBoundRuntimeLocalOperator(c.req.raw),
      principal: resolvePrincipal(c as never).id,
    }),
  );
  // Probes behind the real boundary for the paired-Station chat bridge and
  // peer administration: reaching them means the boundary admitted the call.
  app.post('/api/environments/peers/:id/chat-api/*', (c) =>
    c.json({ relayed: true }),
  );
  app.post('/api/environments/peers', (c) => c.json({ added: true }));
  configureDevicePairingHostRoutes(app as never, pairing, {
    verifyOperatorCredential: (credential) =>
      security.verifyOperatorCredential(credential),
    isRequestPrincipalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
    isApprovalCurrent: (request) =>
      isRuntimeRequestPrincipalCurrent(request, security),
  } as Parameters<typeof configureDevicePairingHostRoutes>[2]);

  const pair = (scope: string) => {
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
    });
    const request = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Phone',
    });
    pairing.confirmRequest(request.requestId, { kind: 'presented-credential' });
    return pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const call = (
    path: string,
    credential: string,
    init: { method?: string; body?: unknown } = {},
  ) =>
    app.request(
      path,
      {
        method: init.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${credential}`,
          ...(init.body !== undefined
            ? { 'Content-Type': 'application/json' }
            : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      // A tailnet peer: the owner's laptop or phone, never this host.
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as TestBindings,
    );
  return { pair, call, pairing };
}

describe('owner-device standing at the real boundary', () => {
  test("the owner's own device resolves to the owner, attributed to itself", async () => {
    const { pair, call } = await harness();
    const laptop = pair(pairingScopePresetString('standard'));
    const response = await call(
      '/api/orchestration/sessions',
      laptop.credential,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      owner: true,
      // Owner standing never claims to be on this host.
      local: false,
      principal: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
  });

  test('a read-only device stays a device', async () => {
    const { pair, call } = await harness();
    const display = pair(pairingScopePresetString('read-only'));
    const response = await call(
      '/api/orchestration/sessions',
      display.credential,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      owner: boolean;
      principal: string;
    };
    expect(body.owner).toBe(false);
    expect(body.principal).not.toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
  });

  test('Pair phone works from an owner device: inventory, requests, and a pre-approved offer', async () => {
    const { pair, call } = await harness();
    const laptop = pair(pairingScopePresetString('standard'));

    const devices = await call('/api/pairing/devices', laptop.credential);
    expect(devices.status).toBe(200);
    const requests = await call('/api/pairing/requests', laptop.credential);
    expect(requests.status).toBe(200);

    const offer = await call('/api/pairing/offers', laptop.credential, {
      method: 'POST',
      body: {
        endpoint: 'http://192.168.50.16:3774',
        scope: pairingScopePresetString('standard'),
        approval: 'on-create',
      },
    });
    expect(offer.status).toBe(201);
    const created = (await offer.json()) as { offerId: string };
    const cancelled = await call(
      `/api/pairing/offers/${encodeURIComponent(created.offerId)}`,
      laptop.credential,
      { method: 'DELETE' },
    );
    expect(cancelled.status).toBe(204);
  });

  test('an owner device still cannot mint a delegation or a protected scope', async () => {
    const { pair, call } = await harness();
    const laptop = pair(pairingScopePresetString('standard'));
    const delegation = await call('/api/pairing/offers', laptop.credential, {
      method: 'POST',
      body: { endpoint: 'https://station.example.test', kind: 'delegation' },
    });
    expect(delegation.status).toBe(403);
    const promoted = await call('/api/pairing/offers', laptop.credential, {
      method: 'POST',
      body: {
        endpoint: 'https://station.example.test',
        scope: 'orchestration:read access:approve',
      },
    });
    expect(promoted.status).toBe(403);
  });

  test('a read-only device keeps the pairing refusals', async () => {
    const { pair, call } = await harness();
    const display = pair(pairingScopePresetString('read-only'));
    expect(
      (await call('/api/pairing/devices', display.credential)).status,
    ).toBe(403);
    expect(
      (
        await call('/api/pairing/offers', display.credential, {
          method: 'POST',
          body: {
            endpoint: 'https://station.example.test',
            approval: 'on-create',
          },
        })
      ).status,
    ).toBe(403);
  });

  test('an owner device chats with a paired Station but cannot administer peers', async () => {
    const { pair, call } = await harness();
    const phone = pair(pairingScopePresetString('standard'));
    const device = pair(DEVICE_WITHOUT_HOST_SHELL);
    const chat =
      '/api/environments/peers/environment-b/chat-api/api/orchestration/chat';
    const sent = await call(chat, phone.credential, {
      method: 'POST',
      body: { message: 'hello' },
    });
    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toEqual({ relayed: true });
    expect(
      (
        await call(
          '/api/environments/peers/environment-b/chat-api/api/orchestration/commands',
          phone.credential,
          { method: 'POST', body: { type: 'interruptTurn' } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call('/api/environments/peers', phone.credential, {
          method: 'POST',
          body: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(chat, device.credential, {
          method: 'POST',
          body: { message: 'hello' },
        })
      ).status,
    ).toBe(403);
  });

  test('revoking the owner device ends its standing on the next request', async () => {
    const { pair, call, pairing } = await harness();
    const laptop = pair(pairingScopePresetString('standard'));
    expect((await call('/api/pairing/devices', laptop.credential)).status).toBe(
      200,
    );
    pairing.revokeDevice(laptop.device.id, 'operator-credential');
    expect((await call('/api/pairing/devices', laptop.credential)).status).toBe(
      401,
    );
  });
});
