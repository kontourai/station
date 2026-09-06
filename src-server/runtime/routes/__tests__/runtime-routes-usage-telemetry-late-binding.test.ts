/**
 * `/api/usage-telemetry/disclosure` 404'd on every fresh boot because
 * `configureRuntimeRoutes` mounted it only `if (context.usageTelemetry)` —
 * and that function runs inside `initializeRuntime`, BEFORE `StationRuntime`
 * constructs the service, so the field is undefined by construction. The route
 * is now mounted unconditionally behind a getter resolved per request.
 *
 * The existing suite for the handler passes a ready service straight in, so it
 * cannot see either half of that: whether the route exists when the service
 * does not, or whether a later-constructed service actually becomes reachable.
 * This drives `configureRuntimeRoutes` itself, on ONE app instance, with the
 * getter flipping between the two requests — the real lifecycle.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import { configureRuntimeRoutes as configureRuntimeRoutesProduction } from '../runtime-routes.js';

const runtimeSupport = vi.hoisted(() => {
  const service = new Proxy({}, { get: () => () => undefined });
  return {
    notificationService: { list: vi.fn(() => [] as unknown[]) },
    service,
  };
});

vi.mock('../runtime-route-support.js', () => ({
  configureRuntimeSupportServices: () => ({
    schedulerService: runtimeSupport.service,
    notificationService: runtimeSupport.notificationService,
    attentionProjection: runtimeSupport.service,
    webPushService: runtimeSupport.service,
    webPushEnabled: true,
  }),
  createRuntimeSystemRouteDeps: () => runtimeSupport.service,
}));

// The runtime's credential policy has its own boundary suite; this test is
// about route composition, so ingress is a no-op here.
vi.mock('../../bootstrap/runtime-http.js', () => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  LOOPBACK_DEVICE_SESSION_COOKIE: 'station-device',
  SECURE_DEVICE_SESSION_COOKIE: '__Host-station-device',
}));

/**
 * A stand-in for an unstubbed member that is callable at EVERY depth.
 * A one-level proxy answers `deps.a.b()` but throws on `deps.a.b.c()`, so
 * adding a member to a production chain reds every fixture that never named
 * it (station#4283 did exactly that). Self-similarity makes chain depth a
 * non-event for fixtures that do not exercise the chain.
 */
function deepCallable(): unknown {
  const proxy: unknown = new Proxy(() => undefined, {
    // `then` must stay absent. A proxy that answers EVERY property is
    // THENABLE, so `await`ing an unstubbed member calls then(resolve,
    // reject), receives another proxy instead of a settled value, and hangs
    // forever — which is exactly how this shape failed CI at 4m57s against
    // the 5-minute lane budget while passing locally.
    get: (_target, property) => (property === 'then' ? undefined : proxy),
    apply: () => proxy,
  });
  return proxy;
}

function runtimeContext(
  app: Hono,
  homeDir: string,
  overrides: Record<string, unknown>,
) {
  const fallback = new Proxy(
    {
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {},
      configLoader: {
        getProjectHomeDir: () => homeDir,
        loadAppConfig: () => ({}),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      activeAgents: new Map(),
      agentMetadataMap: new Map(),
      agentFixedTokens: new Map(),
      agentTools: new Map(),
      agentStats: new Map(),
      agentStatus: new Map(),
      memoryAdapters: new Map(),
      metricsLog: [],
      monitoringEvents: [],
      orchestrationEventStore: new Proxy(
        {
          sessionTurnBoundaryAuthority: () => ({
            reconcile: () => ({ kind: 'available', interrupted: [] }),
          }),
        },
        {
          get(target, property) {
            if (property in target) return Reflect.get(target, property);
            return deepCallable();
          },
        },
      ),
      taskGraphService: { listTasks: () => [] },
      ...overrides,
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        return deepCallable();
      },
    },
  );
  Reflect.set(fallback as object, 'buildRuntimeContext', () => fallback);
  return fallback as never;
}

function loopbackEnv() {
  return { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never;
}

const disclosure = {
  acknowledged: false,
  inventoryRevision: 'inventory-revision',
  events: { station_started: { description: 'Starts', properties: {} } },
};

describe('configureRuntimeRoutes — late-bound usage telemetry disclosure', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('answers 503 while the service is unconstructed, then 200 once the SAME app resolves it', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'station-usage-telemetry-'));
    directories.push(homeDir);
    const app = new Hono();

    // Exactly the production lifecycle: `configureRuntimeRoutes` runs first
    // and the service does not exist yet.
    let usageTelemetry: UsageTelemetryService | undefined;
    const result = configureRuntimeRoutesProduction(
      runtimeContext(app, homeDir, {
        usageTelemetry: undefined,
        getUsageTelemetry: () => usageTelemetry,
      }),
    );
    await result.kitLifecycleReady;

    const beforeReady = await app.request(
      '/api/usage-telemetry/disclosure',
      undefined,
      loopbackEnv(),
    );
    // The route EXISTS (this is the 404 the UI met on every fresh boot) and
    // says honestly that the service is not ready yet.
    expect(beforeReady.status).toBe(503);
    await expect(beforeReady.json()).resolves.toEqual({
      success: false,
      error: { code: 'telemetry_not_ready' },
    });

    // `StationRuntime` finishes constructing it. No re-registration happens in
    // production, and none happens here.
    usageTelemetry = {
      disclosure: vi.fn().mockResolvedValue(disclosure),
      acknowledgeDisclosure: vi.fn().mockResolvedValue(undefined),
    } as unknown as UsageTelemetryService;

    const afterReady = await app.request(
      '/api/usage-telemetry/disclosure',
      undefined,
      loopbackEnv(),
    );
    expect(afterReady.status).toBe(200);
    await expect(afterReady.json()).resolves.toEqual({
      success: true,
      data: disclosure,
    });

    const acknowledged = await app.request(
      '/api/usage-telemetry/disclosure/acknowledgements',
      { method: 'POST' },
      loopbackEnv(),
    );
    expect(acknowledged.status).toBe(200);
  });
});
