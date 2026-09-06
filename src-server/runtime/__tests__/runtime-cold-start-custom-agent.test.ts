/**
 * Regression test for archive#208: a Station home containing one or more custom
 * agents on disk must cold-boot successfully via `StationRuntime.initialize()`
 * — the real production entry point, not a reimplementation of
 * `initializeRuntime()`'s deps in isolation. See the s208-coldstart-appconfig
 * plan for the full root-cause analysis.
 *
 * Root cause: `StationRuntime` only assigned `this.appConfig`/`this.framework`/
 * `this.modelCatalog` at the *tail* of `initialize()`, but `initializeRuntime()`
 * needs all three, mid-flight, through closures bound at construction time —
 * before that tail assignment ever runs. Every custom agent silently failed to
 * load (soft-swallowed by a per-agent try/catch in `initializeRuntimeAgents`).
 *
 * The VoltAgent mock mirrors the dependency's lifecycle boundary: `ready`
 * resolves independently while provider startup runs fire-and-forget. The
 * retry test delays Hono's internal route construction and pins archive#212's
 * invariant that Station awaits the actual provider startup operation.
 *
 * All three network surfaces are mocked or replaced below. This keeps the
 * regression hermetic under Vitest file parallelism; advisory "free port"
 * discovery cannot reserve a port and previously raced other test workers.
 *
 * The filesystem-watch surface is replaced for the same reason. `ConfigLoader`
 * opens a real chokidar watcher during boot, and closing it dominated this
 * file's wall time: with every other shutdown step under 20ms, a single
 * `configLoader.dispose()` measured 1.2s idle and 2.9-4.7s with eight suites
 * running, pushing the first test past Vitest's 5s budget. That cost is
 * macOS's, not Station's — every `fs.watch` handle in a process shares one
 * libuv FSEvents stream, so closing one tears that stream down on a CFRunLoop
 * thread and the latency tracks machine load rather than the (three small,
 * empty) directories being watched. Config hot-reload is not part of the archive#208
 * regression and nothing below asserts on it, so the watcher is faked and
 * `ConfigLoader` itself stays real.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { rmDirSyncRetrying } from '@kontourai/station-shared/fs-windows-compat';
import { createStationHomeBackup } from '@kontourai/station-shared/station-home-archive';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStationHomeSchema } from '../../domain/home-schema-gate.js';
import { getOrchestrationDatabasePath } from '../../domain/migrations/003-orchestration-events.js';
import {
  principalKey,
  UnattendedGrantStore,
} from '../../services/agents/unattended-grant-store.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import type { RuntimeSearch } from '../../services/search/runtime-search.js';
import { USAGE_TELEMETRY_INVENTORY_REVISION } from '../../services/usage-telemetry-inventory.js';

const TEST_PORT = 31_141;
const hostedRegistryFileEnv = 'STATION_HOSTED_TENANT_REGISTRY_FILE';
const originalHostedRegistryFile = process.env[hostedRegistryFileEnv];

async function createSchemaHome(prefix: string): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  await ensureStationHomeSchema(home);
  return home;
}

const routeMocks = vi.hoisted(() => {
  const servicePairs: Array<{
    schedulerService: { stop: ReturnType<typeof vi.fn> };
    notificationService: { shutdown: ReturnType<typeof vi.fn> };
  }> = [];
  const taskDispatches: Array<Promise<unknown>> = [];
  return {
    servicePairs,
    taskDispatches,
    deferServerFactory: false,
    kitLifecycleReady: Promise.resolve(),
    configureRuntimeRoutes: vi.fn((context: any) => {
      // This crosses the same Dispatcher Interface that task routes and
      // capability bindings receive while `initializeRuntime` is still
      // constructing VoltAgent/routes. Before archive#2528's ordering repair this
      // access crashed because StationRuntime assigned the field only after
      // initializeRuntime returned.
      const dispatch = context.taskDispatcher.dispatch(
        '__cold-start-missing__',
        {},
      );
      taskDispatches.push(dispatch);
      const services = {
        schedulerService: { stop: vi.fn(async () => {}) },
        notificationService: { shutdown: vi.fn() },
        kitLifecycleReady: routeMocks.kitLifecycleReady,
      };
      servicePairs.push(services);
      return services;
    }),
  };
});

vi.mock('../routes/runtime-routes.js', () => routeMocks);

// `config-loader.ts` is the only chokidar consumer in the tree, so this
// replaces exactly one thing: the OS handle behind `ConfigLoader`'s config
// hot-reload watcher. See the header note for the measurements.
vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => {}),
  })),
}));

// The sandboxed Vitest process cannot always read its OS birth timestamp.
// Runtime homes use the lifecycle lock, so provide the test process an exact,
// deterministic ownership fingerprint without weakening production locking.
vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      // The stores take the ASYNC lock since archive#2646; overriding only the sync
      // twin left this injection inert and the grants store failing with
      // `store infrastructure failure (ENOENT)`.
      acquireFileMutationLockAsync: (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) =>
        actual.acquireFileMutationLockAsync(lock, {
          ...options,
          birthFingerprint: () => 'runtime-cold-start-test',
        }),
    };
  },
);

vi.mock('@voltagent/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voltagent/core')>();
  return {
    ...actual,
    // Invoke the server provider during construction so a route-service
    // assignment that moves below `new VoltAgent(...)` fails deterministically.
    // Do NOT mock `Agent` — real agent construction inside
    // `framework.createAgent(...)` remains part of the archive#208 proof.
    VoltAgent: vi.fn().mockImplementation(function MockVoltAgent(options: any) {
      const server = options.server?.({});
      const startServer = () => server?.start();
      void startServer();
      return {
        agents: options.agents,
        ready: Promise.resolve(),
        shutdown: vi.fn(async () => {}),
        registerAgent: vi.fn(),
      };
    }),
  };
});

vi.mock('@voltagent/server-hono', () => ({
  honoServer: vi.fn((config: any) => () => {
    return {
      start: vi.fn(async () => {
        if (routeMocks.deferServerFactory) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const handlers = new Proxy({}, { get: () => vi.fn() }) as Record<
          string,
          () => void
        >;
        await config.configureFullApp({
          // The production Hono app exposes this live registration list.
          // Keep the lifecycle harness structurally honest now that startup
          // verifies the completed route surface (archive#2000).
          app: { routes: [] },
          routes: handlers,
          middlewares: handlers,
        });
        return { port: 0 };
      }),
      stop: vi.fn(async () => {}),
      isRunning: vi.fn(() => true),
    };
  }),
}));

vi.mock('../../routes/operations/voice.js', () => ({
  attachVoiceWebSocket: vi.fn(),
}));

vi.mock('../../providers/llm/bedrock.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../providers/llm/bedrock.js')>();
  return {
    ...actual,
    // Real implementation races AWS credential-chain resolution against a 2s
    // timeout; avoid the real IMDS probe latency in CI. Keep
    // `createBedrockProvider` real — it's a lazy, non-network construction
    // used by real agent/model creation inside this test's code path.
    checkBedrockCredentials: vi.fn(async () => false),
  };
});

vi.mock('../bootstrap/runtime-startup.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../bootstrap/runtime-startup.js')>();
  return {
    ...actual,
    // Real implementation does a `fetch` to localhost:11434 with a 2s
    // AbortSignal.timeout — unreachable in CI but still adds latency waiting
    // for the timeout/connection-refused round trip on every run.
    checkOllamaAvailability: vi.fn(async () => false),
  };
});

/**
 * archive#3218. Spied, not stubbed away for convenience: the scheduled
 * store verification has one production caller, and every test of the
 * verification module itself injects both its interval and its probe. With
 * nothing asserting this call, deleting it left that whole corpus green — a
 * silently-unwired scheduler, which after archive#3219 removes the boot check
 * would leave the only detector being a user losing their history.
 *
 * The spy does not delegate. What has to hold here is the WIRING — that the
 * runtime hands over the store it opened and its own teardown list — and the
 * behaviour behind it is proven in
 * `bootstrap/__tests__/store-integrity-verification.test.ts`.
 */
