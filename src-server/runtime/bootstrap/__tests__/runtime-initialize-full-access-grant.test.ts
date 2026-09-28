/**
 * #1796 H2 (delta review): the production runtime composition connects the
 * orchestration service's live full-access grant check to the Station's
 * paired-device registry. Without it, a revoked device's sessions keep the
 * `host` stamp its grant wrote, and every revocation test still passes on
 * fixtures that wire the check themselves.
 *
 * Drives the real `initializeRuntime` up to the orchestration service's
 * construction, captures the options it is built with, and stops there.
 */
import { describe, expect, test, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

class StopAfterConstruction extends Error {}

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

describe('runtime composition: the live full-access grant check', () => {
  test('is wired to the paired-device registry', async () => {
    const { initializeRuntime } = await import('../runtime-initialize.js');
    const deviceHoldsFullAccess = vi.fn(
      (deviceId: string) => deviceId === 'still-granted',
    );
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
          deviceHoldsFullAccess,
        },
        configLoader: {
          loadAppConfig: async () => ({}),
          loadACPConfig: async () => ({ connections: [] }),
          loadIntegration: async () => null,
          loadPluginOverrides: async () => ({}),
          getProjectHomeDir: () => '/tmp/station-h2',
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
        // Construction-time reads only; nothing here runs a store query.
        orchestrationEventStore: new Proxy(
          {},
          { get: () => vi.fn(() => ({})) },
        ),
      } as never),
    ).rejects.toBeInstanceOf(StopAfterConstruction);

    const check = captured.options?.isFullAccessGrantorCurrent as
      | ((deviceId: string) => boolean)
      | undefined;
    expect(check).toBeTypeOf('function');
    expect(check?.('still-granted')).toBe(true);
    expect(check?.('revoked')).toBe(false);
    expect(deviceHoldsFullAccess).toHaveBeenCalledWith('revoked');
  });
});
