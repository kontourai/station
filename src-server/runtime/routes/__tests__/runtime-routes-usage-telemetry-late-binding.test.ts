/**
 * `/api/usage-telemetry/disclosure` 404'd on every fresh boot because
 * `configureRuntimeRoutes` mounted it only `if (context.usageTelemetry)` —
 * and that function runs inside `initializeRuntime`, BEFORE `StationRuntime`
 * constructs the service, so the field is undefined by construction. The route
 * is now mounted unconditionally behind a getter resolved per request.
 *
 * A suite that passes a ready service straight into the handler cannot see
 * either half of that: whether the route exists when the service does not, or
 * whether a later-constructed service actually becomes reachable. This drives
 * `configureRuntimeRoutes` itself, on ONE app instance, with the getter
 * flipping between the requests — the real lifecycle. It is also the route's
 * envelope proof; receipt persistence and revision idempotence belong to
 * usage-telemetry-service.test.ts.
 */
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProductTelemetryBatch } from '@kontourai/station-contracts/product-telemetry';
import { PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION } from '@kontourai/station-shared/product-telemetry';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { bindOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { assertRuntimeHttpRouteCoverage } from '../../../security/pairing-route-scopes.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { FileSecretBindingAdministration } from '../../../services/secrets/secret-binding-administration.js';
import {
  FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
  USAGE_TELEMETRY_EVENTS,
} from '../../../services/usage-telemetry-inventory.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import {
  beginOtelExport,
  beginOtelTelemetryDelivery,
  checkOtelTelemetryConnection,
  getOtelTelemetryDeliveryStatus,
} from '../../../telemetry-delivery-state.js';
import type { Logger } from '../../../utils/logger.js';
import { StationRuntime } from '../../bootstrap/station-runtime.js';
import type { AgentConfigurationMutationRunner } from '../../types.js';
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
vi.mock('../../bootstrap/runtime-http.js', async (importOriginal) => ({
  configureRuntimeHttp: () => undefined,
  configureRuntimeRouteClassificationGate: () => undefined,
  // Real: it holds no credential policy, and composition installs it itself.
  installStationEnvelopeMarker: (
    await importOriginal<typeof import('../../bootstrap/runtime-http.js')>()
  ).installStationEnvelopeMarker,
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
      deploymentAuthentication: undefined,
      app,
      port: 4321,
      host: '127.0.0.1',
      appConfig: {
        defaultModel: 'configured-model',
        invokeModel: 'configured-model',
        structureModel: 'configured-model',
      },
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

function writableConfig(config: AppConfig) {
  // First-run transitions and revisioned log levels use separate endpoints.
  const { firstRun: _firstRun, logLevel: _logLevel, ...settings } = config;
  return settings;
}

function configurationRuntime(
  loader: ConfigLoader,
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>,
  appConfig: AppConfig,
) {
  const runtime = Object.create(StationRuntime.prototype);
  Object.assign(runtime, {
    configLoader: loader,
    logger,
    appConfig,
    agentConfigurationRevision: 0,
    agentConfigurationPersistenceRevision: 0,
    agentConfigurationMutationQueue: Promise.resolve(),
    agentConfigurationPersistenceQueue: Promise.resolve(),
    agentConfigurationMutationsClosed: false,
    agentConfigurationActivationDeadlineMs: 10_000,
    configurationReconciliationAttempt: 0,
    configurationReconciliationScheduled: false,
    timers: [],
    runtimeConfigurationSourcesAreLoaded: () => false,
  });
  return runtime;
}

const makeTempDir = trackTempDirs();

const disclosure: Awaited<ReturnType<UsageTelemetryService['disclosure']>> = {
  acknowledged: false,
  inventoryRevision: 'inventory-revision',
  events: USAGE_TELEMETRY_EVENTS,
  envelope: 'Published envelope',
  acknowledgementProtocol: 2,
  endpointConfigured: false,
  telemetryEnabled: false,
  enabledSource: 'config',
  publishers: {
    operator: {
      tier: 'lite',
      reason: 'disclosure',
      userChoice: 'full',
      source: 'config',
    },
    kontour: { tier: 'lite', reason: 'default', source: 'default' },
  },
};

describe('configureRuntimeRoutes — late-bound usage telemetry disclosure', () => {
  test('answers 503 while the service is unconstructed, then 200 once the SAME app resolves it', async () => {
    const homeDir = makeTempDir('station-usage-telemetry-');
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
    assertRuntimeHttpRouteCoverage(app.routes);

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
    for (const [method, path] of [
      ['GET', '/api/usage-telemetry/delivery-status'],
      ['POST', '/api/usage-telemetry/connection-checks/product'],
      ['POST', '/api/usage-telemetry/connection-checks/otel'],
    ]) {
      const pending = await app.request(path, { method }, loopbackEnv());
      expect(pending.status).toBe(503);
      await expect(pending.json()).resolves.toEqual({
        success: false,
        error: { code: 'telemetry_not_ready' },
      });
    }

    // `StationRuntime` finishes constructing it. No re-registration happens in
    // production, and none happens here.
    const fetch = vi.fn();
    const live = new UsageTelemetryService({
      homeDir,
      appConfig: {
        defaultModel: 'configured-model',
        invokeModel: 'configured-model',
        structureModel: 'configured-model',
        telemetryTier: { operator: 'full' },
      },
      version: '1.2.3',
      logger: { warn: vi.fn() },
      env: {
        STATION_TELEMETRY_ENDPOINT: 'https://private-receiver.test/legacy',
        STATION_USAGE_TELEMETRY_KEY: 'private-product-key',
      },
      fetch,
    });
    usageTelemetry = live;
    try {
      const disclosureSpy = vi
        .spyOn(live, 'disclosure')
        .mockResolvedValue(disclosure);
      const acknowledgeDisclosure = vi
        .spyOn(live, 'acknowledgeDisclosure')
        .mockResolvedValue(undefined);
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

      for (const [body, status] of [
        [undefined, 426],
        [
          JSON.stringify({
            acknowledgementProtocol: 1,
            inventoryRevision: disclosure.inventoryRevision,
          }),
          426,
        ],
        [
          JSON.stringify({
            acknowledgementProtocol: 3,
            inventoryRevision: disclosure.inventoryRevision,
          }),
          426,
        ],
        [JSON.stringify({ acknowledgementProtocol: 2 }), 400],
        [
          JSON.stringify({
            acknowledgementProtocol: 2,
            inventoryRevision: 'stale-revision',
          }),
          409,
        ],
      ] as const) {
        const refused = await app.request(
          '/api/usage-telemetry/disclosure/acknowledgements',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            ...(body ? { body } : {}),
          },
          loopbackEnv(),
        );
        expect(refused.status).toBe(status);
        expect(acknowledgeDisclosure).not.toHaveBeenCalled();
      }

      const acknowledged = await app.request(
        '/api/usage-telemetry/disclosure/acknowledgements',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            acknowledgementProtocol: 2,
            inventoryRevision: disclosure.inventoryRevision,
          }),
        },
        loopbackEnv(),
      );
      expect(acknowledged.status).toBe(200);
      expect(acknowledgeDisclosure).toHaveBeenCalledExactlyOnceWith(
        disclosure.inventoryRevision,
      );
      await expect(acknowledged.json()).resolves.toEqual({
        success: true,
        data: disclosure,
      });

      disclosureSpy.mockRestore();
      acknowledgeDisclosure.mockRestore();
      const status = await app.request(
        '/api/usage-telemetry/delivery-status',
        undefined,
        loopbackEnv(),
      );
      expect(status.status).toBe(200);
      expect(status.headers.get('cache-control')).toBe('private, no-store');
      const body = await status.json();
      expect(body).toMatchObject({
        success: true,
        data: {
          protocol: 'station-telemetry-delivery/v1',
          product: {
            scope: 'current-process',
            phase: 'awaiting-disclosure',
            endpointConfigured: true,
            keyConfigured: true,
            disclosureAcknowledged: false,
            queued: 0,
            counts: { buffered: 0, acknowledged: 0, attempts: 0 },
          },
          otel: { scope: 'current-process', downstreamDelivery: 'unverified' },
        },
      });
      expect(JSON.stringify(body)).not.toContain('private-product-key');
      expect(JSON.stringify(body)).not.toContain('private-receiver.test');
      const checked = await app.request(
        '/api/usage-telemetry/connection-checks/product',
        { method: 'POST' },
        loopbackEnv(),
      );
      expect(checked.status).toBe(200);
      await expect(checked.json()).resolves.toMatchObject({
        success: true,
        data: {
          phase: 'unsupported',
          scope: null,
          failure: { code: 'probe_unsupported' },
        },
      });
      const invalid = await app.request(
        '/api/usage-telemetry/connection-checks/unknown',
        { method: 'POST' },
        loopbackEnv(),
      );
      expect(invalid.status).toBe(400);
      expect(fetch).not.toHaveBeenCalled();
      expect((await live.disclosure()).acknowledged).toBe(false);
    } finally {
      await live.shutdown();
    }
  });
});

