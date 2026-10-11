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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProductTelemetryBatch } from '@kontourai/station-contracts/product-telemetry';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { bindOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileSecretBindingAdministration } from '../../../services/secrets/secret-binding-administration.js';
import { USAGE_TELEMETRY_INVENTORY_REVISION } from '../../../services/usage-telemetry-inventory.js';
import { UsageTelemetryService } from '../../../services/usage-telemetry-service.js';
import {
  beginOtelExport,
  beginOtelTelemetryDelivery,
  getOtelTelemetryDeliveryStatus,
} from '../../../telemetry-delivery-state.js';
import { StationRuntime } from '../../bootstrap/station-runtime.js';
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
    const acknowledgeDisclosure = vi.fn().mockResolvedValue(undefined);
    usageTelemetry = {
      disclosure: vi.fn().mockResolvedValue(disclosure),
      acknowledgeDisclosure,
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

    const fetch = vi.fn();
    const live = new UsageTelemetryService({
      homeDir,
      appConfig: {
        defaultModel: 'configured-model',
        invokeModel: 'configured-model',
        structureModel: 'configured-model',
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
  const homes: Array<{ homeDir: string; loader: ConfigLoader }> = [];
  afterEach(async () => {
    for (const { homeDir, loader } of homes.splice(0)) {
      await loader.dispose();
      await loader.whenWatcherClosed();
      rmSync(homeDir, { recursive: true, force: true });
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
    { label: 'unchanged full settings round-trip', update: {} },
  ])(
    '$label fences only changed telemetry before held/failing activation',
    async ({ update }) => {
      const homeDir = mkdtempSync(
        join(tmpdir(), 'station-telemetry-persisted-'),
      );
      const loader = new ConfigLoader({
        projectHomeDir: homeDir,
        watchFiles: false,
      });
      homes.push({ homeDir, loader });
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

      const runtime = Object.create(StationRuntime.prototype);
      Object.assign(runtime, {
        configLoader: loader,
        logger,
        appConfig: initial,
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
                        inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
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
        await live.acknowledgeDisclosure(USAGE_TELEMETRY_INVENTORY_REVISION);
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
        saving = app
          .request(
            '/config/app',
            {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...initial, ...update }),
            },
            loopbackEnv(),
          )
          .then((response) => {
            saveSettled = true;
            return response;
          });
        await vi.waitFor(() =>
          expect(runtime.reloadAgentsFromDisk).toHaveBeenCalledTimes(1),
        );
        const persisted = await loader.loadAppConfig();
        for (const [key, value] of Object.entries(update)) {
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
          expect(during.queued).toBe(0);
          expect(during.counts.withdrawn).toBe(1);
          if ('telemetryEnabled' in update)
            expect(during.phase).toBe('disabled');
        } else {
          expect(pendingSignal?.aborted).toBe(false);
          expect(during.queued).toBe(1);
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
