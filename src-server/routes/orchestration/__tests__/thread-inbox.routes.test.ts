/**
 * #3568 at the route: `POST /chat` with `whenBusy: 'queue'` hands a follow-up
 * to a busy conversation's inbox instead of sending it; the inbox sends it
 * when the turn ends. Real pieces: the route, the production
 * `executeForegroundMessage`, a real `OrchestrationService`, the SQLite turn
 * ledger and the inbox on the same EventStore. Only the engine is scripted.
 */
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  ConversationInboxEntry,
  TurnDeliveryInspection,
} from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  INTERNAL_SESSION_READ_SCOPE,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  ProviderTurnInProgressError,
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
import { ACTIVE_TURN_FOLD_METHODS } from '../../../services/orchestration/session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../../../services/orchestration/thread-inbox.js';
import {
  createOrchestrationRoutes,
  isForegroundDispatchHandle,
  isForegroundIndeterminateShape,
} from '../orchestration.js';

const OWNER = 'inbox-owner';
const STRANGER = 'inbox-stranger';
const READER = 'inbox-reader';
const ENVIRONMENT = 'inbox-station';
const AGENT = agentId('claude');
const CONVERSATION = 'conversation:inbox';

class ScriptedAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Code',
    description: 'Inbox qualification adapter',
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
  /** Leave each turn running until `complete` ends it. */
  holdTurns = false;
  /** Refuse the next send as a turn the engine opened itself. */
  refuseNextAsBusy = false;
  /** Take the next send and never answer it (the engine may have it). */
  hangNextSend = false;
  private readonly sessions = new Set<string>();
  private open: { threadId: string; turnId: string } | undefined;

  async startSession(input: ProviderSessionStartInput) {
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

  async sendTurn(input: ProviderSendTurnInput) {
    if (this.refuseNextAsBusy) {
      this.refuseNextAsBusy = false;
      throw new ProviderTurnInProgressError();
    }
    this.turns.push(input);
    if (this.hangNextSend) {
      this.hangNextSend = false;
      return new Promise<never>(() => {});
    }
    const turnId = `inbox-turn-${this.turns.length}`;
    this.events.push({
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.input,
    });
    if (this.holdTurns) this.open = { threadId: input.threadId, turnId };
    else this.end(input.threadId, turnId);
    return { threadId: input.threadId, turnId };
  }

  /** End the turn left running. */
  complete() {
    const open = this.open;
    this.open = undefined;
    if (open) this.end(open.threadId, open.turnId);
  }

  private end(threadId: string, turnId: string) {
    this.events.push({
      provider: this.provider,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: 'ok',
    });
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

describe('POST /chat whenBusy queue (#3568)', () => {
  const tempDir = trackTempDirs();
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  function station(
    options: {
      inbox?: boolean;
      /** Reopen another process's home (a restart). */
      root?: string;
      /** This process's birth: an earlier birth's claims read as dead. */
      birth?: string;
      /** The inbox's start deadline (default: production's). */
      placementDeadlineMs?: number;
    } = {},
  ) {
    const root = options.root ?? tempDir('station-inbox-');
    const birth = options.birth;
    const store = new EventStore(
      join(root, 'orchestration.sqlite'),
      512,
      ...(birth
        ? [
            {
              exact: () => ({ pid: process.pid, start: birth }),
              probe: () => ({
                state: 'exact' as const,
                identity: { pid: process.pid, start: birth },
              }),
            },
          ]
        : []),
    );
    const adapter = new ScriptedAdapter();
    const bus = new EventBus();
    const service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'claude' ? adapter : undefined),
        list: () => [adapter],
      } satisfies IProviderAdapterRegistry,
      eventBus: bus,
      eventStore: store,
      // A personal Station that lets READER read (and so continue) OWNER's
      // conversations, as a paired person's second account would.
      personalConversationAccess: {
        canRead: (requesterId, ownerId) =>
          requesterId === READER && ownerId === OWNER,
        ownerIds: (requesterId) =>
          requesterId === READER ? [READER, OWNER] : undefined,
      },
      loadAgentExecutionConfig: async () => ({}),
      resolveSessionAgent: createSessionAgentResolver({
        loadAgentSpec: async (slug) => ({
          name: slug,
          prompt: 'Inbox qualification agent',
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
        apiBase: 'http://inbox.station',
        environmentId: ENVIRONMENT,
        environmentName: 'Inbox Station',
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
      // The live path's own rule for a reader who is not the owner.
      canContinueConversation: (_access, conversationId, userId) =>
        service.canUserReadSession(conversationId, authority(userId)),
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
      sendTurn: async (_access, input) => {
        const dispatched = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: OWNER },
        );
        if (!dispatched.result || !('turnId' in dispatched.result))
          throw new Error('dispatch returned no turn id');
        return { turnId: dispatched.result.turnId };
      },
    };
    /** Set to lose the inbox's answer after the engine took the turn (a crash). */
    const crashAfterStart: { armed: boolean; release?: () => void } = {
      armed: false,
    };
    const authority = (userId: string) =>
      sessionReadAuthorityFromRequest(userId, undefined, undefined);
    // A new delivery over the same store and service: a restarted process.
    const makeInbox = () =>
      new ThreadInboxDelivery({
        store: store.threadInboxStore(),
        foldEvents: (threadId) =>
          store
            .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
            .map((stored) => ({
              sequence: stored.sequence,
              event: stored.payload,
            })),
        headSequence: (threadId) =>
          store.readSessionInventoryHighWater(threadId),
        coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
        conversationOf: (threadId) =>
          store.conversationForSession(threadId)?.conversationId ?? threadId,
        currentSessionId: (conversationId) =>
          service.currentConversationSessionId(conversationId),
        // The live continuation's own rule, as production composes it.
        mayContinue: (conversationId, userId) =>
          service.sessionRecordedOwnerId(
            service.currentConversationSessionId(conversationId),
          ) === userId ||
          service.canUserReadSession(conversationId, authority(userId)),
        deviceMaySend: () => true,
        inspectDelivery: (conversationId, clientTurnId) =>
          service.inspectTurnDelivery(
            conversationId,
            clientTurnId,
            INTERNAL_SESSION_READ_SCOPE,
          ),
        // The continuation a placement makes, through the same foreground
        // execution the route uses, as the recorded sender.
        start: async ({ conversationId, payload, clientTurnId }) => {
          try {
            const handle = await executeForegroundMessage(
              {
                target: { environment: { kind: 'current' }, agent: AGENT },
                message: payload.message,
                conversationId,
                clientTurnId,
                userId: payload.actor.userId,
                ownerAttribution: undefined,
                fullAccessGrant: null,
              } as never,
              deps,
            );
            if (!isForegroundDispatchHandle(handle))
              return { outcome: 'indeterminate' };
            if (crashAfterStart.armed)
              return new Promise((_resolve, reject) => {
                crashAfterStart.release = () =>
                  reject(new Error('The process is gone.'));
              });
            return {
              outcome: 'started',
              conversationId: handle.conversationId,
              sessionId: (handle as { sessionId: string }).sessionId,
              turnId: handle.providerTurnId,
            };
          } catch (error) {
            if (isForegroundIndeterminateShape(error))
              return { outcome: 'indeterminate' };
            throw error;
          }
        },
        subscribe: (listener) =>
          bus.subscribe((frame) => {
            const event = (frame.data as { event?: CanonicalRuntimeEvent })
              ?.event;
            if (frame.event === 'orchestration:event' && event)
              listener({ threadId: event.threadId, method: event.method });
          }),
        logger: { warn: vi.fn() },
        retryDelaysMs: [20, 50, 100],
        ...(options.placementDeadlineMs
          ? { placementDeadlineMs: options.placementDeadlineMs }
          : {}),
      });
    const inbox = makeInbox();
    inbox.start();
    cleanup.push(() => {
      store.close();
    });
    cleanup.push(() => service.shutdown());
    cleanup.push(async () => {
      inbox.stop();
      await inbox.idle();
    });
    let caller = OWNER;
    const app = new Hono();
    app.route(
      '/api/orchestration',
      createOrchestrationRoutes(service, {
        eventBus: bus,
        logger: { debug: vi.fn() },
        getUserId: () => caller,
        executeForegroundMessage: (input) =>
          executeForegroundMessage(input, deps),
        ...(options.inbox === false ? {} : { threadInbox: inbox }),
      }),
    );
    const as = async <T>(who: string, run: () => T | Promise<T>) => {
      const previous = caller;
      caller = who;
      try {
        return await run();
      } finally {
        caller = previous;
      }
    };
    const send = (
      clientTurnId: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) =>
      app.request('/api/orchestration/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          conversationId: CONVERSATION,
          clientTurnId,
          target: { environment: { kind: 'current' }, agent: AGENT },
          ...extra,
        }),
      });
    const lookup = async (clientTurnId: string, who = OWNER) =>
      as(who, async () => {
        const response = await app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/turn-deliveries/${encodeURIComponent(clientTurnId)}`,
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { data: TurnDeliveryInspection })
          .data.outcome;
      });
    const listInbox = (who = OWNER) =>
      as(who, () =>
        app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/inbox`,
        ),
      );
    const cancel = (clientTurnId: string, who = OWNER) =>
      as(who, () =>
        app.request(
          `/api/orchestration/conversations/${encodeURIComponent(CONVERSATION)}/inbox/${encodeURIComponent(clientTurnId)}`,
          { method: 'DELETE' },
        ),
      );
    /** The first turn, left running. */
    const busy = async () => {
      adapter.holdTurns = true;
      const first = await send('first', 'read the file');
      expect(first.status, await first.clone().text()).toBe(200);
      await eventually(() => expect(inbox.mustQueue(CONVERSATION)).toBe(true));
    };
    const prompts = () => adapter.turns.map((turn) => turn.input);
    return {
      root,
      adapter,
      store,
      service,
      inbox,
      makeInbox,
      crashAfterStart,
      as,
      send,
      lookup,
      listInbox,
      cancel,
      busy,
      prompts,
    };
  }

  test('a follow-up to a busy conversation is held, answered 202, and sent once when the turn ends', async () => {
    const world = station();
    await world.busy();
    const queued = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(queued.status, await queued.clone().text()).toBe(202);
    expect(await queued.json()).toMatchObject({
      success: true,
      data: {
        outcome: 'queued',
        conversationId: CONVERSATION,
        clientTurnId: 'follow',
        entry: { state: 'queued', position: 1, message: 'then summarize' },
      },
    });
    expect(world.prompts()).toEqual(['read the file']);
    expect(await world.lookup('follow')).toBe('queued');
    // Another client of the conversation sees the same queue.
    const listed = await world.listInbox();
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { data: { entries: ConversationInboxEntry[] } })
        .data.entries,
    ).toMatchObject([{ clientTurnId: 'follow', state: 'queued' }]);
    // The same send again is the same entry.
    const again = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(again.status).toBe(202);

    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    await eventually(async () =>
      expect(await world.lookup('follow')).toBe('started'),
    );
    expect(world.adapter.turns.at(-1)?.clientTurnId).toBe('follow');
    // Sent once: a later send of the same key returns the same turn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file', 'then summarize']);
  });

  test('a send without whenBusy is not held, whatever the conversation is doing', async () => {
    const world = station();
    await world.busy();
    const direct = await world.send('direct', 'not queued');
    expect(direct.status, await direct.clone().text()).toBe(200);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('a send the inbox cannot replay is not held, even when asked', async () => {
    const world = station();
    await world.busy();
    const withPick = await world.send('pick', 'with an approval pick', {
      whenBusy: 'queue',
      setApprovalMode: 'default',
      setApprovalModeBasedOn: null,
    });
    expect(withPick.status).not.toBe(202);
    // A valid attachment (the route reaches the inbox check with it); this
    // engine takes no files, so the direct dispatch refuses it.
    const withFile = await world.send('file', 'needs its attachment', {
      whenBusy: 'queue',
      attachments: [
        {
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 2,
          dataUrl: 'data:text/plain;base64,aGk=',
        },
      ],
    });
    expect(withFile.status, await withFile.clone().text()).not.toBe(202);
    expect(await withFile.json()).toMatchObject({ success: false });
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('a Station without the inbox ignores whenBusy', async () => {
    const world = station({ inbox: false });
    await world.busy();
    const sent = await world.send('follow', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(sent.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('a send refused because the engine opened a turn itself is held instead, and goes once', async () => {
    const world = station();
    const first = await world.send('first', 'read the file');
    expect(first.status).toBe(200);
    await eventually(() =>
      expect(world.inbox.mustQueue(CONVERSATION)).toBe(false),
    );
    world.adapter.refuseNextAsBusy = true;
    const raced = await world.send('raced', 'then summarize', {
      whenBusy: 'queue',
    });
    expect(raced.status, await raced.clone().text()).toBe(202);
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file', 'then summarize']);
  });

  test('a reused key with a different message is refused 409, and the held message is kept', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    const conflict = await world.send('follow', 'something else', {
      whenBusy: 'queue',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'inbox_key_conflict' });
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { message: 'then summarize' },
    ]);
  });

  test('only the sender withdraws a held message; a stranger cannot read or remove it', async () => {
    const world = station();
    await world.busy();
    await world.send('follow', 'then summarize', { whenBusy: 'queue' });
    expect((await world.listInbox(STRANGER)).status).toBe(404);
    expect((await world.cancel('follow', STRANGER)).status).toBe(404);
    expect(await world.lookup('follow', STRANGER)).toBe('not-received');
    const withdrawn = await world.cancel('follow');
    expect(withdrawn.status).toBe(200);
    expect(await withdrawn.json()).toMatchObject({
      data: { entry: { clientTurnId: 'follow', state: 'cancelled' } },
    });
    expect((await world.cancel('missing')).status).toBe(404);
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(world.prompts()).toEqual(['read the file']);
    expect(await world.lookup('follow')).toBe('not-received');
  });

  test('D1: an entry the engine took before a crash is not sent again into a successor Session', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    // The engine takes the follow-up, and the process dies before the
    // inbox hears back: the entry stays `sending`, pinned to this Session.
    world.crashAfterStart.armed = true;
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual(['read the file', 'then summarize']),
    );
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { state: 'sending' },
    ]);
    world.inbox.stop();
    world.crashAfterStart.armed = false;
    // That Session ends, so continuing the conversation would reserve a
    // successor with a fresh turn claim.
    const session = world.service.currentConversationSessionId(CONVERSATION);
    world.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const restarted = world.makeInbox();
    restarted.start();
    try {
      await restarted.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 200));
      await restarted.idle();
      expect(world.prompts()).toEqual(['read the file', 'then summarize']);
      expect(restarted.list(CONVERSATION)).toMatchObject([{ state: 'sent' }]);
    } finally {
      restarted.stop();
      await restarted.idle();
      // Let the dead process's abandoned call end, so teardown can finish.
      world.crashAfterStart.release?.();
    }
  });

  test('A1: a reader the Station lets continue the conversation has a held follow-up delivered', async () => {
    const world = station();
    await world.busy();
    const queued = await world.as(READER, () =>
      world.send('reader-follow', 'from the other account', {
        whenBusy: 'queue',
      }),
    );
    expect(queued.status, await queued.clone().text()).toBe(202);
    world.adapter.holdTurns = false;
    world.adapter.complete();
    await eventually(() =>
      expect(world.prompts()).toEqual([
        'read the file',
        'from the other account',
      ]),
    );
    await eventually(() =>
      expect(world.inbox.list(CONVERSATION)).toMatchObject([
        { clientTurnId: 'reader-follow', state: 'sent' },
      ]),
    );
  });

  test('A1: a caller placement would refuse is never answered 202', async () => {
    const world = station();
    await world.busy();
    const refused = await world.as(STRANGER, () =>
      world.send('stranger-follow', 'not mine', { whenBusy: 'queue' }),
    );
    expect(refused.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('A3: another reader cannot withdraw a waiting message that is not theirs', async () => {
    const world = station();
    await world.busy();
    await world.send('follow', 'then summarize', { whenBusy: 'queue' });
    expect((await world.cancel('follow', READER)).status).toBe(404);
    expect((await world.cancel('follow', STRANGER)).status).toBe(404);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([{ state: 'queued' }]);
  });

  test('A4: a body naming another Agent or workspace than the binding takes the live path', async () => {
    const world = station();
    await world.busy();
    const otherAgent = await world.send('other-agent', 'elsewhere', {
      whenBusy: 'queue',
      target: { environment: { kind: 'current' }, agent: agentId('writer') },
    });
    expect(otherAgent.status).not.toBe(202);
    const otherWorkspace = await world.send('other-ws', 'elsewhere', {
      whenBusy: 'queue',
      target: {
        environment: { kind: 'current' },
        agent: AGENT,
        workspace: { kind: 'directory', cwd: '/tmp/somewhere-else' },
      },
    });
    expect(otherWorkspace.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toEqual([]);
  });

  test('R2-1: a send the engine may have taken, then a crash and the Session ending, is unconfirmed, never sent into a successor', async () => {
    // A short deadline only so this dead process's abandoned call can end
    // for teardown; a stopped inbox records nothing at it.
    const first = station({ birth: 'boot-1', placementDeadlineMs: 300 });
    await first.busy();
    expect(
      (await first.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    // The engine is handed the follow-up (its claim records the invocation)
    // and never answers; the process then dies.
    first.adapter.hangNextSend = true;
    first.adapter.holdTurns = false;
    first.adapter.complete();
    await eventually(() =>
      expect(first.prompts()).toEqual(['read the file', 'then summarize']),
    );
    first.inbox.stop();
    // The Session the claim is on ends, so continuing would reserve a
    // successor with a fresh claim of its own.
    const session = first.service.currentConversationSessionId(CONVERSATION);
    first.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = station({ root: first.root, birth: 'boot-2' });
    await second.inbox.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await second.inbox.idle();
    // A start into a successor Session carries the transcript before the
    // message, so a second send ends with it rather than equalling it.
    expect(
      [...first.prompts(), ...second.prompts()].filter((prompt) =>
        prompt.endsWith('then summarize'),
      ),
    ).toHaveLength(1);
    expect(second.inbox.list(CONVERSATION)).toMatchObject([
      { state: 'unconfirmed', reasonCode: 'may_have_been_sent' },
    ]);
  });

  test('R2-2: a live claim on the ended Session holds the entry back from a successor', async () => {
    const world = station();
    await world.busy();
    expect(
      (await world.send('follow', 'then summarize', { whenBusy: 'queue' }))
        .status,
    ).toBe(202);
    const session = world.service.currentConversationSessionId(CONVERSATION);
    // Another attempt of the same key holds a live claim on this Session
    // and has not begun invoking.
    const claim = world.store
      .createTurnDeduplicator()
      .claim({ threadId: session, clientTurnId: 'follow' });
    expect(claim).toMatchObject({ kind: 'owner' });
    world.adapter.events.push({
      eventId: `${session}:exited`,
      provider: 'claude',
      threadId: session,
      sessionId: session,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      exitKind: 'error',
    } as unknown as CanonicalRuntimeEvent);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(world.prompts()).toEqual(['read the file']);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([{ state: 'queued' }]);
  });

  test("R2-8: a reader sees no key for someone else's message that may still be sent", async () => {
    const world = station();
    await world.busy();
    await world.send('owner-key', 'then summarize', { whenBusy: 'queue' });
    await world.as(READER, () =>
      world.send('reader-key', 'from the reader', { whenBusy: 'queue' }),
    );
    const read = async (who: string) =>
      (
        (await (await world.listInbox(who)).json()) as {
          data: { entries: Array<Record<string, unknown>> };
        }
      ).data.entries;
    const asReader = await read(READER);
    expect(asReader[0]).not.toHaveProperty('clientTurnId');
    expect(asReader[1]).toMatchObject({ clientTurnId: 'reader-key' });
    const asOwner = await read(OWNER);
    expect(asOwner[0]).toMatchObject({ clientTurnId: 'owner-key' });
    expect(asOwner[1]).not.toHaveProperty('clientTurnId');
  });

  test('R2-7: a send carrying an Agent-definition precondition takes the live path', async () => {
    const world = station();
    const override = {
      kind: 'agent-execution-override' as const,
      agent: AGENT,
      executionAgent: AGENT,
    };
    // The conversation is bound through an execution override, so a
    // follow-up naming the same override matches its binding.
    world.adapter.holdTurns = true;
    const first = await world.send('first', 'read the file', {
      target: { environment: { kind: 'current' }, agent: override },
    });
    expect(first.status, await first.clone().text()).toBe(200);
    await eventually(() =>
      expect(world.inbox.mustQueue(CONVERSATION)).toBe(true),
    );
    // Control: the same target without a precondition is held.
    const plain = await world.send('plain', 'no precondition', {
      whenBusy: 'queue',
      target: { environment: { kind: 'current' }, agent: override },
    });
    expect(plain.status, await plain.clone().text()).toBe(202);
    const fingerprinted = await world.send('fp', 'with a precondition', {
      whenBusy: 'queue',
      target: {
        environment: { kind: 'current' },
        agent: {
          ...override, // A well-formed fingerprint, so the route reaches the hold check.
          expectedDefinitionFingerprint: `sha256:${'0'.repeat(64)}`,
        },
      },
    });
    expect(fingerprinted.status).not.toBe(202);
    expect(world.inbox.list(CONVERSATION)).toMatchObject([
      { clientTurnId: 'plain' },
    ]);
  });
});