describe('persisted telemetry configuration during Agent activation', () => {
  const loaders: ConfigLoader[] = [];
  afterEach(async () => {
    for (const loader of loaders.splice(0)) {
      await loader.dispose();
      await loader.whenWatcherClosed();
    }
  });
  // The existing service suite owns receipt validity and exact grants. This
  // boundary owns whether a real saved change reaches those services before
  // the real mutation runner finishes unrelated Agent activation.
  test.each([
    { label: 'disable', update: { telemetryEnabled: false } },
    {
      label: 'replace product destination',
      update: {
        productTelemetryEndpoint: 'https://replacement.test/v1/product/events',
      },
    },
    {
      label: 'clear product reference',
      update: { productTelemetryKeyRef: null },
    },
    {
      label: 'replace collector destination',
      update: { otelTelemetryEndpoint: 'https://replacement-collector.test' },
    },
    {
      label: 'clear collector reference',
      update: { otelTelemetryKeyRef: null },
    },
    { label: 'unchanged writable config round-trip', update: {} },
  ])(
    '$label fences only changed telemetry before held/failing activation',
    async ({ update }) => {
      const homeDir = makeTempDir('station-telemetry-persisted-');
      const loader = new ConfigLoader({
        projectHomeDir: homeDir,
        watchFiles: false,
      });
      loaders.push(loader);
      const logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };
      const initial = await loader.updateAppConfig({
        telemetryEnabled: true,
        productTelemetryEndpoint: 'https://receiver.test/v1/product/events',
        productTelemetryKeyRef: 'product-source',
        otelTelemetryEndpoint: 'https://collector.test',
        otelTelemetryKeyRef: 'otel-source',
      });
      const bindings = new FileSecretBindingAdministration(homeDir, {
        environment: { PRODUCT_KEY: 'private-old-product-key' },
      });
      await bindings.create({
        id: 'product-source',
        name: 'Source',
        authRef: { env: 'PRODUCT_KEY' },
      });
      await bindings.grant({
        id: 'product-source',
        expectedRevision: 1,
        grant: {
          kind: 'instance-telemetry-destination',
          transport: 'product',
          destination: initial.productTelemetryEndpoint!,
        },
      });

      const runtime = configurationRuntime(loader, logger, initial);
      let releaseActivation!: () => void;
      const heldActivation = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      runtime.reloadAgentsFromDisk = vi.fn(async () => {
        await heldActivation;
        throw new Error('injected unrelated Agent activation failure');
      });

      const app = new Hono();
      bindOperatorPrincipal(app);
      let live: UsageTelemetryService | undefined;
      const mounted = configureRuntimeRoutesProduction(
        runtimeContext(app, homeDir, {
          configLoader: loader,
          usageTelemetry: undefined,
          getUsageTelemetry: () => live,
          applyAgentConfigurationMutation:
            runtime.applyAgentConfigurationMutation.bind(runtime),
        }),
      );
      await mounted.kitLifecycleReady;

      let releaseResponse!: () => void;
      let releaseProbe: (() => void) | undefined;
      let probeSignal: AbortSignal | null | undefined;
      let pendingSignal: AbortSignal | null | undefined;
      const accepted = (init?: RequestInit) => {
        const batch = JSON.parse(String(init?.body)) as ProductTelemetryBatch;
        return Response.json(
          {
            receipt: {
              protocol: 'station-product-commit/v1',
              receiptId: '11111111-2222-4333-8444-555555555555',
              sourceId: '22222222-2222-4333-8444-555555555555',
              eventIds: batch.events.map((event) => event.event_id),
              inserted: batch.events.length,
              alreadyPresent: 0,
              storedAt: '2026-10-11T06:00:00.000Z',
            },
          },
          { status: 202 },
        );
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async (_input, init) => accepted(init))
        .mockImplementation(
          (input, init) =>
            new Promise<Response>((resolve) => {
              if (String(input).endsWith('/probes')) {
                probeSignal = init?.signal;
                releaseProbe = () =>
                  resolve(
                    Response.json({
                      probe: {
                        protocol: 'station-product-probe/v1',
                        sourceId: '22222222-2222-4333-8444-555555555555',
                        inventoryRevision:
                          PRODUCT_TELEMETRY_DATA_INVENTORY_REVISION,
                        checkedAt: '2026-10-11T06:00:00.000Z',
                        storage: 'postgres-schema-v1',
                      },
                    }),
                  );
                return;
              }
              pendingSignal = init?.signal;
              // Deliberately ignores cancellation: a late valid receipt must still
              // lose authority when the saved configuration changes.
              releaseResponse = () => resolve(accepted(init));
            }),
        );
      live = new UsageTelemetryService({
        homeDir,
        appConfig: initial,
        version: '1.2.3',
        logger,
        env: {},
        fetch,
        telemetrySecretResolver: bindings,
        setInterval: vi.fn() as typeof setInterval,
      });
      const collector = beginOtelTelemetryDelivery(
        initial.otelTelemetryEndpoint!,
        undefined,
        initial,
      );
      const completeOldExport = beginOtelExport(collector, 'traces');
      let flushing: Promise<void> | undefined;
      let probing:
        | ReturnType<UsageTelemetryService['checkConnection']>
        | undefined;
      let saving: Promise<Response> | undefined;
      try {
        await live.acknowledgeDisclosure(
          FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
        );
        await live.stationStarted();
        await live.flush();
        const acknowledged = await live.deliveryStatus();
        expect(acknowledged.counts.acknowledged).toBe(1);
        expect(acknowledged.lastAcknowledged).not.toBeNull();
        await live.stationStarted();
        flushing = live.flush();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        expect(fetch.mock.calls[1][1]?.headers).toMatchObject({
          'x-api-key': 'private-old-product-key',
        });
        const productDestinationChanged =
          'productTelemetryEndpoint' in update ||
          'productTelemetryKeyRef' in update;
        if (productDestinationChanged) {
          probing = live.checkConnection();
          await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'));
        }
        const before = await live.deliveryStatus();
        const refused = await app.request(
          '/config/app',
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              productTelemetryEndpoint:
                'https://receiver.test/events?key=private',
              telemetryEnabled: false,
            }),
          },
          loopbackEnv(),
        );
        expect(refused.status).toBe(400);
        expect(await loader.loadAppConfig()).toEqual(initial);
        expect(runtime.reloadAgentsFromDisk).not.toHaveBeenCalled();
        expect(pendingSignal?.aborted).toBe(false);
        expect((await live.deliveryStatus()).queued).toBe(1);
        let saveSettled = false;
        saving = Promise.resolve(
          app.request(
            '/config/app',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...writableConfig(initial), ...update }),
            },
            loopbackEnv(),
          ),
        ).then((response) => {
          saveSettled = true;
          return response;
        });
        // Persistence uses real filesystem I/O before activation can enter.
        // This observes entry, not a one-second configuration-save deadline.
        await vi.waitFor(
          () => expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(1),
          { timeout: 10_000 },
        );
        const persisted = await loader.loadAppConfig();
        for (const [key, value] of Object.entries(update)) {
          if (key === 'telemetryEnabled') {
            expect(persisted).not.toHaveProperty('telemetryEnabled');
            expect(persisted.telemetryTier).toEqual({
              kontour: 'off',
              operator: 'off',
            });
          } else
            expect(persisted[key as keyof AppConfig]).toBe(
              value === null ? undefined : value,
            );
        }
        expect(saveSettled).toBe(false);
        expect(runtime.appConfig).toBe(initial);

        const productChanged =
          'telemetryEnabled' in update ||
          'productTelemetryEndpoint' in update ||
          'productTelemetryKeyRef' in update;
        const collectorChanged =
          'otelTelemetryEndpoint' in update || 'otelTelemetryKeyRef' in update;
        const during = await live.deliveryStatus();
        if (productChanged) {
          expect(pendingSignal?.aborted).toBe(true);
          expect(during.queued).toBe('telemetryEnabled' in update ? 0 : 1);
          expect(during.counts.withdrawn).toBe(1);
          if ('telemetryEnabled' in update)
            expect(during.phase).toBe('disabled');
        } else {
          expect(pendingSignal?.aborted).toBe(false);
          expect(during.queued).toBe(collectorChanged ? 2 : 1);
          expect(during.lastAcknowledged).toEqual(before.lastAcknowledged);
        }
        expect(getOtelTelemetryDeliveryStatus().phase).toBe(
          collectorChanged ? 'restart-required' : 'initializing',
        );
        expect(collector.credentialAbort.signal.aborted).toBe(collectorChanged);
        completeOldExport(true);
        expect(getOtelTelemetryDeliveryStatus().traces.accepted).toBe(
          collectorChanged ? 0 : 1,
        );
        if (productDestinationChanged) {
          expect(probeSignal?.aborted).toBe(true);
          releaseProbe!();
          await probing;
          expect((await live.deliveryStatus()).probe.phase).not.toBe('ready');
        }
        releaseResponse();
        await flushing;
        const afterLateReceipt = await live.deliveryStatus();
        expect(afterLateReceipt.counts.acknowledged).toBe(
          productChanged ? 1 : 2,
        );
        expect(fetch).toHaveBeenCalledTimes(productDestinationChanged ? 3 : 2);
        releaseActivation();
        const response = await saving;
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
          configurationActivation: { status: 'pending' },
        });
        if (collectorChanged) {
          const refusedProbe = await checkOtelTelemetryConnection();
          expect(refusedProbe).toMatchObject({
            phase: 'failed',
            failure: { code: 'restart_required' },
          });
          const repeat = await app.request(
            '/config/app',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                writableConfig(await loader.loadAppConfig()),
              ),
            },
            loopbackEnv(),
          );
          expect(repeat.status).toBe(202);
          expect(getOtelTelemetryDeliveryStatus().probe).toEqual(refusedProbe);
          expect(collector.credentialAbort.signal.aborted).toBe(true);
          const restoredBootSettings = await app.request(
            '/config/app',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(writableConfig(initial)),
            },
            loopbackEnv(),
          );
          expect(restoredBootSettings.status).toBe(202);
          expect(getOtelTelemetryDeliveryStatus().phase).toBe(
            'restart-required',
          );
          expect(collector.credentialAbort.signal.aborted).toBe(true);
          completeOldExport(true);
          expect(getOtelTelemetryDeliveryStatus().traces.accepted).toBe(0);
        }
      } finally {
        runtime.agentConfigurationMutationsClosed = true;
        releaseActivation();
        releaseResponse?.();
        releaseProbe?.();
        await Promise.allSettled([saving, flushing, probing]);
        for (const timer of runtime.timers) clearTimeout(timer);
        await runtime.drainConfigurationQueues();
        await live.shutdown();
      }
    },
  );
});

