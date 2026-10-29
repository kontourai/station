/**
 * #3628: a worker's turn ending wakes the person's coordinator, once, through
 * the real path: the worker's terminal -> the real turn-completion notifier
 * (`wireTurnCompletionNotifications`) -> NotificationService ->
 * NOTIFICATION_DELIVERED -> `wireCoordinatorWakes` -> the conversation inbox
 * (`ThreadInboxDelivery`) -> the coordinator's engine.
 *
 * Two engine seams: the real `AcpAdapter` (only its child process is faked,
 * as its own suite does) and a Claude-provider adapter driven through
 * `OrchestrationService` (the native-engine seam the #4003 lead wake uses;
 * not the Claude Agent SDK itself). Both run over a SQLite `EventStore`.
 *
 * The coordinator's own wake turn ending writes a "finished" notification of
 * its own; each test also pins that it does not wake the coordinator again.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FakeAcpProcess } from '../../../providers/__tests__/fake-acp-process.js';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { createCoordinatorRoutes } from '../../../routes/orchestration/coordinator.js';
import type { ACPProcess } from '../../acp/acp-process.js';
import { NotificationService } from '../../notifications/notification-service.js';
import {
  coordinatorDeliveryPorts,
  readCoordinatorDelivery,
  wireCoordinatorWakes,
} from '../coordinator-session.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../thread-inbox.js';
import { wireTurnCompletionNotifications } from '../turn-completion-notifications.js';

const makeTempDir = trackTempDirs();

const CONNECTION_ID = 'fake-acp-connection';
const OWNER = 'human:local:operator';
const COORDINATOR = 'coordinator-chat';
const WORKER = 'worker-chat';
const FRAME = 'This message is from Station, not the person.';

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (matches(value)) return value;
    if (Date.now() - startedAt > timeoutMs)
      throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

interface World {
  store: EventStore;
  bus: EventBus;
  service: OrchestrationService;
  inbox: ThreadInboxDelivery;
  notifications: NotificationService;
  /** The real coordinator routes, as the person (owner) calls them. */
  routes: Hono;
  dispose: () => Promise<void>;
}

const worlds: World[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.dispose();
});

function boot(adapters: ProviderAdapterShape[]): World {
  const tmp = makeTempDir('coordinator-wake-');
  const previousHome = process.env.STATION_HOME;
  process.env.STATION_HOME = join(tmp, 'home');
  mkdirSync(process.env.STATION_HOME, { recursive: true });
  const store = new EventStore(join(tmp, 'orchestration.sqlite'));
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: (provider: string) =>
        adapters.find((adapter) => adapter.provider === provider),
      list: () => adapters,
    } as IProviderAdapterRegistry,
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  // The ports `createThreadInboxDelivery` gives production, minus the HTTP
  // continuation: `start` sends the entry as its recorded actor.
  const inbox = new ThreadInboxDelivery({
    store: store.threadInboxStore(),
    foldEvents: (threadId) =>
      store
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map((stored) => ({
          sequence: stored.sequence,
          event: stored.payload,
        })),
    headSequence: (threadId) => store.readSessionInventoryHighWater(threadId),
    readInputlessTurnDisposition: (threadId) =>
      store.readInputlessTurnDisposition(threadId),
    readInvocationTerminal: (threadId, invocationId, turnId) =>
      store.readInvocationTerminal(threadId, invocationId, turnId),
    coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
    hasPossibleEffect: (threadId) =>
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
    conversationOf: (threadId) =>
      store.conversationForSession(threadId)?.conversationId ?? threadId,
    currentSessionId: (conversationId) =>
      service.currentConversationSessionId(conversationId),
    mayContinue: (conversationId, userId) =>
      service.sessionRecordedOwnerId(
        service.currentConversationSessionId(conversationId),
      ) === userId,
    inspectDelivery: (conversationId, clientTurnId, inputDigest) =>
      service.inspectTurnDelivery(
        conversationId,
        clientTurnId,
        INTERNAL_SESSION_READ_SCOPE,
        inputDigest,
      ),
    start: async ({ conversationId, threadId, payload, clientTurnId }) => {
      const dispatched = await service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId, input: payload.message, clientTurnId },
        },
        {
          userId: payload.actor.userId,
          ...(payload.clientOrigin
            ? { clientOrigin: payload.clientOrigin }
            : {}),
        },
      );
      const result = dispatched.result as { turnId?: string } | undefined;
      if (!result?.turnId) return { outcome: 'indeterminate' };
      return {
        outcome: 'started',
        conversationId,
        sessionId: threadId,
        turnId: result.turnId,
      };
    },
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    logger: { warn: vi.fn() },
    retryDelaysMs: [20, 50, 100],
  });
  inbox.start();
  const notifications = new NotificationService(bus, tmp);
  const unwireCompletions = wireTurnCompletionNotifications(
    bus,
    service,
    notifications,
    { warn: vi.fn() },
  );
  store.coordinatorStore().designate({
    conversationId: COORDINATOR,
    actor: { userId: OWNER },
    replace: false,
    now: Date.now(),
  });
  const wakes = wireCoordinatorWakes({
    eventBus: bus,
    eventStore: store,
    store: store.coordinatorStore(),
    threadInbox: inbox,
    // The person may read a Session they own (the owner branch of the
    // production read rule).
    mayRead: (userId, sessionId) =>
      service.sessionRecordedOwnerId(sessionId) === userId,
    logger: { warn: vi.fn() },
    // Coalescing is the unit suite's; here a burst window of a few ms.
    setTimer: (callback) => {
      const timer = setTimeout(callback, 5);
      return () => clearTimeout(timer);
    },
  });
  const routes = new Hono().route(
    '/api/orchestration',
    createCoordinatorRoutes({
      store: store.coordinatorStore(),
      person: () => ({
        userId: OWNER,
        mayRead: () => true,
        mayMutate: () => true,
      }),
      dispatchActor: () => ({ userId: OWNER }),
      wakes,
    }),
  );
  const world: World = {
    store,
    bus,
    service,
    inbox,
    notifications,
    routes,
    dispose: async () => {
      wakes.unsubscribe();
      unwireCompletions();
      inbox.stop();
      await inbox.idle();
      await notifications.shutdown();
      await service.shutdown();
      store.close();
      if (previousHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousHome;
    },
  };
  worlds.push(world);
  return world;
}

