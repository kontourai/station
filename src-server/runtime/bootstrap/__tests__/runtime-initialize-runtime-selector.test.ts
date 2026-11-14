/**
 * #3909: the persisted `runtime` setting is the only runtime selector. The
 * retired `STATION_FEATURES=strands-runtime` boot override must not choose
 * a framework any more.
 *
 * Drives the real `initializeRuntime` past framework selection, records which
 * framework class it constructs, and stops at the orchestration service's
 * construction (the same seam `runtime-initialize-full-access-grant` uses).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const constructed = vi.hoisted(() => ({ frameworks: [] as string[] }));

class StopAfterConstruction extends Error {}

vi.mock(
  '../../../services/orchestration/orchestration-service.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/orchestration/orchestration-service.js')
    >()),
    OrchestrationService: class {
      constructor() {
        throw new StopAfterConstruction();
      }
    },
  }),
);

vi.mock('../../frameworks/voltagent-adapter.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../frameworks/voltagent-adapter.js')
    >();
  return {
    ...actual,
    VoltAgentFramework: class extends actual.VoltAgentFramework {
      constructor() {
        super();
        constructed.frameworks.push('voltagent');
      }
    },
  };
});

vi.mock('../../frameworks/strands-adapter.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../frameworks/strands-adapter.js')
    >();
  return {
    ...actual,
    StrandsFramework: class extends actual.StrandsFramework {
      constructor() {
        super();
        constructed.frameworks.push('strands');
      }
    },
  };
});

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

async function bootWith(appConfig: Record<string, unknown>): Promise<{
  frameworks: string[];
  loggedRuntime: unknown;
}> {
  constructed.frameworks = [];
  const { initializeRuntime } = await import('../runtime-initialize.js');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
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
        deviceHoldsFullAccess: vi.fn(() => false),
      },
      configLoader: {
        loadAppConfig: async () => ({ ...appConfig }),
        loadACPConfig: async () => ({ connections: [] }),
        loadIntegration: async () => null,
        loadPluginOverrides: async () => ({}),
        getProjectHomeDir: () => '/tmp/station-3909',
      },
      storageAdapter: { listProjects: () => [] },
      skillService: {},
      acpBridge: {},
      claudeAdapter: fakeAdapter('claude'),
      codexAdapter: fakeAdapter('codex'),
      museAdapter: fakeAdapter('muse'),
      copilotSdkAdapter: fakeAdapter('copilot-sdk'),
      bedrockAdapter: fakeAdapter('bedrock'),
      ollamaAdapter: fakeAdapter('ollama'),
      activeAgents: new Map(),
      orchestrationEventStore: new Proxy({}, { get: () => vi.fn(() => ({})) }),
    } as never),
  ).rejects.toBeInstanceOf(StopAfterConstruction);
  const loaded = logger.info.mock.calls.find(
    ([message]) => message === 'App config loaded',
  );
  return {
    frameworks: [...constructed.frameworks],
    loggedRuntime: (loaded?.[1] as { runtime?: unknown } | undefined)?.runtime,
  };
}

describe('runtime composition: the runtime framework selector (#3909)', () => {
  afterEach(() => vi.unstubAllEnvs());

  test('STATION_FEATURES=strands-runtime no longer switches a VoltAgent home to Strands', async () => {
    vi.stubEnv('STATION_FEATURES', 'strands-runtime');
    expect(await bootWith({ runtime: 'voltagent' })).toEqual({
      frameworks: ['voltagent'],
      loggedRuntime: 'voltagent',
    });
    expect(await bootWith({})).toEqual({
      frameworks: ['voltagent'],
      loggedRuntime: 'voltagent',
    });
  });

  test('the persisted runtime setting selects Strands, with or without the retired variable', async () => {
    expect(await bootWith({ runtime: 'strands' })).toEqual({
      frameworks: ['strands'],
      loggedRuntime: 'strands',
    });
    vi.stubEnv('STATION_FEATURES', 'strands-runtime');
    expect(await bootWith({ runtime: 'strands' })).toEqual({
      frameworks: ['strands'],
      loggedRuntime: 'strands',
    });
  });
});
