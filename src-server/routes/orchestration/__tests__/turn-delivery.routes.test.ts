/**
 * The foreground delivery lookup at its real boundary: `POST /chat` through
 * the production `executeForegroundMessage`, a real `OrchestrationService` and
 * the SQLite turn ledger, then `GET /conversations/:id/turn-deliveries/:key`.
 * Only the engine is scripted, so a held session start, a resend and a dead
 * owner are the real ones.
 */
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { TurnDeliveryInspection } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  SendTurnRefusedError,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import {
  type ExecutionSessionBinding,
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createSessionAgentResolver } from '../../../services/orchestration/session-agent-resolution.js';
import { authorizeStationControlRequest } from '../../../tools/station-control-policy.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const OWNER = 'delivery-owner';
const STRANGER = 'delivery-stranger';
const ENVIRONMENT = 'delivery-station';
const AGENT = agentId('claude');

class ScriptedAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Delivery lookup qualification adapter',
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
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly turns: ProviderSendTurnInput[] = [];
  /** Set to hold the next session start open until released. */
  startGate: Promise<void> | undefined;
  readonly startEntered: Array<() => void> = [];
  private readonly sessions = new Set<string>();

  async startSession(input: ProviderSessionStartInput) {
    for (const entered of this.startEntered.splice(0)) entered();
    if (this.startGate) await this.startGate;
    const now = new Date().toISOString();
    for (const method of ['session.started', 'session.configured'] as const)
      this.events.push({
        eventId: `${input.threadId}:${method}`,
        method,
        provider: this.provider,
        threadId: input.threadId,
        sessionId: input.threadId,
        createdAt: now,
        metadata: input.metadata,
      } as CanonicalRuntimeEvent);
    this.sessions.add(input.threadId);
    return {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * `refuse`: the adapter refuses before any provider-visible effect.
   * `fail`: the call fails after the engine may have taken the turn.
   */
  nextTurn: 'refuse' | 'fail' | undefined;
  turnGate: Promise<void> | undefined;

  async sendTurn(input: ProviderSendTurnInput) {
    const next = this.nextTurn;
    this.nextTurn = undefined;
    if (next === 'refuse')
      throw new SendTurnRefusedError('The engine refused this turn.', 'busy');
    if (next === 'fail') throw new Error('The engine connection dropped.');
    this.turns.push(input);
    if (this.turnGate) await this.turnGate;
    const turnId = `delivery-turn-${this.turns.length}`;
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
      outputText: 'ok',
    });
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.sessions.delete(threadId);
  }
  async retireSession(threadId: string) {
    await this.stopSession(threadId);
    return { status: 'retired' as const };
  }
  async listSessions() {
    return [];
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {}
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
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
    void check();
  });
}

function currentBinding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const current = store.conversationSessions(conversationId).at(-1);
  if (!current) return null;
  const metadata = store
    .listEvents(current.sessionId)
    .map((item) => item.payload)
    .reverse()
    .find((event) => event.method === 'session.configured')?.metadata;
  if (!metadata || typeof metadata.environmentId !== 'string') return null;
  return {
    environmentId: metadata.environmentId,
    agentId: String(metadata.agentId ?? metadata.targetId),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
  };
}