const storeIntegrityVerification = vi.hoisted(() => {
  const stop = vi.fn();
  return {
    start: vi.fn(
      (_context: { timers: NodeJS.Timeout[]; databasePath: string }) => stop,
    ),
    stop,
  };
});
vi.mock('../bootstrap/store-integrity-verification.js', () => ({
  startStoreIntegrityVerification: storeIntegrityVerification.start,
}));

/**
 * station#1586 (item 6, fix round M2): boot fires the engine prerequisite
 * priming, and the real thing resolves the host's `claude` and SPAWNS it for
 * a version probe (plus a credentials read) — inside a suite whose whole
 * point is a hermetic cold boot, after its assertions, on whatever the dev
 * machine happens to have installed. Mocked for the same reason
 * `checkOllamaAvailability` and `checkBedrockCredentials` are above; the
 * priming's own behaviour is proven in
 * `bootstrap/__tests__/engine-prerequisite-priming.test.ts`, and the call
 * recorded here is what proves boot actually performs it.
 */
const enginePrerequisitePriming = vi.hoisted(() => ({
  calls: [] as Array<{ adapters: unknown[]; signal?: AbortSignal }>,
  primeEnginePrerequisites: vi.fn(),
}));
vi.mock('../bootstrap/engine-prerequisite-priming.js', () => ({
  primeEnginePrerequisites: (options: {
    adapters: unknown[];
    signal?: AbortSignal;
  }) => {
    enginePrerequisitePriming.calls.push(options);
    return Promise.resolve();
  },
}));

const { StationRuntime } = await import('../bootstrap/station-runtime.js');
const { BedrockAdapter } = await import(
  '../../providers/adapters/bedrock-adapter.js'
);
const { BedrockModelCatalog } = await import(
  '../../providers/llm/bedrock-models.js'
);
const { OllamaLLMProvider } = await import(
  '../../providers/llm/ollama-provider.js'
);
const { checkBedrockCredentials } = await import(
  '../../providers/llm/bedrock.js'
);
const { honoServer } = await import('@voltagent/server-hono');
const { attachVoiceWebSocket } = await import(
  '../../routes/operations/voice.js'
);
const MCPManager = await import('../mcp/mcp-manager.js');

