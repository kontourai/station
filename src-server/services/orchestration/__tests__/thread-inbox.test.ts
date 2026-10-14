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
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
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
  type ThreadInboxStore,
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
/** Who may send to the conversation now (the live send rule's answer). */
const permitted = new Set<string>([OWNER]);
/** Paired devices still holding the scope to send. */
const devicesAllowed = new Set<string>();
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
function boot(
  path: string,
  ports: Partial<ThreadInboxDeliveryPorts> = {},
  wrapStore?: (store: ThreadInboxStore) => ThreadInboxStore,
) {
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
    store: wrapStore
      ? wrapStore(store.threadInboxStore())
      : store.threadInboxStore(),
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
    mayContinue: (_conversationId, userId) => permitted.has(userId),
    deviceMaySend: (deviceId) => devicesAllowed.has(deviceId),
    inspectDelivery: (conversationId, clientTurnId) =>
      service.inspectTurnDelivery(
        conversationId,
        clientTurnId,
        INTERNAL_SESSION_READ_SCOPE,
      ),
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

/** Wait for `check`; a timeout fails the test rather than passing quietly. */
async function eventuallyTrue(check: () => boolean, timeoutMs: number) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs)
      throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
  permitted.clear();
  permitted.add(OWNER);
  devicesAllowed.clear();
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
    expect(second.inbox.cancel(THREAD, 'a', OWNER).kind).toBe('cancelled');
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
      {
        clientTurnId: 'a',
        state: 'refused',
        reasonCode: 'session_ended',
        reason: 'Station could not send this message. Nothing was sent.',
      },
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

  test('an entry claimed on a session the conversation has left, but never sent, is sent once', async () => {
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

    // No Session of the conversation holds the key: nothing reached an
    // engine, so sending it where the conversation is now is the one send.
    const second = boot(file);
    await startSession(second);
    await second.inbox.reconcile();
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
    expect(second.inbox.list(THREAD)).toMatchObject([{ state: 'sent' }]);
  });

  test('a sender who may no longer send to the conversation is refused at placement, and nothing is sent', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    queueFollowUp(world);
    permitted.delete(OWNER);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(followUpSends()).toEqual([]);
    expect(world.inbox.list(THREAD)).toMatchObject([
      { state: 'refused', reasonCode: 'not_permitted' },
    ]);
  });

  test('a sender placement would refuse is never accepted', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    expect(
      world.inbox.submit({
        conversationId: THREAD,
        clientTurnId: 'stranger',
        payload: { ...payload, actor: { userId: 'human:local:stranger' } },
      }),
    ).toEqual({ outcome: 'not-permitted' });
    expect(world.inbox.list(THREAD)).toEqual([]);
  });

  test('a device revoked or narrowed after it queued is refused at placement', async () => {
    const world = boot(path());
    await runningFirstTurn(world);
    devicesAllowed.add('phone');
    const fromPhone = {
      ...payload,
      clientOrigin: {
        version: 1 as const,
        actor: { kind: 'device' as const, deviceId: 'phone' },
        reported: { version: 1 as const, surface: 'web' as const, build: null },
      },
    };
    expect(
      world.inbox.submit({
        conversationId: THREAD,
        clientTurnId: 'from-phone',
        payload: fromPhone,
      }).outcome,
    ).toBe('queued');
    devicesAllowed.delete('phone');
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(followUpSends()).toEqual([]);
    expect(world.inbox.list(THREAD)).toMatchObject([
      { state: 'refused', reasonCode: 'device_not_permitted' },
    ]);
    // And a device without the scope cannot queue at all.
    expect(
      world.inbox.submit({
        conversationId: THREAD,
        clientTurnId: 'from-phone-again',
        payload: fromPhone,
      }),
    ).toEqual({ outcome: 'not-permitted' });
  });

  test("anyone who may send dismisses another person's unconfirmed entry; only the sender withdraws a waiting one", async () => {
    const READER = 'human:local:reader';
    const file = path();
    const first = boot(file);
    await runningFirstTurn(first);
    permitted.add(READER);
    nextSend = 'hang';
    first.inbox.submit({
      conversationId: THREAD,
      clientTurnId: 'reader-1',
      payload: { message: 'reader note', actor: { userId: READER } },
    });
    queueFollowUp(first, 'owner-1');
    await emit(first, 'turn.completed', { turnId: 'turn-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await crash(first);
    const second = boot(file);
    permitted.add(READER);
    await startSession(second);
    await second.inbox.reconcile();
    await settle(second);
    expect(second.inbox.list(THREAD)).toMatchObject([
      { clientTurnId: 'reader-1', state: 'unconfirmed' },
      { clientTurnId: 'owner-1', state: 'queued' },
    ]);
    // The reader cannot withdraw the owner's waiting message.
    expect(second.inbox.cancel(THREAD, 'owner-1', READER)).toEqual({
      kind: 'forbidden',
    });
    // A stranger cannot dismiss anything.
    expect(
      second.inbox.cancel(THREAD, 'reader-1', 'human:local:stranger'),
    ).toEqual({ kind: 'forbidden' });
    // The owner dismisses the reader's unconfirmed one, and its own goes.
    expect(second.inbox.cancel(THREAD, 'reader-1', OWNER).kind).toBe(
      'cancelled',
    );
    await settle(second);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a start that stays refused while the session starts, with no event, is sent once it is ready', async () => {
    let refusals = 7;
    const world = boot(path(), {
      start: async ({ payload: sent }) => {
        if (refusals > 0) {
          refusals -= 1;
          throw Object.assign(new Error('starting'), {
            code: 'provider_session_starting',
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
    // More refusals than the four-step schedule: the last delay repeats.
    await eventuallyTrue(() => followUpSends().length === 1, 3_000);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a session becoming ready places a waiting entry without any re-check', async () => {
    let refuseOnce = true;
    const world = boot(path(), {
      retryDelaysMs: [],
      start: async ({ payload: sent }) => {
        if (refuseOnce) {
          refuseOnce = false;
          throw Object.assign(new Error('starting'), {
            code: 'provider_session_starting',
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
    expect(followUpSends()).toEqual([]);
    await emit(world, 'session.state-changed', {
      sessionId: THREAD,
      state: 'ready',
    });
    await settle(world);
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a start that never answers is unconfirmed at its deadline, and the inbox is not wedged', async () => {
    const world = boot(path(), {
      placementDeadlineMs: 50,
      start: async () => new Promise(() => {}),
    });
    await runningFirstTurn(world);
    queueFollowUp(world, 'a');
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(world.inbox.list(THREAD)).toMatchObject([
      { clientTurnId: 'a', state: 'unconfirmed', reasonCode: 'start_deadline' },
    ]);
    // Dismissable, so the inbox can move on.
    expect(world.inbox.cancel(THREAD, 'a', OWNER).kind).toBe('cancelled');
  });

  test('a settle that fails after the engine took it is re-driven to sent, with no second send', async () => {
    let failOnce = true;
    const flaky = boot(path(), {}, (inner) => ({
      ...inner,
      settle: (...args: Parameters<typeof inner.settle>) => {
        if (failOnce && args[1] === 'placed') {
          failOnce = false;
          throw new Error('disk full');
        }
        return inner.settle(...args);
      },
    }));
    await runningFirstTurn(flaky);
    queueFollowUp(flaky);
    await emit(flaky, 'turn.completed', { turnId: 'turn-1' });
    await eventuallyTrue(
      () => flaky.inbox.list(THREAD)[0]?.state === 'sent',
      3_000,
    );
    expect(followUpSends()).toEqual([FOLLOW_UP]);
  });

  test('a head met twice in one drive is looked at again later, not left waiting', async () => {
    let sabotage = true;
    // A store whose first settle puts the entry back in the queue, as if it
    // never moved: the drive meets the same head twice, and no event follows.
    const stuck = boot(
      path(),
      {
        start: async () => {
          throw Object.assign(new Error('The session has ended.'), {
            code: 'session_ended',
          });
        },
      },
      (inner) => ({
        ...inner,
        settle: (...args: Parameters<typeof inner.settle>) => {
          if (sabotage) {
            sabotage = false;
            return inner.release(args[0], false, Date.now());
          }
          return inner.settle(...args);
        },
      }),
    );
    await runningFirstTurn(stuck);
    // Queued once the turn has ended, so no busy wait left a re-check
    // pending: only the one the guard schedules can settle it now.
    await emit(stuck, 'turn.completed', { turnId: 'turn-1' });
    await settle(stuck);
    queueFollowUp(stuck);
    await eventuallyTrue(
      () => stuck.inbox.list(THREAD)[0]?.state === 'refused',
      3_000,
    );
  });

  test('a session id of the conversation names the same inbox as the conversation', async () => {
    const world = boot(path(), {
      conversationOf: (threadId) =>
        threadId === 'later-session' ? THREAD : threadId,
    });
    await runningFirstTurn(world);
    world.inbox.submit({
      conversationId: 'later-session',
      clientTurnId: 'via-session',
      payload,
    });
    expect(world.inbox.list(THREAD)).toMatchObject([
      { clientTurnId: 'via-session', conversationId: THREAD },
    ]);
    expect(world.inbox.mustQueue('later-session')).toBe(true);
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