const methods = (world: World, threadId: string) =>
  world.store.listEvents(threadId).map((row) => row.payload.method);

/** Coordinator and worker chats on the real AcpAdapter (child faked). */
async function acpWorld() {
  const processes: FakeAcpProcess[] = [];
  const acp = new AcpAdapter({
    getConnections: async () => [
      {
        id: CONNECTION_ID,
        name: 'Scripted Fake',
        command: process.execPath,
        args: [],
        enabled: true,
      },
    ],
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    processFactory: (opts) => {
      const child = new FakeAcpProcess(opts);
      processes.push(child);
      return child as unknown as ACPProcess;
    },
  });
  const world = boot([acp]);
  const start = async (threadId: string) => {
    await world.service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId,
          provider: 'acp',
          cwd: process.env.STATION_HOME!,
          metadata: { connectionId: CONNECTION_ID, userId: OWNER },
        },
      },
      { userId: OWNER },
    );
    await waitFor(
      () => methods(world, threadId),
      (seen) => seen.includes('session.started'),
      `${threadId} session.started`,
    );
  };
  await start(COORDINATOR);
  await start(WORKER);
  const [coordinatorProcess, workerProcess] = processes;
  const prompts = (child: FakeAcpProcess | undefined) =>
    (child?.promptContents ?? []).map((blocks) =>
      blocks.map((block) => ('text' in block ? block.text : '')).join(''),
    );
  /** One worker turn, ended by its engine. */
  const finishWorkerTurn = async (input: string) => {
    const before = prompts(workerProcess).length;
    await world.service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: WORKER, input } },
      { userId: OWNER },
    );
    await waitFor(
      () => prompts(workerProcess),
      (p) => p.length === before + 1,
      'worker prompt',
    );
    workerProcess!.resolvePrompt('end_turn');
  };
  return {
    world,
    coordinatorProcess,
    workerProcess,
    prompts,
    finishWorkerTurn,
  };
}

