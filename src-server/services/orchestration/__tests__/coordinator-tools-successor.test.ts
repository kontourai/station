import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderAdapterShape,
  ProviderSessionStartInput,
} from '../../../providers/adapter-shape.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { builtinStationControlServerPath } from '../../../runtime/bootstrap/station-control-runtime-env.js';
import {
  coordinatorGeneration,
  revokeCoordinatorConversationCredentials,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import {
  coordinatorDeliveryPorts,
  readCoordinatorDelivery,
} from '../coordinator-session.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';

const makeTempDir = trackTempDirs();
const worlds: Array<{ service: OrchestrationService; store: EventStore }> = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.service.shutdown();
    world.store.close();
  }
});

test.each(['codex', 'acp'] as const)(
  'review: a re-designated %s coordinator needs fresh tools',
  async (engine) => {
    const starts: ProviderSessionStartInput[] = [];
    const sends: string[] = [];
    const events = new AsyncEventQueue<any>();
    const adapter: ProviderAdapterShape = {
      provider: engine,
      metadata: {
        displayName: 'fake Codex',
        description: 'shared host fixture',
        capabilities: ['agent-runtime'],
      },
      async startSession(input) {
        starts.push(input);
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
        sends.push(input.threadId);
        const turnId = `turn-${sends.length}`;
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
    const store = new EventStore(
      join(makeTempDir('coordinator-tools-'), 'events.sqlite'),
    );
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      logger: { debug: vi.fn(), warn: vi.fn() },
      adapterRegistry: {
        register() {},
        get: (provider: string) => (provider === engine ? adapter : undefined),
        list: () => [adapter],
      },
      coordinatorGenerationForSession: (id: string) =>
        coordinatorGeneration(
          store.conversationForSession(id)?.conversationId ?? id,
        ),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async () => ({
          name: 'Writer',
          prompt: 'Help the person.',
          tools: {
            mcpServers: [],
            ...(engine === 'codex'
              ? { available: ['station-control_read_conversation'] }
              : {}),
          },
        }),
        resolveToolServer: async (id) =>
          id === 'station-control'
            ? {
                id,
                kind: 'mcp',
                transport: 'stdio',
                command: 'node',
                args: [builtinStationControlServerPath()],
              }
            : null,
        resolveSkillDir: async () => null,
        coordinatorGenerationForSession: (id) =>
          coordinatorGeneration(
            store.conversationForSession(id)?.conversationId ?? id,
          ),
        isCoordinatorSession: (id) =>
          store.isCoordinatorConversation(
            store.conversationForSession(id)?.conversationId ?? id,
          ),
      }),
    } as never);
    worlds.push({ service, store });
    const start = (
      threadId: string,
      conversationId = threadId,
      extra: Record<string, unknown> = {},
    ) =>
      service.dispatch(
        {
          type: 'startSession',
          input: {
            threadId,
            provider: engine,
            metadata: {
              userId: 'owner',
              agentSlug: 'writer',
              conversationId,
              ...extra,
            },
          },
        },
        { userId: 'owner' },
      );
    await start('houston');
    await start('other');
    for (
      let i = 0;
      i < 100 &&
      !store.listEventsByMethods('houston', ['session.started']).length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts[0]?.agent?.toolServers ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'station-control' }),
      ]),
    );
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: 'houston', input: 'Remember the release plan.' },
      },
      { userId: 'owner' },
    );
    for (
      let i = 0;
      i < 100 &&
      !store.listEventsByMethods('houston', ['turn.completed']).length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      store.listEventsByMethods('houston', ['turn.completed']),
    ).toHaveLength(1);
    store.coordinatorStore().designate({
      conversationId: 'houston',
      actor: { userId: 'owner' },
      replace: false,
      now: Date.now(),
    });
    expect(
      await service.resolveCoordinatorStationControl('houston'),
    ).toMatchObject({
      id: 'station-control',
      ...(engine === 'codex' ? { allowedTools: ['read_conversation'] } : {}),
    });
    const successor = await service.resolveConversationContinuation(
      'houston',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: engine },
    );
    expect(successor.startRequired).toBe(true);
    expect(successor.sessionId).not.toBe('houston');
    expect(successor.contextSeed).toBeDefined();
    expect(successor.transcriptSeed).toContain('Remember the release plan.');
    await start(successor.sessionId, 'houston', {
      conversationStartSeedCarrier: {
        pinDigest: successor.contextSeed!.pinDigest,
        seedDigest: successor.contextSeed!.seedDigest,
        clientTurnId: 'next-turn',
      },
      coordinatorToolsRestart: successor.coordinatorToolsRestart,
    });
    expect(starts.at(-1)?.agent?.toolServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'station-control' }),
      ]),
    );
    for (
      let i = 0;
      i < 100 &&
      !store.listEventsByMethods(successor.sessionId, ['session.started'])
        .length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      readCoordinatorDelivery(
        'houston',
        coordinatorDeliveryPorts({ eventStore: store, service }),
      ).toolsRestarted,
    ).toBe(true);
    await service.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: successor.sessionId,
          input: 'next',
          clientTurnId: 'next-turn',
          ambientContext: successor.transcriptSeed,
        },
      },
      { userId: 'owner' },
    );
    expect(sends).toContain(successor.sessionId);
    for (
      let i = 0;
      i < 100 &&
      !store.listEventsByMethods(successor.sessionId, ['turn.completed'])
        .length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    events.push({
      eventId: 'review-configured',
      provider: engine,
      threadId: successor.sessionId,
      method: 'session.configured',
      createdAt: new Date().toISOString(),
      metadata: {
        capabilityDelivery: {
          toolServers: {
            source: 'agent',
            requested: ['station-control'],
            delivered: ['station-control'],
            undelivered: [],
          },
        },
      },
    });
    for (
      let i = 0;
      i < 100 &&
      !store.listEventsByMethods(successor.sessionId, ['session.configured'])
        .length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      readCoordinatorDelivery(
        'houston',
        coordinatorDeliveryPorts({ eventStore: store, service }),
      ).toolsPending,
    ).toBe(false);
    const originalGeneration = coordinatorGeneration('houston');
    store.coordinatorStore().undesignate('owner');
    revokeCoordinatorConversationCredentials('houston', [successor.sessionId]);
    store.coordinatorStore().designate({
      conversationId: 'other',
      actor: { userId: 'owner' },
      replace: true,
      now: Date.now(),
    });
    store.coordinatorStore().designate({
      conversationId: 'houston',
      actor: { userId: 'owner' },
      replace: true,
      now: Date.now(),
    });
    revokeCoordinatorConversationCredentials('houston', [successor.sessionId]);
    expect(coordinatorGeneration('houston')).toBeGreaterThan(
      originalGeneration,
    );
    const redesignated = await service.resolveConversationContinuation(
      'houston',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: engine },
    );
    expect(redesignated.startRequired).toBe(true);
    expect(redesignated.sessionId).not.toBe(successor.sessionId);
    expect(redesignated.transcriptSeed).toContain('Remember the release plan.');
    await start(redesignated.sessionId, 'houston', {
      conversationStartSeedCarrier: {
        pinDigest: redesignated.contextSeed!.pinDigest,
        seedDigest: redesignated.contextSeed!.seedDigest,
        clientTurnId: 'redesignated-turn',
      },
      coordinatorToolsRestart: redesignated.coordinatorToolsRestart,
    });
    expect(starts.at(-1)?.agent?.toolServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'station-control',
          coordinatorDerived: true,
          coordinatorGeneration: coordinatorGeneration('houston'),
        }),
      ]),
    );
    await service.dispatch(
      {
        type: 'sendTurn',
        input: {
          threadId: redesignated.sessionId,
          input: 'after redesignation',
          clientTurnId: 'redesignated-turn',
          ambientContext: redesignated.transcriptSeed,
        },
      },
      { userId: 'owner' },
    );
    expect(sends).toContain(redesignated.sessionId);
    const other = await service.resolveConversationContinuation(
      'other',
      INTERNAL_SESSION_READ_SCOPE,
      { provider: engine },
    );
    expect(other).toEqual({ sessionId: 'other', startRequired: false });
    expect(starts.filter((input) => input.threadId === 'other')).toHaveLength(
      1,
    );
    await service.dispatch(
      {
        type: 'sendTurn',
        input: { threadId: other.sessionId, input: 'continue other chat' },
      },
      { userId: 'owner' },
    );
    expect(sends).toContain('other');
    for (
      let i = 0;
      i < 100 && !store.listEventsByMethods('other', ['turn.completed']).length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    store.coordinatorStore().designate({
      conversationId: 'other',
      actor: { userId: 'owner' },
      replace: true,
      now: Date.now(),
    });
    let stale = false;
    Object.assign(adapter, {
      coordinatorToolsRefresh: true,
      coordinatorToolsNeedSuccessor: (id: string) => id === 'other' && stale,
    });
    expect(
      await service.resolveConversationContinuation(
        'other',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: engine },
      ),
    ).toEqual({ sessionId: 'other', startRequired: false });
    stale = true;
    expect(
      await service.resolveConversationContinuation(
        'other',
        INTERNAL_SESSION_READ_SCOPE,
        { provider: engine },
      ),
    ).toMatchObject({ startRequired: true, coordinatorToolsRestart: true });
  },
);
