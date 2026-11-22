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
 * `mutateAgentConfiguration` (the watcher's `reloadAgents`), configuration
 * reconciliation, `resolveExternalPreToolPolicy` (what the Claude, ACP,
 * OpenCode and Codex adapters hold for a session's life), the staged
 * evaluator, the session agent resolver every start uses, and the
 * orchestration service's continuation and turn dispatch. The engine is a
 * fake adapter that holds the evaluator for its process's life, as a real
 * one does, and reports a resume cursor unless told not to.
 */
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { AgentConfigNotFoundError } from '../../../domain/config-loader-agents.js';
import type {
  ProviderAdapterShape,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { ApprovalGuardianService } from '../../../services/approvals/approval-guardian.js';
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
  vi.restoreAllMocks();
  for (const world of worlds.splice(0)) {
    await world.service.shutdown();
    world.store.close();
  }
});

const REPLACED_TEXT = 'Retrying in this turn will be refused again';
const RETRY_TEXT = 'Retry it in a moment';

interface Config {
  agents: Map<string, AgentSpec>;
  integrations: Map<string, any>;
  projectServers: string[];
  appConfig: Record<string, any>;
  providerConnections: any[];
  acpConnections: any[];
}

/** A runtime with only the configuration and policy seams this file drives. */
function policyRuntime(home: string, config: Config) {
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
    listProviderConnections: () => structuredClone(config.providerConnections),
  };
  runtime.configLoader = {
    getLaunchabilityRevision: () => 0,
    getProjectHomeDir: () => home,
    loadAgent: vi.fn(async (slug: string) => {
      const spec = config.agents.get(slug);
      if (!spec) throw new AgentConfigNotFoundError(slug, `${home}/${slug}`);
      return structuredClone(spec);
    }),
    loadIntegration: async (id: string) => {
      const integration = config.integrations.get(id);
      if (!integration) throw new Error(`Integration '${id}' not found`);
      return structuredClone(integration);
    },
    loadAppConfig: async () => structuredClone(config.appConfig),
    loadACPConfig: async () => ({
      connections: structuredClone(config.acpConnections),
    }),
  };
  runtime.appConfig = structuredClone(config.appConfig);
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

const ENGINES = ['claude', 'codex', 'acp'] as const;
type Engine = (typeof ENGINES)[number] | 'opencode';

function world(
  engine: Engine,
  options: {
    resumable?: boolean;
    openWork?: () => boolean;
    /** False: a model switch needs a successor session. */
    perTurnModel?: boolean;
  } = {},
) {
  const home = makeTempDir('external-policy-generation-');
  const config: Config = {
    agents: new Map<string, AgentSpec>([
      [
        'claude',
        {
          name: 'Claude',
          prompt: 'Help the person.',
          tools: {
            mcpServers: ['github'],
            autoApprove: ['Bash', 'mcp__github__*'],
          },
        },
      ],
    ]),
    integrations: new Map<string, any>([
      [
        'github',
        {
          id: 'github',
          displayName: 'GitHub',
          transport: 'stdio',
          command: 'gh-mcp',
          args: [],
        },
      ],
      [
        'linear',
        {
          id: 'linear',
          displayName: 'Linear',
          transport: 'stdio',
          command: 'linear-mcp',
          args: [],
        },
      ],
    ]),
    projectServers: [],
    appConfig: {
      agentConnections: {
        claude: { config: { proxyConnectionId: 'proxy' } },
        codex: { config: { proxyConnectionId: 'proxy' } },
      },
    },
    providerConnections: [
      {
        id: 'proxy',
        type: 'openai-compat',
        name: 'Proxy',
        enabled: true,
        capabilities: ['llm'],
        config: { baseUrl: 'https://proxy.example/v1', apiKey: 'key' },
      },
    ],
    acpConnections: [{ id: 'opencode', command: 'opencode', args: ['acp'] }],
  };
  const runtime = policyRuntime(home, config);
  const policies = new Map<string, StagedPreToolPolicyEvaluator>();
  const starts: ProviderSessionStartInput[] = [];
  const stops: string[] = [];
  const events = new AsyncEventQueue<any>();
  let turns = 0;
  const adapter: ProviderAdapterShape = {
    provider: engine,
    metadata: {
      displayName: 'fake engine',
      description: 'holds its pre-tool policy for the process, like a real one',
      capabilities: ['agent-runtime'],
      ...(options.perTurnModel === false
        ? {
            modelLaunch: {
              defaultAtStart: 'engine-selected',
              omissionAtResume: 'retain-session-model',
              omissionPerTurn: 'retain-session-model',
              overrideAtStart: true,
              overrideAtResume: true,
              overridePerTurn: false,
            },
          }
        : {}),
    } as never,
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
        eventId: `start-${input.threadId}-${starts.length}`,
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
        ...(options.resumable === false
          ? {}
          : { resumeCursor: { native: `native-${input.threadId}` } }),
      };
    },
    async sendTurn(input) {
      turns += 1;
      const turnId = `turn-${input.threadId}-${turns}`;
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
    // The engine process ends: its policy goes with it.
    async stopSession(threadId: string) {
      stops.push(threadId);
      policies.delete(threadId);
      events.push({
        eventId: `exit-${threadId}-${stops.length}`,
        provider: engine,
        threadId,
        sessionId: threadId,
        method: 'session.exited',
        createdAt: new Date().toISOString(),
        reason: 'stopped',
      });
    },
    async listSessions() {
      return [];
    },
    // A live engine process: the session keeps its policy across turns.
    async hasSession(threadId: string) {
      return policies.has(threadId);
    },
    // Work the engine still runs past its turn (a subagent, a background
    // task): parking would kill it.
    hasOpenEngineWork: () => options.openWork?.() === true,
    async stopAll() {},
    streamEvents: (streamOptions) => events.iterable(streamOptions),
  };
  const store = new EventStore(join(home, 'events.sqlite'));
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    idleSessionParkExitWaitMs: 2_000,
    adapterRegistry: {
      register() {},
      get: (provider: string) => (provider === engine ? adapter : undefined),
      list: () => [adapter],
    },
    preToolPolicyReplaced: (threadId: string) =>
      runtime.preToolPolicyGenerations.replaced(threadId),
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: async (slug) =>
        structuredClone(config.agents.get(slug) ?? null),
      resolveToolServer: async (id) =>
        structuredClone(config.integrations.get(id) ?? null),
      resolveProjectToolServers: async () => [...config.projectServers],
      resolveSkillDir: async () => null,
    }),
  } as never);
  runtime.orchestrationService = service;
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
    model?: string,
  ) => {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: engine,
          ...(model ? { model } : {}),
          metadata: {
            userId: 'owner',
            agentSlug: 'claude',
            conversationId: 'conversation',
            ...(engine === 'acp' || engine === 'opencode'
              ? { connectionId: 'opencode' }
              : {}),
            ...extra,
          },
        },
      },
      { userId: 'owner' },
    );
    await waitFor(threadId, 'session.started');
  };
  const turn = async (threadId: string, input: string, extra = {}) => {
    const completed = () =>
      store.listEventsByMethods(threadId, ['turn.completed']).length;
    const before = completed();
    await service.dispatch(
      { type: 'sendTurn', input: { threadId, input, ...extra } },
      { userId: 'owner' },
    );
    for (let i = 0; i < 200 && completed() === before; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed()).toBe(before + 1);
  };
  /** The engine's PreToolUse (or permission request) for one call. */
  const call = (threadId: string, toolName = 'Bash') =>
    policies.get(threadId)!(
      { toolName, toolArgs: { command: 'ls' } } as never,
      { agentSlug: 'claude', conversationId: 'conversation' } as never,
      { interaction: 'external' },
    );
  const next = () =>
    service.resolveConversationContinuation(
      'conversation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: engine },
    );
  /** The watcher's `reloadAgents` path: one serialized mutation. */
  const mutate = (change: () => void) =>
    runtime.mutateAgentConfiguration(async () => change());
  /** `station agents create` / `PUT /api/agents/:slug`, then reconciliation. */
  const saveAgent = async (slug: string, spec: AgentSpec) => {
    await runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        config.agents.set(slug, spec);
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
  };
  return {
    runtime,
    config,
    service,
    store,
    start,
    turn,
    call,
    next,
    mutate,
    saveAgent,
    starts,
    stops,
    policies,
  };
}

