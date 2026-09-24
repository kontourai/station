/**
 * The device helper address the runtime composes with (#C5 ui-equivalents):
 * `configureRuntimeRoutes` must feed the settings-registry resolution —
 * stored config first, then the `STATION_MOBILE_DEVICE_HUB_URL` env
 * fallback — into the device toolchain service, not a direct env read. A
 * direct env read is what made the Settings row ("Device helper URL") and
 * its provenance badge describe a value the runtime never consulted.
 *
 * This drives the REAL composition on a personal host and captures the
 * `configuredHubUrl` each construction received. The explicit-endpoint side
 * of the composition consumes the same resolved binding, so capturing the
 * constructor input is capturing the seam.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const constructed = vi.hoisted(() => ({
  configuredHubUrls: [] as (string | undefined)[],
}));

vi.mock(
  '../../../services/devices/toolchain/device-toolchain-service.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/devices/toolchain/device-toolchain-service.js')
      >();
    return {
      ...actual,
      DeviceToolchainService: class extends actual.DeviceToolchainService {
        constructor(
          options: ConstructorParameters<
            typeof actual.DeviceToolchainService
          >[0],
        ) {
          constructed.configuredHubUrls.push(options.configuredHubUrl);
          super(options);
        }
      },
    };
  },
);

vi.mock('../runtime-route-support.js', () => {
  const runtimeSupportStub = new Proxy({}, { get: () => () => undefined });
  return {
    configureRuntimeSupportServices: () => ({
      schedulerService: runtimeSupportStub,
      notificationService: runtimeSupportStub,
      attentionProjection: runtimeSupportStub,
      webPushService: runtimeSupportStub,
      webPushEnabled: false,
    }),
    createRuntimeSystemRouteDeps: () => runtimeSupportStub,
  };
});

/** Answers every unlisted member with an inert, non-thenable proxy. */
function deepStub<T extends object>(overrides: T): T {
  return new Proxy(overrides, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      const proxy: unknown = new Proxy(() => undefined, {
        get: (_target, property) => (property === 'then' ? undefined : proxy),
      });
      return proxy;
    },
  }) as T;
}

async function composedHarness(appConfig: Record<string, unknown>) {
  const homeDir = mkdtempSync(join(tmpdir(), 'station-device-hub-setting-'));
  // The kit-observability registry the composition arms writes its lifecycle
  // ledger under <home>/config; create it or its atomic writes reject.
  mkdirSync(join(homeDir, 'config'), { mode: 0o700 });
  mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
  const context = deepStub({
    projectMembership: undefined,
    projectSharedTasks: undefined,
    deploymentAuthentication: undefined,
    localAccounts: undefined,
    applicationSessions: undefined,
    app: new Hono(),
    port: 4321,
    appConfig,
    getLiveAppConfig: () => appConfig,
    configLoader: {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: () => appConfig,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    activeAgents: new Map(),
    agentService: { listAgents: () => [] },
    agentMetadataMap: new Map(),
    agentFixedTokens: new Map(),
    agentTools: new Map(),
    agentStats: new Map(),
    agentStatus: new Map(),
    memoryAdapters: new Map(),
    metricsLog: [],
    monitoringEvents: [],
    orchestrationEventStore: deepStub({
      sessionTurnBoundaryAuthority: () => ({
        reconcile: () => ({ kind: 'available', interrupted: [] }),
      }),
    }),
    taskGraphService: { listTasks: () => [] },
    projectService: { listProjects: () => [] },
    environmentSecurityService: deepStub({}),
  });
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  const result = await configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  createdHomes.push(homeDir);
  // The composition arms background writers into <home>; let them land
  // before afterEach removes the directory out from under them.
  await result.kitLifecycleReady;
  return result;
}

const createdHomes: string[] = [];

describe('runtime routes: the device helper address resolves through the settings registry', () => {
  afterEach(async () => {
    delete process.env.STATION_MOBILE_DEVICE_HUB_URL;
    for (const directory of createdHomes.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test('an unconfigured Station composes with no explicit hub URL', async () => {
    const result = await composedHarness({});
    expect(constructed.configuredHubUrls.at(-1)).toBeUndefined();
    await result.deviceToolchainService?.shutdown();
  });

  test('the env fallback alone reaches the composition', async () => {
    process.env.STATION_MOBILE_DEVICE_HUB_URL = 'http://0.0.0.0:8433';
    const result = await composedHarness({});
    expect(constructed.configuredHubUrls.at(-1)).toBe('http://0.0.0.0:8433');
    await result.deviceToolchainService?.shutdown();
  });

  test('a stored Station value outranks the env fallback, verbatim', async () => {
    process.env.STATION_MOBILE_DEVICE_HUB_URL = 'http://0.0.0.0:8433';
    const result = await composedHarness({
      mobileDeviceHubUrl: 'http://127.0.0.1:45987',
    });
    expect(constructed.configuredHubUrls.at(-1)).toBe('http://127.0.0.1:45987');
    await result.deviceToolchainService?.shutdown();
  });
});
