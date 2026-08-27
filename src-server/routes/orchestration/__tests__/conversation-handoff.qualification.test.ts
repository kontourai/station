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
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
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

  constructor(readonly provider: 'claude' | 'codex') {
    this.metadata = {
      displayName: provider === 'claude' ? 'Claude Code' : 'Codex',
      description: 'Terminal cross-Agent qualification adapter',
      capabilities: ['agent-runtime'],
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
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const ordinal = this.turns.length;
    const turnId = `${this.provider}-handoff-turn-${ordinal}`;
    const token = /HANDOFF-CARRY-[0-9]+/.exec(
      `${input.ambientContext ?? ''}\n${input.input}`,
    )?.[0];
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
      prompt: input.input,
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
  async stopSession(): Promise<void> {}
  async listSessions(): Promise<ProviderSession[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
  async stopAll(): Promise<void> {}
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
    ...(typeof metadata.connectionId === 'string'
      ? { connectionId: metadata.connectionId }
      : {}),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
    ...(typeof session?.cwd === 'string' ? { cwd: session.cwd } : {}),
  };
}

describe('daily-driver real Agent handoff qualification (#3912/#731/#3307)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test.each([
    { label: 'Claude Code to Codex', source: CLAUDE, target: CODEX },
    { label: 'Codex to Claude Code', source: CODEX, target: CLAUDE },
  ])(
    '$label preserves one Conversation across an explicit, replay-safe Session handoff and an ordinary target turn',
    async ({ source, target }) => {
      const root = mkdtempSync(join(tmpdir(), 'station-dd-real-handoff-'));
      roots.push(root);
      const databasePath = join(root, 'orchestration.sqlite');
      let store = new EventStore(databasePath);
      let eventBus = new EventBus();
      const sourceAdapter = new TerminalHandoffAdapter(source.provider);
      const targetAdapter = new TerminalHandoffAdapter(target.provider);
      let service = new OrchestrationService({
        adapterRegistry: registry([sourceAdapter, targetAdapter]),
        eventBus,
        eventStore: store,
        resolveSessionAgent: async (input) => {
          const configuredAgent = input.metadata?.agentId;
          return {
            ...input,
            agent: {
              slug:
                typeof configuredAgent === 'string'
                  ? configuredAgent
                  : source.agent,
            },
          };
        },
        logger: { debug: vi.fn(), warn: vi.fn() },
        ownerlessSessionAccess: 'single-user-compat',
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
            slug: path.agent,
            available: true,
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
              agent: selected.agent,
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
          execute(source, {
            message: input.message,
            ...(input.conversationId
              ? { conversationId: input.conversationId }
              : {}),
          }),
        handoffConversation: (input) =>
          execute(target, {
            message: input.message,
            conversationId: input.conversationId,
            idempotencyKey: input.idempotencyKey,
          }),
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
        ).toBe('completed');
      });

      const idempotencyKey = `handoff-${source.provider}-to-${target.provider}`;
      const handoffBody = {
        message: 'Continue and recall the token.',
        idempotencyKey,
        target: {
          environment: { kind: 'current' },
          agent: target.agent,
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
        handoff: { outcome: 'existing' },
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
        ).toBe('completed');
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
      await eventually(() => {
        expect(targetAdapter.turns).toHaveLength(2);
        expect(store.conversationSessions(conversationId)).toHaveLength(3);
      });
      expect(targetAdapter.turns[1]?.ambientContext).toContain(CONTEXT_TOKEN);
      expect(sourceAdapter.turns).toHaveLength(1);

      const lineage = store.conversationSessions(conversationId);
      expect(new Set(lineage.map((entry) => entry.sessionId))).toHaveLength(3);
      expect(lineage.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
      expect(currentBinding(store, conversationId)?.agentId).toBe(target.agent);

      await service.shutdown();
      store.close();
      store = new EventStore(databasePath);
      eventBus = new EventBus();
      service = new OrchestrationService({
        adapterRegistry: registry([
          new TerminalHandoffAdapter(source.provider),
          new TerminalHandoffAdapter(target.provider),
        ]),
        eventBus,
        eventStore: store,
        logger: { debug: vi.fn(), warn: vi.fn() },
        ownerlessSessionAccess: 'single-user-compat',
      });
      const restored = await service.readConversationEventWindow(
        conversationId,
        { authority: INTERNAL_SESSION_READ_SCOPE, turnLimit: 10 },
      );
      expect(restored?.currentSessionId).toBe(lineage[2]?.sessionId);
      expect(restored?.handoffs).toEqual([
        expect.objectContaining({
          predecessorSessionId: conversationId,
          sessionId: handoffReceipt.data.sessionId,
          idempotencyKey,
          targetAgentId: target.agent,
          targetConnectionId: target.connectionId,
          carried: [...CONVERSATION_HANDOFF_CARRIED_FIELDS],
          reset: [...CONVERSATION_HANDOFF_RESET_FIELDS],
        }),
      ]);
      expect(
        restored?.events.filter(
          (entry) => entry.event.method === 'turn.completed',
        ),
      ).toHaveLength(3);
      expect(
        restored?.events.filter(
          (entry) =>
            entry.event.method === 'turn.completed' &&
            entry.event.outputText?.includes(CONTEXT_TOKEN),
        ),
      ).toHaveLength(3);

      await service.shutdown();
      store.close();
    },
  );
});