const allowed = { behavior: 'allow', toolGrant: true };
const replaced = {
  behavior: 'deny',
  denial: {
    policyDenied: true,
    reason: expect.stringContaining(REPLACED_TEXT),
  },
};

describe('external engine pre-tool policy generation', () => {
  test.each(ENGINES)(
    '%s: creating or editing an unrelated Agent leaves a running session able to run tools',
    async (engine) => {
      const w = world(engine);
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      expect(await w.call('conversation')).toEqual(allowed);

      await w.saveAgent('main-repair', {
        name: 'Main repair',
        prompt: 'Repair main.',
      });
      expect(w.runtime.agentConfigurationRevision).toBe(2);
      // The engine process outlives turns (Claude's stream-json session):
      // a later turn in the same session reaches the same evaluator.
      await w.turn('conversation', 'Now commit.');
      expect(w.starts.map((input) => input.threadId)).toEqual(['conversation']);
      expect(await w.call('conversation')).toEqual(allowed);

      await w.saveAgent('main-repair', {
        name: 'Main repair',
        prompt: 'Repair main, carefully.',
        tools: { mcpServers: [], autoApprove: ['*'] },
      });
      expect(await w.call('conversation')).toEqual(allowed);
      // Nothing to recover from: the next turn stays in this engine.
      expect((await w.next()).startRequired).toBe(false);
      await w.turn('conversation', 'Push it.');
      expect(w.stops).toEqual([]);
      expect(w.starts).toHaveLength(1);
    },
  );

  test.each(ENGINES)(
    "%s: a change to the session's own Agent refuses its tools, and the next turn restarts the engine in place under the new definition",
    async (engine) => {
      const w = world(engine);
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      expect(await w.call('conversation')).toEqual(allowed);

      // The person withdraws the Bash grant.
      await w.saveAgent('claude', {
        name: 'Claude',
        prompt: 'Help the person.',
        tools: { mcpServers: ['github'], autoApprove: ['mcp__github__*'] },
      });

      // The running engine cannot re-bind what it was launched with, so it
      // never decides under the old grant: refused, the same on retry, and
      // the text says what works.
      for (const attempt of [1, 2, 3])
        expect(
          await w.call('conversation'),
          `attempt ${attempt}`,
        ).toMatchObject(replaced);

      // The next turn stays in this conversation's Session; its dispatch
      // parks the stale engine (exit absorbed) and restarts it in place from
      // its resume cursor, which binds the current definition.
      expect(await w.next()).toMatchObject({
        sessionId: 'conversation',
        startRequired: false,
      });
      await w.turn('conversation', 'Run the tests again.');
      expect(w.stops).toEqual(['conversation']);
      expect(w.starts.map((input) => input.threadId)).toEqual([
        'conversation',
        'conversation',
      ]);
      expect(w.starts.at(-1)?.agent?.autoApprove).toEqual(['mcp__github__*']);
      // No grant now: Station leaves the call to the engine's own approval
      // flow, which asks the person.
      expect(await w.call('conversation')).toEqual({ behavior: 'defer' });
      expect(await w.call('conversation', 'mcp__github__list')).toEqual(
        allowed,
      );
      // The park is not an ending: nothing in the conversation says the
      // engine failed or exited.
      expect(
        w.store.listEventsByMethods('conversation', [
          'runtime.error',
          'session.exited',
        ]),
      ).toEqual([]);
      expect((await w.next()).startRequired).toBe(false);
    },
  );

  test('an engine that cannot resume gets a successor, and its stale engine is retired', async () => {
    const w = world('acp', { resumable: false });
    await w.start('conversation');
    await w.turn('conversation', 'Run the tests.');
    await w.saveAgent('claude', {
      name: 'Claude',
      prompt: 'Help the person.',
      tools: { mcpServers: ['github'], autoApprove: [] },
    });
    expect(await w.call('conversation')).toMatchObject(replaced);

    const successor = await w.next();
    expect(successor.startRequired).toBe(true);
    expect(successor.sessionId).not.toBe('conversation');
    // Retired before anything can run a turn in it again.
    expect(w.stops).toEqual(['conversation']);
    expect(w.policies.has('conversation')).toBe(false);
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
    expect(w.starts.at(-1)?.agent?.autoApprove).toEqual([]);
    expect(await w.call(successor.sessionId)).toEqual({ behavior: 'defer' });
  });

  // Each input the session was launched with, changed under it by the
  // watcher's reload path: the running engine must refuse, and the next
  // turn must restart it under the current configuration.
  const LAUNCH_INPUTS: Array<{
    name: string;
    engines?: readonly Engine[];
    change(config: Config): void;
    afterRestart(input: ProviderSessionStartInput): void;
  }> = [
    {
      name: 'its integration is deleted',
      change: (config) => config.integrations.delete('github'),
      afterRestart: (input) =>
        expect(input.agent?.toolServers?.map((server) => server.id)).toEqual(
          [],
        ),
    },
    {
      name: 'its integration is disabled',
      change: (config) =>
        config.integrations.set('github', {
          ...config.integrations.get('github'),
          enabled: false,
        }),
      afterRestart: (input) =>
        expect(input.agent?.toolServers?.map((server) => server.id)).toEqual(
          [],
        ),
    },
    {
      name: 'a tool is disabled in its integration',
      engines: ['claude', 'codex'],
      change: (config) =>
        config.integrations.set('github', {
          ...config.integrations.get('github'),
          disabledTools: ['delete_repo'],
        }),
      afterRestart: (input) =>
        expect(input.agent?.toolServers?.[0]?.disabledTools).toEqual([
          'delete_repo',
        ]),
    },
    {
      name: "its integration's command changes",
      change: (config) =>
        config.integrations.set('github', {
          ...config.integrations.get('github'),
          command: 'other-mcp',
        }),
      afterRestart: (input) =>
        expect(input.agent?.toolServers?.[0]?.command).toBe('other-mcp'),
    },
    {
      // Project (connection-default) tool servers resolve at start beside
      // the Agent's own.
      name: 'a Project default tool server is added',
      change: (config) => config.projectServers.push('linear'),
      afterRestart: (input) =>
        expect(input.agent?.toolServers?.map((server) => server.id)).toEqual(
          expect.arrayContaining(['github', 'linear']),
        ),
    },
    {
      // A plugin's integrations reach a start through the same integration
      // read (the ConfigLoader's plugin overlay) as a hand-written one.
      name: "a plugin's integration is removed",
      change: (config) => config.integrations.delete('github'),
      afterRestart: (input) =>
        expect(input.agent?.toolServers ?? []).toEqual([]),
    },
    {
      name: 'its model proxy connection is revoked',
      engines: ['claude', 'codex'],
      change: (config) => {
        config.providerConnections = [];
      },
      afterRestart: () => {},
    },
    {
      name: 'its engine connection settings change',
      engines: ['claude', 'codex'],
      change: (config) => {
        config.appConfig.agentConnections.claude.config.provideSkills = [
          'review',
        ];
        config.appConfig.agentConnections.codex.config.provideSkills = [
          'review',
        ];
      },
      afterRestart: () => {},
    },
    {
      name: 'its ACP connection is removed',
      engines: ['acp'],
      change: (config) => {
        config.acpConnections = [];
      },
      afterRestart: () => {},
    },
  ];
  for (const row of LAUNCH_INPUTS) {
    for (const engine of row.engines ?? ENGINES) {
      test(`${engine}: a running session is replaced when ${row.name}`, async () => {
        const w = world(engine);
        await w.start('conversation');
        await w.turn('conversation', 'Look at the repository.');
        expect(
          await w.call('conversation', 'mcp__github__delete_repo'),
        ).toEqual(allowed);

        await w.mutate(() => row.change(w.config));
        expect(
          await w.call('conversation', 'mcp__github__delete_repo'),
        ).toMatchObject(replaced);
        expect(await w.call('conversation')).toMatchObject(replaced);

        if (row.name === 'its model proxy connection is revoked') {
          // A launch now refuses too; the conversation's next turn surfaces
          // that refusal rather than running on the revoked credentials.
          expect(
            await w.runtime.preToolPolicyGenerations.replaced('conversation'),
          ).toBe(true);
          return;
        }
        if (row.name === 'its ACP connection is removed') {
          expect(
            await w.runtime.preToolPolicyGenerations.replaced('conversation'),
          ).toBe(true);
          return;
        }
        await w.turn('conversation', 'Look again.');
        expect(w.stops).toEqual(['conversation']);
        row.afterRestart(w.starts.at(-1)!);
      });
    }
  }

  test('a successor reserved for another reason retires nothing: only a replaced predecessor is stopped', async () => {
    const w = world('claude', { perTurnModel: false });
    await w.start('conversation', {}, 'first-model');
    await w.turn('conversation', 'Run the tests.');
    expect(
      await w.runtime.preToolPolicyGenerations.replaced('conversation'),
    ).toBe(false);
    // A model switch this engine cannot apply to a turn reserves a successor.
    const successor = await w.service.resolveConversationContinuation(
      'conversation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', modelOverride: 'another-model' },
    );
    expect(successor.startRequired).toBe(true);
    expect(successor.sessionId).not.toBe('conversation');
    // The predecessor's policy was never replaced, so it is not retired.
    expect(w.stops).toEqual([]);
    expect(w.policies.has('conversation')).toBe(true);
  });

  test('a start that names its Agent only through input.agent binds normally: its calls are allowed and it is not replaced', async () => {
    const w = world('claude');
    const agent = await w.service.resolveLaunchAgent({
      provider: 'claude',
      threadId: 'conversation',
      cwd: '/tmp',
      metadata: { agentSlug: 'claude' },
    } as never);
    expect(agent?.slug).toBe('claude');
    // As a start whose metadata lacks the slug: only `input.agent` has it.
    await w.service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: 'conversation',
          provider: 'claude',
          agent,
          metadata: { userId: 'owner', conversationId: 'conversation' },
        },
      } as never,
      { userId: 'owner' },
    );
    for (let i = 0; i < 200 && !w.starts.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(w.starts).toHaveLength(1);
    expect(w.starts[0]?.metadata?.agentSlug).toBeUndefined();
    expect(
      await w.runtime.preToolPolicyGenerations.replaced('conversation'),
    ).toBe(false);
    expect(await w.call('conversation')).toEqual(allowed);
  });

  test('a successor reserved without a context boundary and left unstarted (as after a crash) retires a predecessor replaced since', async () => {
    const w = world('claude', { perTurnModel: false });
    await w.start('conversation', {}, 'first-model');
    await w.turn('conversation', 'Run the tests.');
    // A model switch this engine cannot apply to a turn reserves a successor
    // that is never started.
    const reserved = await w.service.resolveConversationContinuation(
      'conversation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', modelOverride: 'another-model' },
    );
    expect(reserved.startRequired).toBe(true);
    expect(w.stops).toEqual([]);
    // The predecessor's launch is replaced while the reservation waits.
    await w.saveAgent('claude', {
      name: 'Claude',
      prompt: 'Help the person.',
      tools: { mcpServers: ['github'], autoApprove: [] },
    });
    expect(await w.call('conversation')).toMatchObject(replaced);
    const again = await w.service.resolveConversationContinuation(
      'conversation',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: 'claude', modelOverride: 'another-model' },
    );
    expect(again.sessionId).toBe(reserved.sessionId);
    expect(again.startRequired).toBe(true);
    expect(again.contextBoundary).toBeUndefined();
    expect(w.stops).toEqual(['conversation']);
  });

  test.each(['after', 'with'] as const)(
    'an explicit context reset %s a real configuration change: one engine at the end, history once',
    async (timing) => {
      const w = world('claude');
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      const change = () =>
        w.saveAgent('claude', {
          name: 'Claude',
          prompt: 'Help the person.',
          tools: { mcpServers: ['github'], autoApprove: [] },
        });
      const reset = () =>
        w.service.reserveConversationContextBoundary(
          'conversation',
          INTERNAL_SESSION_READ_SCOPE,
          {
            policy: 'continue-from-history',
            idempotencyKey: `reset-${timing}`,
            expectedCurrentSessionId: 'conversation',
            actorId: 'owner',
          },
        );
      if (timing === 'after') {
        await change();
        expect(await w.call('conversation')).toMatchObject(replaced);
        await reset();
      } else {
        // The reset and the change land together, before the next message.
        await Promise.all([reset(), change()]);
      }
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
      // The replaced engine was retired before the successor started.
      expect(w.stops).toEqual(['conversation']);
      // One engine alive: the successor, under the current definition.
      expect([...w.policies.keys()]).toEqual([successor.sessionId]);
      expect(w.starts.at(-1)?.agent?.autoApprove).toEqual([]);
      expect(await w.call(successor.sessionId)).toEqual({ behavior: 'defer' });
      // The prior conversation is replayed once.
      expect(
        successor.contextSeed?.text.split('User: Run the tests.').length,
      ).toBe(2);
      expect(successor.contextBoundary?.policy).toBe('continue-from-history');
      expect(
        w.store.listEventsByMethods('conversation', ['runtime.error']),
      ).toEqual([]);
    },
  );

  test('an unrelated change to the approval guardian reaches a running session on its next call', async () => {
    const w = world('claude');
    await w.start('conversation');
    // No grant for Write: Station leaves it to the engine.
    expect(await w.call('conversation', 'Write')).toEqual({
      behavior: 'defer',
    });
    const review = vi
      .spyOn(ApprovalGuardianService.prototype, 'reviewToolCall')
      .mockResolvedValue({
        decision: 'deny',
        reason: 'Not this one.',
      } as never);
    await w.mutate(() => {
      w.runtime.appConfig = {
        ...w.runtime.appConfig,
        approvalGuardian: { enabled: true, mode: 'enforce' },
      };
    });
    expect(await w.call('conversation', 'Write')).toMatchObject({
      behavior: 'deny',
      denial: { reason: expect.stringContaining('approval guardian') },
    });
    expect(review).toHaveBeenCalled();
    // The Agent itself did not change: the session keeps running.
    expect(await w.call('conversation')).toEqual(allowed);
  });

  test('a call made while a change is still being applied is refused with a retry, then decided', async () => {
    const w = world('claude');
    await w.start('conversation');
    await w.runtime.applyAgentConfigurationMutation(
      async (beginMutation: () => void) => {
        beginMutation();
        w.config.agents.set('main-repair', {
          name: 'Main repair',
          prompt: 'x',
        });
        return { slug: 'main-repair' };
      },
      {
        resolveAgentSlug: (saved: { slug: string }) => saved.slug,
        activationMode: 'defer',
      },
    );
    expect(await w.call('conversation')).toMatchObject({
      behavior: 'deny',
      denial: { reason: expect.stringContaining(RETRY_TEXT) },
    });
    expect((await w.next()).startRequired).toBe(false);
    await w.runtime.reconcileAgentConfigurationSources();
    expect(await w.call('conversation')).toEqual(allowed);
  });

  test('a replaced session hit during the next in-flight change still says retrying will not help', async () => {
    const w = world('claude');
    await w.start('conversation');
    await w.mutate(() =>
      w.config.agents.set('claude', { name: 'Claude', prompt: 'changed' }),
    );
    expect(await w.call('conversation')).toMatchObject(replaced);
    w.runtime.agentConfigurationRevision += 1;
    expect(await w.call('conversation')).toMatchObject(replaced);
    w.runtime.agentConfigurationRevision += 1;
  });

  test('a transient read failure refuses the call and re-checks; it does not replace the session', async () => {
    const w = world('claude');
    await w.start('conversation');
    const load = w.runtime.configLoader.loadAgent;
    const original = load.getMockImplementation();
    let failing = true;
    load.mockImplementation(async (slug: string) => {
      if (failing)
        throw new Error(`Agent '${slug}' plugin installation is not ready`);
      return original(slug);
    });
    await w.mutate(() => {});
    expect(await w.call('conversation')).toMatchObject({
      behavior: 'deny',
      denial: { reason: expect.stringContaining(RETRY_TEXT) },
    });
    expect(
      await w.runtime.preToolPolicyGenerations.replaced('conversation'),
    ).toBe(false);
    // Read again on the very next call: no further change is needed.
    failing = false;
    expect(await w.call('conversation')).toEqual(allowed);
  });

  test('a replaced verdict is kept until the configuration moves again', async () => {
    const w = world('claude');
    await w.start('conversation');
    await w.mutate(() =>
      w.config.agents.set('claude', { name: 'Claude', prompt: 'changed' }),
    );
    const load = w.runtime.configLoader.loadAgent;
    load.mockClear();
    for (let i = 0; i < 5; i++)
      expect(await w.call('conversation')).toMatchObject(replaced);
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('a change to an Agent field the resolved definition does not carry still replaces the session', async () => {
    const w = world('claude');
    await w.start('conversation');
    const spec = w.config.agents.get('claude')!;
    // `execution` is read by the start (model and engine binding), not
    // carried on the resolved definition.
    await w.mutate(() =>
      w.config.agents.set('claude', {
        ...spec,
        execution: { modelId: 'claude-other' },
      } as AgentSpec),
    );
    expect(await w.call('conversation')).toMatchObject(replaced);
  });

  // Tool servers an ACP-family launch resolves itself from its connection,
  // outside the session agent resolver.
  test.each([
    {
      name: 'connection default (no authored tool servers)',
      engine: 'acp' as const,
      tools: { autoApprove: ['Bash', 'mcp__github__*'] },
    },
    {
      name: "connection servers kept by `mcpMode: 'add'`",
      engine: 'acp' as const,
      tools: {
        mcpServers: ['linear'],
        mcpMode: 'add' as const,
        autoApprove: ['Bash', 'mcp__github__*'],
      },
    },
    {
      name: 'OpenCode native MCP, connection default',
      engine: 'opencode' as const,
      tools: { autoApprove: ['Bash', 'mcp__github__*'] },
    },
  ])(
    'a connection-provided tool server removed under a running session replaces it: $name',
    async ({ engine, tools }) => {
      const w = world(engine);
      w.config.acpConnections = [
        {
          id: 'opencode',
          command: 'opencode',
          args: ['acp'],
          provideToolServers: ['github'],
        },
      ];
      w.config.agents.set('claude', {
        name: 'Claude',
        prompt: 'Help the person.',
        tools: tools as AgentSpec['tools'],
      });
      await w.start('conversation');
      expect(await w.call('conversation', 'mcp__github__delete_repo')).toEqual(
        allowed,
      );
      await w.mutate(() => w.config.integrations.delete('github'));
      expect(
        await w.call('conversation', 'mcp__github__delete_repo'),
      ).toMatchObject(replaced);
      expect(
        await w.runtime.preToolPolicyGenerations.replaced('conversation'),
      ).toBe(true);
    },
  );

  test('a credential-recovery cycle and a probe refresh replace no running session; a profile switch does', async () => {
    const w = world('claude');
    const profiles = [{ ref: 'profile-a' }, { ref: 'profile-b' }];
    w.config.appConfig.agentConnections.claude.credentialRecovery = {
      profiles,
      activeProfileRef: 'profile-a',
    };
    w.config.agents.set('claude', {
      name: 'Claude',
      prompt: 'Help the person.',
      tools: {
        mcpServers: ['github'],
        mcpMode: 'replace',
        autoApprove: ['Bash', 'mcp__github__*'],
      },
    });
    w.config.integrations.set('github', {
      ...w.config.integrations.get('github'),
      probe: {
        status: 'ok',
        toolNames: ['list', 'delete_repo'],
        checkedAt: '2026-11-16T23:00:00.000Z',
      },
    });
    await w.start('conversation');
    const recovery = (fields: Record<string, unknown>) =>
      w.mutate(() => {
        w.config.appConfig.agentConnections.claude.credentialRecovery = {
          profiles,
          activeProfileRef: 'profile-a',
          ...fields,
        };
      });
    // A recovery cycle that stages and rolls back on the active profile.
    for (const outcome of ['staged', 'failed', 'rolled_back']) {
      await recovery({ outcome });
      expect(await w.call('conversation'), outcome).toEqual(allowed);
    }
    // A probe refresh: same tools in another order, a new timestamp.
    await w.mutate(() =>
      w.config.integrations.set('github', {
        ...w.config.integrations.get('github'),
        probe: {
          status: 'ok',
          toolNames: ['delete_repo', 'list'],
          checkedAt: '2026-11-16T23:30:00.000Z',
        },
      }),
    );
    expect(await w.call('conversation')).toEqual(allowed);
    expect(w.stops).toEqual([]);
    // A real switch to another credential profile is a different launch.
    await w.mutate(() => {
      w.config.appConfig.agentConnections.claude.credentialRecovery = {
        profiles,
        activeProfileRef: 'profile-b',
      };
    });
    expect(await w.call('conversation')).toMatchObject(replaced);
  });

  test('a replaced session still running work refuses the next turn until that work ends, then restarts in place: one engine throughout', async () => {
    let working = false;
    const w = world('claude', { openWork: () => working });
    await w.start('conversation');
    await w.turn('conversation', 'Start the long job.');
    working = true;
    await w.saveAgent('claude', {
      name: 'Claude',
      prompt: 'Help the person.',
      tools: { mcpServers: ['github'], autoApprove: [] },
    });
    expect(await w.call('conversation')).toMatchObject(replaced);

    // No successor while the old engine still runs work: the next turn
    // stays on this Session and is refused with what to do.
    expect(await w.next()).toMatchObject({
      sessionId: 'conversation',
      startRequired: false,
    });
    await expect(
      w.service.dispatch(
        {
          type: 'sendTurn',
          input: { threadId: 'conversation', input: 'Status?' },
        },
        { userId: 'owner' },
      ),
    ).rejects.toThrow(/still running work started under the old configuration/);
    expect(w.stops).toEqual([]);
    expect(w.starts).toHaveLength(1);

    // The work ends: the next turn parks and restarts it in place.
    working = false;
    await w.turn('conversation', 'Status?');
    expect(w.stops).toEqual(['conversation']);
    expect(w.starts.map((input) => input.threadId)).toEqual([
      'conversation',
      'conversation',
    ]);
    expect(await w.call('conversation')).toEqual({ behavior: 'defer' });
  });

  // The owner's Station: a reload with nothing changed (2026-11-17 the daily
  // midnight reload, since removed; 2026-11-21 an ordinary `Agents reloaded`)
  // refused every tool call of a running session, across several turns,
  // until the service was restarted.
  test.each(ENGINES)(
    '%s: a reloadAgents() with nothing changed leaves a running engine and its tools alone',
    async (engine) => {
      const w = world(engine);
      const reload = () => w.runtime.reloadAgents();
      await w.start('conversation');
      await w.turn('conversation', 'Run the tests.');
      expect(await w.call('conversation')).toEqual(allowed);
      // Inside the turn: the reload lands between two tool calls.
      await reload();
      expect(w.runtime.reloadConfigurationFromDisk).toHaveBeenCalledOnce();
      expect(await w.call('conversation')).toEqual(allowed);
      // A later turn on the same engine.
      await w.turn('conversation', 'And again.');
      expect(await w.call('conversation')).toEqual(allowed);
      // Another reload between turns.
      await reload();
      await w.turn('conversation', 'Once more.');
      expect(await w.call('conversation')).toEqual(allowed);
      expect(w.starts).toHaveLength(1);
      expect(w.stops).toEqual([]);
    },
  );

  test("turning Claude's Artifact tool off replaces a running Claude session", async () => {
    const w = world('claude');
    w.config.appConfig.claudeArtifactsEnabled = true;
    await w.start('conversation');
    expect(await w.call('conversation')).toEqual(allowed);
    await w.mutate(() => {
      w.config.appConfig.claudeArtifactsEnabled = false;
    });
    expect(await w.call('conversation')).toMatchObject(replaced);
  });

  test('narrowing the confined network replaces a session started confined, and only that one', async () => {
    const w = world('claude');
    w.config.appConfig.confinedNetwork = {
      mode: 'restricted',
      allowedHosts: ['registry.npmjs.org', 'github.com'],
    };
    const launch = (threadId: string, confined: boolean) =>
      w.runtime.resolveExternalPreToolPolicy(
        {
          provider: 'claude',
          threadId,
          agent: { slug: 'claude', autoApprove: ['Bash'] },
          metadata: { agentSlug: 'claude' },
          ...(confined
            ? { confinementPlan: { mechanism: 'seatbelt', level: 'workspace' } }
            : {}),
        },
        'authentic',
      ) as Promise<StagedPreToolPolicyEvaluator>;
    const bash = (policy: StagedPreToolPolicyEvaluator) =>
      policy(
        { toolName: 'Bash', toolArgs: {} } as never,
        { agentSlug: 'claude', conversationId: 'c' } as never,
        { interaction: 'external' },
      );
    const confined = await launch('confined', true);
    const open = await launch('open', false);
    await w.mutate(() => {
      w.config.appConfig.confinedNetwork = {
        mode: 'restricted',
        allowedHosts: ['registry.npmjs.org'],
      };
    });
    expect(await bash(confined)).toMatchObject(replaced);
    // A session started without confinement has no broker to narrow.
    expect(await bash(open)).toEqual(allowed);
  });

  test("a change to the Agent's approval mode replaces the session", async () => {
    const w = world('claude');
    await w.start('conversation');
    await w.mutate(() =>
      w.config.agents.set('claude', {
        ...w.config.agents.get('claude')!,
        approvalMode: 'never',
      } as AgentSpec),
    );
    expect(await w.call('conversation')).toMatchObject(replaced);
  });

  test.each(ENGINES)(
    '%s: a start that races a configuration change refuses its tools and restarts at the next turn',
    async (engine) => {
      const w = world(engine);
      // A mutation is in flight while the session starts.
      w.runtime.agentConfigurationRevision = 1;
      await w.start('conversation');
      expect(await w.call('conversation')).toMatchObject(replaced);
      expect(
        await w.runtime.preToolPolicyGenerations.replaced('conversation'),
      ).toBe(true);
      w.runtime.agentConfigurationRevision = 2;
      await w.turn('conversation', 'Run the tests.');
      expect(w.stops).toEqual(['conversation']);
      expect(w.starts).toHaveLength(2);
      expect(await w.call('conversation')).toEqual(allowed);
    },
  );

  test('a deleted Agent is a replaced one', async () => {
    const w = world('acp');
    await w.start('conversation');
    await w.mutate(() => w.config.agents.delete('claude'));
    expect(await w.call('conversation')).toMatchObject(replaced);
  });

  test('a conversation from before session lineage gets its lineage at boot, so the recovery reaches it', async () => {
    const home = makeTempDir('pre-lineage-');
    const path = join(home, 'events.sqlite');
    const first = new EventStore(path);
    const now = new Date().toISOString();
    first.upsertSession({
      provider: 'claude',
      threadId: 'claude:1794757786272',
      status: 'ready',
      createdAt: now,
      updatedAt: now,
    } as never);
    // A store written before lineage existed: the provider session row with
    // no lineage mapping.
    (first as any).db
      .prepare(
        'DELETE FROM orchestration_conversation_sessions WHERE session_id = ?',
      )
      .run('claude:1794757786272');
    expect(first.conversationSessions('claude:1794757786272')).toEqual([]);
    first.close();
    const booted = new EventStore(path);
    try {
      expect(
        booted
          .conversationSessions('claude:1794757786272')
          .map((entry) => entry.sessionId),
      ).toEqual(['claude:1794757786272']);
    } finally {
      booted.close();
    }
  });
});
