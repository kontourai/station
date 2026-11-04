/**
 * #4521: the OTel bootstrap runs before `main()` loads the managed policy, so
 * it reads the policy itself. With `limits.telemetry: false` no exporter is
 * created whatever the environment or the saved endpoint says; asserted at
 * the SDK factory, the only way an exporter comes into being.
 */
import { rm } from 'node:fs/promises';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { ManagedPolicyInvalidError } from '@kontourai/station-shared/managed-policy';
import { createStationTempDir } from '@kontourai/station-shared/temp-dir';
import { metrics, trace } from '@opentelemetry/api';
import { afterEach, expect, test, vi } from 'vitest';
import { ensureStationHomeSchemaSync } from '../domain/home-schema-gate.js';

const homes: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  metrics.disable();
  trace.disable();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function fixture() {
  const homeDir = await createStationTempDir('otel-managed');
  homes.push(homeDir);
  ensureStationHomeSchemaSync(homeDir);
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  vi.stubEnv('STATION_HOME', homeDir);
  vi.stubEnv('STATION_ROOT', '');
  const telemetry = await import('../telemetry.js');
  const delivery = await import('../telemetry-delivery-state.js');
  return { homeDir, ...telemetry, ...delivery };
}

function policy(limits: Record<string, unknown>) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits,
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  return { summary: summarizeManagedPolicy(parsed.document) };
}

/** Every input that would otherwise start an exporter. */
const configured = {
  env: {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.test',
    DO_NOT_TRACK: '',
  },
  appConfig: { otelTelemetryEndpoint: 'https://saved-collector.test' },
};

test('control: with no policy the configured endpoint creates an exporter', async () => {
  const { homeDir, initializeTelemetry } = await fixture();
  const createSdk = vi.fn(() => ({
    start: () => {},
    shutdown: async () => {},
  }));
  await initializeTelemetry({
    ...configured,
    homeDir,
    managedPolicy: () => null,
    createSdk,
    log: () => {},
  });
  expect(createSdk).toHaveBeenCalledTimes(1);
});

test('limits.telemetry false: no exporter, and the status says why', async () => {
  const { homeDir, initializeTelemetry, getOtelTelemetryDeliveryStatus } =
    await fixture();
  const createSdk = vi.fn(() => ({
    start: () => {},
    shutdown: async () => {},
  }));
  await initializeTelemetry({
    ...configured,
    homeDir,
    managedPolicy: () => policy({ telemetry: false }),
    createSdk,
    log: () => {},
  });
  expect(createSdk).not.toHaveBeenCalled();
  const status = getOtelTelemetryDeliveryStatus();
  expect(status.phase).toBe('unconfigured');
  expect(status.managedDenial).toBe(
    "Acme's policy manages telemetry: it is turned off. Contact your administrator for help.",
  );
});

test('a policy that cannot be loaded registers no exporter either', async () => {
  const { homeDir, initializeTelemetry, getOtelTelemetryDeliveryStatus } =
    await fixture();
  const createSdk = vi.fn(() => ({
    start: () => {},
    shutdown: async () => {},
  }));
  await initializeTelemetry({
    ...configured,
    homeDir,
    managedPolicy: () => {
      throw new ManagedPolicyInvalidError('/etc/station/policy.json', 'bad');
    },
    createSdk,
    log: () => {},
  });
  expect(createSdk).not.toHaveBeenCalled();
  expect(getOtelTelemetryDeliveryStatus().phase).toBe('failed');
});

test('other limits leave OTel to the saved configuration', async () => {
  const { homeDir, initializeTelemetry } = await fixture();
  const createSdk = vi.fn(() => ({
    start: () => {},
    shutdown: async () => {},
  }));
  await initializeTelemetry({
    ...configured,
    homeDir,
    managedPolicy: () => policy({ webhookAutomations: false }),
    createSdk,
    log: () => {},
  });
  expect(createSdk).toHaveBeenCalledTimes(1);
});
