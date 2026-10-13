/**
 * #3158 fix round 2: the delivery store's retention against a controllable
 * clock, driven through the coordinator's own event subscription, and the
 * bound on the event store's turn-scoped read.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createSqliteDelegationResultStore,
  DELEGATION_RESULT_DELIVERY_SCHEMA,
  DelegationResultDelivery,
} from '../delegation-result-delivery.js';
import { EventStore } from '../event-store.js';

const DAY = 24 * 60 * 60 * 1000;
const makeTempDir = trackTempDirs();

function coordinatorAt(clock: { now: number }) {
  const db = new DatabaseSync(':memory:');
  db.exec(DELEGATION_RESULT_DELIVERY_SCHEMA);
  const store = createSqliteDelegationResultStore(db, () => clock.now);
  let listener:
    | ((event: { threadId: string; method: string }) => void)
    | undefined;
  const delivery = new DelegationResultDelivery({
    store,
    // The child is running a turn that has not ended.
    foldEvents: (threadId) =>
      threadId === 'child'
        ? [
            {
              sequence: 1,
              event: {
                eventId: 'started',
                provider: 'claude',
                threadId,
                createdAt: new Date(0).toISOString(),
                method: 'turn.started',
                turnId: 'long-turn',
              } as never,
            },
          ]
        : [],
    headSequence: () => 1,
    turnEvents: () => [],
    conversationOf: (threadId) => threadId,
    currentSessionId: (conversationId) => conversationId,
    coordinatorBusy: () => false,
    sessionOwnerId: () => 'human:local:owner',
    start: async () => {
      throw new Error('not expected');
    },
    steer: async () => ({ outcome: 'unsupported-engine' }),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    logger: { warn: vi.fn() },
    retryDelaysMs: [],
  });
  delivery.start();
  delivery.arm({
    childConversationId: 'child',
    taskId: 'child',
    parentConversationId: 'parent',
    actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
  });
  return {
    store,
    delivery,
    publish: (method: string) => listener?.({ threadId: 'child', method }),
  };
}

describe('delegation result retention (#3158)', () => {
  test('a child that is still active keeps its owner past the retention window', () => {
    const clock = { now: 0 };
    const { store, publish } = coordinatorAt(clock);
    clock.now = 29 * DAY;
    publish('turn.started'); // child activity, after persistence
    clock.now = 31 * DAY;
    store.prune();
    expect(store.owner('child')).toBeDefined();
  });

  test('an idle owner is pruned after the retention window', () => {
    const clock = { now: 0 };
    const { store } = coordinatorAt(clock);
    clock.now = 31 * DAY;
    store.prune();
    expect(store.owner('child')).toBeUndefined();
  });
});

describe('delegation result cancellation records (#3158)', () => {
  function storeWithPendingRow(clock = { now: 0 }) {
    const db = new DatabaseSync(':memory:');
    db.exec(DELEGATION_RESULT_DELIVERY_SCHEMA);
    const store = createSqliteDelegationResultStore(db, () => clock.now);
    store.arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    store.record({
      childConversationId: 'child',
      transitionKey: 'settled:child:turn-1',
      transition: 'settled',
      parentConversationId: 'parent',
      childSessionId: 'child',
      childTurnId: 'turn-1',
      outcome: 'completed',
      deliveryId: 'dr-1',
      text: 'result',
      cancelledBy: [],
    });
    const state = () => store.listForChild('child')[0]!.state;
    return { store, state, clock };
  }

  test('a refused interrupt leaves a row another interrupt still holds cancelled', () => {
    const { store, state } = storeWithPendingRow();
    store.beginCancel('child', 'token-a', null);
    store.beginCancel('child', 'token-b', null);
    store.refuseCancel('token-a');
    expect(state()).toBe('cancelled');
    store.refuseCancel('token-b');
    expect(state()).toBe('pending');
  });

  test('a refused interrupt never reopens a row a read consumed meanwhile', () => {
    const { store, state } = storeWithPendingRow();
    store.beginCancel('child', 'token-a', null);
    store.consume('child');
    store.refuseCancel('token-a');
    expect(state()).toBe('consumed');
  });

  test('a suppression is spent by the turn it names and never matches a later one', () => {
    const { store } = storeWithPendingRow();
    store.beginCancel('child', 'token-unlogged', undefined);
    store.bindUnloggedSuppressions('child', 'turn-2');
    store.beginCancel('child', 'token-visible', 'turn-2');
    expect(store.spendSuppressions('child', 'turn-2').sort()).toEqual([
      'token-unlogged',
      'token-visible',
    ]);
    expect(store.spendSuppressions('child', 'turn-3')).toEqual([]);
  });

  test('a suppression for an unlogged turn expires if no turn appears in its window', () => {
    const { store, clock } = storeWithPendingRow();
    store.beginCancel('child', 'token-unlogged', undefined);
    clock.now = 121_000;
    store.bindUnloggedSuppressions('child', 'turn-days-later');
    expect(store.spendSuppressions('child', 'turn-days-later')).toEqual([]);
  });

  test('a refused interrupt deletes only its own unspent suppression', () => {
    const { store } = storeWithPendingRow();
    store.beginCancel('child', 'token-a', 'turn-2');
    store.beginCancel('child', 'token-b', 'turn-2');
    store.refuseCancel('token-a');
    expect(store.spendSuppressions('child', 'turn-2')).toEqual(['token-b']);
  });
});

describe('EventStore.listTurnEventsByMethods bound (#3158)', () => {
  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  test.each([0, 5_001, 1.5])('refuses a limit of %s', (limit) => {
    const store = new EventStore(
      join(makeTempDir('turn-events-bound-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    expect(() =>
      store.listTurnEventsByMethods(
        'thread',
        'turn',
        ['turn.completed'],
        limit,
      ),
    ).toThrow('A turn event read limit must be between 1 and 5000');
  });

  test('returns at most the limit, oldest first', () => {
    const store = new EventStore(
      join(makeTempDir('turn-events-bound-'), 'orchestration.sqlite'),
    );
    stores.push(store);
    for (let index = 0; index < 3; index += 1)
      store.appendEvent({
        eventId: `delta-${index}`,
        provider: 'claude',
        threadId: 'thread',
        turnId: 'turn',
        itemId: 'text',
        createdAt: new Date(index).toISOString(),
        method: 'content.text-delta',
        delta: String(index),
      } as never);
    expect(
      store
        .listTurnEventsByMethods('thread', 'turn', ['content.text-delta'], 2)
        .map((event) => (event.payload as { delta?: string }).delta),
    ).toEqual(['0', '1']);
  });
});
