/**
 * #3568: a follow-up queued while a turn runs is sent once, by Station, when
 * that turn ends, across a restart.
 *
 * The real pieces: an on-disk EventStore (the inbox's Monument tables and the
 * turn-dedup claims share its connection), a real OrchestrationService whose
 * `sendTurn` claims the follow-up's key before it calls the engine, and a
 * counting engine adapter. A "restart" closes every piece and opens new ones
 * on the same file, as a new process with a new birth: the old owner's
 * claims then read as dead. The start port is the service's own `sendTurn`
 * with the entry's key, which is where the production continuation ends.
 */
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { isForegroundIndeterminateShape } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { TURN_DEDUP_MAX_ENTRIES } from '../sqlite-turn-dedup-persistence.js';
import {
  ThreadInboxDelivery,
  type ThreadInboxDeliveryPorts,
  type ThreadInboxPayload,
} from '../thread-inbox.js';

const OWNER = 'human:local:owner';
const THREAD = 'conversation-1';
const FOLLOW_UP = 'and then summarize it';

const makeTempDir = trackTempDirs();

/** Every engine send across every incarnation, in order. */
let sends: string[] = [];
/** What the next engine send does instead of answering. */
let nextSend: 'answer' | 'hang' = 'answer';
let incarnation = 0;
let sequence = 0;

class CountingAdapter extends GateTestAdapter {
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    sends.push(input.input);
    if (nextSend === 'hang') {
      nextSend = 'answer';
      return new Promise(() => {});
    }
    return { threadId: input.threadId, turnId: `turn-${sends.length}` };
  }
}

interface World {
  adapter: CountingAdapter;
  store: EventStore;
  bus: EventBus;
  service: OrchestrationService;
  inbox: ThreadInboxDelivery;
  /** How the start port behaves after the service answered. */
  afterStart: { hang: boolean };
}

const open: World[] = [];

/** One "process": its own birth, so the previous one's claims read as dead. */
function boot(path: string, ports: Partial<ThreadInboxDeliveryPorts> = {}) {
  incarnation += 1;
  const birth = `boot-${incarnation}`;
  const store = new EventStore(path, TURN_DEDUP_MAX_ENTRIES, {
    exact: () => ({ pid: process.pid, start: birth }),
    probe: () => ({
      state: 'exact',
      identity: { pid: process.pid, start: birth },
    }),
  });
  const bus = new EventBus();
  const adapter = new CountingAdapter();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: (provider) => (provider === adapter.provider ? adapter : undefined),
      list: () => [adapter],
    },
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const afterStart = { hang: false };
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
    coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
    conversationOf: (threadId) => threadId,
    currentSessionId: (conversationId) => conversationId,
    sessionOwnerId: (threadId) => service.sessionRecordedOwnerId(threadId),
    start: async ({ threadId, payload, clientTurnId }) => {
      try {
        const result = (await service.dispatch({
          type: 'sendTurn',
          input: { threadId, input: payload.message, clientTurnId },
        })) as ProviderTurnStartResult;
        if (afterStart.hang) return new Promise(() => {});
        return {
          outcome: 'started',
          conversationId: threadId,
          sessionId: threadId,
          turnId: result.turnId,
        };
      } catch (error) {
        if (isForegroundIndeterminateShape(error))
          return { outcome: 'indeterminate' };
        throw error;
      }
    },
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    logger: { warn: vi.fn() },
    // The production schedule, scaled down: a busy flag that outlives its
    // terminal is looked at again.
    retryDelaysMs: [5, 10, 20, 40],
    ...ports,
  });
  inbox.start();
  const world: World = { adapter, store, bus, service, inbox, afterStart };
  open.push(world);
  return world;
}

/** The process dies: nothing it had in flight settles, nothing more runs. */
async function crash(world: World) {
  world.inbox.stop();
  open.splice(open.indexOf(world), 1);
  world.store.close();
}

/**
 * An engine event, through the engine's own stream: the service projects it,
 * persists it, then publishes it, which is what the inbox listens to.
 */
