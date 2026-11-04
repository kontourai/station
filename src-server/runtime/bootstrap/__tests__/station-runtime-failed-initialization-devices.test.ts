import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createLogger } from '../../../utils/logger.js';

const temporaryHome = trackTempDirs();

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
    taskRecordings: {
      dispose: async () => {
        order.push('task recordings');
      },
    },
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
  const home = temporaryHome('runtime-initialize-failure-');
  // Only the lifecycle fields runInitialize and its cleanup read are
  // supplied; nothing here constructs production storage or listeners.
  Object.assign(runtime, {
    logger,
    // Route composition builds the operator-passkey service (#3319), which
    // reads the home but opens its store only on first use.
    configLoader: { getProjectHomeDir: () => home },
    featurePreviews: new FeaturePreviewRegistry(
      home,
      createLogger({ name: 'failed-initialization-preview' }),
    ),
    consentChannel: { trustedOrigin: null },
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
    // Recordings, then browsers and sessions (their producers read the hub), then the SSH
    // hosts and the toolchain; the live-surface registry once every
    // producer has stopped.
    expect(order.filter((step) => step !== 'plugin drafts')).toEqual([
      'task recordings',
      'browsers',
      'device sessions',
      'device hosts',
      'device toolchain',
      'live surfaces',
    ]);
    for (const field of [
      'browserService',
      'taskRecordings',
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
      'task recordings',
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

test.each(['inner-bootstrap', 'post-composition'] as const)(
  'failed initialization revokes the orchestration listener (%s)',
  async (phase) => {
    const store = new EventStore(
      join(temporaryHome('failed-orchestration-'), 'events.sqlite'),
    );
    const listeners = new Set<() => void>();
    const adapter = new GateTestAdapter();
    const service = new OrchestrationService({
      adapterRegistry: {
        ...createGateTestRegistry(adapter),
        onChange: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      eventStore: store,
      eventBus: new EventBus(),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const { initializeRuntime } = await import('../runtime-initialize.js');
    const runtime = failingRuntime();
    if (phase === 'inner-bootstrap') {
      vi.mocked(initializeRuntime).mockImplementationOnce(async (deps) => {
        deps.onOrchestrationServiceCreated?.(service);
        service.initialize();
        expect(listeners.size).toBe(1);
        throw STARTUP_FAILURE;
      });
    } else {
      Object.assign(runtime, {
        orchestrationService: service,
        runInitialize: async () => {
          service.initialize();
          throw STARTUP_FAILURE;
        },
      });
    }
    const shutdown = vi.spyOn(service, 'shutdown');
    if (phase === 'inner-bootstrap') {
      Object.assign(runtime, {
        runtimeSearch: {
          stop() {},
          retireAfterFailedInitialization: async () => {
            // Inner cleanup must revoke subscriptions before retiring its next service.
            expect(shutdown).toHaveBeenCalledTimes(1);
            expect(listeners.size).toBe(0);
            return { state: 'closed' };
          },
        },
      });
    }
    try {
      await expect(runtime.initialize()).rejects.toBe(STARTUP_FAILURE);
      expect(listeners.size).toBe(0);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await service.shutdown();
      store.close();
    }
  },
);