describe('product telemetry constructed after a persisted startup edit', () => {
  const loaders: ConfigLoader[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const loader of loaders.splice(0)) {
      await loader.dispose();
      await loader.whenWatcherClosed();
    }
  });

  test.each([
    {
      label: 'saved disable',
      update: { telemetryEnabled: false },
      acknowledged: true,
      expected: 'disabled',
    },
    {
      label: 'cleared destination',
      update: { productTelemetryEndpoint: null },
      acknowledged: true,
      expected: 'unconfigured',
    },
    {
      label: 'replacement destination',
      update: {
        productTelemetryEndpoint: 'https://replacement.test/v1/product/events',
      },
      acknowledged: true,
      expected: 'acknowledged',
    },
    {
      label: 'replacement reference',
      update: { productTelemetryKeyRef: 'replacement-source' },
      acknowledged: true,
      expected: 'acknowledged',
    },
    {
      label: 'cleared reference',
      update: { productTelemetryKeyRef: null },
      acknowledged: true,
      expected: 'acknowledged',
    },
    {
      label: 'unchanged settings',
      update: {},
      acknowledged: true,
      expected: 'acknowledged',
    },
    {
      label: 'no prior disclosure',
      update: {},
      acknowledged: false,
      expected: 'awaiting-disclosure',
    },
    {
      label: 'stale captured snapshot',
      update: { telemetryEnabled: false },
      acknowledged: true,
      expected: 'disabled',
      staleSnapshot: true,
    },
    {
      label: 'every captured snapshot superseded',
      update: {},
      acknowledged: true,
      expected: 'unavailable',
      unstableSnapshots: true,
    },
    {
      label: 'disable while prior disclosure is loading',
      update: { telemetryEnabled: false },
      acknowledged: true,
      expected: 'disabled',
      heldDisclosure: true,
    },
  ])('$label survives held and failing Agent activation', async (scenario) => {
    const diagnose = 'staleSnapshot' in scenario;
    const started = performance.now();
    const stages: { stage: string; ms: number; error?: unknown }[] = [];
    const knownMessages = new Set([
      'injected unrelated Agent activation failure',
      'App configuration changed while capturing a snapshot.',
      'App configuration changed before product telemetry initialization.',
      'Configuration mutation and runtime reload both failed.',
      'App config updated',
      'Failed to update app config',
      'Configuration activation failed after persistence',
    ]);
    const summarize = (value: unknown) => {
      const message = value instanceof Error ? value.message : value;
      return {
        kind:
          value instanceof TypeError
            ? 'TypeError'
            : value instanceof SyntaxError
              ? 'SyntaxError'
              : value instanceof Error
                ? 'Error'
                : typeof value,
        message:
          typeof message === 'string' && knownMessages.has(message)
            ? message
            : '[content omitted]',
        messageLength: typeof message === 'string' ? message.length : undefined,
        code:
          value instanceof Error &&
          'code' in value &&
          typeof value.code === 'string' &&
          [
            'EACCES',
            'EBUSY',
            'EEXIST',
            'EIO',
            'ENOENT',
            'ENOSPC',
            'EPERM',
            'ETIMEDOUT',
          ].includes(value.code)
            ? value.code
            : undefined,
      };
    };
    const mark = (stage: string, error?: unknown) => {
      if (diagnose && stages.length < 100)
        stages.push({
          stage,
          ms: performance.now() - started,
          ...(error === undefined ? {} : { error: summarize(error) }),
        });
    };
    // Observe settlement without substituting the promise awaited by callers.
    const observe = <T>(stage: string, run: () => Promise<T>): Promise<T> => {
      mark(`${stage}:entry`);
      let promise: Promise<T>;
      try {
        promise = run();
      } catch (error) {
        mark(`${stage}:throw`, error);
        throw error;
      }
      void promise.then(
        () => mark(`${stage}:fulfilled`),
        (error: unknown) => mark(`${stage}:rejected`, error),
      );
      return promise;
    };
    const request: {
      state: 'not-started' | 'pending' | 'fulfilled' | 'rejected';
      status?: number;
      body?: unknown;
      error?: unknown;
    } = { state: 'not-started' };
    const homeDir = makeTempDir('station-late-telemetry-');
    const loader = new ConfigLoader({
      projectHomeDir: homeDir,
      watchFiles: false,
    });
    loaders.push(loader);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const oldDestination = 'https://receiver.test/v1/product/events';
    const initial = await loader.updateAppConfig({
      telemetryEnabled: true,
      productTelemetryEndpoint: oldDestination,
      productTelemetryKeyRef: 'product-source',
    });
    const bindings = new FileSecretBindingAdministration(homeDir, {
      environment: { OLD_KEY: 'private-old-key', NEW_KEY: 'private-new-key' },
    });
    for (const [id, variable] of [
      ['product-source', 'OLD_KEY'],
      ['replacement-source', 'NEW_KEY'],
    ] as const) {
      await bindings.create({ id, name: id, authRef: { env: variable } });
      await bindings.grant({
        id,
        expectedRevision: 1,
        grant: {
          kind: 'instance-telemetry-destination',
          transport: 'product',
          destination: oldDestination,
        },
      });
    }
    await bindings.grant({
      id: 'product-source',
      expectedRevision: 2,
      grant: {
        kind: 'instance-telemetry-destination',
        transport: 'product',
        destination: 'https://replacement.test/v1/product/events',
      },
    });
    if (scenario.acknowledged) {
      const priorProcess = new UsageTelemetryService({
        homeDir,
        appConfig: initial,
        version: '1.2.3',
        logger,
        env: {},
      });
      try {
        await priorProcess.acknowledgeDisclosure(
          FULL_TELEMETRY_ACKNOWLEDGEMENT_REVISION,
        );
      } finally {
        await priorProcess.shutdown();
      }
    }
    for (const key of [
      'STATION_PRODUCT_TELEMETRY_ENDPOINT',
      'STATION_TELEMETRY_ENDPOINT',
      'STATION_PRODUCT_TELEMETRY_KEY',
      'STATION_USAGE_TELEMETRY_KEY',
      'STATION_PRODUCT_TELEMETRY_ENABLED',
      'STATION_TELEMETRY_ENABLED',
    ]) {
      vi.stubEnv(key, undefined);
    }
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const batch = JSON.parse(String(init?.body)) as ProductTelemetryBatch;
      return Response.json(
        {
          receipt: {
            protocol: 'station-product-commit/v1',
            receiptId: '11111111-2222-4333-8444-555555555555',
            sourceId: '22222222-2222-4333-8444-555555555555',
            eventIds: batch.events.map((event) => event.event_id),
            inserted: batch.events.length,
            alreadyPresent: 0,
            storedAt: '2026-10-11T06:00:00.000Z',
          },
        },
        { status: 202 },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = configurationRuntime(loader, logger, initial);
    runtime.secretBindingAdministration = bindings;
    runtime.buildProvenanceSnapshot = null;
    runtime.orchestrationService = { setUsageTelemetry: vi.fn() };
    runtime.eventBus = new EventBus();
    let releaseActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    runtime.reloadAgentsFromDisk = vi.fn(async () => {
      mark('reload:entry');
      await activation;
      const error = new Error('injected unrelated Agent activation failure');
      mark('reload:rejected', error);
      throw error;
    });
    const runMutation: AgentConfigurationMutationRunner =
      runtime.applyAgentConfigurationMutation.bind(runtime);
    const observedMutation: AgentConfigurationMutationRunner = (
      operation,
      options,
    ) =>
      observe('runner', () =>
        runMutation(
          (beginMutation, receipt) =>
            observe('operation', () =>
              operation(() => {
                mark('beginMutation:entry');
                beginMutation();
                mark('beginMutation:return');
              }, receipt),
            ),
          options,
        ),
      );
    if (diagnose) {
      const load = loader.loadAppConfig.bind(loader);
      vi.spyOn(loader, 'loadAppConfig').mockImplementation((...args) =>
        observe('load', () => load(...args)),
      );
      const mutate = loader.mutateAppConfig.bind(loader);
      vi.spyOn(loader, 'mutateAppConfig').mockImplementation((operation) =>
        observe('mutate', () =>
          mutate((current) => {
            mark('mutate-callback:entry');
            const result = operation(current);
            mark('mutate-callback:return');
            return result;
          }),
        ),
      );
    }
    const app = new Hono();
    bindOperatorPrincipal(app);
    const mounted = configureRuntimeRoutesProduction(
      runtimeContext(app, homeDir, {
        configLoader: loader,
        usageTelemetry: undefined,
        getUsageTelemetry: () => runtime.usageTelemetry,
        applyAgentConfigurationMutation: diagnose
          ? observedMutation
          : runMutation,
      }),
    );
    await mounted.kitLifecycleReady;
    let releaseSnapshot: (() => void) | undefined;
    let releaseDisclosure: (() => void) | undefined;
    let disclosureLoading = false;
    let capturedSnapshot = false;
    let capturedRevision: number | undefined;
    const capture = loader.captureAppConfigLaunchabilitySnapshot.bind(loader);
    let supersededSnapshots = 0;
    if ('staleSnapshot' in scenario) {
      vi.spyOn(
        loader,
        'captureAppConfigLaunchabilitySnapshot',
      ).mockImplementationOnce(async () => {
        const snapshot = await observe('snapshot', capture);
        capturedRevision = snapshot.revision;
        capturedSnapshot = true;
        mark('snapshot:held');
        await new Promise<void>((resolve) => {
          releaseSnapshot = () => {
            mark('snapshot:release');
            resolve();
          };
        });
        mark('snapshot:return');
        return snapshot;
      });
    }
    if ('unstableSnapshots' in scenario) {
      vi.spyOn(
        loader,
        'captureAppConfigLaunchabilitySnapshot',
      ).mockImplementation(async () => {
        const snapshot = await capture();
        await loader.updateAppConfig({
          defaultMaxTurns: ++supersededSnapshots,
        });
        return snapshot;
      });
    }
    if ('heldDisclosure' in scenario) {
      const loadDisclosure =
        UsageTelemetryService.prototype.loadDisclosureReceipt;
      vi.spyOn(
        UsageTelemetryService.prototype,
        'loadDisclosureReceipt',
      ).mockImplementationOnce(async function (this: UsageTelemetryService) {
        disclosureLoading = true;
        await new Promise<void>((resolve) => {
          releaseDisclosure = resolve;
        });
        return loadDisclosure.call(this);
      });
    }
    let initializing: Promise<void> | undefined;
    let saving: Promise<Response> | undefined;
    let diagnosticFailure: Error | undefined;
    const checkpoint = () => ({
      stages: [...stages],
      stageLimitReached: stages.length === 100,
      request: { ...request },
      reloadCalls: runtime.reloadAgentsFromDisk.mock.calls.length,
      fetchCalls: fetch.mock.calls.length,
      capturedSnapshot,
      capturedRevision,
      configurationRevision: runtime.agentConfigurationRevision,
      persistenceRevision: runtime.agentConfigurationPersistenceRevision,
      mutationsClosed: runtime.agentConfigurationMutationsClosed,
      logger: Object.fromEntries(
        Object.entries(logger).map(([level, mock]) => [
          level,
          {
            count: mock.mock.calls.length,
            calls: mock.mock.calls.slice(-8).map((args, index, calls) => ({
              order:
                mock.mock.invocationCallOrder[
                  mock.mock.calls.length - calls.length + index
                ],
              message: summarize(args[0]),
              error: summarize(args[1]?.error),
            })),
          },
        ]),
      ),
    });
    try {
      if ('staleSnapshot' in scenario) {
        initializing = observe<void>('initialize', () =>
          runtime.initializeUsageTelemetry(),
        );
        await vi.waitFor(() => expect(capturedSnapshot).toBe(true));
      }
      if ('heldDisclosure' in scenario) {
        initializing = runtime.initializeUsageTelemetry();
        await vi.waitFor(() => expect(disclosureLoading).toBe(true));
      }
      if (diagnose) {
        request.state = 'pending';
        mark('request:entry');
      }
      const saveResponse = Promise.resolve(
        app.request(
          '/config/app',
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...writableConfig(initial),
              ...scenario.update,
            }),
          },
          loopbackEnv(),
        ),
      );
      saving = saveResponse;
      if (diagnose) {
        void saveResponse.then(
          (response) => {
            request.state = 'fulfilled';
            request.status = response.status;
            mark('request:fulfilled');
            request.body = '[pending clone read]';
            try {
              void response
                .clone()
                .json()
                .then(
                  (body: unknown) => {
                    // Never retain the returned config, keys, tokens or arbitrary errors.
                    request.body =
                      body && typeof body === 'object'
                        ? {
                            success: 'success' in body && body.success === true,
                            error: summarize(
                              'error' in body ? body.error : undefined,
                            ),
                            activationPending:
                              'configurationActivation' in body &&
                              body.configurationActivation !== undefined,
                            otherFields: '[omitted]',
                          }
                        : '[non-object body omitted]';
                    mark('request:body-read');
                  },
                  (error: unknown) => {
                    request.body = { readError: summarize(error) };
                    mark('request:body-rejected', error);
                  },
                );
            } catch (error) {
              request.body = { cloneError: summarize(error) };
              mark('request:clone-threw', error);
            }
          },
          (error: unknown) => {
            request.state = 'rejected';
            request.error = summarize(error);
            mark('request:rejected', error);
          },
        );
      }
      mark('reload-wait:entry');
      await vi.waitFor(() =>
        expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(1),
      );
      mark('reload-wait:fulfilled');
      if (!('heldDisclosure' in scenario))
        expect(runtime.usageTelemetry).toBeUndefined();
      expect(runtime.appConfig).toBe(initial);
      const persisted = await loader.loadAppConfig();
      for (const [key, value] of Object.entries(scenario.update)) {
        if (key === 'telemetryEnabled') {
          expect(persisted).not.toHaveProperty('telemetryEnabled');
          expect(persisted.telemetryTier).toEqual({
            kontour: 'off',
            operator: 'off',
          });
        } else
          expect(persisted[key as keyof AppConfig]).toBe(
            value === null ? undefined : value,
          );
      }
      releaseSnapshot?.();
      releaseDisclosure?.();
      initializing ??= runtime.initializeUsageTelemetry();
      if ('unstableSnapshots' in scenario) {
        await expect(initializing).rejects.toThrow(
          'App configuration changed before product telemetry initialization.',
        );
        expect(supersededSnapshots).toBe(3);
        expect(runtime.usageTelemetry).toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
        releaseActivation();
        expect((await saveResponse).status).toBe(202);
        return;
      }
      await initializing;
      const telemetry: UsageTelemetryService = runtime.usageTelemetry;
      await telemetry.stationStarted();
      await telemetry.flush();
      const status = await telemetry.deliveryStatus();
      expect(status.phase).toBe(scenario.expected);
      expect(status.disclosureAcknowledged).toBe(scenario.acknowledged);
      if (scenario.expected === 'acknowledged') {
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(String(fetch.mock.calls[0][0])).toBe(
          persisted.productTelemetryEndpoint,
        );
        expect(
          new Headers(fetch.mock.calls[0][1]?.headers).get('x-api-key'),
        ).toBe(
          persisted.productTelemetryKeyRef === 'replacement-source'
            ? 'private-new-key'
            : persisted.productTelemetryKeyRef
              ? 'private-old-key'
              : null,
        );
      } else {
        expect(fetch).not.toHaveBeenCalled();
        expect(status.queued).toBe(0);
      }
      expect(runtime.appConfig).toBe(initial);
      releaseActivation();
      expect((await saveResponse).status).toBe(202);
    } catch (error) {
      if (!diagnose) throw error;
      mark('test:failed');
      diagnosticFailure = new Error(
        `Stale-snapshot diagnostics before cleanup: ${JSON.stringify(checkpoint())}`,
        { cause: error },
      );
      throw diagnosticFailure;
    } finally {
      mark('cleanup:entry');
      runtime.agentConfigurationMutationsClosed = true;
      mark('activation:release');
      releaseActivation();
      releaseSnapshot?.();
      releaseDisclosure?.();
      const settled = await Promise.allSettled([saving, initializing]);
      if (diagnose)
        settled.forEach((result, index) =>
          mark(
            `cleanup:${index === 0 ? 'request' : 'initialize'}:${result.status}`,
            result.status === 'rejected' ? result.reason : undefined,
          ),
        );
      for (const timer of runtime.timers) clearTimeout(timer);
      await runtime.drainConfigurationQueues();
      await runtime.usageTelemetry?.shutdown();
      if (diagnosticFailure)
        diagnosticFailure.message += `\nAfter cleanup: ${JSON.stringify(checkpoint())}`;
    }
  });
});
