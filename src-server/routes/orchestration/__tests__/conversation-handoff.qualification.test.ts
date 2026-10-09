import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentId,
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import {
  CONVERSATION_HANDOFF_CARRIED_FIELDS,
  CONVERSATION_HANDOFF_RESET_FIELDS,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
} from '../../../providers/adapter-shape.js';
import { nativeSessionIdentityKey } from '../../../providers/adapters/native-resume-binding.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import {
  createConversationHandoffIntent,
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import type { NativeSessionOwnership } from '../../../services/orchestration/native-session-ownership.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const OWNER = 'handoff-qualification-owner';
const ENVIRONMENT = 'handoff-qualification-station';
const CONTEXT_TOKEN = 'HANDOFF-CARRY-731';

type AgentPath = {
  agent: AgentId;
  connectionId: string;
  provider: 'claude' | 'codex';
};

const CLAUDE: AgentPath = {
  agent: agentId('claude'),
  connectionId: 'claude',
  provider: 'claude',
};
const CODEX: AgentPath = {
  agent: agentId('codex'),
  connectionId: 'codex',
  provider: 'codex',
};

class TerminalHandoffAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];
  readonly stopped = new Set<string>();
  private readonly nativeIds = new Map<string, string>();
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(
    readonly provider: 'claude' | 'codex',
    readonly nativeReturn = false,
    private readonly ownership?: NativeSessionOwnership,
  ) {
    this.metadata = {
      displayName: provider === 'claude' ? 'Claude Code' : 'Codex',
      description: 'Terminal cross-Agent qualification adapter',
      capabilities: ['agent-runtime'],
      ...(nativeReturn
        ? {
            continuity: {
              resume: 'same-session' as const,
              fork: 'none' as const,
              rewind: 'none' as const,
              resumeIdentity: 'require-match' as const,
              nativeReturn: 'same-binding' as const,
            },
          }
        : {}),
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    };
  }

  async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const cursor = input.resumeCursor;
    const nativeId =
      cursor &&
      typeof cursor === 'object' &&
      'nativeSessionId' in cursor &&
      typeof cursor.nativeSessionId === 'string'
        ? cursor.nativeSessionId
        : `${this.provider}:native:${input.threadId}`;
    this.nativeIds.set(input.threadId, nativeId);
    if (this.nativeReturn)
      this.ownership?.claim(
        nativeSessionIdentityKey(this.provider, 'a'.repeat(64), nativeId),
        input.threadId,
      );
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:started`,
      method: 'session.started',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      initialState: 'created',
      metadata: input.metadata,
    });
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      metadata: {
        ...input.metadata,
        ...(this.nativeReturn
          ? {
              nativeResumeBindingKey: 'a'.repeat(64),
              ...(input.resumeCursor
                ? { nativeResumeIdentity: 'matched' }
                : {}),
            }
          : {}),
      },
    } as CanonicalRuntimeEvent);
    this.events.push({
      eventId: `${input.threadId}:started`,
      method: 'session.started',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      metadata: { ...input.metadata },
    });
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
      ...(this.nativeReturn
        ? { resumeCursor: { nativeSessionId: nativeId }, persistSession: true }
        : {}),
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  /** A live engine session keeps its own context across turns (#2540). */
  private readonly memory = new Map<string, string>();

  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const ordinal = this.turns.length;
    const turnId = `${this.provider}-handoff-turn-${ordinal}`;
    const token =
      /HANDOFF-CARRY-[0-9]+/.exec(
        `${input.ambientContext ?? ''}\n${input.input}`,
      )?.[0] ??
      this.memory.get(this.nativeIds.get(input.threadId) ?? input.threadId);
    if (token)
      this.memory.set(
        this.nativeIds.get(input.threadId) ?? input.threadId,
        token,
      );
    const base = {
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
    } as const;
    this.events.push({
      ...base,
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
    });
    this.events.push({
      ...base,
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: token
        ? `${this.provider} retained ${token}`
        : `${this.provider} CONTEXT_MISSING`,
    });
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.stopped.add(threadId);
    if (!this.sessions.delete(threadId)) return;
    this.events.push({
      eventId: `${threadId}:exited`,
      provider: this.provider,
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      reason: 'stopped',
    });
    this.ownership?.retired(threadId);
  }
  async retireSession(threadId: string) {
    await this.stopSession(threadId);
    return { status: 'retired' as const };
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((session) => {
      if (!this.nativeReturn) return session;
      const { resumeCursor: _cursor, ...snapshot } = session;
      return snapshot;
    });
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {
    for (const threadId of this.sessions.keys())
      await this.stopSession(threadId);
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
}

function registry(
  adapters: readonly TerminalHandoffAdapter[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return [...adapters];
    },
  };
}

function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const check = async () => {
      try {
        await assertion();
        resolve();
      } catch (error) {
        if (Date.now() - started >= timeoutMs) reject(error);
        else setTimeout(check, 10);
      }
    };
    void check();
  });
}

function currentBinding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const current = store.conversationSessions(conversationId).at(-1);
  if (!current) return null;
  const configured = store
    .listEvents(current.sessionId)
    .map((item) => item.payload)
    .reverse()
    .find((event) => event.method === 'session.configured');
  const metadata = configured?.metadata;
  const boundAgent =
    typeof metadata?.agentId === 'string'
      ? metadata.agentId
      : typeof metadata?.targetId === 'string'
        ? metadata.targetId
        : undefined;
  if (!metadata || typeof metadata.environmentId !== 'string' || !boundAgent)
    return null;
  const session = store
    .readSessions()
    .find((item) => item.threadId === current.sessionId);
  return {
    environmentId: metadata.environmentId,
    agentId: boundAgent,
    ...(typeof metadata.executionAgentId === 'string'
      ? { executionAgentId: metadata.executionAgentId }
      : {}),
    ...(typeof metadata.connectionId === 'string'
      ? { connectionId: metadata.connectionId }
      : {}),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
    ...(typeof session?.cwd === 'string' ? { cwd: session.cwd } : {}),
  };
}

describe('scripted provider Agent handoff qualification (#3912/#731/#3307)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test.each([
    {
      label: 'Claude Code to Codex',
      source: CLAUDE,
      target: CODEX,
      nativeReturn: false,
      preserveProfile: false,
    },
    {
      label: 'Codex to Claude Code',
      source: CODEX,
      target: CLAUDE,
      nativeReturn: false,
      preserveProfile: false,
    },
    {
      label: 'Claude Code to Codex and native return',
      source: CLAUDE,
      target: CODEX,
      nativeReturn: true,
      preserveProfile: false,
    },
    {
      label: 'Codex to Claude Code and native return',
      source: CODEX,
      target: CLAUDE,
      nativeReturn: true,
      preserveProfile: false,
    },
    {
      label: 'Same Agent from Claude Code to Codex',
      source: CLAUDE,
      target: CODEX,
      preserveProfile: true,
      nativeReturn: false,
    },
    {
      label: 'Same Agent from Claude Code to Codex and native return',
      source: CLAUDE,
      target: CODEX,
      preserveProfile: true,
      nativeReturn: true,
    },
  ])(
    '$label preserves one Conversation across an explicit, replay-safe Session handoff and an ordinary target turn',
    async ({ source, target, preserveProfile, nativeReturn }) => {
      const targetProfileId = preserveProfile ? source.agent : target.agent;
      const targetRef = preserveProfile
        ? {
            kind: 'agent-execution-override' as const,
            agent: source.agent,
            executionAgent: target.agent,
            expectedDefinitionFingerprint:
              'sha256:0792be2242775718be74c87d7c99dac4af95a3c3863862c9aae70629321d5bbe',
          }
        : target.agent;
      const root = mkdtempSync(join(tmpdir(), 'station-dd-real-handoff-'));
      roots.push(root);
      const databasePath = join(root, 'orchestration.sqlite');
      let store = new EventStore(databasePath);
      let eventBus = new EventBus();
      const ownership: NativeSessionOwnership = {
        assertMutable: (id) => store.assertNativeSessionMutable(id),
        claim: (key, id, rebind) =>
          store.claimNativeSessionIdentity(key, id, rebind),
        retired: (id) => store.recordNativeSessionRetired(id),
      };
      let sourceAdapter = new TerminalHandoffAdapter(
        source.provider,
        nativeReturn,
        ownership,
      );
      let targetAdapter = new TerminalHandoffAdapter(
        target.provider,
        nativeReturn,
        ownership,
      );
      let service = new OrchestrationService({
        adapterRegistry: registry([sourceAdapter, targetAdapter]),
        eventBus,
        eventStore: store,
        loadAgentExecutionConfig: async (slug) => ({
          credentialProfileRef: `${slug}-account`,
        }),
        resolveSessionAgent: createSessionAgentResolver({
          loadAgentSpec: async (slug) => ({
            name: slug,
            prompt: `Profile instructions for ${slug}`,
            skills: [],
            tools: { mcpServers: [] },
          }),
          resolveToolServer: async () => null,
          resolveSkillDir: async () => null,
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const conversationId = `conversation:handoff:${source.provider}-to-${target.provider}`;

      const pathFor = (id: AgentId): AgentPath =>
        id === source.agent ? source : target;
      const executionDeps: ExecutionTargetExecutionDependencies = {
        resolveEnvironmentAccess: async () => ({
          apiBase: 'http://qualification.station',
          environmentId: ENVIRONMENT,
          environmentName: 'Qualification Station',
          kind: 'current',
        }),
        getAgent: async (_access, id) => {
          const path = pathFor(id);
          return {
            slug: id,
            available: true,
            ...(preserveProfile && id === source.agent
              ? {
                  definitionFingerprint:
                    'sha256:0792be2242775718be74c87d7c99dac4af95a3c3863862c9aae70629321d5bbe',
                }
              : {}),
            executionDefault: id === source.agent || id === target.agent,
            execution: {
              agentConnectionId: engineConnectionId(path.connectionId),
            },
          };
        },
        getConnection: async (_access, id) => {
          const path = [source, target].find(
            (candidate) => candidate.connectionId === id,
          );
          if (!path) throw new Error(`unknown qualification connection ${id}`);
          return {
            id: engineConnectionId(path.connectionId),
            name: path.provider === 'claude' ? 'Claude Code' : 'Codex',
            type: `${path.provider}-runtime`,
            kind: 'agent',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            prerequisites: [],
            config: { provider: path.provider },
          };
        },
        getProject: vi.fn(),
        getProviderAdapter: (provider) => service.getProviderAdapter(provider),
        readSessionBinding: async (_access, id) => currentBinding(store, id),
        resolveConversationSession: async (_access, id, requested) =>
          service.resolveConversationContinuation(
            id,
            INTERNAL_SESSION_READ_SCOPE,
            requested,
          ),
        prepareConversationHandoff: async (_access, input) =>
          service.prepareConversationHandoff(
            input.conversationId,
            INTERNAL_SESSION_READ_SCOPE,
            {
              agentId: input.agentId,
              provider: input.provider,
              ...(input.executionAgentId
                ? { executionAgentId: input.executionAgentId }
                : {}),
              environmentId: ENVIRONMENT,
              ...(input.connectionId
                ? { connectionId: input.connectionId }
                : {}),
              ...(input.modelId ? { modelId: input.modelId } : {}),
              idempotencyKey: input.idempotencyKey,
              messageDigest: input.messageDigest,
            },
          ),
        readConversationHandoffEffect: async (_access, input) =>
          service.readConversationHandoffStatus(
            input.conversationId,
            input.idempotencyKey,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        retireNativeReturnSource: async (_access, sessionId) =>
          service.retireNativeReturnSource(
            sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        retireHandoffPredecessor: async (_access, sessionId) =>
          service.retireHandoffPredecessor(
            sessionId,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        retireNativeContinuationSource: async (_access, sourceId, targetId) =>
          service.retireNativeContinuationSource(
            sourceId,
            targetId,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        startSession: async (_access, input) => {
          const started = await service.startSessionInternal(
            { type: 'start-session', input },
            { userId: OWNER },
            {
              conversationIdentity: {
                conversationId: String(input.metadata?.conversationId),
                environmentId: String(input.metadata?.environmentId),
              },
            },
          );
          if (started.status !== 'accepted') throw new Error(started.message);
          await eventually(() => {
            expect(
              currentBinding(store, String(input.metadata?.conversationId)),
            ).not.toBeNull();
          });
          // The provider contract returns a started-session handle; this mock
          // drives the real service and reports no handle of its own.
          return undefined;
        },
        sendTurn: async (_access, input) => {
          const dispatched = await service.dispatchWithReceipt(
            { type: 'sendTurn', input },
            { userId: OWNER },
          );
          if (!dispatched.result || !('turnId' in dispatched.result))
            throw new Error('qualification dispatch returned no turn id');
          return { turnId: dispatched.result.turnId };
        },
        createConversationId: () => conversationId,
      };

      const execute = (
        selected: AgentPath,
        input: {
          message: string;
          conversationId?: string;
          idempotencyKey?: string;
        },
      ) =>
        executeForegroundMessage(
          {
            message: input.message,
            ...(input.conversationId
              ? { conversationId: input.conversationId }
              : {}),
            target: {
              environment: { kind: 'current' },
              agent:
                preserveProfile && selected === target
                  ? targetRef
                  : selected.agent,
            },
            userId: OWNER,
            ...(input.idempotencyKey
              ? {
                  handoffIntent: createConversationHandoffIntent(
                    input.idempotencyKey,
                  ),
                }
              : {}),
          },
          executionDeps,
        );
      const routes = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => OWNER,
        executeForegroundMessage: (input) =>
          executeForegroundMessage({ ...input, userId: OWNER }, executionDeps),
        handoffConversation: (input) =>
          executeForegroundMessage(
            {
              ...input,
              userId: OWNER,
              handoffIntent: createConversationHandoffIntent(
                input.idempotencyKey,
              ),
            },
            executionDeps,
          ),
        continueForegroundMessage: (input) =>
          execute(target, {
            message: input.message,
            conversationId: input.conversationId,
          }),
      });
      const app = new Hono();
      app.route('/api/orchestration', routes);
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      if (preserveProfile) {
        const refused = await post('/api/orchestration/chat', {
          message: 'An authored Agent is not an engine selector.',
          target: {
            environment: { kind: 'current' },
            agent: {
              kind: 'agent-execution-override',
              agent: source.agent,
              executionAgent: 'arbitrary-authored-agent',
            },
          },
        });
        expect(refused.status, await refused.clone().text()).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: expect.stringMatching(/receiver-owned default engine Agent/),
        });
        expect(sourceAdapter.starts).toHaveLength(0);
        expect(targetAdapter.starts).toHaveLength(0);
        expect(store.conversationSessions(conversationId)).toHaveLength(0);
      }

      const started = await post('/api/orchestration/chat', {
        message: `Remember ${CONTEXT_TOKEN}.`,
        target: { environment: { kind: 'current' }, agent: source.agent },
      });
      expect(started.status, await started.clone().text()).toBe(200);
      await eventually(async () => {
        expect(
          (
            await service.readCurrentConversationSession(
              conversationId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.session.lifecycleState,
        ).toBe('idle');
      });

      const idempotencyKey = `handoff-${source.provider}-to-${target.provider}`;
      const handoffBody = {
        message: 'Continue and recall the token.',
        idempotencyKey,
        target: {
          environment: { kind: 'current' },
          agent: targetRef,
        },
      };
      const handoff = await post(
        `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
        handoffBody,
      );
      expect(handoff.status, await handoff.clone().text()).toBe(200);
      const handoffReceipt = (await handoff.json()) as {
        data: {
          sessionId: string;
          handoff: {
            predecessorSessionId: string;
            currentSessionId: string;
            outcome: string;
            carried: string[];
            reset: string[];
          };
        };
      };
      expect(handoffReceipt.data.handoff).toMatchObject({
        predecessorSessionId: conversationId,
        currentSessionId: handoffReceipt.data.sessionId,
        outcome: 'created',
        target: {
          agentId: targetProfileId,
          provider: target.provider,
          ...(preserveProfile ? { executionAgentId: target.agent } : {}),
        },
        carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS],
        reset: [...CONVERSATION_HANDOFF_RESET_FIELDS],
      });
      expect(handoffReceipt.data.handoff.reset).toEqual(
        expect.arrayContaining([
          'providerNativeCursor',
          'toolState',
          'sessionApprovals',
          'queuedRequests',
        ]),
      );

      const replay = await post(
        `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
        handoffBody,
      );
      expect(replay.status, await replay.clone().text()).toBe(200);
      const replayBody = (await replay.json()) as { data: unknown };
      expect(replayBody.data).toMatchObject({
        sessionId: handoffReceipt.data.sessionId,
        handoff: {
          outcome: 'existing',
          target: {
            agentId: targetProfileId,
            provider: target.provider,
            ...(preserveProfile ? { executionAgentId: target.agent } : {}),
          },
        },
      });
      await eventually(() => expect(targetAdapter.turns).toHaveLength(1));
      expect(targetAdapter.turns[0]?.ambientContext).toContain(CONTEXT_TOKEN);

      await eventually(async () => {
        expect(
          (
            await service.readCurrentConversationSession(
              conversationId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.session.lifecycleState,
        ).toBe('idle');
      });
      const lineageAfterHandoff = store.conversationSessions(conversationId);
      expect(lineageAfterHandoff).toHaveLength(2);
      expect(lineageAfterHandoff[1]?.sessionId).toBe(
        handoffReceipt.data.sessionId,
      );

      const directSwitch = await post('/api/orchestration/chat', {
        conversationId,
        message: 'Illegally switch back through ordinary chat.',
        target: { environment: { kind: 'current' }, agent: source.agent },
      });
      expect(directSwitch.status).toBe(400);
      expect(await directSwitch.json()).toMatchObject({
        success: false,
        error: expect.stringMatching(
          /different Environment, Agent, or Station user/,
        ),
      });
      expect(sourceAdapter.turns).toHaveLength(1);
      expect(targetAdapter.turns).toHaveLength(1);

      const ordinary = await post(
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        { message: 'Third turn stays on the target Agent.' },
      );
      expect(ordinary.status, await ordinary.clone().text()).toBe(200);
      // #2540: the ordinary turn after a handoff runs in the handoff target's
      // live Session — no third Session, and no transcript seed: that engine
      // already holds the context the handoff turn carried to it.
      await eventually(() => {
        expect(targetAdapter.turns).toHaveLength(2);
      });
      expect(targetAdapter.turns[1]?.threadId).toBe(
        handoffReceipt.data.sessionId,
      );
      expect(sourceAdapter.turns).toHaveLength(1);

      const lineage = store.conversationSessions(conversationId);
      expect(new Set(lineage.map((entry) => entry.sessionId))).toHaveLength(2);
      expect(lineage.map((entry) => entry.ordinal)).toEqual([0, 1]);
      expect(currentBinding(store, conversationId)?.agentId).toBe(
        targetProfileId,
      );
      expect(targetAdapter.starts[0]?.agent?.slug).toBe(targetProfileId);
      expect(targetAdapter.starts[0]?.credentialProfileRef).toBe(
        `${target.agent}-account`,
      );
      if (preserveProfile) {
        expect(targetAdapter.starts[0]?.metadata?.executionAgentId).toBe(
          target.agent,
        );
        expect(
          targetAdapter.starts[0]?.metadata?.expectedDefinitionFingerprint,
        ).toBe(
          'sha256:0792be2242775718be74c87d7c99dac4af95a3c3863862c9aae70629321d5bbe',
        );
        expect(targetAdapter.turns[0]?.ambientContext).toContain(
          `Profile instructions for ${source.agent}`,
        );
        expect(
          await service.readConversationHandoffStatus(
            conversationId,
            idempotencyKey,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        ).toMatchObject({
          marker: {
            targetAgentId: source.agent,
            targetExecutionAgentId: target.agent,
            targetProvider: target.provider,
            expectedDefinitionFingerprint:
              targetAdapter.starts[0]?.metadata?.expectedDefinitionFingerprint,
          },
        });
      }

      if (preserveProfile) {
        const fresh = await post('/api/orchestration/chat', {
          conversationId: `${conversationId}:fresh-override`,
          message: 'Start directly on my chosen engine.',
          target: { environment: { kind: 'current' }, agent: targetRef },
        });
        expect(fresh.status, await fresh.clone().text()).toBe(200);
        expect(await fresh.json()).toMatchObject({
          data: {
            resolution: {
              agentId: source.agent,
              executionAgentId: target.agent,
              provider: target.provider,
            },
          },
        });
        expect(targetAdapter.starts.at(-1)?.agent?.slug).toBe(source.agent);
        expect(targetAdapter.starts.at(-1)?.credentialProfileRef).toBe(
          `${target.agent}-account`,
        );
      }

      let returnedSessionId: string | undefined;
      if (nativeReturn) {
        await eventually(async () => {
          expect(
            (
              await service.readCurrentConversationSession(
                conversationId,
                INTERNAL_SESSION_READ_SCOPE,
              )
            )?.session.hasActiveTurn,
          ).toBe(false);
        });
        const returned = await post(
          `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/handoff`,
          {
            message: 'Recall the token after returning to your earlier engine.',
            idempotencyKey: 'return-to-earlier-engine',
            target: { environment: { kind: 'current' }, agent: source.agent },
          },
        );
        expect(returned.status, await returned.clone().text()).toBe(200);
        const returnedBody = (await returned.json()) as {
          data: { sessionId: string };
        };
        returnedSessionId = returnedBody.data.sessionId;
        await eventually(() => expect(sourceAdapter.turns).toHaveLength(2));
        expect(sourceAdapter.starts.at(-1)).toMatchObject({
          resumeCursor: {
            nativeSessionId: `${source.provider}:native:${conversationId}`,
          },
          requireNativeResumeIdentity: true,
          nativeResumeBindingKey: 'a'.repeat(64),
        });
        expect(sourceAdapter.stopped.has(conversationId)).toBe(true);
        expect(sourceAdapter.turns.at(-1)?.ambientContext).toContain(
          'Conversation while this engine was away',
        );
        expect(sourceAdapter.turns.at(-1)?.ambientContext).toContain(
          'Third turn stays on the target Agent.',
        );
        expect(sourceAdapter.turns.at(-1)?.ambientContext).not.toContain(
          `Remember ${CONTEXT_TOKEN}.`,
        );
        const marker = store.conversationHandoffForSession(returnedSessionId!);
        expect(marker?.nativeReturnSourceSessionId).toBe(conversationId);
        expect(marker?.nativeReturnSourceEventId).toBe(
          `${source.provider}-handoff-turn-1:completed`,
        );
        const status = await service.readConversationHandoffStatus(
          conversationId,
          'return-to-earlier-engine',
          INTERNAL_SESSION_READ_SCOPE,
        );
        expect(status?.marker.carried).toContain('nativeSession');
        expect(status?.marker.reset).not.toContain('providerNativeCursor');
        expect(status?.nativeResumeIdentity).toBe('matched');
        await eventually(async () =>
          expect(
            (
              await service.readCurrentConversationSession(
                conversationId,
                INTERNAL_SESSION_READ_SCOPE,
              )
            )?.session.lifecycleState,
          ).toBe('idle'),
        );
      }

      await service.shutdown();
      store.close();
      store = new EventStore(databasePath);
      eventBus = new EventBus();
      sourceAdapter = new TerminalHandoffAdapter(source.provider);
      targetAdapter = new TerminalHandoffAdapter(target.provider);
      service = new OrchestrationService({
        adapterRegistry: registry([sourceAdapter, targetAdapter]),
        loadAgentExecutionConfig: async (slug) => ({
          credentialProfileRef: `${slug}-account`,
        }),
        resolveSessionAgent: createSessionAgentResolver({
          loadAgentSpec: async (slug) => ({
            name: slug,
            prompt: `Profile instructions for ${slug}`,
            skills: [],
            tools: { mcpServers: [] },
          }),
          resolveToolServer: async () => null,
          resolveSkillDir: async () => null,
        }),

        eventBus,
        eventStore: store,
        logger: { debug: vi.fn(), warn: vi.fn() },
      });
      const restored = await service.readConversationEventWindow(
        conversationId,
        { authority: INTERNAL_SESSION_READ_SCOPE, turnLimit: 10 },
      );
      expect(restored?.currentSessionId).toBe(
        returnedSessionId ?? lineage[1]?.sessionId,
      );
      expect(restored?.handoffs).toEqual([
        expect.objectContaining({
          predecessorSessionId: conversationId,
          sessionId: handoffReceipt.data.sessionId,
          idempotencyKey,
          targetAgentId: targetProfileId,
          targetProvider: target.provider,
          ...(preserveProfile
            ? {
                targetExecutionAgentId: target.agent,
                expectedDefinitionFingerprint:
                  'sha256:0792be2242775718be74c87d7c99dac4af95a3c3863862c9aae70629321d5bbe',
              }
            : {}),
          targetConnectionId: target.connectionId,
          carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS],
          reset: [...CONVERSATION_HANDOFF_RESET_FIELDS],
        }),
        ...(nativeReturn
          ? [
              expect.objectContaining({
                sessionId: returnedSessionId,
                targetAgentId: source.agent,
                carried: expect.arrayContaining(['nativeSession']),
                reset: expect.not.arrayContaining(['providerNativeCursor']),
              }),
            ]
          : []),
      ]);
      expect(
        restored?.events.filter(
          (entry) => entry.event.method === 'turn.completed',
        ),
      ).toHaveLength(nativeReturn ? 4 : 3);
      expect(
        restored?.events.filter(
          (entry) =>
            entry.event.method === 'turn.completed' &&
            entry.event.outputText?.includes(CONTEXT_TOKEN),
        ),
      ).toHaveLength(nativeReturn ? 4 : 3);

      if (preserveProfile) {
        const returned = await execute(source, {
          message: 'Return to my Agent default engine.',
          conversationId,
          idempotencyKey: 'return-to-agent-default',
        });
        expect(returned.resolution).toMatchObject({
          agentId: source.agent,
          provider: source.provider,
        });
        expect(returned.resolution.executionAgentId).toBeUndefined();
        expect(sourceAdapter.starts[0]?.agent?.slug).toBe(source.agent);
        expect(
          sourceAdapter.starts[0]?.metadata?.executionAgentId,
        ).toBeUndefined();
        expect(sourceAdapter.starts[0]?.credentialProfileRef).toBe(
          `${source.agent}-account`,
        );
        expect(store.conversationSessions(conversationId)).toHaveLength(
          nativeReturn ? 4 : 3,
        );
      }

      await service.shutdown();
      store.close();
    },
  );
});
