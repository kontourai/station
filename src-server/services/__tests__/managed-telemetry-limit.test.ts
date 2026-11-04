/**
 * #4521: `limits.telemetry: false` stops usage data at the publisher. Each
 * case runs the real `UsageTelemetryService` against a real HTTP receiver
 * and counts what the receiver got; a control with no policy proves the same
 * calls do send, so a zero is the policy's doing.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { withOperatorPrincipal } from '../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../domain/config-loader.js';
import { createUsageTelemetryDisclosureRoutes } from '../../routes/operations/usage-telemetry-disclosure.js';
import { createConfigRoutes } from '../../routes/system/config.js';
import { installManagedCapabilityLimits } from '../../security/managed-capability-limits.js';
import { createLogger } from '../../utils/logger.js';
import { UsageTelemetryService } from '../usage-telemetry-service.js';

const build = vi.hoisted(() => ({ endpoint: '' }));
vi.mock('../../domain/telemetry-build-constants.js', () => ({
  get STATION_AUTHOR_TELEMETRY_ENDPOINT() {
    return build.endpoint;
  },
}));

const makeTempDir = trackTempDirs();
const services: UsageTelemetryService[] = [];
const servers: Server[] = [];

function policy(limits: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    supportUrl: 'https://help.example/station',
    limits,
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  return { summary: summarizeManagedPolicy(parsed.document) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime('2026-10-12T10:00:00Z');
});
afterEach(async () => {
  installManagedCapabilityLimits(null);
  await Promise.all(services.splice(0).map((service) => service.shutdown()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  build.endpoint = '';
  vi.useRealTimers();
});

/** A destination that records every request body it receives. */
async function receiver() {
  const payloads: unknown[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    payloads.push(body ? JSON.parse(body) : null);
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/product/events`,
    payloads,
  };
}

async function liveService(endpoint: string) {
  const homeDir = makeTempDir('station-managed-telemetry-');
  const config: AppConfig = {
    defaultModel: 'fixture',
    invokeModel: 'fixture',
    structureModel: 'fixture',
    productTelemetryEndpoint: endpoint,
    telemetryTier: { operator: 'lite', kontour: 'lite' },
  };
  const live = new UsageTelemetryService({
    homeDir,
    appConfig: config,
    version: '1.2.3',
    env: {},
    logger: { warn: vi.fn() },
  });
  services.push(live);
  return { live, homeDir, config };
}

/** The Lite notices the publisher recorded as shown, by publisher. */
function recordedNotices(homeDir: string): string[] {
  try {
    const state = JSON.parse(
      readFileSync(join(homeDir, 'config', 'telemetry-daily.json'), 'utf8'),
    ) as { notices?: Record<string, unknown> };
    return Object.keys(state.notices ?? {}).sort();
  } catch {
    return [];
  }
}

/** Everything a running Station sends: daily pings and lowering feedback. */
async function exercise(live: UsageTelemetryService) {
  await live.stationStarted();
  vi.setSystemTime('2026-10-13T10:00:00Z');
  await live.flushDaily();
  await live.flush();
  await live.recordTierLowering('operator', 'privacy');
  await live.recordTierLowering('kontour', 'privacy');
  await live.submitFeedback({
    publisher: 'operator',
    action: 'tier-lowered',
    reason: 'privacy',
  });
}

test('control: without a policy the same calls reach both destinations', async () => {
  const author = await receiver();
  const operator = await receiver();
  build.endpoint = author.endpoint;
  const { live, homeDir } = await liveService(operator.endpoint);
  await exercise(live);
  expect(recordedNotices(homeDir)).toEqual(['kontour', 'operator']);
  expect(author.payloads.length).toBeGreaterThan(0);
  expect(operator.payloads.length).toBeGreaterThan(0);
  expect(operator.payloads).toContainEqual({
    publisher: 'operator',
    action: 'tier-lowered',
    reason: 'privacy',
  });
});

test('limits.telemetry false: no destination receives anything, lowering feedback included', async () => {
  installManagedCapabilityLimits(policy({ telemetry: false }));
  const author = await receiver();
  const operator = await receiver();
  build.endpoint = author.endpoint;
  const { live, homeDir } = await liveService(operator.endpoint);
  await exercise(live);
  // No Lite notice is announced or recorded as shown.
  expect(recordedNotices(homeDir)).toEqual([]);
  expect(author.payloads).toEqual([]);
  expect(operator.payloads).toEqual([]);
  const status = (await live.telemetryStatus()).publishers;
  for (const publisher of ['kontour', 'operator'] as const) {
    expect(status[publisher]).toMatchObject({
      tier: 'off',
      reason: 'managed',
      managedDenial:
        "Acme's policy manages usage sharing: it is turned off. For help, visit https://help.example/station",
    });
  }
});

test('limits.telemetry false outranks a saved Full choice and Do Not Track being off', async () => {
  installManagedCapabilityLimits(policy({ telemetry: false }));
  const operator = await receiver();
  const { live, config } = await liveService(operator.endpoint);
  live.reconfigure({ ...config, telemetryTier: { operator: 'full' } });
  await exercise(live);
  expect(operator.payloads).toEqual([]);
  expect((await live.telemetryStatus()).publishers.operator.reason).toBe(
    'managed',
  );
});

test('PUT /config/app refuses a raise with the managed message; lowering still saves', async () => {
  installManagedCapabilityLimits(policy({ telemetry: false }));
  const operator = await receiver();
  const { live, homeDir, config } = await liveService(operator.endpoint);
  const loader = new ConfigLoader({
    projectHomeDir: homeDir,
    watchFiles: false,
  });
  await loader.loadAppConfig();
  await loader.updateAppConfig({
    ...config,
    telemetryTier: { operator: 'off' },
  });
  const app = withOperatorPrincipal(
    createConfigRoutes(
      loader,
      createLogger({ name: 'managed-telemetry', level: 'error' }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (updated) => live.reconfigure(updated),
    ),
  );
  const put = (tier: string) =>
    app.request('/app', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telemetryTier: { operator: tier } }),
    });
  const raise = await put('lite');
  expect(raise.status).toBe(403);
  expect(await raise.json()).toMatchObject({
    code: MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
    error: expect.stringContaining("Acme's policy manages usage sharing"),
  });
  expect((await loader.loadAppConfig()).telemetryTier?.operator).toBe('off');
  // Keeping or lowering a choice is not a raise.
  expect((await put('off')).status).toBe(200);
  expect(operator.payloads).toEqual([]);
});

test('the connection check contacts nothing while the policy turns telemetry off', async () => {
  installManagedCapabilityLimits(policy({ telemetry: false }));
  const operator = await receiver();
  const { live } = await liveService(operator.endpoint);
  const routes = createUsageTelemetryDisclosureRoutes(live);
  for (const transport of ['product', 'otel']) {
    const response = await routes.request(`/connection-checks/${transport}`, {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code?: string }).code).toBe(
      MANAGED_POLICY_CAPABILITY_DISABLED_CODE,
    );
  }
  expect(operator.payloads).toEqual([]);
});

test('the product delivery status carries the policy sentence, so clients disable the check', async () => {
  const operator = await receiver();
  const { live } = await liveService(operator.endpoint);
  // Control: without a policy there is no sentence.
  expect((await live.deliveryStatus()).managedDenial).toBeUndefined();
  installManagedCapabilityLimits(policy({ telemetry: false }));
  expect((await live.deliveryStatus()).managedDenial).toBe(
    "Acme's policy manages usage sharing: it is turned off. For help, visit https://help.example/station",
  );
});
