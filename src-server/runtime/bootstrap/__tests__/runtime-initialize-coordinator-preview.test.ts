/**
 * #3628: the `coordinator-session` preview reaches the Session tool grant the
 * production composition builds. Drives the real `initializeRuntime` up to
 * the orchestration service's construction (as
 * `runtime-initialize-usage-limit-resume.test.ts` does), then calls the
 * composed agent resolver for a designated chat and reads the composed
 * service gate, with the preview off and then on.
 */
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import type { ProviderSessionStartInput } from '../../../providers/adapter-shape.js';
import { FeaturePreviewRegistry } from '../../../services/feature-previews/feature-preview-registry.js';
import { EventStore } from '../../../services/orchestration/event-store.js';

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
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

describe('#3628 runtime composition: coordinator-session preview', () => {
  test('a designated chat gets coordinator tools only while the preview is on', async () => {
    const home = makeTempDir('coordinator-preview-init-');
    const registry = new FeaturePreviewRegistry(home, logger as never);
    const preview = registry.bind({
      id: 'coordinator-session',
      label: 'Coordinator chat',
      description: 'test',
    });
    const store = new EventStore(join(home, 'orchestration.sqlite'));
    try {
      store.coordinatorStore().designate({
        conversationId: 'chat-a',
        actor: { userId: 'owner' },
        replace: false,
        now: 1,
      });
      // The real store answers the coordinator reads; every other member is
      // inert, as in the usage-limit composition test.
      const eventStore = new Proxy(
        {},
        {
          get: (_target, property) =>
            property === 'coordinatorStore' ||
            property === 'conversationForSession'
              ? (store[property] as (...args: unknown[]) => unknown).bind(store)
              : vi.fn(() => ({})),
        },
      );
      const { initializeRuntime } = await import('../runtime-initialize.js');
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
          configLoader: new ConfigLoader({ projectHomeDir: home }),
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
          orchestrationEventStore: eventStore,
          coordinatorSessionPreview: preview,
        } as never),
      ).rejects.toBeInstanceOf(StopAfterConstruction);
      const options = captured.options as {
        resolveSessionAgent: (
          input: ProviderSessionStartInput,
        ) => Promise<ProviderSessionStartInput>;
        coordinatorEnabled: () => boolean;
      };
      // The built-in servers are not installed in this home, so the grant is
      // observed as the servers the coordinator's Session requests.
      const requestedServers = async () =>
        (
          (
            await options.resolveSessionAgent({
              threadId: 'chat-a',
              provider: 'claude',
              metadata: { agentSlug: 'writer', userId: 'owner' },
            })
          ).metadata?.capabilityDelivery as
            | { toolServers?: { requested?: string[] } }
            | undefined
        )?.toolServers?.requested ?? [];

      expect(options.coordinatorEnabled()).toBe(false);
      expect(await requestedServers()).not.toContain('station-control');

      await registry.setEnabled('coordinator-session', true);
      expect(options.coordinatorEnabled()).toBe(true);
      expect(await requestedServers()).toContain('station-control');

      await registry.setEnabled('coordinator-session', false);
      expect(await requestedServers()).not.toContain('station-control');
    } finally {
      store.close();
    }
  });
});
