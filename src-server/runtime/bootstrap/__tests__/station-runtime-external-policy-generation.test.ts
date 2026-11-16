/**
 * 2026-11-16: creating an unrelated Agent stopped every running Claude Code
 * conversation. Each external engine session keeps the pre-tool policy
 * evaluator it was started with, and that evaluator compared the GLOBAL agent
 * configuration revision, so any configuration mutation made it refuse every
 * later tool call (`stale_generation`), for the rest of the session: a retry
 * or a new turn reached the same evaluator.
 *
 * These cases drive the real runtime pieces: `applyAgentConfigurationMutation`
 * in the deferred mode `POST /api/agents` (`station agents create`) uses,
 * configuration reconciliation, `resolveExternalPreToolPolicy` (what the
 * Claude, ACP, OpenCode and Codex adapters hold for a session's life), the
 * staged evaluator, and the orchestration conversation lineage. The engine
 * is a fake adapter that holds the evaluator exactly as a real one does.
 */
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterShape,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import type { StagedPreToolPolicyEvaluator } from '../../agents/pre-tool-policy.js';
import { PreToolPolicyGenerations } from '../../agents/pre-tool-policy-generation.js';
import { StationRuntime } from '../station-runtime.js';

const makeTempDir = trackTempDirs();
const worlds: Array<{ service: OrchestrationService; store: EventStore }> = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.service.shutdown();
    world.store.close();
  }
});

const REPLACED_TEXT = 'Retrying in this turn will be refused again';

/** A runtime with only the configuration and policy seams this file drives. */
function policyRuntime(home: string, agents: Map<string, AgentSpec>) {
  const runtime = Object.create(StationRuntime.prototype) as any;
  runtime.orchestrationEventStore = {
    createPackageMcpAdmissionJournal: () => ({
      selectedInstallations: () => ({ state: 'observed', installations: [] }),
    }),
  };
  runtime.loadedSelectedPackageFingerprint =
    runtime.captureSelectedPackageFingerprint();
  runtime.agentConfigurationRevision = 0;
  runtime.agentConfigurationMutationQueue = Promise.resolve();
  runtime.agentConfigurationPersistenceQueue = Promise.resolve();
  runtime.agentConfigurationMutationsClosed = false;
  runtime.loadedProviderLaunchabilityRevision = 0;
  runtime.loadedAppConfigLaunchabilityRevision = 0;
  runtime.providerService = {
    getLaunchabilityRevision: () => 0,
    listProviderConnections: () => [],
  };
  runtime.configLoader = {
    getLaunchabilityRevision: () => 0,
    getProjectHomeDir: () => home,
    loadAgent: async (slug: string) => {
      const spec = agents.get(slug);
      if (!spec) throw new Error(`Agent '${slug}' not found`);
      return structuredClone(spec);
    },
    loadIntegration: async (id: string) => {
      throw new Error(`Integration '${id}' not found`);
    },
  };
  runtime.appConfig = {};
  runtime.logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
  runtime.toolNameMapping = new Map();
  runtime.preToolPolicyGenerations = new PreToolPolicyGenerations();
  // Reconciliation's reload re-reads every source and marks them loaded.
  runtime.scheduleAgentConfigurationReconciliation = vi.fn();
  runtime.reloadConfigurationFromDisk = vi.fn(async () => {
    runtime.loadedProviderLaunchabilityRevision = 0;
    runtime.loadedAppConfigLaunchabilityRevision = 0;
    runtime.agentsAwaitingReconciliation?.clear();
  });
  return runtime;
}

/** `station agents create` / `PUT /api/agents/:slug`, then reconciliation. */
async function saveAgent(
  runtime: any,
  agents: Map<string, AgentSpec>,
  slug: string,
  spec: AgentSpec,
) {
  await runtime.applyAgentConfigurationMutation(
    async (beginMutation: () => void) => {
      beginMutation();
      agents.set(slug, spec);
      return { slug };
    },
    {
      resolveAgentSlug: (saved: { slug: string }) => saved.slug,
      activationMode: 'defer',
    },
  );
  await expect(runtime.reconcileAgentConfigurationSources()).resolves.toBe(
    true,
  );
}

const ENGINES = ['claude', 'codex', 'acp'] as const;