describe('a worker finishing wakes the coordinator once', () => {
  test('ACP: the coordinator engine is prompted with one framed Station turn', async () => {
    const { world, coordinatorProcess, workerProcess, prompts } =
      await acpWorld();

    await world.service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: WORKER, input: 'build it' } },
      { userId: OWNER },
    );
    await waitFor(
      () => prompts(workerProcess),
      (p) => p.length === 1,
      'worker prompt',
    );
    workerProcess!.resolvePrompt('end_turn');

    const [wake] = await waitFor(
      () => prompts(coordinatorProcess),
      (p) => p.length === 1,
      'the coordinator wake',
    );
    expect(wake).toContain(FRAME);
    expect(wake).toContain(`Finished: Session ${WORKER}`);
    const started = world.store
      .listEvents(COORDINATOR)
      .map((row) => row.payload)
      .filter((event) => event.method === 'turn.started');
    expect(started[0]).toMatchObject({
      clientOrigin: { actor: { kind: 'internal' } },
    });

    // The wake turn ends: its own "finished" does not wake it again.
    coordinatorProcess!.resolvePrompt('end_turn');
    await waitFor(
      () => methods(world, COORDINATOR),
      (seen) => seen.includes('turn.completed'),
      'the wake turn to end',
    );
    await quiet();
    await world.inbox.idle();
    expect(prompts(coordinatorProcess)).toHaveLength(1);
  });

  test('ACP: undesignating withdraws a wake still queued for the old coordinator', async () => {
    const { world, coordinatorProcess, prompts, finishWorkerTurn } =
      await acpWorld();
    await finishWorkerTurn('build it');
    await waitFor(
      () => prompts(coordinatorProcess),
      (p) => p.length === 1,
      'the first wake',
    );
    // A second worker finishes while the first wake's turn still runs: its
    // wake waits in the coordinator's inbox.
    await finishWorkerTurn('build another');
    await waitFor(
      () => world.inbox.list(COORDINATOR),
      (rows) => rows.some((row) => row.state === 'queued'),
      'the second wake queued',
    );
    const removed = await world.routes.request(
      '/api/orchestration/coordinator',
      {
        method: 'DELETE',
      },
    );
    expect(await removed.json()).toEqual({
      success: true,
      data: { undesignated: true },
    });
    expect(
      world.inbox.list(COORDINATOR).filter((row) => row.state === 'queued'),
    ).toEqual([]);
    // The running turn ends: nothing more reaches the old coordinator.
    coordinatorProcess!.resolvePrompt('end_turn');
    await waitFor(
      () => methods(world, COORDINATOR),
      (seen) => seen.includes('turn.completed'),
      'the first wake turn to end',
    );
    await quiet();
    await world.inbox.idle();
    expect(prompts(coordinatorProcess)).toHaveLength(1);
  });

  test('Claude provider: the coordinator engine receives one framed Station turn', async () => {
    const sends = new Map<string, string[]>();
    const invocations = new Map<string, (string | undefined)[]>();
    class CountingAdapter extends GateTestAdapter {
      override async sendTurn(
        input: ProviderSendTurnInput,
      ): Promise<ProviderTurnStartResult> {
        const list = sends.get(input.threadId) ?? [];
        list.push(input.input);
        sends.set(input.threadId, list);
        invocations.set(input.threadId, [
          ...(invocations.get(input.threadId) ?? []),
          input.invocationId,
        ]);
        return { threadId: input.threadId, turnId: `turn-${list.length}` };
      }
    }
    const adapter = new CountingAdapter();
    const world = boot([adapter]);
    let sequence = 0;
    const emit = async (
      threadId: string,
      method: string,
      fields: Record<string, unknown>,
      invocationId?: string,
    ) => {
      sequence += 1;
      adapter.events.push({
        eventId: `coordinator-wake-${sequence}`,
        provider: 'claude',
        threadId,
        createdAt: new Date().toISOString(),
        method,
        ...fields,
        ...(invocationId === undefined ? {} : { invocationId }),
      } as unknown as CanonicalRuntimeEvent);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    for (const threadId of [COORDINATOR, WORKER]) {
      await world.service.dispatch({
        type: 'startSession',
        input: { threadId, provider: 'claude' },
      });
      await emit(threadId, 'session.started', {
        sessionId: threadId,
        metadata: { userId: OWNER },
      });
    }

    await world.service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: WORKER, input: 'build it' } },
      { userId: OWNER },
    );
    const workerInvocation = invocations.get(WORKER)?.[0];
    await emit(WORKER, 'turn.started', { turnId: 'turn-1' }, workerInvocation);
    await emit(
      WORKER,
      'turn.completed',
      { turnId: 'turn-1' },
      workerInvocation,
    );

    const [wake] = await waitFor(
      () => sends.get(COORDINATOR) ?? [],
      (seen) => seen.length === 1,
      'the coordinator wake',
    );
    expect(wake).toContain(FRAME);
    expect(wake).toContain(`Finished: Session ${WORKER}`);

    const wakeInvocation = invocations.get(COORDINATOR)?.[0];
    await emit(
      COORDINATOR,
      'turn.started',
      { turnId: 'turn-1' },
      wakeInvocation,
    );
    await emit(
      COORDINATOR,
      'turn.completed',
      { turnId: 'turn-1' },
      wakeInvocation,
    );
    await quiet();
    await world.inbox.idle();
    expect(sends.get(COORDINATOR)).toHaveLength(1);
    // The worker's terminal was turned into exactly one waiting-then-sent item.
    expect(world.store.coordinatorStore().waitingItems(OWNER)).toEqual([]);
  });
});

