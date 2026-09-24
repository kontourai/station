import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * #2443: a startup that fails AFTER route composition has built the device
 * services must dispose them, as `shutdown()` does. A device session, the
 * supervised hub and SSH device host sessions/forwards are processes; left
 * behind they live until the next boot's reaper.
 *
 * The real `initialize()` → `runInitialize()` → failure → cleanup path runs.
 * Only the heavyweight owners are replaced: `initializeRuntime` calls the
 * real `configureRoutes` callback and then fails, and `configureRuntimeRoutes`
 * returns recording fakes for the services it would construct.
 */

const order: string[] = [];
const HOSTS_FAILURE = new Error('ssh device host dispose failed');
let failHostsDispose = false;
const STARTUP_FAILURE = new Error('startup failed after route composition');

vi.mock('../runtime-initialize.js', () => ({
  initializeRuntime: vi.fn(
    async (deps: { configureRoutes: (app: unknown) => void }) => {
      deps.configureRoutes({});
      throw STARTUP_FAILURE;
    },
  ),
}));

vi.mock('../runtime-initialize-deps.js', () => ({
  createRuntimeInitializationDeps: (deps: unknown) => deps,
}));

vi.mock('../../routes/runtime-routes.js', () => ({
  configureRuntimeRoutes: () => ({
    kitLifecycleReady: Promise.resolve(),
    browserService: {
      shutdown: async () => {
        order.push('browsers');
      },
    },
    deviceSessions: {
      dispose: async () => {
        order.push('device sessions');
      },
    },
    deviceHosts: {
      dispose: async () => {
        order.push('device hosts');
        if (failHostsDispose) throw HOSTS_FAILURE;
      },
    },
    deviceToolchainService: {
      shutdown: async () => {
        order.push('device toolchain');
      },
    },
    liveSurfaceRegistry: {
      dispose: async () => {
        order.push('live surfaces');
      },
    },
    pluginDraftService: {
      dispose: () => {
        order.push('plugin drafts');
      },
    },
  }),
}));

const { StationRuntime } = await import('../station-runtime.js');

function failingRuntime() {
  const runtime = Object.create(StationRuntime.prototype) as InstanceType<
    typeof StationRuntime
  >;
  const logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
  // Only the lifecycle fields runInitialize and its cleanup read are
  // supplied; nothing here constructs production storage or listeners.
  Object.assign(runtime, {
    logger,
    port: 0,
    host: '127.0.0.1',
    virtualApplicationLifetime: new AbortController(),
    initializeInFlight: null,
    searchRetirementRequired: false,
    searchAdmissionStopped: false,
    runtimeSearch: {
      stop() {},
      retireAfterFailedInitialization: async () => ({ state: 'closed' }),
    },
    environmentSecurityService: {
      initialize: async () => ({ environmentId: 'station-env-1' }),
    },
    relayEnrollment: { recoverBeforeAdmission: async () => {} },
    pluginInstallationHost: {
      reconcile: async () => ({ status: 'ready' }),
    },
    sshEnvironmentService: {
      initialize: async () => {},
      shutdown: async () => {},
    },
    terminalWsStarted: true,
    terminalWsServer: { stop() {} },
    connectionService: {
      migrateLegacyCredentialApplicationsAtStartup: async () => {},
      createCredentialProfileRecoveryAdapter: () => ({}),
    },
    discordGatewayService: { stop: async () => {} },
    pluginOperationalEventSubscriptions: {
      close: async () => ({ kind: 'closed' }),
    },
  });
  return runtime;
}

describe('StationRuntime failed initialization (#2443)', () => {
  beforeEach(() => {
    order.length = 0;
    failHostsDispose = false;
  });

  test('disposes the device services composed before the failure, in shutdown order', async () => {
    const runtime = failingRuntime();
    await expect(runtime.initialize()).rejects.toBe(STARTUP_FAILURE);
    // Browsers, then sessions (their producers read the hub), then the SSH
    // hosts and the toolchain; the live-surface registry once every
    // producer has stopped.
    expect(order.filter((step) => step !== 'plugin drafts')).toEqual([
      'browsers',
      'device sessions',
      'device hosts',
      'device toolchain',
      'live surfaces',
    ]);
    for (const field of [
      'browserService',
      'deviceSessions',
      'deviceHosts',
      'deviceToolchainService',
      'liveSurfaceRegistry',
    ])
      expect(Reflect.get(runtime, field)).toBeUndefined();
  });

  test('a disposal that fails is reported, keeps its field, and the later disposals still run', async () => {
    failHostsDispose = true;
    const runtime = failingRuntime();
    await expect(runtime.initialize()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [STARTUP_FAILURE, HOSTS_FAILURE],
    });
    expect(order.filter((step) => step !== 'plugin drafts')).toEqual([
      'browsers',
      'device sessions',
      'device hosts',
      'device toolchain',
      'live surfaces',
    ]);
    // Kept, so a later shutdown can try it again.
    expect(Reflect.get(runtime, 'deviceHosts')).toBeDefined();
    expect(Reflect.get(runtime, 'deviceSessions')).toBeUndefined();
    expect(Reflect.get(runtime, 'deviceToolchainService')).toBeUndefined();
  });
});