function world(engine: (typeof ENGINES)[number]) {
  const home = makeTempDir('external-policy-generation-');
  const agents = new Map<string, AgentSpec>([
    [
      'claude',
      {
        name: 'Claude',
        prompt: 'Help the person.',
        tools: { mcpServers: [], autoApprove: ['Bash'] },
      },
    ],
  ]);
  const runtime = policyRuntime(home, agents);
  const policies = new Map<string, StagedPreToolPolicyEvaluator>();
  const starts: ProviderSessionStartInput[] = [];
  const events = new AsyncEventQueue<any>();
  const adapter: ProviderAdapterShape = {
    provider: engine,
    metadata: {
      displayName: 'fake engine',
      description: 'holds its pre-tool policy for the session, like a real one',
      capabilities: ['agent-runtime'],
    },
    async startSession(input) {
      starts.push(input);
      // What every external adapter does at session start.
      const policy = await runtime.resolveExternalPreToolPolicy(
        input,
        'authentic',
      );
      if (policy) policies.set(input.threadId, policy);
      const now = new Date().toISOString();
      events.push({
        eventId: `start-${input.threadId}`,
        provider: engine,
        threadId: input.threadId,
        sessionId: input.threadId,
        method: 'session.started',
        createdAt: now,
        metadata: input.metadata,
      });
      return {
        provider: engine,
        threadId: input.threadId,
        status: 'ready',
        createdAt: now,
        updatedAt: now,
      };
    },
    async sendTurn(input) {
      const turnId = `turn-${input.threadId}`;
      const base = {
        provider: engine,
        threadId: input.threadId,
        turnId,
        invocationId: input.invocationId,
        createdAt: new Date().toISOString(),
      };
      events.push({
        ...base,
        eventId: `${turnId}-start`,
        method: 'turn.started',
        prompt: input.input,
      });
      events.push({
        ...base,
        eventId: `${turnId}-end`,
        method: 'turn.completed',
      });
      return { threadId: input.threadId, turnId };
    },
    async interruptTurn() {
      return { outcome: 'no-active-turn' };
    },
    async respondToRequest() {},
    async stopSession() {},
    async listSessions() {
      return [];
    },
    async hasSession() {
      return false;
    },
    async stopAll() {},
    streamEvents: (options) => events.iterable(options),
  };
  const store = new EventStore(join(home, 'events.sqlite'));
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug: vi.fn(), warn: vi.fn() },
    adapterRegistry: {
      register() {},
      get: (provider: string) => (provider === engine ? adapter : undefined),
      list: () => [adapter],
    },
    preToolPolicyReplaced: (threadId: string) =>
      runtime.preToolPolicyGenerations.replaced(threadId),
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async (slug) => structuredClone(agents.get(slug) ?? null),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  } as never);
  worlds.push({ service, store });
  const waitFor = async (threadId: string, method: string) => {
    for (
      let i = 0;
      i < 200 && !store.listEventsByMethods(threadId, [method]).length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.listEventsByMethods(threadId, [method])).not.toHaveLength(0);
  };
  const start = async (
    threadId: string,
    extra: Record<string, unknown> = {},
  ) => {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: engine,
          metadata: {
            userId: 'owner',
            agentSlug: 'claude',
            conversationId: 'conversation',
            ...extra,
          },
        },
      },
      { userId: 'owner' },
    );
    await waitFor(threadId, 'session.started');
  };
  const turn = async (threadId: string, input: string, extra = {}) => {
    await service.dispatch(
      { type: 'sendTurn', input: { threadId, input, ...extra } },
      { userId: 'owner' },
    );
    await waitFor(threadId, 'turn.completed');
  };
  /** The engine's PreToolUse (or permission request) for one Bash call. */
  const bash = (threadId: string) =>
    policies.get(threadId)!(
      { toolName: 'Bash', toolArgs: { command: 'ls' } } as never,
      { agentSlug: 'claude', conversationId: 'conversation' } as never,
      { interaction: 'external' },
    );
  const next = () =>
    service.resolveConversationContinuation(
      'conversation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: engine },
    );
  return { runtime, agents, service, start, turn, bash, next, starts };
}

