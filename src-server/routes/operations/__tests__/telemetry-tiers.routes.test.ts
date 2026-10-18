import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { setGrantedPairingScope } from '../../../security/pairing-route-scopes.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION } from '../../../services/usage-telemetry-inventory.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createUsageTelemetryDisclosureRoutes } from '../usage-telemetry-disclosure.js';

const makeTempDir = trackTempDirs();
test('status uses the live service configuration, respects DNT and never sends', async () => {
  const home = makeTempDir('station-tiers-route-');
  const fetch = vi.fn();
  const subject = new UsageTelemetryService({
    homeDir: home,
    appConfig: {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      telemetryTier: { operator: 'full' },
    },
    version: '1.2.3',
    logger: { warn: vi.fn() },
    env: { DO_NOT_TRACK: '1' },
    fetch,
  });
  const response =
    await createUsageTelemetryDisclosureRoutes(subject).request('/status');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  const body = await response.json();
  expect(body).toMatchObject({
    success: true,
    data: {
      liteInventory: {
        event: { domain: ['station_daily'] },
        public_plugins_enabled: { arrayMax: 20 },
      },
      liteInventoryRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      publishers: {
        kontour: { tier: 'off', reason: 'DNT' },
        operator: { tier: 'off', reason: 'DNT' },
      },
    },
  });
  const acknowledgement = await createUsageTelemetryDisclosureRoutes(
    subject,
  ).request('/disclosure/acknowledgements', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      acknowledgementProtocol: 2,
      inventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
    }),
  });
  expect(acknowledgement.status).toBe(409);
  expect((await subject.disclosure()).acknowledged).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

test('an agent with manage scope cannot acknowledge a pending stored Full choice; a managing device can', async () => {
  const subject = new UsageTelemetryService({
    homeDir: makeTempDir('station-tier-agent-ack-'),
    appConfig: {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      telemetryTier: { operator: 'full' },
    },
    version: '1.2.3',
    logger: { warn: vi.fn() },
    env: {},
    fetch: vi.fn(),
  });
  let agent = true;
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(
      c.req.raw,
      agent
        ? {
            kind: 'internal',
            credential: 'internal-test',
            authority: 'operator-credential',
            source: 'bearer',
          }
        : {
            kind: 'credential',
            credential: 'managing-device',
            authority: undefined,
            deviceId: 'managing-device',
            deviceKind: 'device',
            source: 'bearer',
          },
    );
    setGrantedPairingScope(
      c as never,
      'orchestration:read orchestration:operate access:manage',
    );
    await next();
  });
  app.route('/', createUsageTelemetryDisclosureRoutes(subject));
  const acknowledge = () =>
    app.request('/disclosure/acknowledgements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        acknowledgementProtocol: 2,
        inventoryRevision: FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
      }),
    });
  expect((await subject.disclosure()).acknowledged).toBe(false);
  expect((await acknowledge()).status).toBe(403);
  expect((await subject.disclosure()).acknowledged).toBe(false);
  expect((await subject.telemetryStatus()).publishers.operator).toMatchObject({
    tier: 'lite',
    reason: 'disclosure',
    userChoice: 'full',
  });
  agent = false;
  expect((await acknowledge()).status).toBe(200);
  expect((await subject.disclosure()).acknowledged).toBe(true);
  expect((await subject.telemetryStatus()).publishers.operator.tier).toBe(
    'full',
  );
});

test('environment-only opt-in stays Lite and reports environment even with a current receipt', async () => {
  const subject = new UsageTelemetryService({
    homeDir: makeTempDir('station-tier-env-status-'),
    appConfig: { defaultModel: '', invokeModel: '', structureModel: '' },
    version: '1.2.3',
    logger: { warn: vi.fn() },
    env: { STATION_PRODUCT_TELEMETRY_ENABLED: 'true' },
    fetch: vi.fn(),
  });
  await subject.acknowledgeDisclosure(FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION);
  const response =
    await createUsageTelemetryDisclosureRoutes(subject).request('/status');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: {
      publishers: {
        operator: { tier: 'lite', reason: 'environment', source: 'env' },
      },
    },
  });
});

test.each([undefined, '1'])(
  'Lite receipt status survives service recreation and DNT refuses recording; DNT=%s',
  async (dnt) => {
    const home = makeTempDir('station-notice-status-');
    const options = {
      homeDir: home,
      appConfig: { defaultModel: '', invokeModel: '', structureModel: '' },
      version: '1.2.3',
      logger: { warn: vi.fn() },
      env: dnt ? { DO_NOT_TRACK: dnt } : {},
      fetch: vi.fn(),
    };
    const service = new UsageTelemetryService(options);
    const app = createUsageTelemetryDisclosureRoutes(service);
    expect(await (await app.request('/status')).json()).toMatchObject({
      data: { liteNotices: {} },
    });
    const status = await service.telemetryStatus();
    expect(status.liteNotices).toEqual({});
    const post = (inventoryRevision: string) =>
      app.request('/lite-notices', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publisher: 'operator', inventoryRevision }),
      });
    expect((await post('old-revision')).status).toBe(409);
    expect((await post(status.liteInventoryRevision)).status).toBe(
      dnt ? 409 : 200,
    );
    const restarted = new UsageTelemetryService(options);
    const after = await restarted.telemetryStatus();
    if (dnt) expect(after.liteNotices).toEqual({});
    else
      expect(after.liteNotices.operator).toMatchObject({
        publisher: 'operator',
        inventoryRevision: status.liteInventoryRevision,
        shownAt: expect.any(String),
      });
    expect(options.fetch).not.toHaveBeenCalled();
  },
);