async function emit(
  world: World,
  method: string,
  fields: Record<string, unknown>,
) {
  sequence += 1;
  world.adapter.events.push({
    eventId: `inbox-event-${sequence}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: new Date().toISOString(),
    method,
    ...fields,
  } as unknown as CanonicalRuntimeEvent);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

async function startSession(world: World) {
  await world.service.dispatch({
    type: 'startSession',
    input: { threadId: THREAD, provider: 'claude' },
  });
  // The owner a real start records, read back as `sessionRecordedOwnerId`.
  await emit(world, 'session.started', {
    sessionId: THREAD,
    metadata: { userId: OWNER },
  });
}

/** The first turn: sent by the user, and running. */
async function runningFirstTurn(world: World) {
  await startSession(world);
  await world.service.dispatch({
    type: 'sendTurn',
    input: { threadId: THREAD, input: 'read the file', clientTurnId: 'first' },
  });
  await emit(world, 'turn.started', {
    turnId: 'turn-1',
    prompt: 'read the file',
  });
}

const payload: ThreadInboxPayload = {
  message: FOLLOW_UP,
  actor: { userId: OWNER },
};

function queueFollowUp(world: World, key = 'follow-up-1') {
  return world.inbox.submit({
    conversationId: THREAD,
    clientTurnId: key,
    payload,
  });
}

/** Let a drive that a submit, an event or a re-check started finish. */
async function settle(world: World) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await world.inbox.idle();
}

const followUpSends = () => sends.filter((input) => input === FOLLOW_UP);

afterEach(async () => {
  for (const world of open.splice(0)) {
    world.inbox.stop();
    await world.inbox.idle();
    await world.service.shutdown();
    world.store.close();
  }
  sends = [];
  nextSend = 'answer';
});

describe('thread inbox (#3568)', () => {
  const path = () => join(makeTempDir('thread-inbox-'), 'orchestration.sqlite');

  test('a follow-up queued during a turn, then a restart before its terminal, is sent exactly once', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    const queued = queueFollowUp(first);
    expect(queued).toMatchObject({
      outcome: 'queued',
      entry: { state: 'queued', position: 1, message: FOLLOW_UP },
    });
    await settle(first);
    // The turn is still running: nothing was sent.
    expect(followUpSends()).toEqual([]);
    await crash(first);

    const second = boot(file);
    // Before the restarted Station reattaches the Session, its log still
    // shows the turn open: recovery leaves the follow-up waiting.
    await second.inbox.reconcile();
    expect(followUpSends()).toEqual([]);
    expect(second.inbox.list(THREAD)).toMatchObject([{ state: 'queued' }]);

    // Reattaching ends the turn the restart interrupted (`turn.aborted`), and
    // that terminal places the follow-up.
    await startSession(second);
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toMatchObject([
      { state: 'sent', turnId: expect.any(String), sessionId: THREAD },
    ]);

    // The interrupted turn's own completion arriving late, the follow-up's
    // turn ending, and another startup send nothing more.
    await emit(second, 'turn.completed', { turnId: 'turn-1' });
    await emit(second, 'turn.started', { turnId: 'turn-follow-up' });
    await emit(second, 'turn.completed', { turnId: 'turn-follow-up' });
    await second.inbox.reconcile();
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    await crash(second);
    const third = boot(file);
    await third.inbox.reconcile();
    await startSession(third);
    await settle(third);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('the same key submitted twice across a restart is one entry, and is sent once', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    expect(queueFollowUp(first).outcome).toBe('queued');
    await crash(first);

    const second = boot(file);
    const again = queueFollowUp(second);
    expect(again).toMatchObject({ outcome: 'queued', entry: { position: 1 } });
    expect(second.inbox.list(THREAD)).toHaveLength(1);
    // The same key with another message is refused, and changes nothing.
    expect(
      second.inbox.submit({
        conversationId: THREAD,
        clientTurnId: 'follow-up-1',
        payload: { ...payload, message: 'something else' },
      }),
    ).toEqual({ outcome: 'conflict' });

    await startSession(second);
    await emit(second, 'turn.completed', { turnId: 'turn-1' });
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toHaveLength(1);
    await crash(second);

    // Once it was sent, the same submission after another restart answers
    // the sent entry: it is never queued, or sent, again.
    const third = boot(file);
    expect(queueFollowUp(third)).toMatchObject({
      outcome: 'queued',
      entry: { state: 'sent' },
    });
    await startSession(third);
    await third.inbox.reconcile();
    await settle(third);
    expect(third.inbox.list(THREAD)).toMatchObject([{ state: 'sent' }]);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a follow-up submitted after its turn already ended is placed at once', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    queueFollowUp(world);
    await settle(world);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('follow-ups go one per turn, in the order they were queued', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    queueFollowUp(world, 'a');
    world.inbox.submit({
      conversationId: THREAD,
      clientTurnId: 'b',
      payload: { ...payload, message: 'second follow-up' },
    });
    expect(world.inbox.list(THREAD).map((entry) => entry.position)).toEqual([
      1, 2,
    ]);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    // The first follow-up started a turn; the second waits for it to end.
    expect(sends.slice(1)).toEqual([FOLLOW_UP]);
    await emit(world, 'turn.started', { turnId: 'turn-2' });
    await emit(world, 'turn.completed', { turnId: 'turn-2' });
    await settle(world);
    expect(sends.slice(1)).toEqual([FOLLOW_UP, 'second follow-up']);
  });

  test('an entry claimed but never handed to the engine before a crash is sent once after recovery', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    await emit(first, 'turn.completed', { turnId: 'turn-1' });
    await settle(first);
    // The crash lands after the placement was recorded, before the start.
    const store = first.store.threadInboxStore();
    store.submit({
      conversationId: THREAD,
      clientTurnId: 'follow-up-1',
      payload,
      now: Date.now(),
    });
    expect(store.claimNext(THREAD, THREAD, Date.now()).kind).toBe('claimed');
    await crash(first);

    const second = boot(file);
    await startSession(second);
    await second.inbox.reconcile();
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toMatchObject([{ state: 'sent' }]);
  });

  test('an entry the engine accepted before the crash settles sent after it, with no second send', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    first.afterStart.hang = true;
    queueFollowUp(first);
    await emit(first, 'turn.completed', { turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The engine has it; the process dies before the inbox heard back.
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(first.inbox.list(THREAD)).toMatchObject([{ state: 'sending' }]);
    await crash(first);

    const second = boot(file);
    await startSession(second);
    await second.inbox.reconcile();
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toMatchObject([{ state: 'sent' }]);
  });

  test('an entry handed to the engine with an unknown outcome is surfaced after a restart, never re-sent', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    nextSend = 'hang';
    queueFollowUp(first, 'a');
    first.inbox.submit({
      conversationId: THREAD,
      clientTurnId: 'b',
      payload: { ...payload, message: 'behind it' },
    });
    await emit(first, 'turn.completed', { turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The engine call began and never answered.
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    await crash(first);

    const second = boot(file);
    await startSession(second);
    await second.inbox.reconcile();
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toMatchObject([
      { clientTurnId: 'a', state: 'unconfirmed', position: 1 },
      { clientTurnId: 'b', state: 'queued', position: 2 },
    ]);
    expect(second.inbox.deliveryOutcome(THREAD, 'a', OWNER)).toBe(
      'indeterminate',
    );
    expect(sends).not.toContain('behind it');

    // Dismissing it lets the one behind it go, and never re-sends it.
    expect(second.inbox.cancel(THREAD, 'a').kind).toBe('cancelled');
    await settle(second);
    expect(sends.filter((input) => input === 'behind it')).toEqual([
      'behind it',
    ]);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a start refused before any effect settles refused, and the next entry still goes', async () => {
    const world = boot(path(), {
      start: async ({ payload: sent }) => {
        if (sent.message === FOLLOW_UP)
          throw Object.assign(new Error('The session has ended.'), {
            code: 'session_ended',
          });
        sends.push(sent.message);
        return {
          outcome: 'started',
          conversationId: THREAD,
          sessionId: THREAD,
          turnId: 'turn-next',
        };
      },
    });
    await runningFirstTurn(world);
    queueFollowUp(world, 'a');
    world.inbox.submit({
      conversationId: THREAD,
      clientTurnId: 'b',
      payload: { ...payload, message: 'second follow-up' },
    });
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(world.inbox.list(THREAD)).toMatchObject([
      { clientTurnId: 'a', state: 'refused', reason: 'The session has ended.' },
      { clientTurnId: 'b', state: 'sent' },
    ]);
    expect(world.inbox.deliveryOutcome(THREAD, 'a', OWNER)).toBeUndefined();
  });

  test('a start refused because the session is busy goes back to the queue, and goes at the next terminal', async () => {
    let refuseOnce = true;
    const world = boot(path(), {
      // No re-checks: only the next terminal can place it.
      retryDelaysMs: [],
      start: async ({ payload: sent }) => {
        if (refuseOnce) {
          refuseOnce = false;
          throw Object.assign(new Error('busy'), {
            code: 'provider_turn_in_progress',
          });
        }
        sends.push(sent.message);
        return {
          outcome: 'started',
          conversationId: THREAD,
          sessionId: THREAD,
          turnId: 'turn-next',
        };
      },
    });
    await runningFirstTurn(world);
    queueFollowUp(world);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(world.inbox.list(THREAD)).toMatchObject([{ state: 'queued' }]);
    expect(followUpSends()).toEqual([]);
    // The engine's own turn ends.
    await emit(world, 'turn.started', { turnId: 'turn-engine' });
    await emit(world, 'turn.completed', { turnId: 'turn-engine' });
    await settle(world);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a busy flag that outlives the terminal is looked at again, and the follow-up goes', async () => {
    let coordinatorHolds = true;
    const world = boot(path(), { coordinatorBusy: () => coordinatorHolds });
    await runningFirstTurn(world);
    queueFollowUp(world);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    expect(followUpSends()).toEqual([]);
    // No further event arrives; only the bounded re-check can see this.
    coordinatorHolds = false;
    await settle(world);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('an entry pinned to a session the conversation has left is surfaced, not sent there or anywhere', async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    const store = first.store.threadInboxStore();
    store.submit({
      conversationId: THREAD,
      clientTurnId: 'follow-up-1',
      payload,
      now: Date.now(),
    });
    store.claimNext(THREAD, 'an-earlier-session', Date.now());
    await crash(first);

    const second = boot(file);
    await startSession(second);
    await second.inbox.reconcile();
    expect(followUpSends()).toEqual([]);
    expect(second.inbox.list(THREAD)).toMatchObject([
      { state: 'unconfirmed', sessionId: 'an-earlier-session' },
    ]);
  });

  test('a conversation now owned by someone else is never sent to', async () => {
    const world = boot(path(), { sessionOwnerId: () => 'human:local:other' });
    await runningFirstTurn(world);
    queueFollowUp(world);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(followUpSends()).toEqual([]);
    expect(world.inbox.list(THREAD)).toMatchObject([{ state: 'refused' }]);
  });

  test('the lookup answers queued only to the sender, and only while it waits', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    queueFollowUp(world);
    expect(world.inbox.deliveryOutcome(THREAD, 'follow-up-1', OWNER)).toBe(
      'queued',
    );
    expect(
      world.inbox.deliveryOutcome(THREAD, 'follow-up-1', 'human:local:other'),
    ).toBeUndefined();
    expect(world.inbox.mustQueue(THREAD)).toBe(true);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    // Sent: the turn ledger answers for it now.
    expect(
      world.inbox.deliveryOutcome(THREAD, 'follow-up-1', OWNER),
    ).toBeUndefined();
  });

  test("a store that never opened its inbox still forgets a deleted conversation's entries", async () => {
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    queueFollowUp(first);
    await crash(first);
    // A new process deletes the conversation before anything opened the inbox.
    const fresh = new EventStore(file, TURN_DEDUP_MAX_ENTRIES);
    try {
      fresh.deleteThread(THREAD);
      expect(fresh.threadInboxStore().list(THREAD)).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  test('a deleted conversation takes its queued follow-ups with it', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    queueFollowUp(world);
    world.store.deleteThread(THREAD);
    expect(world.inbox.list(THREAD)).toEqual([]);
  });
});
