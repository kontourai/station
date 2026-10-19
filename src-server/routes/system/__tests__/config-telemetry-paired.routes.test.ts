import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { pairingScopePresetString } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchemaSync } from '../../../domain/home-schema-gate.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { createLogger } from '../../../utils/logger.js';
import { createUsageTelemetryDisclosureRoutes } from '../../operations/usage-telemetry-disclosure.js';
import { createConfigRoutes } from '../config.js';

const makeTempDir = trackTempDirs();

test.each([false, true])(
  'a real standard paired credential keeps migrated legacy Off, lowers Full, and cannot raise or acknowledge (agent marker: %s)',
  async (agentMarker) => {
    const home = makeTempDir('station-paired-telemetry-');
    ensureStationHomeSchemaSync(home);
    mkdirSync(join(home, 'config'), { recursive: true });
    const configPath = join(home, 'config', 'app.json');
    const receiptPath = join(home, 'config', 'usage-telemetry-disclosure.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        telemetryEnabled: false,
      }),
    );
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
      env: {},
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
            ...(agentMarker
              ? { 'x-station-control-origin': 'agent-tool' }
              : {}),
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
      const keep = await call('/config/app', 'PUT', {
        telemetryTier: { operator: 'off' },
      });
      expect(await keep.json()).toMatchObject({
        success: true,
        data: { telemetryTier: { kontour: 'off', operator: 'off' } },
      });
      expect(keep.status).toBe(200);
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