describe('foreground delivery lookup (GET /conversations/:id/turn-deliveries/:key)', () => {
  const tempDir = trackTempDirs();
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  function station(
    options: { root?: string; maxEntries?: number; deadOwners?: boolean } = {},
  ) {
    const root = options.root ?? tempDir('station-delivery-');
    const store = new EventStore(
      join(root, 'orchestration.sqlite'),
      options.maxEntries ?? 512,
      ...(options.deadOwners
        ? [
            {
              exact: () => ({ pid: process.pid, start: 'replacement' }),
              probe: () => ({ state: 'dead' as const }),
            },
          ]
        : []),
    );
    stores.push(store);
    const adapter = new ScriptedAdapter();
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
      } satisfies IProviderAdapterRegistry,
      eventBus: new EventBus(),
      eventStore: store,
      loadAgentExecutionConfig: async () => ({}),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) => ({
          name: slug,
          prompt: 'Delivery qualification agent',
          skills: [],
          tools: { mcpServers: [] },
        }),
        resolveToolServer: async () => null,
        resolveSkillDir: async () => null,
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const deps: ExecutionTargetExecutionDependencies = {
      resolveEnvironmentAccess: async () => ({
        apiBase: 'http://delivery.station',
        environmentId: ENVIRONMENT,
        environmentName: 'Delivery Station',
        kind: 'current',
      }),
      getAgent: async (_access, id) => ({
        slug: id,
        available: true,
        executionDefault: true,
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
      getProject: vi.fn(),
      getProviderAdapter: (provider) => service.getProviderAdapter(provider),
      readSessionBinding: async (_access, id) => currentBinding(store, id),
      resolveConversationSession: async (_access, id, requested) =>
        service.resolveConversationContinuation(
          id,
          INTERNAL_SESSION_READ_SCOPE,
          requested,
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
        return undefined;
      },
      sendTurn: async (_access, input, context) => {
        const dispatched = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: OWNER },
          { submissionDigest: context?.submissionDigest },
        );
        if (!dispatched.result || !('turnId' in dispatched.result))
          throw new Error('dispatch returned no turn id');
        return { turnId: dispatched.result.turnId };
      },
    };
    let caller = OWNER;
    const app = new Hono();
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(service, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => caller,
        executeForegroundMessage: (input) =>
          executeForegroundMessage({ ...input, userId: OWNER }, deps),
      }),
    );
    const send = (
      conversationId: string,
      clientTurnId: string,
      message = 'Hello delivery',
    ) =>
      app.request('/api/orchestration/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationId,
          clientTurnId,
          target: { environment: { kind: 'current' }, agent: AGENT },
        }),
      });
    const lookup = async (
      conversationId: string,
      clientTurnId: string,
      as = OWNER,
    ) => {
      const previous = caller;
      caller = as;
      try {
        const response = await app.request(
          `/api/orchestration/conversations/${encodeURIComponent(conversationId)}/turn-deliveries/${encodeURIComponent(clientTurnId)}`,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return ((await response.json()) as { data: TurnDeliveryInspection })
          .data;
      } finally {
        caller = previous;
      }
    };
    return { root, store, adapter, service, send, lookup };
  }

  test('#3567: concurrent changed intent conflicts while identical intent joins the one adapter invocation', async () => {
    const { adapter, send } = station();
    let release!: () => void;
    adapter.turnGate = new Promise((resolve) => {
      release = resolve;
    });
    const first = send('conversation:concurrent-digest', 'K', 'A');
    let identical: Response | Promise<Response> | undefined;
    try {
      await eventually(() => expect(adapter.turns).toHaveLength(1));
      const changed = await send('conversation:concurrent-digest', 'K', 'B');
      expect(changed.status, await changed.clone().text()).toBe(409);
      expect(await changed.json()).toMatchObject({
        success: false,
        code: 'client_turn_input_conflict',
      });
      identical = send('conversation:concurrent-digest', 'K', 'A');
      expect(adapter.turns).toHaveLength(1);
    } finally {
      release();
    }
    const accepted = (await (await first).json()) as {
      data: { providerTurnId: string };
    };
    if (!identical) throw new Error('identical request was not submitted');
    const replay = await identical;
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({
      success: true,
      data: { providerTurnId: accepted.data.providerTurnId },
    });
    expect(adapter.turns).toHaveLength(1);
  });

  test('answers received while the session start is held open, then started once the engine has the turn; a same-key resend sends nothing', async () => {
    const { adapter, send, lookup } = station();
    let release!: () => void;
    adapter.startGate = new Promise((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) =>
      adapter.startEntered.push(resolve),
    );
    expect(await lookup('conversation:a', 'key-a')).toEqual({
      outcome: 'not-received',
      conversationId: 'conversation:a',
      clientTurnId: 'key-a',
    });
    const pending = send('conversation:a', 'key-a');
    await entered;
    expect(await lookup('conversation:a', 'key-a')).toEqual({
      outcome: 'received',
      conversationId: 'conversation:a',
      clientTurnId: 'key-a',
    });
    // Another caller cannot tell this request from one never made.
    expect(await lookup('conversation:a', 'key-a', STRANGER)).toEqual({
      outcome: 'not-received',
      conversationId: 'conversation:a',
      clientTurnId: 'key-a',
    });
    release();
    const sent = await pending;
    expect(sent.status, await sent.clone().text()).toBe(200);
    const receipt = (await sent.json()) as {
      data: { sessionId: string; providerTurnId: string };
    };
    expect(await lookup('conversation:a', 'key-a')).toEqual({
      outcome: 'started',
      conversationId: 'conversation:a',
      clientTurnId: 'key-a',
      sessionId: receipt.data.sessionId,
      turnId: receipt.data.providerTurnId,
    });
    expect(await lookup('conversation:a', 'key-a', STRANGER)).toEqual({
      outcome: 'not-received',
      conversationId: 'conversation:a',
      clientTurnId: 'key-a',
    });
    expect(adapter.turns).toHaveLength(1);

    // The reconciler's rule: a key the lookup calls started is never sent
    // again; a resend with the SAME key is answered with the same turn.
    const resend = await send('conversation:a', 'key-a');
    expect(resend.status).toBe(200);
    expect(
      ((await resend.json()) as { data: { providerTurnId: string } }).data
        .providerTurnId,
    ).toBe(receipt.data.providerTurnId);
    expect(adapter.turns).toHaveLength(1);
  });

  test('a send refused before the engine took it is not-received again, so the same key can be retried', async () => {
    const { adapter, send, lookup } = station();
    adapter.nextTurn = 'refuse';
    const refused = await send('conversation:refused', 'key-refused');
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await refused.json()).toMatchObject({
      kind: 'busy',
      retryable: true,
      failurePhase: 'refused',
    });
    expect(await lookup('conversation:refused', 'key-refused')).toEqual({
      outcome: 'not-received',
      conversationId: 'conversation:refused',
      clientTurnId: 'key-refused',
    });
    const retried = await send('conversation:refused', 'key-refused');
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(adapter.turns).toHaveLength(1);
  });

  test('a send that failed after the engine may have taken it is indeterminate while this Station lives, never received', async () => {
    const { adapter, send, lookup } = station();
    adapter.nextTurn = 'fail';
    const failed = await send('conversation:failed', 'key-failed');
    expect(failed.status).toBe(409);
    expect(await lookup('conversation:failed', 'key-failed')).toEqual({
      outcome: 'indeterminate',
      conversationId: 'conversation:failed',
      clientTurnId: 'key-failed',
    });
    expect(adapter.turns).toHaveLength(0);
  });

  test('stamps the send key on the turn.started that send produced', async () => {
    const { store, send } = station();
    const sent = await send('conversation:stamp', 'key-stamp');
    expect(sent.status, await sent.clone().text()).toBe(200);
    const { sessionId } = (
      (await sent.json()) as { data: { sessionId: string } }
    ).data;
    await eventually(() => {
      const started = store
        .listEvents(sessionId)
        .map((row) => row.payload)
        .find((event) => event.method === 'turn.started');
      expect(started).toMatchObject({ clientTurnId: 'key-stamp' });
    });
  });

  test('a claim whose owner died after it began invoking answers indeterminate, and a resend sends nothing', async () => {
    const first = station();
    const sent = await first.send('conversation:dead', 'key-first');
    expect(sent.status).toBe(200);
    const { sessionId } = (
      (await sent.json()) as { data: { sessionId: string } }
    ).data;
    // This process's ledger owns a claim it began invoking, then "dies".
    const owner = first.store
      .createTurnDeduplicator()
      .claim({ threadId: sessionId, clientTurnId: 'key-dead' });
    if (owner.kind !== 'owner') throw new Error('expected owner');
    owner.claim.beginInvocation();
    // And one that never began (died before invoking).
    const unstarted = first.store
      .createTurnDeduplicator()
      .claim({ threadId: sessionId, clientTurnId: 'key-unstarted' });
    expect(unstarted.kind).toBe('owner');
    expect(await first.lookup('conversation:dead', 'key-dead')).toMatchObject({
      outcome: 'received',
    });
    stores.splice(stores.indexOf(first.store), 1);
    first.store.close();

    const restarted = station({ root: first.root, deadOwners: true });
    expect(await restarted.lookup('conversation:dead', 'key-dead')).toEqual({
      outcome: 'indeterminate',
      conversationId: 'conversation:dead',
      clientTurnId: 'key-dead',
    });
    expect(
      await restarted.lookup('conversation:dead', 'key-unstarted'),
    ).toMatchObject({ outcome: 'not-received' });
    // The lookup is read-only: it neither reclaimed nor settled anything.
    expect(
      await restarted.lookup('conversation:dead', 'key-dead'),
    ).toMatchObject({ outcome: 'indeterminate' });
    const resend = await restarted.send('conversation:dead', 'key-dead');
    expect(resend.status).toBe(409);
    expect(restarted.adapter.turns).toHaveLength(0);
  });

  // Investigation: a first send whose Station died while its session was
  // starting. The lookup says not-received (the request record died with the
  // process and no turn was ever claimed), so the client replays the SAME
  // key. What happens next is pinned as observed: the dead owner's session-
  // start boundary still fences the conversation, so the replay is refused
  // before any provider call — no duplicate, and nothing delivered. Without
  // a startup recovery pass in this harness, whether production's recovery
  // sweep clears that fence (and the replay then delivers) is not shown here.
  test('Station dies mid-session-start: a same-key replay never makes a second turn', async () => {
    const first = station();
    first.adapter.startGate = new Promise(() => {
      // Never released: this Station "dies" holding the start open.
    });
    const entered = new Promise<void>((resolve) =>
      first.adapter.startEntered.push(resolve),
    );
    void first.send('conversation:crash', 'key-crash');
    await entered;
    expect(await first.lookup('conversation:crash', 'key-crash')).toMatchObject(
      {
        outcome: 'received',
      },
    );
    stores.splice(stores.indexOf(first.store), 1);
    first.store.close();

    const restarted = station({ root: first.root, deadOwners: true });
    expect(
      await restarted.lookup('conversation:crash', 'key-crash'),
    ).toMatchObject({ outcome: 'not-received' });
    const replay = await restarted.send('conversation:crash', 'key-crash');
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({
      error:
        'Session start admission is unavailable; no provider call was made.',
    });
    expect(first.adapter.turns).toHaveLength(0);
    expect(restarted.adapter.turns).toHaveLength(0);
    // Still nothing claimed: the client shows not-sent, and a Retry reuses
    // the same key.
    expect(
      await restarted.lookup('conversation:crash', 'key-crash'),
    ).toMatchObject({ outcome: 'not-received' });
  });

  test('an evicted key answers expired', async () => {
    const { send, lookup, adapter } = station({ maxEntries: 1 });
    expect((await send('conversation:evict', 'key-old')).status).toBe(200);
    await eventually(async () => {
      expect((await send('conversation:evict', 'key-new')).status).toBe(200);
    });
    expect(await lookup('conversation:evict', 'key-old')).toEqual({
      outcome: 'expired',
      conversationId: 'conversation:evict',
      clientTurnId: 'key-old',
    });
    expect(await lookup('conversation:evict', 'key-new')).toMatchObject({
      outcome: 'started',
    });
    expect(adapter.turns).toHaveLength(2);
  });

  test('a conversation whose Project runs on another Environment answers unknown, never not-received', async () => {
    const app = new Hono();
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(
        {
          // A conversation with Sessions here, whose ledger holds nothing for
          // the key, as for one with none.
          inspectTurnDelivery: (conversationId: string) =>
            conversationId === 'local-history'
              ? { outcome: 'not-received' }
              : null,
        } as never,
        {
          eventBus: new EventBus(),
          logger: { debug: vi.fn() },
          getUserId: () => OWNER,
          projectDefaultEnvironment: (slug: string) =>
            slug === 'remote-project'
              ? { kind: 'saved' as const, id: 'peer-station' }
              : { kind: 'current' as const },
        } as never,
      ),
    );
    const ask = async (query: string) =>
      (
        (await (
          await app.request(
            `/api/orchestration/conversations/c/turn-deliveries/k${query}`,
          )
        ).json()) as { data: TurnDeliveryInspection }
      ).data.outcome;
    expect(await ask('?projectSlug=remote-project')).toBe('unknown');
    expect(
      (
        (await (
          await app.request(
            '/api/orchestration/conversations/local-history/turn-deliveries/k?projectSlug=remote-project',
          )
        ).json()) as { data: TurnDeliveryInspection }
      ).data.outcome,
    ).toBe('unknown');
    expect(await ask('?projectSlug=local-project')).toBe('not-received');
    expect(await ask('')).toBe('not-received');
  });

  test('refuses an over-long key rather than truncating it', async () => {
    const app = new Hono();
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes({ inspectTurnDelivery: vi.fn() } as never, {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
      }),
    );
    const response = await app.request(
      `/api/orchestration/conversations/c/turn-deliveries/${'k'.repeat(201)}`,
    );
    expect(response.status).toBe(400);
  });

  test('is on no Station Control tool route: an agent cannot probe deliveries', () => {
    expect(
      authorizeStationControlRequest(
        'GET',
        '/api/orchestration/conversations/c/turn-deliveries/k',
        {} as never,
      ),
    ).toMatchObject({ code: 'station_control_route_unmapped' });
  });
});
