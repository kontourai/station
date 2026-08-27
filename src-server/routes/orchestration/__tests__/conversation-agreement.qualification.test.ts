import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ExecutionModelRequest,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import type { ProviderAdapterMetadata } from '../../../providers/adapter-shape.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const OWNER = 'daily-driver-owner';
const ENVIRONMENT = 'daily-driver-station';
const CONTEXT_TOKEN = 'CARRY-3912';

type WorkspaceCase = {
  label: string;
  workspace?: ExecutionTarget['workspace'];
  projectDirectory?: string;
  worktree?: boolean;
};

class TerminalAgreementAdapter extends GateTestAdapter {
  override readonly metadata: ProviderAdapterMetadata;
  private turn = 0;

  constructor(modelOverride = true) {
    super();
    this.metadata = {
      displayName: 'Claude Code',
      description: 'Terminal daily-driver qualification adapter',
      capabilities: ['agent-runtime'],
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: modelOverride,
        overrideAtResume: modelOverride,
        overridePerTurn: modelOverride,
      },
    };
  }

  override async startSession(input: ProviderSessionStartInput) {
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

  override async sendTurn(input: ProviderSendTurnInput) {
    this.turn += 1;
    const turnId = `qualification-turn-${this.turn}`;
    const token = /CARRY-[0-9]+/.exec(
      `${input.ambientContext ?? ''}\n${input.input}`,
    )?.[0];
    const outputText = token
      ? `Recalled ${token} on turn ${this.turn}`
      : 'CONTEXT_MISSING';
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
      outputText,
      metadata: {
        effectiveModel: input.modelId ?? 'claude-default',
        reportedModel: input.modelId ?? 'claude-default',
      },
    });
    return { threadId: input.threadId, turnId };
  }
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
    check();
  });
}

function latestBinding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const lineage = store.conversationSessions(conversationId);
  if (lineage.length === 0) return null;
  const root = lineage[0]!;
  const events = store.listEvents(root.sessionId).map((item) => item.payload);
  const configured = [...events]
    .reverse()
    .find((event) => event.method === 'session.configured');
  const metadata = configured?.metadata;
  const boundAgent =
    typeof metadata?.agentId === 'string'
      ? metadata.agentId
      : typeof metadata?.targetId === 'string'
        ? metadata.targetId
        : typeof metadata?.agentSlug === 'string'
          ? metadata.agentSlug
          : undefined;
  if (!metadata || typeof metadata.environmentId !== 'string' || !boundAgent)
    return null;
  const session = store
    .readSessions()
    .find((item) => item.threadId === root.sessionId);
  return {
    environmentId: metadata.environmentId,
    agentId: boundAgent,
    ...(typeof metadata.connectionId === 'string'
      ? { connectionId: metadata.connectionId }
      : {}),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
    ...(typeof metadata.projectSlug === 'string'
      ? { projectSlug: metadata.projectSlug }
      : {}),
    ...(typeof session?.cwd === 'string' ? { cwd: session.cwd } : {}),
    ...(metadata.workspaceIsolation &&
    typeof metadata.workspaceIsolation === 'object'
      ? {
          workspaceIsolation: metadata.workspaceIsolation as {
            mode: 'shared' | 'worktree';
          },
        }
      : {}),
    ...(metadata.worktree && typeof metadata.worktree === 'object'
      ? {
          worktree:
            metadata.worktree as ExecutionSessionBinding['worktree'] & {},
        }
      : {}),
  };
}

