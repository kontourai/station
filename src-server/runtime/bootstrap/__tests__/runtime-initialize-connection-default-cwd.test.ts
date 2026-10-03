/**
 * #2873: the production runtime composition tells the orchestration service
 * where an ACP connection would start a session that has no directory of
 * its own, from the same connection config the ACP adapter spawns with.
 * Without it a scoped station-control dispatch with no workspace cannot be
 * decided on the directory it would run in, and every test that wires the
 * reader itself still passes.
 *
 * Drives the real `initializeRuntime` up to the orchestration service's
 * construction, captures the options it is built with, and stops there.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, test, vi } from 'vitest';

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

describe('runtime composition: an engine connection’s default working directory', () => {
  // The runtime graph's cold import is slow under host load; it gets its own
  // budget here, so the test's timeout covers only construction and reads.
  let initializeRuntime: typeof import('../runtime-initialize.js')['initializeRuntime'];
  beforeAll(async () => {
    ({ initializeRuntime } = await import('../runtime-initialize.js'));
  }, 120_000);

  test('is read from the ACP connection config, as the adapter resolves it', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
    };
    // Read at each call: the operator can change a connection at any time.
    let connections: { id: string; cwd?: string }[] = [
      { id: 'tilde', cwd: '~/work/project' },
      { id: 'relative', cwd: 'relative/dir' },
      { id: 'empty', cwd: '' },
      { id: 'unset' },
    ];
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
        configLoader: {
          loadAppConfig: async () => ({}),
          loadACPConfig: async () => ({ connections }),
          loadIntegration: async () => null,
          loadPluginOverrides: async () => ({}),
          getProjectHomeDir: () => '/tmp/station-2873',
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

    const read = captured.options?.resolveConnectionDefaultCwd as
      | ((
          provider: string,
          connectionId: string | undefined,
        ) => Promise<string | undefined>)
      | undefined;
    expect(read).toBeTypeOf('function');
    await expect(read?.('acp', 'tilde')).resolves.toBe(
      join(homedir(), 'work', 'project'),
    );
    await expect(read?.('acp', 'relative')).resolves.toBe(
      resolve('relative/dir'),
    );
    await expect(read?.('acp', 'empty')).resolves.toBeUndefined();
    await expect(read?.('acp', 'unset')).resolves.toBeUndefined();
    await expect(read?.('acp', 'unknown')).resolves.toBeUndefined();
    await expect(read?.('acp', undefined)).resolves.toBeUndefined();
    // Only ACP leaves a directory-less session to its connection.
    await expect(read?.('claude', 'tilde')).resolves.toBeUndefined();
    connections = [{ id: 'tilde', cwd: '/changed' }];
    await expect(read?.('acp', 'tilde')).resolves.toBe('/changed');
  });
});
