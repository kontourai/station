/**
 * #3157: the production composition reads `usageLimitAutoResume` from the
 * real config file, per call, and the orchestration service hands it to the
 * recovery coordinator. Drives the real `initializeRuntime` up to the
 * orchestration service's construction with a real `ConfigLoader`, then
 * builds the real service from the captured options and reads the
 * coordinator's gate. The coordinator's own tests prove that gate decides
 * the dispatch (`session-recovery-usage-limit.test.ts`).
 */
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

class StopAfterConstruction extends Error {}

vi.mock(
  '../../../services/orchestration/orchestration-service.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../services/orchestration/orchestration-service.js')
      >();
    return {
      ...actual,
      RealOrchestrationService: actual.OrchestrationService,
      OrchestrationService: class {
        constructor(options: Record<string, unknown>) {
          captured.options = options;
          throw new StopAfterConstruction();
        }
      },
    };
  },
);

function fakeAdapter(provider: string) {
  return {
    provider,
    metadata: {
      displayName: provider,
      description: provider,
      capabilities: [],
    },
    startSession: vi.fn(),
    sendTurn: vi.fn(),
    interruptTurn: vi.fn(),
    respondToRequest: vi.fn(),
    stopSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
    stopAll: vi.fn(),
    streamEvents: vi.fn(),
  };
}

const makeTempDir = trackTempDirs();

async function composedOptions(configLoader: ConfigLoader) {
  const { initializeRuntime } = await import('../runtime-initialize.js');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  captured.options = undefined;
  await expect(
    initializeRuntime({
      port: 0,
      host: '127.0.0.1',
      logger,
      eventBus: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        subscribe: vi.fn(() => () => {}),
      },
      approvalRegistry: {},
      timers: [],
      environmentSecurityService: {
        verifyCredential: vi.fn(),
        resolveGrantedScope: vi.fn(),
        canSharePersonalConversation: vi.fn(),
        personalConversationOwnerIds: vi.fn(),
        deviceHoldsFullAccess: vi.fn(),
      },
      configLoader,
      storageAdapter: { listProjects: () => [] },
      skillService: {},
      acpBridge: {},
      claudeAdapter: fakeAdapter('claude'),
      codexAdapter: fakeAdapter('codex'),
      museAdapter: fakeAdapter('muse'),
      bedrockAdapter: fakeAdapter('bedrock'),
      ollamaAdapter: fakeAdapter('ollama'),
      activeAgents: new Map(),
      orchestrationEventStore: new Proxy({}, { get: () => vi.fn(() => ({})) }),
    } as never),
  ).rejects.toBeInstanceOf(StopAfterConstruction);
  return captured.options as unknown as {
    resolveUsageLimitAutoResume?: () => Promise<boolean | undefined>;
  };
}

describe('#3157 runtime composition: usageLimitAutoResume', () => {
  test('the stored setting reaches the recovery coordinator, read per call', async () => {
    const configLoader = new ConfigLoader({
      projectHomeDir: makeTempDir('usage-limit-resume-home-'),
    });
    const options = await composedOptions(configLoader);
    expect(options.resolveUsageLimitAutoResume).toBeTypeOf('function');
    await expect(options.resolveUsageLimitAutoResume?.()).resolves.not.toBe(
      true,
    );

    await configLoader.updateAppConfig({ usageLimitAutoResume: true });
    await expect(options.resolveUsageLimitAutoResume?.()).resolves.toBe(true);

    // The real service hands the same reader to the coordinator's gate.
    const { RealOrchestrationService } = (await import(
      '../../../services/orchestration/orchestration-service.js'
    )) as unknown as {
      RealOrchestrationService: new (
        options: unknown,
      ) => {
        recoveryCoordinator?: {
          options: { autoResume: () => Promise<boolean> };
        };
      };
    };
    const { EventStore } = await import(
      '../../../services/orchestration/event-store.js'
    );
    const store = new EventStore(
      `${makeTempDir('usage-limit-resume-store-')}/orchestration.sqlite`,
    );
    try {
      const service = new RealOrchestrationService({
        adapterRegistry: {
          get: () => undefined,
          list: () => [],
          register: () => {},
        },
        eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}) },
        eventStore: store,
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveUsageLimitAutoResume: options.resolveUsageLimitAutoResume,
      });
      await expect(
        service.recoveryCoordinator?.options.autoResume(),
      ).resolves.toBe(true);
      await configLoader.updateAppConfig({ usageLimitAutoResume: false });
      await expect(
        service.recoveryCoordinator?.options.autoResume(),
      ).resolves.toBe(false);
    } finally {
      store.close();
    }
  });
});