describe('delivery state through the production ports', () => {
  class RecordingAdapter extends GateTestAdapter {
    readonly invocations: (string | undefined)[] = [];
    override async sendTurn(
      input: ProviderSendTurnInput,
    ): Promise<ProviderTurnStartResult> {
      this.invocations.push(input.invocationId);
      return { threadId: input.threadId, turnId: 'turn-1' };
    }
  }

  /**
   * The coordinator chat on a Claude-provider adapter, one turn sent through
   * the real service (which records its durable boundary), and the engine's
   * events as given. `stamp` decides whether they name the send's invocation.
   */
  async function coordinatorAfter(
    methods: readonly (string | Record<string, unknown>)[],
    stamp: boolean,
  ) {
    const adapter = new RecordingAdapter();
    const world = boot([adapter]);
    let sequence = 0;
    const emit = async (method: string, fields: Record<string, unknown>) => {
      sequence += 1;
      adapter.events.push({
        eventId: `delivery-${sequence}`,
        provider: 'claude',
        threadId: COORDINATOR,
        createdAt: new Date().toISOString(),
        method,
        ...fields,
      } as unknown as CanonicalRuntimeEvent);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await world.service.dispatch({
      type: 'startSession',
      input: { threadId: COORDINATOR, provider: 'claude' },
    });
    await emit('session.started', {
      sessionId: COORDINATOR,
      metadata: { userId: OWNER },
    });
    await world.service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: COORDINATOR, input: 'go' } },
      { userId: OWNER },
    );
    const invocationId = adapter.invocations[0];
    if (!invocationId) throw new Error('send invocation prerequisite');
    for (const step of methods) {
      const fields = typeof step === 'string' ? { method: step } : step;
      const { method, ...extra } = fields;
      await emit(String(method), {
        turnId: 'turn-1',
        ...extra,
        ...(stamp ? { invocationId } : {}),
      });
    }
    return {
      world,
      delivery: () =>
        readCoordinatorDelivery(
          COORDINATOR,
          coordinatorDeliveryPorts({
            eventStore: world.store,
            service: world.service,
          }),
        ),
    };
  }

  test('a turn that ended without naming its invocation (#4051) reads blocked', async () => {
    const { world, delivery } = await coordinatorAfter(
      ['turn.started', 'turn.completed'],
      false,
    );
    // Why `hasActiveTurn` could not tell: it reads the held boundary too.
    expect(world.service.hasActiveTurn(COORDINATOR)).toBe(true);
    expect(delivery().wakes).toBe('blocked');
  });

  test('a Codex retry-in-progress error is not a completed turn', async () => {
    const { world, delivery } = await coordinatorAfter(
      [
        'turn.started',
        {
          method: 'runtime.error',
          provider: 'codex',
          retriable: true,
          severity: 'error',
          message: 'Retrying transient error',
        },
      ],
      true,
    );
    expect(
      world.store.sessionTurnBoundaryAuthority().hasPossibleEffect(COORDINATOR),
    ).toEqual({ kind: 'available', active: true });
    const errors = world.store.listEventsByMethods(COORDINATOR, [
      'runtime.error',
    ]);
    expect(errors.at(-1)?.payload).toMatchObject({
      provider: 'codex',
      retriable: true,
    });
    expect(delivery().wakes).toBe('ready');
  });

  test('a turn that ended normally reads ready', async () => {
    const { delivery } = await coordinatorAfter(
      ['turn.started', 'turn.completed'],
      true,
    );
    expect(delivery().wakes).toBe('ready');
  });

  test('a long turn still running reads ready', async () => {
    const { world, delivery } = await coordinatorAfter(['turn.started'], true);
    expect(world.service.hasActiveTurn(COORDINATOR)).toBe(true);
    expect(delivery().wakes).toBe('ready');
  });
});
