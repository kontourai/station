/**
 * The Browser pane's egress deny set must include every Station-owned device
 * port: the managed hub and its helpers (#1970) and each SSH device host's
 * forward and hub port (#1973). This drives the REAL composition —
 * `configureRuntimeRoutes` on a personal host — and reads the browser
 * service it built. The device toolchain and the SSH host registry are the
 * real classes with one member replaced: the ports they report, which a
 * test cannot get from a real hub. What is proved is the WIRING: the
 * composition hands both providers to the browser, read live.
 *
 * (It replaces a source-text check that stayed green with both providers
 * commented out, because a node's text includes its comments.)
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { configureRuntimeRoutes } from '../runtime-routes.js';

const reported = vi.hoisted(() => ({
  toolchain: [] as number[],
  hosts: [] as number[],
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
        override listeningPorts() {
          return reported.toolchain;
        }
      },
    };
  },
);

vi.mock(
  '../../../services/devices/hosts/device-host-registry.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/devices/hosts/device-host-registry.js')
      >();
    return {
      ...actual,
      DeviceHostRegistry: class extends actual.DeviceHostRegistry {
        override listeningPorts() {
          return reported.hosts;
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

describe('runtime routes: the browser deny set includes every device port', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test('the composed browser service denies the managed hub’s and every SSH device host’s ports, read live', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-browser-ports-'));
    directories.push(homeDir);
    mkdirSync(join(homeDir, 'security'), { mode: 0o700 });
    const context = deepStub({
      projectMembership: undefined,
      projectSharedTasks: undefined,
      deploymentAuthentication: undefined,
      localAccounts: undefined,
      applicationSessions: undefined,
      app: new Hono(),
      port: 4321,
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
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
    const result = configureRuntimeRoutes(
      context as unknown as Parameters<typeof configureRuntimeRoutes>[0],
    );
    await result.kitLifecycleReady;
    const browser = result.browserService;
    expect(browser, 'a personal host composes the browser').toBeDefined();
    try {
      reported.toolchain = [51_001, 51_002];
      reported.hosts = [52_001];
      expect(browser!.listeners().ports).toEqual(
        expect.arrayContaining([51_001, 51_002, 52_001]),
      );
      // Read live: a restarted hub and a re-forwarded host move ports.
      reported.toolchain = [53_001];
      reported.hosts = [54_001];
      const ports = browser!.listeners().ports;
      expect(ports).toEqual(expect.arrayContaining([53_001, 54_001]));
      expect(ports).not.toContain(51_001);
      expect(ports).not.toContain(52_001);
    } finally {
      await browser?.shutdown();
      await result.deviceHosts?.dispose();
      await result.deviceToolchainService?.shutdown();
    }
  });
});
