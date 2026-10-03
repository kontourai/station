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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
// #2421: new temp dirs route through the self-removing tracker, not raw
// mkdtempSync — cleanup lands in a vitest hook even when an assertion fails.
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const makeTempDir = trackTempDirs();
const OPERATOR_SECRET = 'trust-settings-operator-fixture';

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

async function composedHarness(
  appConfig: Record<string, unknown>,
  workspacePath?: string,
) {
  let liveAppConfig = appConfig;
  const homeDir = makeTempDir('station-device-hub-setting-');
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
    getLiveAppConfig: () => liveAppConfig,
    configLoader: {
      getProjectHomeDir: () => homeDir,
      loadAppConfig: () => liveAppConfig,
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
    projectService: {
      listProjects: () => [],
      getProject: (slug: string) =>
        workspacePath && slug === 'demo'
          ? { slug, workingDirectory: workspacePath }
          : undefined,
    },
    environmentSecurityService: deepStub({
      verifyCredential: (credential: string) => credential === OPERATOR_SECRET,
      authorizeCredential: (credential: string) =>
        credential === OPERATOR_SECRET,
      verifyOperatorCredential: (credential: string) =>
        credential === OPERATOR_SECRET,
      resolveGrantedScope: () => DEFAULT_GRANT_PAIRING_SCOPE,
      identifyDevice: () => undefined,
      credentialLocality: () => 'home-possession',
      credentialMintKind: () => 'operator',
    }),
  });
  Reflect.set(context as object, 'buildRuntimeContext', () => context);
  const result = await configureRuntimeRoutes(
    context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
  );
  // The composition arms background writers into <home>; let them land
  // before afterEach removes the directory out from under them.
  await result.kitLifecycleReady;
  return {
    ...result,
    app: context.app,
    replaceAppConfig: (next: Record<string, unknown>) => {
      liveAppConfig = next;
    },
  };
}

describe('runtime routes: the device helper address resolves through the settings registry', () => {
  afterEach(() => {
    delete process.env.STATION_MOBILE_DEVICE_HUB_URL;
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

  test('Trust bundle requests follow live Veritas evidence settings without reconstructing routes', async () => {
    const workspace = makeTempDir('station-trust-setting-');
    const evidence = join(workspace, '.kontourai', 'veritas', 'evidence');
    mkdirSync(evidence, { recursive: true });
    writeFileSync(
      join(evidence, 'veritas-settings.json'),
      JSON.stringify({
        trust: {
          bundle: {
            schemaVersion: 5,
            source: 'settings-test',
            claims: [],
            evidence: [],
            policies: [],
            events: [],
          },
        },
      }),
    );
    const result = await composedHarness({}, workspace);
    const readBundles = async () => {
      const response = await result.app.request(
        '/api/projects/demo/trust-bundles',
        {
          headers: { Authorization: `Bearer ${OPERATOR_SECRET}` },
        },
        { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      if (!body || typeof body !== 'object' || !('data' in body)) {
        throw new Error('Trust route did not return its response envelope');
      }
      return body.data;
    };
    try {
      expect(await readBundles()).toEqual([
        expect.objectContaining({
          id: 'veritas-readiness',
          valid: true,
        }),
      ]);
      result.replaceAppConfig({ surfaceTrustFromVeritasEvidence: false });
      expect(await readBundles()).toEqual([]);
      result.replaceAppConfig({ surfaceTrustFromVeritasEvidence: true });
      expect(await readBundles()).toEqual([
        expect.objectContaining({
          id: 'veritas-readiness',
          valid: true,
        }),
      ]);
    } finally {
      await result.deviceToolchainService?.shutdown();
    }
  });
});