describe('external engine pre-tool policy generation', () => {
  test.each(ENGINES)(
    '%s: creating or editing an unrelated Agent leaves a running session able to run tools',
    async (engine) => {
      const w = world(engine);
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      expect(await w.bash('conversation')).toEqual({
        behavior: 'allow',
        toolGrant: true,
      });

      await saveAgent(w.runtime, w.agents, 'main-repair', {
        name: 'Main repair',
        prompt: 'Repair main.',
      });
      expect(w.runtime.agentConfigurationRevision).toBe(2);
      expect(await w.bash('conversation')).toEqual({
        behavior: 'allow',
        toolGrant: true,
      });

      await saveAgent(w.runtime, w.agents, 'main-repair', {
        name: 'Main repair',
        prompt: 'Repair main, carefully.',
        tools: { mcpServers: [], autoApprove: ['*'] },
      });
      expect(await w.bash('conversation')).toEqual({
        behavior: 'allow',
        toolGrant: true,
      });
      // Nothing to recover from: the next turn stays in this session.
      expect((await w.next()).startRequired).toBe(false);
    },
  );

  test.each(ENGINES)(
    "%s: a change to the session's own Agent refuses its tools until the next turn starts a session under the new definition",
    async (engine) => {
      const w = world(engine);
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      expect(await w.bash('conversation')).toMatchObject({ behavior: 'allow' });

      // The person withdraws the Bash grant.
      await saveAgent(w.runtime, w.agents, 'claude', {
        name: 'Claude',
        prompt: 'Help the person.',
        tools: { mcpServers: [] },
      });

      // The running session cannot re-bind what its engine was started with
      // (its grants and tool servers), so it never decides under the old
      // grant: refused, the same on retry, and the text says what works.
      for (const attempt of [1, 2, 3]) {
        const refused = await w.bash('conversation');
        expect(refused, `attempt ${attempt}`).toMatchObject({
          behavior: 'deny',
          denial: {
            policyDenied: true,
            reason: expect.stringContaining(REPLACED_TEXT),
          },
        });
      }

      // The next turn starts a successor that binds the current definition.
      const successor = await w.next();
      expect(successor.startRequired).toBe(true);
      expect(successor.sessionId).not.toBe('conversation');
      await w.start(successor.sessionId, {
        ...(successor.contextSeed
          ? {
              conversationStartSeedCarrier: {
                pinDigest: successor.contextSeed.pinDigest,
                seedDigest: successor.contextSeed.seedDigest,
                clientTurnId: 'next-turn',
              },
            }
          : {}),
      });
      expect(w.starts.at(-1)?.agent?.autoApprove).toBeUndefined();
      // No grant now: Station leaves the call to the engine's own approval
      // flow, which asks the person.
      expect(await w.bash(successor.sessionId)).toEqual({ behavior: 'defer' });
      // And it stays there: the successor is current, so no further one.
      await w.turn(successor.sessionId, 'Run the tests.', {
        clientTurnId: 'next-turn',
        ...(successor.transcriptSeed
          ? { ambientContext: successor.transcriptSeed }
          : {}),
      });
      expect((await w.next()).sessionId).toBe(successor.sessionId);
      expect((await w.next()).startRequired).toBe(false);
    },
  );

  test('a call made while a change is still being applied is refused with a retry, then decided', async () => {
    const w = world('claude');
    await w.start('conversation');
    await w.runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        w.agents.set('main-repair', { name: 'Main repair', prompt: 'x' });
        return { slug: 'main-repair' };
      },
      {
        resolveAgentSlug: (saved: { slug: string }) => saved.slug,
        activationMode: 'defer',
      },
    );
    const settling = await w.bash('conversation');
    expect(settling).toMatchObject({
      behavior: 'deny',
      denial: { reason: expect.stringContaining('Retry it in a moment') },
    });
    expect((await w.next()).startRequired).toBe(false);
    await w.runtime.reconcileAgentConfigurationSources();
    expect(await w.bash('conversation')).toEqual({
      behavior: 'allow',
      toolGrant: true,
    });
  });

  test('a deleted Agent is a replaced one', async () => {
    const w = world('acp');
    await w.start('conversation');
    await w.runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        w.agents.delete('claude');
        return { slug: 'claude' };
      },
      {
        resolveAgentSlug: (saved: { slug: string }) => saved.slug,
        activationMode: 'defer',
      },
    );
    await w.runtime.reconcileAgentConfigurationSources();
    expect(await w.bash('conversation')).toMatchObject({
      behavior: 'deny',
      denial: { reason: expect.stringContaining(REPLACED_TEXT) },
    });
  });
});