describe('daily-driver real conversation agreement qualification (#3912/#3409/#3307)', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  test.each<WorkspaceCase>([
    { label: 'global' },
    { label: 'directory' },
    { label: 'project' },
    { label: 'worktree', worktree: true },
  ])(
    '$label binding reaches three completed turns through root plus two child Sessions and reloads once',
    async (workspaceCase) => {
      const root = mkdtempSync(join(tmpdir(), 'station-dd-real-agreement-'));
      roots.push(root);
      const projectDirectory = workspaceCase.worktree
        ? process.cwd()
        : join(root, 'project');
      const worktreeDirectory = join(root, 'worktree');
      if (!workspaceCase.worktree) mkdirSync(projectDirectory);
      mkdirSync(worktreeDirectory);
      const workspace: ExecutionTarget['workspace'] | undefined =
        workspaceCase.label === 'directory'
          ? { kind: 'directory', cwd: projectDirectory }
          : workspaceCase.label === 'project' || workspaceCase.worktree
            ? {
                kind: 'project',
                projectSlug: 'qualification-project',
                workspaceIsolation: {
                  mode: workspaceCase.worktree ? 'worktree' : 'shared',
                },
              }
            : undefined;
      const databasePath = join(root, 'orchestration.sqlite');
      let store = new EventStore(databasePath);
      const eventBus = new EventBus();
      const adapter = new TerminalAgreementAdapter();
      let service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(adapter),
        eventBus,
        eventStore: store,
        resolveSessionAgent: async (input) => ({
          ...input,
          agent: { slug: 'claude' },
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
        ownerlessSessionAccess: 'single-user-compat',
      });
      const conversationId = `conversation:qualification:${workspaceCase.label}`;
      const starts: ProviderSessionStartInput[] = [];

      const executionDeps: ExecutionTargetExecutionDependencies = {
        resolveEnvironmentAccess: async () => ({
          apiBase: 'http://qualification.station',
          environmentId: ENVIRONMENT,
          environmentName: 'Qualification Station',
          kind: 'current',
        }),
        getAgent: async () => ({
          slug: 'claude',
          available: true,
          execution: { agentConnectionId: engineConnectionId('claude') },
        }),
        getConnection: async () => ({
          id: engineConnectionId('claude'),
          name: 'Claude Code',
          type: 'claude-runtime',
          kind: 'agent',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
          prerequisites: [],
          config: { provider: 'claude' },
        }),
        getProject: async () => ({
          workingDirectory: projectDirectory,
          defaultWorkspaceIsolation: workspaceCase.worktree
            ? 'worktree'
            : 'shared',
        }),
        getProviderAdapter: (provider) => service.getProviderAdapter(provider),
        readSessionBinding: async (_access, id) => latestBinding(store, id),
        resolveConversationSession: async (_access, id, requested) =>
          service.resolveConversationContinuation(
            id,
            INTERNAL_SESSION_READ_SCOPE,
            requested,
          ),
        provisionWorktree: async () => ({
          path: worktreeDirectory,
          repoPath: projectDirectory,
          branch: 'station/session/qualification',
          baseRef: 'HEAD',
          cleanupPolicy: 'cleanup',
          preserveOnFailure: true,
          mode: 'worktree',
          createdAt: '2026-08-24T00:00:00.000Z',
        }),
        startSession: async (_access, input) => {
          starts.push(input);
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
              store
                .listEvents(input.threadId)
                .some(
                  (item) =>
                    (item.payload.method === 'session.started' ||
                      item.payload.method === 'session.configured') &&
                    item.payload.metadata?.userId === OWNER,
                ),
            ).toBe(true);
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

      const execute = (input: {
        message: string;
        conversationId?: string;
        model?: ExecutionModelRequest;
      }) =>
        executeForegroundMessage(
          {
            message: input.message,
            ...(input.conversationId
              ? { conversationId: input.conversationId }
              : {}),
            target: {
              environment: { kind: 'current' },
              agent: agentId('claude'),
              ...(workspace ? { workspace } : {}),
              ...(input.model ? { model: input.model } : {}),
            },
            userId: OWNER,
          },
          executionDeps,
        );
      const routes = createOrchestrationRoutes(service, {
        eventBus,
        logger: { debug: vi.fn() },
        getUserId: () => OWNER,
        executeForegroundMessage: (input) => execute(input),
        continueForegroundMessage: (input) =>
          execute({
            message: input.message,
            conversationId: input.conversationId,
            ...(input.model ? { model: input.model } : {}),
          }),
      });
      const app = new Hono();
      app.route('/api/orchestration', routes);

      const send = async (path: string, body: unknown) => {
        const response = await app.request(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status, await response.text()).toBe(200);
      };

      await send('/api/orchestration/chat', {
        message: `Remember ${CONTEXT_TOKEN}.`,
        target: {
          environment: { kind: 'current' },
          agent: 'claude',
          ...(workspace ? { workspace } : {}),
        },
      });
      await eventually(async () => {
        expect(store.conversationSessions(conversationId)).toHaveLength(1);
        expect(
          (
            await service.readSession(
              conversationId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.session.lifecycleState,
        ).toBe('completed');
        expect(latestBinding(store, conversationId)).not.toBeNull();
      });
      await send(
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        { message: 'Continue without repeating it.' },
      );
      await eventually(async () => {
        const lineage = store.conversationSessions(conversationId);
        expect(lineage).toHaveLength(2);
        expect(
          (
            await service.readSession(
              lineage[1]!.sessionId,
              INTERNAL_SESSION_READ_SCOPE,
            )
          )?.session.lifecycleState,
        ).toBe('completed');
      });
      await send(
        `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
        {
          message: 'Recall the first-turn token.',
          model: { override: 'claude-opus' },
        },
      );
      await eventually(() => {
        const lineage = store.conversationSessions(conversationId);
        expect(lineage).toHaveLength(3);
        expect(new Set(lineage.map((item) => item.sessionId))).toHaveLength(3);
        expect(lineage.map((item) => item.ordinal)).toEqual([0, 1, 2]);
        expect(lineage[1]?.predecessorSessionId).toBe(lineage[0]?.sessionId);
        expect(lineage[2]?.predecessorSessionId).toBe(lineage[1]?.sessionId);
        for (const item of lineage)
          expect(
            store
              .listEvents(item.sessionId)
              .some((event) => event.payload.method === 'turn.completed'),
          ).toBe(true);
      });

      const lineage = store.conversationSessions(conversationId);
      expect(starts.map((input) => input.threadId)).toEqual(
        lineage.map((item) => item.sessionId),
      );
      if (!workspace) {
        expect(starts[0]?.cwd).toBeUndefined();
        expect(new Set(starts.slice(1).map((input) => input.cwd)).size).toBe(1);
      } else {
        expect(new Set(starts.map((input) => input.cwd))).toEqual(
          new Set([
            workspaceCase.worktree ? worktreeDirectory : projectDirectory,
          ]),
        );
      }
      expect(starts[1]?.metadata?.conversationId).toBe(conversationId);
      expect(starts[2]?.metadata?.conversationId).toBe(conversationId);
      expect(starts[2]?.modelId).toBe('claude-opus');
      expect(
        store
          .listEvents(lineage[2]!.sessionId)
          .find((item) => item.payload.method === 'turn.completed')?.payload,
      ).toMatchObject({ outputText: `Recalled ${CONTEXT_TOKEN} on turn 3` });

      await service.shutdown();
      store.close();
      store = new EventStore(databasePath);
      service = new OrchestrationService({
        adapterRegistry: createGateTestRegistry(new TerminalAgreementAdapter()),
        eventBus: new EventBus(),
        eventStore: store,
        resolveSessionAgent: async (input) => ({
          ...input,
          agent: { slug: 'claude' },
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
        ownerlessSessionAccess: 'single-user-compat',
      });
      const restored = await service.readConversationEventWindow(
        conversationId,
        {
          authority: INTERNAL_SESSION_READ_SCOPE,
          turnLimit: 10,
        },
      );
      expect(restored?.currentSessionId).toBe(lineage[2]!.sessionId);
      const restoredEvents = restored?.events.map((item) => item.event) ?? [];
      expect(
        restoredEvents.filter((event) => event.method === 'turn.completed'),
      ).toHaveLength(3);
      expect(
        restoredEvents.filter(
          (event) =>
            event.method === 'turn.completed' &&
            event.outputText === `Recalled ${CONTEXT_TOKEN} on turn 3`,
        ),
      ).toHaveLength(1);

      await service.shutdown();
      store.close();
    },
  );

  test('negative control: reusing a terminal root Session is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-dd-terminal-control-'));
    roots.push(root);
    const store = new EventStore(join(root, 'orchestration.sqlite'));
    const adapter = new TerminalAgreementAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: 'claude' },
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
      ownerlessSessionAccess: 'single-user-compat',
    });
    service.initialize();
    const started = await service.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: 'terminal-root',
          provider: 'claude',
          metadata: {
            conversationId: 'terminal-root',
            environmentId: ENVIRONMENT,
            agentId: 'claude',
            targetKind: 'agent',
            targetId: 'claude',
            userId: OWNER,
          },
        },
      },
      { userId: OWNER },
      {
        conversationIdentity: {
          conversationId: 'terminal-root',
          environmentId: ENVIRONMENT,
        },
      },
    );
    expect(started.status).toBe('accepted');
    await eventually(() => {
      expect(
        store
          .listEvents('terminal-root')
          .some(
            (item) =>
              (item.payload.method === 'session.started' ||
                item.payload.method === 'session.configured') &&
              item.payload.metadata?.userId === OWNER,
          ),
      ).toBe(true);
    });
    await service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId: 'terminal-root',
          input: `Remember ${CONTEXT_TOKEN}`,
        },
      },
      { userId: OWNER },
    );
    await eventually(async () => {
      expect(
        (
          await service.readSession(
            'terminal-root',
            INTERNAL_SESSION_READ_SCOPE,
          )
        )?.session.lifecycleState,
      ).toBe('completed');
    });
    await expect(
      service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId: 'terminal-root', input: 'Illegally reuse it' },
        },
        { userId: OWNER },
      ),
    ).rejects.toThrow(/already ended/i);
    expect(store.conversationSessions('terminal-root')).toHaveLength(1);
    await service.shutdown();
    store.close();
  });

  test('ACP-like capability shape refuses an unsupported model override on the route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-dd-model-control-'));
    roots.push(root);
    const store = new EventStore(join(root, 'orchestration.sqlite'));
    const adapter = new TerminalAgreementAdapter(false);
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: new EventBus(),
      eventStore: store,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const routes = createOrchestrationRoutes(service, {
      eventBus: new EventBus(),
      logger: { debug: vi.fn() },
      getUserId: () => OWNER,
      executeForegroundMessage: (input) =>
        executeForegroundMessage(input, {
          resolveEnvironmentAccess: async () => ({
            apiBase: 'http://qualification.station',
            environmentId: ENVIRONMENT,
            environmentName: 'Qualification Station',
            kind: 'current',
          }),
          getAgent: async () => ({
            slug: 'claude',
            available: true,
            execution: { agentConnectionId: engineConnectionId('claude') },
          }),
          getConnection: async () => ({
            id: engineConnectionId('claude'),
            name: 'Custom engine',
            type: 'claude-runtime',
            kind: 'agent',
            enabled: true,
            status: 'ready',
            capabilities: ['agent-runtime'],
            prerequisites: [],
            config: { provider: 'claude' },
          }),
          getProject: vi.fn(),
          getProviderAdapter: (provider) =>
            service.getProviderAdapter(provider),
          readSessionBinding: async () => null,
          startSession: vi.fn(),
          sendTurn: vi.fn(),
        }),
    });
    const app = new Hono();
    app.route('/api/orchestration', routes);
    const response = await app.request('/api/orchestration/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Use a model this engine cannot override.',
        target: {
          environment: { kind: 'current' },
          agent: 'claude',
          model: { override: 'unsupported-model' },
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringMatching(/cannot use.*override-unsupported/i),
    });
    await service.shutdown();
    store.close();
  });
});
