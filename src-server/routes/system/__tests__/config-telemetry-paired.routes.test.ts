import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { pairingScopePresetString } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { saveAppConfigFile } from '../../../domain/config-loader-app.js';
import { ensureStationHomeSchemaSync } from '../../../domain/home-schema-gate.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createUsageTelemetryDisclosureRoutes } from '../../operations/usage-telemetry-disclosure.js';
import { createConfigRoutes } from '../config.js';

const build = vi.hoisted(() => ({ endpoint: '' }));
vi.mock('../../../domain/telemetry-build-constants.js', () => ({
  get STATION_AUTHOR_TELEMETRY_ENDPOINT() {
    return build.endpoint;
  },
}));
const makeTempDir = trackTempDirs();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  build.endpoint = '';
});

test.each([
  { tier: undefined, legacy: undefined, dnt: '' },
  { tier: 'off', legacy: undefined, dnt: '' },
  { tier: 'lite', legacy: undefined, dnt: '' },
  { tier: 'full', legacy: undefined, dnt: '' },
  { tier: undefined, legacy: 'false', dnt: '' },
  { tier: undefined, legacy: 'true', dnt: '' },
  { tier: 'lite', legacy: 'true', dnt: '1' },
])(
  'a real STANDARD paired device repeats legacy Off with nightly service env (tier=$tier legacy=$legacy DNT=$dnt)',
  async ({ tier, legacy, dnt }) => {
    vi.stubEnv('STATION_CHANNEL', 'nightly');
    vi.stubEnv('STATION_SERVICE_MANAGED', '1');
    vi.stubEnv('STATION_TELEMETRY_TIER', tier);
    vi.stubEnv('STATION_PRODUCT_TELEMETRY_ENABLED', legacy);
    vi.stubEnv('STATION_TELEMETRY_ENABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', dnt);
    vi.stubEnv('STATION_PRODUCT_TELEMETRY_ENDPOINT', undefined);
    vi.stubEnv('STATION_TELEMETRY_ENDPOINT', undefined);
    const home = makeTempDir('station-paired-telemetry-');
    ensureStationHomeSchemaSync(home);
    mkdirSync(join(home, 'config'), { recursive: true });
    const configPath = join(home, 'config', 'app.json');
    const receiptPath = join(home, 'config', 'usage-telemetry-disclosure.json');
    const legacyConfig = {
      defaultModel: '',
      invokeModel: '',
      structureModel: '',
      telemetryEnabled: false,
    };
    await saveAppConfigFile(home, legacyConfig);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(legacyConfig);
    const staleReceipt = JSON.stringify({
      acknowledgedAt: '2026-01-01T00:00:00.000Z',
      inventoryRevision: 'stale',
    });
    writeFileSync(receiptPath, staleReceipt);
    const loader = new ConfigLoader({
      projectHomeDir: home,
      watchFiles: false,
    });
    const security = new EnvironmentSecurityService({ homeDir: home });
    await security.initialize();
    const pairing = security.devicePairing;
    const offer = pairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const pending = pairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Regression phone',
    });
    pairing.confirmRequest(pending.requestId, { kind: 'presented-credential' });
    const paired = pairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
    expect(paired.device.scope).toBe(pairingScopePresetString('standard'));
    const logger = createLogger({
      name: 'paired-telemetry-test',
      level: 'error',
    });
    const app = new Hono<{ Bindings: HttpBindings }>();
    configureRuntimeHttp({
      app: app as never,
      logger,
      eventBus: { emit() {} } as unknown as EventBus,
      security: {
        verifyCredential: (credential, request) =>
          request
            ? security.authorizeCredential(credential, request)
            : security.verifyCredential(credential),
        resolveGrantedScope: (credential) =>
          security.resolveGrantedScope(credential),
        resolveCredentialAuthority: () => 'device-credential',
        resolveCredentialDeviceId: (credential) =>
          security.identifyDevice(credential)?.id,
        resolveCredentialDeviceKind: () => 'device',
        allowedOrigins: [],
      },
    });
    const config = await loader.loadAppConfig();
    const service = new UsageTelemetryService({
      homeDir: home,
      appConfig: config,
      logger,
      version: '1.2.3',
      env: process.env,
    });
    app.route('/config', createConfigRoutes(loader, logger));
    app.route(
      '/api/usage-telemetry',
      createUsageTelemetryDisclosureRoutes(service),
    );
    const call = (path: string, method = 'GET', body?: unknown) =>
      app.request(
        path,
        {
          method,
          headers: {
            Authorization: `Bearer ${paired.credential}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        {
          incoming: { socket: { remoteAddress: '127.0.0.1' } },
        } as HttpBindings,
      );
    try {
      expect(config.telemetryTier).toEqual({ kontour: 'off', operator: 'off' });
      const disclosure = await readJson<{
        data: Awaited<ReturnType<UsageTelemetryService['disclosure']>>;
      }>(await call('/api/usage-telemetry/disclosure'));
      expect(disclosure.data).toMatchObject({
        acknowledged: false,
        endpointConfigured: false,
        publishers: { operator: { tier: 'off' } },
      });
      // Reintroduce the old writer's file after the disclosure read as well:
      // mutation must compare the freshly migrated serialized current value.
      await saveAppConfigFile(home, legacyConfig);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const keep = await call('/config/app', 'PUT', {
          telemetryTier: { operator: 'off' },
        });
        expect(keep.status).toBe(200);
        expect(await keep.json()).toMatchObject({
          success: true,
          data: { telemetryTier: { kontour: 'off', operator: 'off' } },
        });
      }
      for (const tier of ['lite', 'full'])
        expect(
          (
            await call('/config/app', 'PUT', {
              telemetryTier: { operator: tier },
            })
          ).status,
        ).toBe(403);
      await loader.updateAppConfig({ telemetryTier: { operator: 'full' } });
      for (const tier of ['lite', 'off', 'off'])
        expect(
          (
            await call('/config/app', 'PUT', {
              telemetryTier: { operator: tier },
            })
          ).status,
        ).toBe(200);
      expect(
        (
          await call(
            '/api/usage-telemetry/disclosure/acknowledgements',
            'POST',
            {
              acknowledgementProtocol: 2,
              inventoryRevision: disclosure.data.inventoryRevision,
            },
          )
        ).status,
      ).toBe(403);
      expect(readFileSync(receiptPath, 'utf8')).toBe(staleReceipt);
    } finally {
      loader.dispose();
    }
  },
);

async function authorAdmissionFixture(capability = true) {
  vi.stubEnv('DO_NOT_TRACK', '');
  build.endpoint = 'https://author.example.test/events';
  const home = makeTempDir('station-author-admission-');
  ensureStationHomeSchemaSync(home);
  await saveAppConfigFile(home, {
    defaultModel: '',
    invokeModel: '',
    structureModel: '',
    telemetryTier: { kontour: 'lite', operator: 'lite' },
  });
  const loader = new ConfigLoader({ projectHomeDir: home, watchFiles: false });
  const logger = createLogger({ name: 'author-admission', level: 'error' });
  const warn = vi.spyOn(logger, 'warn');
  const service = new UsageTelemetryService({
    homeDir: home,
    appConfig: await loader.loadAppConfig(),
    version: '1.2.3',
    logger,
    env: {},
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
  });
  const security = new EnvironmentSecurityService({ homeDir: home });
  await security.initialize();
  const pair = (scope: string) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope,
    });
    const pending = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: 'Admission test device',
    });
    security.devicePairing.confirmRequest(pending.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: pending.requestId,
    });
  };
  const standard = pair(pairingScopePresetString('standard'));
  const managing = pair(
    `${pairingScopePresetString('standard')} access:manage`,
  );
  const app = new Hono<{ Bindings: HttpBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (credential, request) =>
        request
          ? security.authorizeCredential(credential, request)
          : security.verifyCredential(credential),
      resolveGrantedScope: (credential) =>
        security.resolveGrantedScope(credential),
      resolveCredentialAuthority: () => 'device-credential',
      resolveCredentialDeviceId: (credential) =>
        security.identifyDevice(credential)?.id,
      resolveCredentialDeviceKind: () => 'device',
      allowedOrigins: [],
    },
  });
  let internal = false;
  app.use('*', async (c, next) => {
    if (internal)
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        kind: 'internal',
        credential: 'internal-fixture-credential',
        authority: 'operator-credential',
        source: 'bearer',
      });
    await next();
  });
  const configRoutes = (withCapability: boolean) =>
    createConfigRoutes(
      loader,
      logger,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (config) => {
        void service.reconfigure(config);
      },
      (publisher, reason) => service.recordTierLowering(publisher, reason),
      withCapability ? () => service.canSaveAuthorFull() : undefined,
    );
  app.route('/config', configRoutes(capability));
  const consent = withOperatorPrincipal(
    createUsageTelemetryDisclosureRoutes(service),
  );
  const disclosure = await readJson<{
    data: Awaited<ReturnType<UsageTelemetryService['disclosure']>>;
  }>(await consent.request('/disclosure?publisher=kontour'));
  const acknowledge = (revision = disclosure.data.inventoryRevision) =>
    consent.request('/disclosure/acknowledgements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        publisher: 'kontour',
        destination: disclosure.data.destination,
        inventoryRevision: revision,
        acknowledgementProtocol: 2,
      }),
    });
  const save = (options: { standard?: boolean; marker?: boolean } = {}) =>
    app.request(
      '/config/app',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${options.standard ? standard.credential : managing.credential}`,
          'content-type': 'application/json',
          ...(options.marker
            ? { 'x-station-control-origin': 'agent-tool' }
            : {}),
        },
        body: JSON.stringify({ telemetryTier: { kontour: 'full' } }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as HttpBindings,
    );
  return {
    home,
    loader,
    service,
    warn,
    acknowledge,
    save,
    disclosure: disclosure.data,
    standard,
    managing,
    setInternal: (value: boolean) => {
      internal = value;
    },
    cleanup: async () => {
      await service.shutdown();
      loader.dispose();
    },
  };
}

test.each(['missing', 'stale-revision', 'stale-receipt'] as const)(
  'Kontour Full config admission requires a current destination-bound acknowledgement (%s)',
  async (state) => {
    const f = await authorAdmissionFixture();
    try {
      if (state === 'stale-revision')
        expect((await f.acknowledge('old-disclosure')).status).toBe(409);
      if (state === 'stale-receipt') {
        expect((await f.acknowledge()).status).toBe(200);
        const path = join(
          f.home,
          'config',
          'usage-telemetry-disclosure-kontour.json',
        );
        const receipt = JSON.parse(readFileSync(path, 'utf8'));
        receipt.inventoryRevision = 'old-disclosure';
        writeFileSync(path, JSON.stringify(receipt));
      }
      expect((await f.save()).status).toBe(400);
      expect((await f.loader.loadAppConfig()).telemetryTier?.kontour).toBe(
        'lite',
      );
      expect((await f.service.disclosure('kontour')).acknowledged).toBe(false);
      expect((await f.acknowledge()).status).toBe(200);
      expect((await f.save()).status).toBe(200);
      expect((await f.loader.loadAppConfig()).telemetryTier?.kontour).toBe(
        'full',
      );
      expect((await f.service.telemetryStatus()).publishers.kontour.tier).toBe(
        'full',
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.each([
  'agent marker',
  'internal principal',
  'ungranted paired device',
] as const)(
  'Kontour Full refuses %s with a current acknowledgement and logs a structured 403',
  async (caller) => {
    const f = await authorAdmissionFixture();
    try {
      expect((await f.acknowledge()).status).toBe(200);
      expect((await f.service.disclosure('kontour')).acknowledged).toBe(true);
      f.setInternal(caller === 'internal principal');
      f.warn.mockClear();
      expect(
        (
          await f.save({
            standard: caller === 'ungranted paired device',
            marker: caller === 'agent marker',
          })
        ).status,
      ).toBe(403);
      expect((await f.loader.loadAppConfig()).telemetryTier?.kontour).toBe(
        'lite',
      );
      expect(f.warn.mock.calls).toEqual([
        [
          'App config update refused',
          expect.objectContaining({
            reason: 'telemetry_choice_not_granted',
            principalKind:
              caller === 'internal principal' ? 'internal' : 'credential',
            deviceKind: caller === 'internal principal' ? 'none' : 'device',
          }),
        ],
      ]);
      const diagnostic = JSON.stringify(f.warn.mock.calls);
      for (const secret of [
        f.standard.credential,
        f.managing.credential,
        f.standard.device.id,
        f.managing.device.id,
        build.endpoint,
      ])
        expect(diagnostic).not.toContain(secret);
      f.setInternal(false);
      expect((await f.save()).status).toBe(200);
    } finally {
      await f.cleanup();
    }
  },
);

test('a config route without the runtime author consent capability still refuses Full', async () => {
  const f = await authorAdmissionFixture(false);
  try {
    expect((await f.acknowledge()).status).toBe(200);
    expect((await f.save()).status).toBe(400);
    expect((await f.loader.loadAppConfig()).telemetryTier?.kontour).toBe(
      'lite',
    );
    expect((await f.service.disclosure('kontour')).acknowledged).toBe(true);
  } finally {
    await f.cleanup();
  }
});
