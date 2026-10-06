/**
 * #3429: the production runtime composition gives the orchestration service
 * the Agent and Environment a continued attached conversation runs as. The
 * route test wires the resolver itself, so without this pin the dock fix
 * could be dropped from the real composition with every other test green.
 *
 * Drives the real `initializeRuntime` up to the orchestration service's
 * construction, captures the options it is built with, and stops there. The
 * captured resolver reads a real Agent store.
 */
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { materializeEngineAgent } from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

class StopAfterConstruction extends Error {}

const makeTempDir = trackTempDirs();

vi.mock(
  '../../../services/orchestration/orchestration-service.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/orchestration/orchestration-service.js')
    >()),
    OrchestrationService: class {
      constructor(options: Record<string, unknown>) {
        captured.options = options;
        throw new StopAfterConstruction();
      }
    },
  }),
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

describe('runtime composition: a continued attached conversation’s Agent and Environment', () => {
  let initializeRuntime: typeof import('../runtime-initialize.js')['initializeRuntime'];
  beforeAll(async () => {
    ({ initializeRuntime } = await import('../runtime-initialize.js'));
  }, 120_000);

  test('is the engine’s own Agent on this Station’s Environment, or none', async () => {
    const home = makeTempDir('station-3429-');
    const loader = new ConfigLoader({ projectHomeDir: home });
    await materializeEngineAgent(loader, 'claude', 'Claude Code');
    let environmentId = 'environment-before-reset';
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
          deviceHoldsFullAccess: vi.fn(),
          readExistingRecord: async () => ({ environmentId }),
        },
        configLoader: {
          loadAppConfig: async () => ({}),
          loadACPConfig: async () => ({ connections: [] }),
          loadIntegration: async () => null,
          loadPluginOverrides: async () => ({}),
          getProjectHomeDir: () => home,
          listAgents: () => loader.listAgents(),
          loadAgent: (slug: string) => loader.loadAgent(slug),
        },
        storageAdapter: { listProjects: () => [] },
        skillService: {},
        acpBridge: {},
        claudeAdapter: fakeAdapter('claude'),
        codexAdapter: fakeAdapter('codex'),
        museAdapter: fakeAdapter('muse'),
        bedrockAdapter: fakeAdapter('bedrock'),
        ollamaAdapter: fakeAdapter('ollama'),
        activeAgents: new Map(),
        orchestrationEventStore: new Proxy(
          {},
          { get: () => vi.fn(() => ({})) },
        ),
      } as never),
    ).rejects.toBeInstanceOf(StopAfterConstruction);

    const resolveBinding = captured.options
      ?.resolveAdoptedChildExecutionBinding as
      | ((provider: string) => Promise<unknown>)
      | undefined;
    expect(resolveBinding).toBeTypeOf('function');
    await expect(resolveBinding?.('claude')).resolves.toEqual({
      agentId: 'claude',
      connectionId: 'claude',
      environmentId: 'environment-before-reset',
    });
    // Read per continuation: an Environment reset changes the identity.
    environmentId = 'environment-after-reset';
    await expect(resolveBinding?.('claude')).resolves.toMatchObject({
      environmentId: 'environment-after-reset',
    });
    // No Codex Agent here, and finding one creates none.
    await expect(resolveBinding?.('codex')).resolves.toBeUndefined();
    expect(
      (await loader.listAgents()).map((agent) => String(agent.slug)),
    ).toEqual(['claude']);
  });
});
