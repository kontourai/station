/**
 * #4521 round 2: `limits.telemetry: false` reaches VoltAgent through the
 * PRODUCTION wiring. `StationRuntime.initialize()` runs the real
 * `initializeRuntime`, which installs the managed observability and then
 * constructs the real `new VoltAgent(...)` (nothing here mocks
 * `@voltagent/core`). The unit test beside the helper
 * (`bootstrap/__tests__/voltagent-managed-telemetry.test.ts`) reproduces that
 * order by hand; this one fails if `initializeRuntime` stops doing it.
 *
 * Only owners unrelated to telemetry are replaced, as in
 * `runtime-cold-start-custom-agent.test.ts`: the route table, the Hono server
 * (no listener), the config watcher, voice, host credential and engine
 * probes. VoltOps is given keys in the environment, which the dependency
 * reads itself, and its client's API URL points at a local recorder before
 * boot. After boot one real agent runs, a log record is emitted, and both are
 * flushed. The control boots without a policy and the recorder receives the
 * trace and log exports.
 */
import { createServer } from 'node:http';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { Agent, AgentRegistry, VoltOpsClient } from '@voltagent/core';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ensureStationHomeSchema } from '../../domain/home-schema-gate.js';
import { installManagedCapabilityLimits } from '../../security/managed-capability-limits.js';

vi.mock('../routes/runtime-routes.js', () => ({
  configureRuntimeRoutes: vi.fn(() => ({
    schedulerService: { stop: vi.fn(async () => {}) },
    notificationService: { shutdown: vi.fn() },
    kitLifecycleReady: Promise.resolve(),
  })),
}));

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn().mockReturnThis(),
    close: vi.fn(async () => {}),
  })),
}));

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLockAsync: (
        lock: string,
        options?: Parameters<typeof actual.acquireFileMutationLockAsync>[1],
      ) =>
        actual.acquireFileMutationLockAsync(lock, {
          ...options,
          birthFingerprint: () => 'runtime-voltagent-telemetry-test',
        }),
    };
  },
);

vi.mock('../frameworks/voltagent-hono-runtime.js', () => ({
  stationHonoServer: vi.fn((config: any) => () => ({
    start: vi.fn(async () => {
      const handlers = new Proxy({}, { get: () => vi.fn() }) as Record<
        string,
        () => void
      >;
      await config.configureFullApp({
        app: { routes: [] },
        routes: handlers,
        middlewares: handlers,
      });
      return { port: 0 };
    }),
    stop: vi.fn(async () => {}),
    isRunning: vi.fn(() => true),
  })),
}));

vi.mock('../../routes/operations/voice.js', () => ({
  attachVoiceWebSocket: vi.fn(),
}));

vi.mock('../../providers/llm/bedrock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../providers/llm/bedrock.js')>()),
  checkBedrockCredentials: vi.fn(async () => false),
}));

vi.mock('../bootstrap/runtime-startup.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bootstrap/runtime-startup.js')>()),
  checkOllamaAvailability: vi.fn(async () => false),
}));

vi.mock('../bootstrap/store-integrity-verification.js', () => ({
  startStoreIntegrityVerification: vi.fn(() => () => {}),
}));

vi.mock('../bootstrap/engine-prerequisite-priming.js', () => ({
  primeEnginePrerequisites: vi.fn(() => Promise.resolve()),
}));

vi.mock('../bootstrap/native-engine-adoption.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../bootstrap/native-engine-adoption.js')
  >()),
  adoptDetectedNativeEngines: vi.fn(() => Promise.resolve({ outcomes: {} })),
}));

const { StationRuntime } = await import('../bootstrap/station-runtime.js');

const TEST_PORT = 31_187;
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void> | void> = [];
const savedEnv = {
  publicKey: process.env.VOLTAGENT_PUBLIC_KEY,
  secretKey: process.env.VOLTAGENT_SECRET_KEY,
};

function resetVoltAgentGlobals() {
  const registry = AgentRegistry.getInstance();
  registry.setGlobalObservability(undefined as never);
  registry.setGlobalVoltOpsClient(undefined as never);
}

beforeEach(() => {
  resetVoltAgentGlobals();
  process.env.VOLTAGENT_PUBLIC_KEY = 'pk_station_probe';
  process.env.VOLTAGENT_SECRET_KEY = 'sk_station_probe';
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
  installManagedCapabilityLimits(null);
  resetVoltAgentGlobals();
  for (const [key, value] of [
    ['VOLTAGENT_PUBLIC_KEY', savedEnv.publicKey],
    ['VOLTAGENT_SECRET_KEY', savedEnv.secretKey],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function recorder() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function installTelemetryOff() {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { telemetry: false },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

function mockModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/** Boot the real runtime, then run one real agent, log and flush. */
async function bootRunAndLog(sinkUrl: string) {
  // Before boot: VoltAgent's log exporter initializes while it is constructed.
  vi.spyOn(VoltOpsClient.prototype, 'getApiUrl').mockReturnValue(sinkUrl);
  const home = makeTempDir('station-voltagent-telemetry-');
  await ensureStationHomeSchema(home);
  const runtime = new StationRuntime({
    projectHomeDir: home,
    port: TEST_PORT,
    host: '127.0.0.1',
  });
  cleanups.push(() => runtime.shutdown().catch(() => {}));
  await runtime.initialize();

  const registry = AgentRegistry.getInstance();
  // The dependency configured this client from the environment keys.
  const client = registry.getGlobalVoltOpsClient();
  if (!client) throw new Error('VoltAgent did not read the environment keys');
  expect(client.getApiUrl()).toBe(sinkUrl);
  const observability = registry.getGlobalObservability();
  if (!observability) throw new Error('no VoltAgent observability');

  const agent = new Agent({
    id: 'probe',
    name: 'probe',
    instructions: 'Reply once.',
    model: mockModel(),
    memory: false,
    summarization: false,
    workspace: false,
    workspaceSkillsPrompt: false,
    toolRouting: false,
    feedback: false,
    maxSteps: 1,
    maxRetries: 0,
  });
  expect((await agent.generateText('hello')).text).toBe('ok');
  observability
    .getLoggerProvider()
    .getLogger('station-probe')
    .emit({ body: 'station probe log record' });
  await observability.forceFlush();
}

describe('initializeRuntime and VoltAgent remote export (#4521)', {
  timeout: 60_000,
}, () => {
  it('without a policy the VoltOps exporters reach the recorder (control)', async () => {
    const sink = await recorder();
    await bootRunAndLog(sink.url);
    await expect
      .poll(() => [...new Set(sink.requests)].sort(), { timeout: 10_000 })
      .toEqual([
        'POST /api/public/otel/v1/logs',
        'POST /api/public/otel/v1/traces',
      ]);
  });

  it('under limits.telemetry: false the booted runtime sends no traces or logs', async () => {
    installTelemetryOff();
    const sink = await recorder();
    await bootRunAndLog(sink.url);
    // The lazy remote processors poll for a client every 100ms for 5
    // seconds; wait past one batch window so a late initialization shows.
    await new Promise((done) => setTimeout(done, 1_500));
    await AgentRegistry.getInstance().getGlobalObservability()?.forceFlush();
    expect(sink.requests).toEqual([]);
  });
});