function replaceTerminalListener(
  runtime: InstanceType<typeof StationRuntime>,
): {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  let running = false;
  const start = vi.fn((port: number, host?: string) => {
    if (running) throw new Error('terminal listener is already running');
    running = true;
    return { port, host };
  });
  const stop = vi.fn(async () => {
    running = false;
  });
  (
    runtime as unknown as {
      terminalWsServer: {
        start: ReturnType<typeof vi.fn>;
        stop: ReturnType<typeof vi.fn>;
      };
    }
  ).terminalWsServer = { start, stop };
  return { start, stop };
}

// archive#1019: these cases cold-boot a real StationRuntime (route services, servers,
// terminal/voice seams) — under parallel vitest workers or a sibling agent
// session on the same host, real spawns starve the 5s default budget and this
// file becomes the dominant source of red local gate runs. 30s is a cap on
// hangs, not an expectation; each case normally finishes well under 5s.
describe('StationRuntime.initialize() — cold boot with a custom agent (#208)', {
  timeout: 30_000,
}, () => {
  let home: string;
  let runtime: InstanceType<typeof StationRuntime> | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.shutdown();
      runtime = undefined;
    }
    if (home) {
      rmDirSyncRetrying(home);
    }
    storeIntegrityVerification.start.mockClear();
    storeIntegrityVerification.stop.mockClear();
    enginePrerequisitePriming.calls.length = 0;
    routeMocks.configureRuntimeRoutes.mockClear();
    routeMocks.servicePairs.length = 0;
    routeMocks.taskDispatches.length = 0;
    routeMocks.deferServerFactory = false;
    routeMocks.kitLifecycleReady = Promise.resolve();
    if (originalHostedRegistryFile === undefined)
      delete process.env[hostedRegistryFileEnv];
    else process.env[hostedRegistryFileEnv] = originalHostedRegistryFile;
  });

  it('rejects an incompatible home before EventStore can create SQLite state', () => {
    home = mkdtempSync(join(tmpdir(), 'station-coldstart-incompatible-'));
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(join(home, 'config', 'app.json'), '{}');

    expect(
      () => new StationRuntime({ projectHomeDir: home, port: TEST_PORT }),
    ).toThrow(/STATION_HOME_RESET_REQUIRED/);
    expect(existsSync(join(home, 'monitoring'))).toBe(false);
    expect(existsSync(join(home, 'config', 'agent-registry.json'))).toBe(false);
  });

  it('shutdown during boot settles the in-flight initialize (#1019)', async () => {
    // The cross-test contamination mode: a cancelled/abandoned boot kept
    // initializing after teardown deleted its home, and its rejection
    // surfaced in whichever test ran next ('custom-writer not found at
    // <another test's home>'). shutdown() must settle the in-flight
    // initialize before tearing anything down.
    home = await createSchemaHome('station-coldstart-quit-');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
        region: 'eu-west-1',
      }),
    );
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    routeMocks.deferServerFactory = true;

    let bootSettled = false;
    const boot = runtime
      .initialize()
      .catch(() => {})
      .finally(() => {
        bootSettled = true;
      });

    await runtime.shutdown();
    // shutdown resolving implies the boot promise already settled — nothing
    // is left racing the (about-to-be-deleted) home directory.
    expect(bootSettled).toBe(true);
    await boot;
  });

  it('primes engine prerequisites once at boot, on a signal shutdown aborts (station#1586)', async () => {
    // The boot wiring itself: the priming module's own suite proves what one
    // prime does, and nothing proved that a real cold boot performs it. It
    // also pins the shutdown coupling — an unsignalled fire-and-forget is
    // what let a boot-time host probe outlive the runtime that started it.
    home = await createSchemaHome('station-coldstart-prime-');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
        region: 'eu-west-1',
      }),
    );
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    vi.spyOn(
      runtime as unknown as { resolveBuiltinEngineBinding: () => unknown },
      'resolveBuiltinEngineBinding',
    ).mockResolvedValue(null);
    vi.spyOn(OllamaLLMProvider.prototype, 'healthCheck').mockResolvedValue(
      false,
    );
    vi.spyOn(MCPManager, 'loadAgentTools').mockResolvedValue([]);

    await expect(runtime.initialize()).resolves.toBeUndefined();

    expect(enginePrerequisitePriming.calls).toHaveLength(1);
    const [primed] = enginePrerequisitePriming.calls;
    // The adapter the runtime itself constructed and registered — priming a
    // different instance would warm a memo no session ever reads.
    expect(primed.adapters).toEqual([
      (runtime as unknown as { claudeAdapter: unknown }).claudeAdapter,
    ]);
    // Live at boot…
    expect(primed.signal).toBeInstanceOf(AbortSignal);
    expect(primed.signal?.aborted).toBe(false);

    await runtime.shutdown();
    runtime = undefined;
    // …and closed by shutdown, so the priming cannot wait on work the runtime
    // no longer has a use for. (It does not kill a probe child already
    // spawned — see `enginePrerequisitePrimingAbort`'s doc.)
    expect(primed.signal?.aborted).toBe(true);
  });

  it('restores a saved usage-telemetry disclosure receipt during runtime bootstrap (#2015)', async () => {
    // This intentionally uses StationRuntime.initialize(), rather than calling
    // UsageTelemetryService.loadDisclosureReceipt() directly: the regression
    // is the production composition edge that invokes that method at boot.
    home = await createSchemaHome('station-telemetry-disclosure-bootstrap-');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'usage-telemetry-disclosure.json'),
      JSON.stringify({
        acknowledgedAt: new Date().toISOString(),
        inventoryRevision: USAGE_TELEMETRY_INVENTORY_REVISION,
      }),
    );
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
        region: 'eu-west-1',
      }),
    );
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    // This receipt-composition proof does not cover native-engine discovery.
    // Match the existing archive#2365 cold-start harness so unavailable sandbox CLIs
    // cannot consume the test's timeout budget.
    vi.spyOn(
      runtime as unknown as { resolveBuiltinEngineBinding: () => unknown },
      'resolveBuiltinEngineBinding',
    ).mockResolvedValue(null);
    vi.spyOn(OllamaLLMProvider.prototype, 'healthCheck').mockResolvedValue(
      false,
    );
    vi.spyOn(MCPManager, 'loadAgentTools').mockResolvedValue([]);

    const outbox = (
      runtime as unknown as {
        orchestrationEventStore: EventStore;
      }
    ).orchestrationEventStore.operationalEventReader();
    let readyWasDurableBeforeNotification = false;
    const unsubscribe = runtime.eventBus.subscribe((notification) => {
      if (notification.event !== SERVER_EVENTS.OPERATIONAL_EVENT) return;
      const page = outbox.readAfter();
      readyWasDurableBeforeNotification =
        page.kind === 'available' &&
        page.events?.some(
          ({ event }) =>
            (event.payload.data as { phase?: unknown }).phase === 'ready',
        ) === true;
    });

    await expect(runtime.initialize()).resolves.toBeUndefined();
    unsubscribe();

    const runtimeInternals = runtime as unknown as {
      usageTelemetry?: { hasCurrentDisclosureReceipt: boolean };
    };
    expect(
      runtimeInternals.usageTelemetry?.hasCurrentDisclosureReceipt,
      'runtime bootstrap did not restore consent from the saved disclosure receipt',
    ).toBe(true);
    expect(readyWasDurableBeforeNotification).toBe(true);
    await runtime.shutdown();
    runtime = undefined;

    const reopened = new EventStore(getOrchestrationDatabasePath(home));
    const lifecycle = reopened.operationalEventReader().readAfter();
    expect(lifecycle.kind).toBe('available');
    if (lifecycle.kind !== 'available')
      throw new Error('expected operational lifecycle history');
    expect(
      lifecycle.events.map(
        ({ event }) => (event.payload.data as { phase: string }).phase,
      ),
    ).toEqual(['ready', 'stopping']);
    reopened.close();
    // No telemetry endpoint is configured in this home, so this is strictly a
    // local receipt-restoration assertion; it does not obtain consent through
    // the HTTP disclosure route or emit an ingestion request.
  });

  it('loads a custom agent and publishes route services before construction (#208/#212)', async () => {
    home = await createSchemaHome('station-coldstart-');
    const agentDir = join(home, 'agents', 'custom-writer');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          name: 'Custom Writer',
          prompt: 'You are a custom writer agent.',
          model: 'anthropic.test-model',
        },
        null,
        2,
      ),
    );
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
        region: 'eu-west-1',
      }),
    );

    const port = TEST_PORT;
    runtime = new StationRuntime({
      projectHomeDir: home,
      port,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    const resolveModelId = vi
      .spyOn(BedrockModelCatalog.prototype, 'resolveModelId')
      .mockResolvedValue('anthropic.test-model');
    const configureLaunchability = vi.spyOn(
      BedrockAdapter.prototype,
      'configureLaunchability',
    );
    // Not `mockResolvedValueOnce`: the startup-migration connection listing
    // (archive#954) now runs `connectionService.listRuntimeConnections()`
    // during boot, which evaluates every registered adapter's readiness —
    // including Bedrock's, which calls this same `checkBedrockCredentials`
    // internally (`bedrock-adapter.ts`). That's a real, additional call
    // ahead of the provider-connection-seeding step this mock originally
    // targeted; a `-Once` value would be consumed there instead, starving
    // seeding and breaking `custom-writer`'s own Bedrock model resolution.
    // The test's intent — "Bedrock credentials are available for this cold
    // boot" — holds regardless of how many times it's checked.
    vi.mocked(checkBedrockCredentials).mockResolvedValue(true);

    // Anchor assertion: cold boot must not throw / reject.
    await expect(runtime.initialize()).resolves.toBeUndefined();

    // Load-bearing assertion: the custom agent must actually be loaded, not
    // silently soft-failed inside `initializeRuntimeAgents`'s per-agent
    // try/catch (the archive#208 symptom — pre-fix this list is missing
    // 'custom-writer' because `appConfig`/`framework` were `undefined` when
    // `buildRuntimeAgentInstance` ran for it).
    expect(runtime.listAgents()).toContain('custom-writer');
    expect(resolveModelId).toHaveBeenCalledWith('anthropic.test-model');
    const launchability = configureLaunchability.mock.calls.at(-1)?.[0];
    expect(launchability).toBeDefined();
    expect((launchability!.llm as unknown as { region: string }).region).toBe(
      'eu-west-1',
    );
    await expect(
      (
        launchability!.modelCatalog as unknown as {
          bedrockClient: { config: { region(): Promise<string> } };
        }
      ).bedrockClient.config.region(),
    ).resolves.toBe('eu-west-1');
    expect(honoServer).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: '127.0.0.1',
        port,
        enableWebSocket: false,
        configureFullApp: expect.any(Function),
      }),
    );
    expect(attachVoiceWebSocket).toHaveBeenCalledWith(
      port + 2,
      expect.anything(),
      '127.0.0.1',
      expect.objectContaining({
        verifyCredential: expect.any(Function),
        limiter: expect.anything(),
      }),
    );
    expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalledTimes(1);
    expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrationService: expect.objectContaining({
          runConnectionSmoke: expect.any(Function),
        }),
        usageAggregator: expect.objectContaining({
          loadStats: expect.any(Function),
        }),
      }),
    );
    await expect(routeMocks.taskDispatches[0]).resolves.toEqual({
      kind: 'not-found',
      reason: 'Task not found: __cold-start-missing__',
    });
    // The graph reached routes through a fully composed Dispatcher. Its
    // project and sidecar readers were captured before runtime initialization,
    // never installed by a route-time ordering protocol.
    const taskGraphService = (
      runtime as unknown as { taskGraphService: object }
    ).taskGraphService;
    expect('setProjectService' in taskGraphService).toBe(false);
    expect('setWorkflowSidecarReader' in taskGraphService).toBe(false);

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    configureLaunchability.mockRestore();
    resolveModelId.mockRestore();
    runtime = undefined;
  });

  it('wires the shared unattended-grant resolver into default and persisted agent hooks (#2365)', async () => {
    // This deliberately boots StationRuntime rather than constructing either
    // hook directly: the regression is the two composition forwards from the
    // runtime-owned resolver into bootstrapRuntimeDefaultAgent and
    // runtimeAgentBuilderContext.
    home = await createSchemaHome('station-unattended-grant-composition-');
    const agentDir = join(home, 'agents', 'custom-writer');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify({
        name: 'Custom Writer',
        prompt: 'You are a custom writer agent.',
        model: 'anthropic.test-model',
      }),
    );
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: 'anthropic.test-model',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
        region: 'eu-west-1',
      }),
    );

    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    // Native-engine readiness probes are unrelated to managed-agent hook
    // composition and can take tens of seconds in the sandbox. Keep the
    // built-in agent on Station's engine, which is the production path this
    // test is exercising.
    vi.spyOn(
      runtime as unknown as { resolveBuiltinEngineBinding: () => unknown },
      'resolveBuiltinEngineBinding',
    ).mockResolvedValue(null);
    vi.mocked(checkBedrockCredentials).mockResolvedValue(true);
    vi.spyOn(BedrockModelCatalog.prototype, 'resolveModelId').mockResolvedValue(
      'anthropic.test-model',
    );
    vi.spyOn(OllamaLLMProvider.prototype, 'healthCheck').mockResolvedValue(
      false,
    );
    // Tool-server process startup is outside this resolver-composition proof;
    // both real agent builders still receive the resulting (empty) tool list.
    vi.spyOn(MCPManager, 'loadAgentTools').mockResolvedValue([]);

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(runtime.listAgents()).toEqual(
      expect.arrayContaining(['default', 'custom-writer']),
    );

    const runtimeInternals = runtime as unknown as {
      agentHooksMap: Map<
        string,
        { beforeToolCall?: (tool: any, invocation: any) => Promise<unknown> }
      >;
      unattendedGrantStore: UnattendedGrantStore;
    };
    const principal = { kind: 'scheduled-job' as const, jobId: 'nightly' };
    const grantedTool = {
      toolName: 'station-control_create_project',
      toolCallId: 'granted-tool',
      toolArgs: { name: 'unattended' },
    };
    await runtimeInternals.unattendedGrantStore.grantTool(
      principalKey(principal),
      grantedTool.toolName,
      'operator',
    );

    for (const agentSlug of ['default', 'custom-writer']) {
      const hooks = runtimeInternals.agentHooksMap.get(agentSlug);
      expect(hooks?.beforeToolCall).toEqual(expect.any(Function));

      await expect(
        hooks!.beforeToolCall!(grantedTool, {
          agentSlug,
          unattendedPrincipal: principal,
        }),
      ).resolves.toBe(true);
      await expect(
        hooks!.beforeToolCall!(
          { ...grantedTool, toolName: 'station-control_delete_project' },
          { agentSlug, unattendedPrincipal: principal },
        ),
      ).resolves.toMatchObject({ allowed: false });
    }
  });

  it('schedules store integrity verification against the store it opened (#3218)', async () => {
    home = await createSchemaHome('station-coldstart-store-integrity-');
    runtime = new StationRuntime({ projectHomeDir: home, port: TEST_PORT });
    replaceTerminalListener(runtime);

    await expect(runtime.initialize()).resolves.toBeUndefined();

    expect(storeIntegrityVerification.start).toHaveBeenCalledTimes(1);
    const context = storeIntegrityVerification.start.mock.calls[0]?.[0];
    expect(context).toBeDefined();
    // The store the EventStore actually opened, not a path re-derived at the
    // timer — two seams naming different files is how a verification passes
    // forever against a database nothing writes.
    expect(context?.databasePath).toBe(getOrchestrationDatabasePath(home));
    // Identity, not equality: the runtime's OWN teardown list is what
    // `shutdownRuntimeServices` clears, and handing over a different array
    // would leave the interval running past shutdown.
    expect(context?.timers).toBe(
      (runtime as unknown as { timers: NodeJS.Timeout[] }).timers,
    );

    // And the disposer is reached on the way down. Clearing the interval only
    // stops the NEXT probe; this is what kills a child that is still reading
    // the store when `gracefulShutdown` calls `process.exit`, which would
    // otherwise reparent it to init.
    expect(storeIntegrityVerification.stop).not.toHaveBeenCalled();
    await runtime.shutdown();
    runtime = undefined;
    expect(storeIntegrityVerification.stop).toHaveBeenCalled();
  });

  it('hosted tenant isolation never binds the unauthorised terminal port', async () => {
    home = await createSchemaHome('station-coldstart-hosted-terminal-');
    const registryPath = join(home, 'hosted-tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
      }),
    );
    process.env[hostedRegistryFileEnv] = registryPath;
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '0.0.0.0',
    });
    const terminalListener = replaceTerminalListener(runtime);

    await expect(runtime.initialize()).resolves.toBeUndefined();

    expect(terminalListener.start).not.toHaveBeenCalled();
  });

  it('external-engine-bound agent records (incl. promoted defaults) do not build managed runtime instances and log no errors (station#954)', async () => {
    home = await createSchemaHome('station-coldstart-external-');
    // Byte-for-byte the zero-override shape a promoted default
    // (`004-default-agents.ts`'s `buildPromotedRecord`) writes for a
    // native connected-runtime connection — this is also exactly the shape
    // a user-created External agent has always had on disk. Both must skip
    // the managed-runtime build path cleanly, not error-and-continue.
    const agentDir = join(home, 'agents', 'claude-code');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'agent.json'),
      JSON.stringify(
        {
          name: 'Claude Code',
          prompt: '',
          description:
            'Direct chat using Claude Code with project working directory context when available.',
          execution: { agentConnectionId: 'claude' },
        },
        null,
        2,
      ),
    );
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        systemPrompt: 'You are {{AGENT_NAME}}.',
        templateVariables: [],
      }),
    );

    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    const logger = (
      runtime as unknown as {
        logger: {
          error: ReturnType<typeof vi.fn>;
          debug: ReturnType<typeof vi.fn>;
        };
      }
    ).logger;
    const errorSpy = vi.spyOn(logger, 'error');
    const debugSpy = vi.spyOn(logger, 'debug');

    await expect(runtime.initialize()).resolves.toBeUndefined();

    // Never attempted as a managed VoltAgent instance — no such build
    // exists to list.
    expect(runtime.listAgents()).not.toContain('claude-code');
    // Cleanly skipped, not error-and-continue: no error log names it.
    expect(errorSpy).not.toHaveBeenCalledWith(
      'Failed to load agent',
      expect.objectContaining({ agent: 'claude-code' }),
    );
    // The skip itself is observable at debug level.
    expect(debugSpy).toHaveBeenCalledWith(
      'Skipping agent record with no instance to build',
      expect.objectContaining({
        agent: 'claude-code',
        agentConnectionId: 'claude',
      }),
    );

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    runtime = undefined;
  });

  it('releases terminal and defers voice when initialization fails, then retries cleanly', async () => {
    home = await createSchemaHome('station-coldstart-retry-');
    const port = TEST_PORT;
    runtime = new StationRuntime({
      projectHomeDir: home,
      port,
      host: '127.0.0.1',
    });
    const terminalListener = replaceTerminalListener(runtime);
    const eventLog = (
      runtime as unknown as {
        eventLog: { loadRecentEvents(): Promise<void> };
      }
    ).eventLog;
    const originalLoad = eventLog.loadRecentEvents.bind(eventLog);
    const failure = new Error('deterministic post-terminal startup failure');
    eventLog.loadRecentEvents = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockImplementation(originalLoad);
    vi.mocked(attachVoiceWebSocket).mockClear();
    routeMocks.deferServerFactory = true;

    await expect(runtime.initialize()).rejects.toBe(failure);
    expect(terminalListener.stop).toHaveBeenCalledTimes(1);
    expect(terminalListener.start).toHaveBeenNthCalledWith(
      1,
      port + 1,
      '127.0.0.1',
    );
    expect(attachVoiceWebSocket).not.toHaveBeenCalled();
    expect(routeMocks.servicePairs).toHaveLength(1);
    const failedVoltAgent = (
      runtime as unknown as {
        voltAgent: { shutdown: ReturnType<typeof vi.fn> };
      }
    ).voltAgent;
    expect(
      routeMocks.servicePairs[0].schedulerService.stop,
    ).toHaveBeenCalledTimes(1);
    expect(
      routeMocks.servicePairs[0].notificationService.shutdown,
    ).toHaveBeenCalledTimes(1);
    expect(failedVoltAgent.shutdown).toHaveBeenCalledTimes(1);

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(terminalListener.start).toHaveBeenNthCalledWith(
      2,
      port + 1,
      '127.0.0.1',
    );
    expect(attachVoiceWebSocket).toHaveBeenCalledTimes(1);
    expect(attachVoiceWebSocket).toHaveBeenCalledWith(
      port + 2,
      expect.anything(),
      '127.0.0.1',
      expect.objectContaining({ verifyCredential: expect.any(Function) }),
    );
  });

  it('failed initialization blocks replacement while search retirement is pending, then a fresh hosted owner really reads', async () => {
    home = await createSchemaHome('station-search-init-retry-');
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: tenantId('alpha'), authority: 'alpha.station.test' }],
    });
    const registryPath = join(home, 'hosted-tenants.json');
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: registry.schemaVersion,
        tenants: registry.tenants,
      }),
    );
    process.env[hostedRegistryFileEnv] = registryPath;
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    const subject = runtime as unknown as {
      eventLog: { loadRecentEvents(): Promise<void> };
      orchestrationEventStore: EventStore;
      runtimeSearch?: RuntimeSearch;
    };
    const originalLoad = subject.eventLog.loadRecentEvents.bind(
      subject.eventLog,
    );
    let oldSearch!: RuntimeSearch;
    let retirementBlocked = true;
    const failure = new Error('post-routes search retry fixture');
    subject.eventLog.loadRecentEvents = vi
      .fn()
      .mockImplementationOnce(async () => {
        oldSearch = subject.runtimeSearch!;
        const retire =
          oldSearch.retireAfterFailedInitialization.bind(oldSearch);
        vi.spyOn(
          oldSearch,
          'retireAfterFailedInitialization',
        ).mockImplementation(() =>
          retirementBlocked
            ? Promise.resolve({ state: 'winding-down' })
            : retire(),
        );
        throw failure;
      })
      .mockImplementation(originalLoad);
    await expect(runtime.initialize()).rejects.toBeInstanceOf(AggregateError);
    expect(subject.runtimeSearch).toBe(oldSearch);
    expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalledTimes(1);
    await expect(runtime.initialize()).rejects.toThrow('still retiring');
    expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalledTimes(1);
    retirementBlocked = false;
    const store = subject.orchestrationEventStore;
    store.upsertSession({
      provider: 'claude',
      threadId: 'new-hosted-session',
      status: 'ready',
      controlMode: 'read-only-attached',
      createdAt: '2026-09-04T00:00:00Z',
      updatedAt: '2026-09-04T00:00:00Z',
      tenantExecutionContext: {
        tenantId: tenantId('alpha'),
        source: 'session',
      },
    });
    store.appendEvent({
      eventId: 'new-start',
      provider: 'claude',
      threadId: 'new-hosted-session',
      sessionId: 'new-hosted-session',
      createdAt: '2026-09-04T00:00:00Z',
      method: 'session.started',
      metadata: { userId: 'owner' },
    });
    store.appendEvent({
      eventId: 'new-message',
      provider: 'claude',
      threadId: 'new-hosted-session',
      turnId: 'new-turn',
      createdAt: '2026-09-04T00:00:01Z',
      method: 'turn.started',
      prompt: 'cobalt after retry',
    });
    await runtime.initialize();
    expect(oldSearch.inspect().phase).toBe('closed');
    expect(subject.runtimeSearch).not.toBe(oldSearch);
    const context = {
      authority: sessionReadAuthorityFromRequest(
        'owner',
        { tenantId: tenantId('alpha') },
        registry,
      ),
      current: () => true,
    };
    const request = {
      version: UNIFIED_SEARCH_V1,
      query: 'cobalt',
      filters: { kinds: ['message' as const] },
    };
    expect(await subject.runtimeSearch!.search(request, context)).toMatchObject(
      { results: [{ scope: { sessionId: 'new-hosted-session' } }] },
    );
    expect(
      await subject.runtimeSearch!.open(
        {
          kind: 'session-message',
          sessionId: 'new-hosted-session',
          matchedEventId: 'new-message',
        },
        context,
      ),
    ).toMatchObject({ state: 'resolved' });
    expect(await oldSearch.search(request, context)).toMatchObject({
      state: 'unavailable',
      results: [],
    });
    expect(
      await oldSearch.open(
        { kind: 'session', sessionId: 'new-hosted-session' },
        context,
      ),
    ).toEqual({ state: 'unavailable' });
  });

  it('settles async route-service readiness before capturing agent configuration', async () => {
    home = await createSchemaHome('station-coldstart-route-ready-');
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);

    const captureSpy = vi.spyOn(
      runtime as unknown as {
        captureAgentConfigurationRevisions(): {
          provider: number;
          appConfig: number;
        };
      },
      'captureAgentConfigurationRevisions',
    );

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(captureSpy).toHaveBeenCalled();
    captureSpy.mockRestore();
  });

  it('does not report runtime readiness before Kit lifecycle discovery settles', async () => {
    home = await createSchemaHome('station-coldstart-kit-ready-');
    let releaseDiscovery!: () => void;
    routeMocks.kitLifecycleReady = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);

    let settled = false;
    const initialization = runtime.initialize().finally(() => {
      settled = true;
    });
    await vi.waitFor(
      () => {
        expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalled();
      },
      { timeout: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseDiscovery();
    await expect(initialization).resolves.toBeUndefined();
  });

  it('fails runtime readiness when Kit lifecycle discovery rejects', async () => {
    home = await createSchemaHome('station-coldstart-kit-failure-');
    let rejectDiscovery!: (error: Error) => void;
    routeMocks.kitLifecycleReady = new Promise<void>((_resolve, reject) => {
      rejectDiscovery = reject;
    });
    // Observe the intentionally rejected fixture promise immediately. The
    // runtime must still receive the original promise and fail readiness, but
    // route registration can occur before runInitialize reaches its await.
    void routeMocks.kitLifecycleReady.catch(() => undefined);
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);

    const initialization = runtime
      .initialize()
      .catch((error: unknown) => error);
    await vi.waitFor(
      () => {
        expect(routeMocks.configureRuntimeRoutes).toHaveBeenCalled();
      },
      { timeout: 10_000 },
    );
    rejectDiscovery(new Error('Kit lifecycle discovery failed'));
    const initializationError = await initialization;
    expect(initializationError).toBeInstanceOf(Error);
    expect((initializationError as Error).message).toContain(
      'Kit lifecycle discovery failed',
    );
  });

  it('attempts every route-service cleanup and preserves initialization failures', async () => {
    home = await createSchemaHome('station-coldstart-cleanup-failure-');
    const schedulerFailure = new Error('scheduler cleanup failed');
    const notificationFailure = new Error('notification cleanup failed');
    const services = {
      schedulerService: {
        stop: vi
          .fn()
          .mockRejectedValueOnce(schedulerFailure)
          .mockResolvedValue(undefined),
      },
      notificationService: {
        shutdown: vi
          .fn()
          .mockImplementationOnce(async () => {
            throw notificationFailure;
          })
          .mockResolvedValue(undefined),
      },
      kitLifecycleReady: Promise.resolve(),
    };
    routeMocks.configureRuntimeRoutes.mockImplementationOnce(() => {
      routeMocks.servicePairs.push(services);
      return services;
    });
    runtime = new StationRuntime({
      projectHomeDir: home,
      port: TEST_PORT,
      host: '127.0.0.1',
    });
    replaceTerminalListener(runtime);
    const primaryFailure = new Error('initialization failed');
    (
      runtime as unknown as {
        eventLog: { loadRecentEvents: ReturnType<typeof vi.fn> };
      }
    ).eventLog.loadRecentEvents = vi.fn().mockRejectedValue(primaryFailure);

    await expect(runtime.initialize()).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [primaryFailure, schedulerFailure, notificationFailure],
    });
    expect(services.schedulerService.stop).toHaveBeenCalledTimes(1);
    expect(services.notificationService.shutdown).toHaveBeenCalledTimes(1);
    expect(
      (
        runtime as unknown as {
          voltAgent: { shutdown: ReturnType<typeof vi.fn> };
        }
      ).voltAgent.shutdown,
    ).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit programmatic port 0 without defaulting it', async () => {
    home = await createSchemaHome('station-port-zero-');
    runtime = new StationRuntime({ projectHomeDir: home, port: 0 });

    expect((runtime as unknown as { port: number }).port).toBe(0);

    await runtime.shutdown();
    runtime = undefined;
  });

  it('holds home runtime ownership from construction until clean shutdown', async () => {
    home = await createSchemaHome('station-home-runtime-lease-');
    runtime = new StationRuntime({ projectHomeDir: home, port: TEST_PORT });
    const backupDir = `${home}-backup`;
    try {
      expect(() =>
        createStationHomeBackup({ homeDir: home, outputDir: backupDir }),
      ).toThrow(/must be inactive before backup/);
      await runtime.shutdown();
      runtime = undefined;
      expect(
        createStationHomeBackup({ homeDir: home, outputDir: backupDir })
          .backupDir,
      ).toBe(backupDir);
    } finally {
      rmDirSyncRetrying(backupDir);
    }
  });
});
