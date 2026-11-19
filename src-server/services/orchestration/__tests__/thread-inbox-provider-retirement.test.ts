import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createConformanceEngine,
  THREAD,
} from '../../../providers/__tests__/adapter-conformance-fixtures.js';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../thread-inbox.js';

const makeTempDir = trackTempDirs();
const OWNER = 'human:local:operator';
const FOLLOW_UP = 'The next review is queued.';
const KEY = 'held-foreground-follow-up';

function runtime(store: EventStore, adapter: ProviderAdapterShape) {
  const bus = new EventBus();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: () => adapter,
      list: () => [adapter],
    } as IProviderAdapterRegistry,
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const start = vi.fn<
    ConstructorParameters<typeof ThreadInboxDelivery>[0]['start']
  >(async ({ conversationId, threadId, payload, clientTurnId }) => {
    const dispatched = await service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: { threadId, input: payload.message, clientTurnId },
      },
      { userId: payload.actor.userId },
    );
    const result = dispatched.result as { turnId?: string } | undefined;
    if (!result?.turnId) return { outcome: 'indeterminate' };
    return {
      outcome: 'started',
      conversationId,
      sessionId: threadId,
      turnId: result.turnId,
    };
  });
  const inbox = new ThreadInboxDelivery({
    store: store.threadInboxStore(),
    foldEvents: (threadId) =>
      store
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map(({ sequence, payload: event }) => ({ sequence, event })),
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
    mayContinue: (_conversationId, userId) => userId === OWNER,
    deviceMaySend: () => true,
    inspectDelivery: (conversationId, key, digest) =>
      service.inspectTurnDelivery(
        conversationId,
        key,
        INTERNAL_SESSION_READ_SCOPE,
        digest,
      ),
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    start,
    retryDelaysMs: [20, 50, 100],
    logger: { warn: vi.fn() },
  });
  inbox.start();
  return { service, inbox, start };
}

const cases = [
  ['acp', 'serve'],
  ['codex', 'serve'],
  ['muse', 'serve'],
  ['muse', 'exec-fallback'],
] as const;

test.each(cases)(
  'the %s / %s terminal retires the foreground invocation and sends one held follow-up',
  async (provider, transport) => {
    const root = makeTempDir('inbox-provider-retirement-');
    const cwd = join(root, 'workspace');
    mkdirSync(cwd);
    const previousHome = process.env.STATION_HOME;
    process.env.STATION_HOME = join(root, 'home');
    mkdirSync(process.env.STATION_HOME);
    const file = join(root, 'orchestration.sqlite');
    let store = new EventStore(file);
    const engine = createConformanceEngine(provider, cwd, transport, (input) =>
      current.service.dispatch(
        {
          type: 'startSession',
          input: { ...input, metadata: { ...input.metadata, userId: OWNER } },
        },
        { userId: OWNER },
      ),
    );
    // The wire fixtures supply an engine and a session. Keep the host CLI
    // and login probes outside this test, as in the Muse approval fixture.
    const prerequisites =
      provider === 'acp'
        ? undefined
        : vi.spyOn(engine.adapter, 'getPrerequisites').mockResolvedValue([]);
    let current = runtime(store, engine.adapter);
    const queued = {
      conversationId: THREAD,
      clientTurnId: KEY,
      payload: { message: FOLLOW_UP, actor: { userId: OWNER } },
    };
    const activity = () =>
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD);
    const turnEvents = () =>
      store.listEvents(THREAD).map(({ payload }) => payload);

    try {
      current.service.initialize();
      await engine.start();
      await expect
        .poll(() => turnEvents().some((e) => e.method === 'session.started'))
        .toBe(true);
      await current.service.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: { threadId: THREAD, input: 'Start a review.' },
        },
        { userId: OWNER },
      );
      if (prerequisites) expect(prerequisites).toHaveBeenCalled();
      await expect.poll(() => engine.inputs().length).toBe(1);
      expect(activity()).toEqual({ kind: 'available', active: true });
      const started = turnEvents().find(
        (event) => event.method === 'turn.started',
      );
      expect(started).toMatchObject({ invocationId: expect.any(String) });
      expect(current.inbox.submit(queued)).toMatchObject({ outcome: 'queued' });
      const reopenedReader = new EventStore(file);
      try {
        const reopenedEntry = reopenedReader
          .threadInboxStore()
          .read(THREAD, KEY);
        expect(reopenedEntry).toMatchObject({ state: 'queued' });
        expect(JSON.parse(String(reopenedEntry?.payload))).toMatchObject({
          message: FOLLOW_UP,
        });
      } finally {
        reopenedReader.close();
      }

      engine.complete();
      await expect.poll(() => engine.inputs().length).toBe(2);
      expect(JSON.stringify(engine.inputs()[1])).toContain(FOLLOW_UP);
      expect(current.start).toHaveBeenCalledTimes(1);
      expect(
        turnEvents().find((event) => event.method === 'turn.completed'),
      ).toMatchObject({
        turnId: started?.turnId,
        invocationId: started?.invocationId,
      });
      await expect
        .poll(() => store.threadInboxStore().read(THREAD, KEY)?.state)
        .toBe('placed');

      engine.complete();
      await expect.poll(activity).toEqual({ kind: 'available', active: false });
      const finished = turnEvents().filter(
        (event) => event.method === 'turn.completed',
      );
      expect(finished).toHaveLength(2);
      expect(finished[1]?.invocationId).toEqual(expect.any(String));
      expect(finished[1]?.invocationId).not.toBe(finished[0]?.invocationId);

      current.inbox.stop();
      await current.inbox.idle();
      await current.service.shutdown();
      store.close();
      store = new EventStore(file);
      current = runtime(store, engine.adapter);
      expect(activity()).toEqual({ kind: 'available', active: false });
      expect(store.threadInboxStore().read(THREAD, KEY)).toMatchObject({
        state: 'placed',
      });
      current.inbox.submit(queued);
      await current.inbox.idle();
      expect(current.start).not.toHaveBeenCalled();
      expect(engine.inputs()).toHaveLength(2);
    } finally {
      prerequisites?.mockRestore();
      current.inbox.stop();
      await current.inbox.idle();
      await current.service.shutdown();
      store.close();
      if (previousHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousHome;
    }
  },
);
