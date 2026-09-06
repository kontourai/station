import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createPersonalHomeAuthorityDatabase } from '../../../runtime/bootstrap/personal-home-authority-database.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createHomeAuthorityRoutes } from '../home-authority-routes.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});
async function fixture() {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const homeDir = mkdtempSync(join(tmpdir(), 'station-home-authority-'));
  homes.push(homeDir);
  const security = new EnvironmentSecurityService({ homeDir });
  const record = await security.initialize();
  const pair = (scope?: string) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://controller.example.test',
      scope,
    });
    const request = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Transfer participant',
    });
    security.devicePairing.confirmRequest(request.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: request.requestId,
    });
  };
  const createApp = (
    getPublicHandshake = () => security.getPublicHandshake(),
    openDatabase?: ReturnType<typeof createPersonalHomeAuthorityDatabase>,
  ) => {
    const app = new Hono();
    configureRuntimeHttp({
      app: app as never,
      logger: createLogger({ name: 'home-authority-test', level: 'error' }),
      eventBus: { emit() {} } as unknown as EventBus,
      security: {
        verifyCredential: (candidate) => security.verifyCredential(candidate),
        resolveGrantedScope: (candidate) =>
          security.resolveGrantedScope(candidate),
        resolveCredentialAuthority: (candidate) =>
          security.verifyOperatorCredential(candidate)
            ? 'operator-credential'
            : 'device-credential',
        resolveCredentialDeviceId: (candidate) =>
          security.identifyDevice(candidate)?.id,
        allowedOrigins: [],
      },
    });
    app.route(
      '/api/home-authority',
      createHomeAuthorityRoutes(
        {
          identifyDevice: (candidate) => security.identifyDevice(candidate),
          verifyOperatorCredential: (candidate) =>
            security.verifyOperatorCredential(candidate),
          devicePairing: security.devicePairing,
          getPublicHandshake,
        },
        openDatabase,
      ),
    );
    return app;
  };
  return { security, record, pair, createApp, homeDir };
}
function request(app: Hono, credential?: string, query = '') {
  return app.request(`/api/home-authority/identity${query}`, {
    headers: credential ? { Authorization: `Bearer ${credential}` } : {},
  });
}
test('real owner-approved pairing identifies only the current transfer participant', async () => {
  const f = await fixture();
  const source = f.pair('home:transfer');
  const target = f.pair('home:transfer');
  const app = f.createApp();
  const response = await request(
    app,
    source.credential,
    '?deviceId=forged&tenantId=other',
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const identity = await response.json();
  expect(identity).toEqual({
    schemaVersion: 'station.paired-home-identity/v1',
    controllerEnvironmentId: f.record.environmentId,
    pairedDeviceId: source.device.id,
    scope: 'personal',
    executionAuthorityTransferred: false,
    executionResumeAvailable: false,
  });
  expect(await (await request(app, target.credential)).json()).toMatchObject({
    pairedDeviceId: target.device.id,
  });
  const reopened = new EnvironmentSecurityService({ homeDir: f.homeDir });
  await reopened.initialize();
  expect(reopened.identifyDevice(source.credential)?.id).toBe(source.device.id);
  f.security.devicePairing.revokeDevice(
    source.device.id,
    'operator-credential',
  );
  expect((await request(app, source.credential)).status).toBe(401);
});
test('anonymous, ordinary paired and operator credentials cannot claim transfer enrollment', async () => {
  const f = await fixture();
  const app = f.createApp();
  expect((await request(app)).status).toBe(401);
  expect((await request(app, f.pair().credential)).status).toBe(403);
  expect((await request(app, f.record.credential)).status).toBe(403);
});
test('revocation during the identity read refuses the stale observation', async () => {
  const f = await fixture();
  const paired = f.pair('home:transfer');
  const app = f.createApp(async () => {
    const handshake = await f.security.getPublicHandshake();
    f.security.devicePairing.revokeDevice(
      paired.device.id,
      'operator-credential',
    );
    return handshake;
  });
  expect((await request(app, paired.credential)).status).toBe(403);
});
test('hosted configuration never borrows the personal pairing registry as tenant membership', async () => {
  const f = await fixture();
  const paired = f.pair('home:transfer');
  const app = f.createApp();
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', '/unused/hosted.json');
  const response = await request(app, paired.credential);
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: { code: 'home_authority_tenant_binding_required' },
  });
});
test('a failed controller read exposes no private error details', async () => {
  const f = await fixture();
  const paired = f.pair('home:transfer');
  const app = f.createApp(async () => {
    throw new Error('private secret or filesystem path');
  });
  const response = await request(app, paired.credential);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: { code: 'home_authority_unavailable' },
  });
});

test.skipIf(process.platform === 'win32')(
  'operator enrollment and participant preparation compose through HTTP and reopen the external store',
  async () => {
    const f = await fixture();
    const directory = mkdtempSync(join(tmpdir(), 'station-controller-store-'));
    homes.push(directory);
    const open = createPersonalHomeAuthorityDatabase(
      f.homeDir,
      join(directory, 'authority.sqlite'),
    );
    const source = f.pair('home:transfer');
    const target = f.pair('home:transfer');
    const stranger = f.pair('home:transfer');
    const app = f.createApp(undefined, open);
    const post = (path: string, credential: string, body: unknown) =>
      app.request(`/api/home-authority${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const owner = {
      sourceDeviceId: source.device.id,
      policyRevision: 'policy-1',
    };
    expect(
      (await post('/channels/channel-1/owner', source.credential, owner))
        .status,
    ).toBe(403);
    expect(
      (await post('/channels/channel-1/owner', f.record.credential, owner))
        .status,
    ).toBe(200);
    expect(
      (
        await post('/channels/channel-1/owner', f.record.credential, {
          ...owner,
          sourceDeviceId: target.device.id,
        })
      ).status,
    ).toBe(409);
    const transfer = {
      channelId: 'channel-1',
      operationId: 'operation-1',
      targetDeviceId: target.device.id,
      policyRevision: 'policy-1',
      expectedRevision: 0,
    };
    expect(
      (
        await post('/transfers', source.credential, {
          ...transfer,
          tenantId: 'forged',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post('/transfers', stranger.credential, transfer)).status,
    ).toBe(403);
    const prepared = await post('/transfers', source.credential, transfer);
    expect(prepared.status).toBe(200);
    expect(await prepared.json()).toMatchObject({
      kind: 'stored',
      value: { phase: 'prepared' },
    });
    const reopened = f.createApp(undefined, open);
    const resolve = (credential: string) =>
      reopened.request('/api/home-authority/transfers/operation-1', {
        headers: { Authorization: `Bearer ${credential}` },
      });
    expect((await resolve(target.credential)).status).toBe(200);
    expect((await resolve(stranger.credential)).status).toBe(403);
    f.security.devicePairing.revokeDevice(
      target.device.id,
      'operator-credential',
    );
    expect((await post('/transfers', source.credential, transfer)).status).toBe(
      403,
    );
    expect(
      (await post('/transfers/operation-1/commit', source.credential, {}))
        .status,
    ).toBe(404);
  },
);

test('decision routes refuse absent configuration and oversized input', async () => {
  const f = await fixture();
  const app = f.createApp();
  const paired = f.pair('home:transfer');
  const response = await app.request('/api/home-authority/channels/channel-1', {
    headers: { Authorization: `Bearer ${paired.credential}` },
  });
  expect(response.status).toBe(503);
  const oversized = await app.request('/api/home-authority/transfers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${paired.credential}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ channelId: 'x'.repeat(4096) }),
  });
  expect(oversized.status).toBe(413);
});
