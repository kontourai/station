/**
 * #3158 fix round 2: the delivery store's retention against a controllable
 * clock, driven through the coordinator's own event subscription, and the
 * bound on the event store's turn-scoped read.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PENDING_TURN_INTERRUPT_TTL_MS } from '@kontourai/station-contracts/orchestration';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  createDelegationResultSteerPort,
  createSqliteDelegationResultStore,
  DELEGATION_RESULT_DELIVERY_SCHEMA,
  DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS,
  DelegationResultDelivery,
  type DelegationResultDeliveryPorts,
  migrateDelegationResultSchema,
} from '../delegation-result-delivery.js';

type DelegationResultDeliveryPortsSteer =
  DelegationResultDeliveryPorts['steer'];

import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { captureTurnIntent } from '../prepared-turn-intent.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import {
  evaluateSessionWait,
  SessionTurnWaiter,
  type SessionTurnWaitPorts,
} from '../session-turn-wait.js';
import { turnDedupKey } from '../sqlite-turn-dedup-persistence.js';

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
    readInputlessTurnDisposition: () => ({ kind: 'inputless' }),
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
    expect(
      store.spendSuppressions('child', 'turn-2', 'aborted').sort(),
    ).toEqual(['token-unlogged', 'token-visible']);
    expect(store.spendSuppressions('child', 'turn-3', 'aborted')).toEqual([]);
  });

  test('a suppression for an unlogged turn expires if no turn appears in its window', () => {
    const { store, clock } = storeWithPendingRow();
    store.beginCancel('child', 'token-unlogged', undefined);
    clock.now = DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS + 1;
    store.bindUnloggedSuppressions('child', 'turn-days-later');
    expect(
      store.spendSuppressions('child', 'turn-days-later', 'aborted'),
    ).toEqual([]);
  });

  test('a refused interrupt deletes only its own unspent suppression', () => {
    const { store } = storeWithPendingRow();
    store.beginCancel('child', 'token-a', 'turn-2');
    store.beginCancel('child', 'token-b', 'turn-2');
    store.refuseCancel('token-a');
    expect(store.spendSuppressions('child', 'turn-2', 'aborted')).toEqual([
      'token-b',
    ]);
  });
});

describe('delegation result suppressions, fix round 3 (#3158)', () => {
  function bare(clock = { now: 0 }) {
    const db = new DatabaseSync(':memory:');
    migrateDelegationResultSchema(db);
    const store = createSqliteDelegationResultStore(db, () => clock.now);
    store.arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    const settle = (
      turnId: string,
      outcome: 'completed' | 'aborted' | 'error' = 'aborted',
    ) => {
      store.record({
        childConversationId: 'child',
        transitionKey: `settled:child:${turnId}`,
        transition: 'settled',
        parentConversationId: 'parent',
        childSessionId: 'child',
        childTurnId: turnId,
        outcome,
        deliveryId: `dr-${turnId}`,
        text: 'result',
      });
      return store
        .listForChild('child')
        .find((row) => row.childTurnId === turnId)!.state;
    };
    return { db, store, clock, settle };
  }

  test('the unlogged-turn window is the service pending-interrupt TTL', () => {
    expect(DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS).toBe(60_000);
    expect(DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS).toBe(
      PENDING_TURN_INTERRUPT_TTL_MS,
    );
  });

  test('a turn logged just inside the TTL is suppressed; one logged at the TTL is not', () => {
    const inside = bare();
    inside.store.beginCancel('child', 'token', undefined);
    inside.clock.now = PENDING_TURN_INTERRUPT_TTL_MS - 1;
    inside.store.bindUnloggedSuppressions('child', 'turn-a');
    expect(inside.settle('turn-a')).toBe('cancelled');

    const at = bare();
    at.store.beginCancel('child', 'token', undefined);
    at.clock.now = PENDING_TURN_INTERRUPT_TTL_MS;
    at.store.bindUnloggedSuppressions('child', 'turn-a');
    expect(at.settle('turn-a')).toBe('pending');
  });

  test('an unlogged-turn suppression never cancels a turn that completed normally', () => {
    // The held start failed; the child's next turn runs to completion.
    const { store, settle } = bare();
    store.beginCancel('child', 'token', undefined);
    store.bindUnloggedSuppressions('child', 'turn-next');
    expect(settle('turn-next', 'completed')).toBe('pending');
  });

  test('a suppression is single-use: spending its turn twice cancels once', () => {
    const { store } = bare();
    store.beginCancel('child', 'token', undefined);
    store.bindUnloggedSuppressions('child', 'turn-a');
    expect(store.spendSuppressions('child', 'turn-a', 'aborted')).toEqual([
      'token',
    ]);
    expect(store.spendSuppressions('child', 'turn-a', 'aborted')).toEqual([]);
    store.bindUnloggedSuppressions('child', 'turn-b');
    expect(store.spendSuppressions('child', 'turn-b', 'aborted')).toEqual([]);
  });

  // Fix round 4: the service keeps ONE pending interrupt per thread (a second
  // replaces the first) and applies it to the next `turn.started` only, so
  // however many interrupts precede a turn, none reaches a later one.
  test.each(['completed', 'error'] as const)(
    'two interrupts before one turn starts stop only that turn: a later %s turn is delivered',
    (outcome) => {
      const { store, settle, clock } = bare();
      store.beginCancel('child', 'token-1', undefined);
      clock.now = 1;
      store.beginCancel('child', 'token-2', undefined);
      store.bindUnloggedSuppressions('child', 'turn-a');
      store.bindUnloggedSuppressions('child', 'turn-a'); // re-read of the same turn
      expect(settle('turn-a')).toBe('cancelled');
      // A follow-up turn 30 s later, well inside the pending-interrupt TTL.
      clock.now = 30_000;
      store.bindUnloggedSuppressions('child', 'turn-b');
      expect(settle('turn-b', outcome)).toBe('pending');
    },
  );

  test('a terminal ends an interrupt no turn took: a later failed turn is delivered', () => {
    const { store, settle, clock } = bare();
    store.beginCancel('child', 'token', undefined);
    // The child's Session ends with no turn in the log (no turn id).
    store.record({
      childConversationId: 'child',
      transitionKey: 'settled:child:sequence-7',
      transition: 'settled',
      parentConversationId: 'parent',
      childSessionId: 'child',
      outcome: 'exited',
      deliveryId: 'dr-sequence-7',
      text: 'result',
    });
    clock.now = 30_000;
    store.bindUnloggedSuppressions('child', 'turn-b');
    expect(settle('turn-b', 'error')).toBe('pending');
  });

  test('a refused second interrupt leaves the first one to stop the held turn', () => {
    const { store, settle, clock } = bare();
    store.beginCancel('child', 'token-1', undefined);
    clock.now = 1;
    store.beginCancel('child', 'token-2', undefined);
    store.refuseCancel('token-2');
    store.bindUnloggedSuppressions('child', 'turn-a');
    expect(settle('turn-a')).toBe('cancelled');
  });

  test('a duplicate interrupt of one held turn does not cancel the next normal turn', () => {
    const { store, settle } = bare();
    store.beginCancel('child', 'token-1', undefined);
    store.beginCancel('child', 'token-2', undefined); // the same held turn
    store.bindUnloggedSuppressions('child', 'turn-a');
    expect(settle('turn-a')).toBe('cancelled');
    store.bindUnloggedSuppressions('child', 'turn-b');
    expect(settle('turn-b', 'completed')).toBe('pending');
  });

  test('recording a settlement is atomic: a failure spends no suppression and writes no row', () => {
    const { store } = bare();
    store.beginCancel('child', 'token', 'turn-a');
    const touch = store.touchOwner;
    store.touchOwner = () => {
      throw new Error('disk full');
    };
    expect(() =>
      store.record({
        childConversationId: 'child',
        transitionKey: 'settled:child:turn-a',
        transition: 'settled',
        parentConversationId: 'parent',
        childSessionId: 'child',
        childTurnId: 'turn-a',
        outcome: 'aborted',
        deliveryId: 'dr-turn-a',
        text: 'result',
      }),
    ).toThrow('disk full');
    store.touchOwner = touch;
    expect(store.listForChild('child')).toEqual([]);
    expect(store.spendSuppressions('child', 'turn-a', 'aborted')).toEqual([
      'token',
    ]);
  });

  // Fix round 5, P2-A / P3-A: every waiting suppression binds to the turn
  // that appears, so whichever interrupt is refused afterwards, the other's
  // suppression is still there for the turn the service's pending cancel
  // stops. Binding only the newest loses it when the newer one is refused;
  // binding only the oldest loses it when the older one is.
  test('both waiting interrupts bind to the held turn and are spent by it together', () => {
    const { store, clock } = bare();
    store.beginCancel('child', 'token-1', undefined);
    clock.now = 1;
    store.beginCancel('child', 'token-2', undefined);
    store.bindUnloggedSuppressions('child', 'turn-a');
    expect(
      store.spendSuppressions('child', 'turn-a', 'aborted').sort(),
    ).toEqual(['token-1', 'token-2']);
    store.bindUnloggedSuppressions('child', 'turn-b');
    expect(store.spendSuppressions('child', 'turn-b', 'aborted')).toEqual([]);
  });

  test.each(['token-1', 'token-2'] as const)(
    'refusing %s after both bound to the held turn leaves the other to cancel it',
    (refused) => {
      const { store, settle, clock } = bare();
      store.beginCancel('child', 'token-1', undefined);
      clock.now = 1;
      store.beginCancel('child', 'token-2', undefined);
      store.bindUnloggedSuppressions('child', 'turn-a');
      store.refuseCancel(refused);
      expect(settle('turn-a')).toBe('cancelled');
      // Spent with that turn: neither reaches an aborted turn 30 s later.
      clock.now = 30_000;
      store.bindUnloggedSuppressions('child', 'turn-b');
      expect(settle('turn-b')).toBe('pending');
    },
  );

  // Fix round 5, P3-B: the service drops its pending cancel on
  // `turn.completed`, `turn.aborted` and `session.exited`, not on
  // `runtime.error`, so after an error the waiting suppression still binds
  // to (and cancels) the next turn that cancel stops.
  test.each([
    ['error', 'no turn', 'cancelled'],
    ['error', 'an earlier bound turn', 'cancelled'],
    ['exited', 'no turn', 'pending'],
    ['completed', 'an earlier bound turn', 'pending'],
    ['aborted', 'an earlier bound turn', 'pending'],
  ] as const)(
    'a waiting interrupt survives a %s settlement of %s only when the service keeps its cancel',
    (outcome, shape, expected) => {
      const { store, settle, clock } = bare();
      if (shape === 'an earlier bound turn') {
        store.beginCancel('child', 'token-earlier', undefined);
        store.bindUnloggedSuppressions('child', 'turn-a');
      }
      clock.now = 1;
      store.beginCancel('child', 'token', undefined);
      store.record({
        childConversationId: 'child',
        transitionKey:
          shape === 'no turn'
            ? 'settled:child:sequence-7'
            : 'settled:child:turn-a',
        transition: 'settled',
        parentConversationId: 'parent',
        childSessionId: 'child',
        ...(shape === 'no turn' ? {} : { childTurnId: 'turn-a' }),
        outcome,
        deliveryId: 'dr-first',
        text: 'result',
      });
      clock.now = 30_000;
      store.bindUnloggedSuppressions('child', 'turn-b');
      expect(settle('turn-b')).toBe(expected);
    },
  );
});

describe('delegation result cancellation, fix round 6 (#3158)', () => {
  // The child's turn `long-turn` is open in the log (see `coordinatorAt`), so
  // an interrupt names it: the outcome the service reported decides whether
  // that suppression stands.
  test.each([
    ['no-active-turn', []],
    ['cooperative', ['kept']],
    ['forced', ['kept']],
    ['turn-completed', ['kept']],
    ['pending-turn-start', ['kept']],
    [undefined, ['kept']],
  ] as const)(
    'an interrupt the service answered %s keeps its suppression: %j',
    (outcome, expected) => {
      const { store, delivery } = coordinatorAt({ now: 0 });
      const cancellation = delivery.beginCancel('child', {
        kind: 'conversation',
        conversationId: 'parent',
      })!;
      delivery.settleCancellation(cancellation, outcome);
      expect(
        store
          .spendSuppressions('child', 'long-turn', 'completed')
          .map((token) => (token === cancellation.token ? 'kept' : token)),
      ).toEqual(expected);
    },
  );

  test('a transition found late takes only suppressions older than the store', () => {
    const clock = { now: 0 };
    const db = new DatabaseSync(':memory:');
    migrateDelegationResultSchema(db);
    const before = createSqliteDelegationResultStore(db, () => clock.now);
    before.arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    before.beginCancel('child', 'token-before-restart', undefined);
    clock.now = 10;
    const after = createSqliteDelegationResultStore(db, () => clock.now);
    after.beginCancel('child', 'token-since-restart', undefined);
    after.record(
      {
        childConversationId: 'child',
        transitionKey: 'settled:child:turn-x',
        transition: 'settled',
        parentConversationId: 'parent',
        childSessionId: 'child',
        childTurnId: 'turn-x',
        outcome: 'aborted',
        deliveryId: 'dr-x',
        text: 'x',
      },
      { caughtUp: true },
    );
    expect(after.listForChild('child')[0]!.state).toBe('cancelled');
    // The suppression made since the store opened still waits for its turn.
    after.bindUnloggedSuppressions('child', 'turn-y');
    expect(after.spendSuppressions('child', 'turn-y', 'aborted')).toEqual([
      'token-since-restart',
    ]);
  });

  test('a transition recorded as it lands takes every suppression waiting since the store opened', () => {
    const clock = { now: 0 };
    const db = new DatabaseSync(':memory:');
    migrateDelegationResultSchema(db);
    const store = createSqliteDelegationResultStore(db, () => clock.now);
    store.arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    clock.now = 10;
    store.beginCancel('child', 'token', undefined);
    store.record({
      childConversationId: 'child',
      transitionKey: 'settled:child:turn-x',
      transition: 'settled',
      parentConversationId: 'parent',
      childSessionId: 'child',
      childTurnId: 'turn-x',
      outcome: 'aborted',
      deliveryId: 'dr-x',
      text: 'x',
    });
    expect(store.listForChild('child')[0]!.state).toBe('cancelled');
  });

  // Fix round 7, P3-b: the service's pending interrupts are in memory, so a
  // suppression recorded before a restart can stop no turn that runs after
  // it, whether that turn is bound while open or recorded as it lands.
  test('a turn running since the restart takes no suppression from before it', () => {
    const clock = { now: 0 };
    const db = new DatabaseSync(':memory:');
    migrateDelegationResultSchema(db);
    const before = createSqliteDelegationResultStore(db, () => clock.now);
    before.arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    before.beginCancel('child', 'token-before-restart', undefined);
    clock.now = 10;
    const after = createSqliteDelegationResultStore(db, () => clock.now);
    after.bindUnloggedSuppressions('child', 'turn-open');
    expect(after.spendSuppressions('child', 'turn-open', 'aborted')).toEqual(
      [],
    );
    after.record({
      childConversationId: 'child',
      transitionKey: 'settled:child:turn-live',
      transition: 'settled',
      parentConversationId: 'parent',
      childSessionId: 'child',
      childTurnId: 'turn-live',
      outcome: 'aborted',
      deliveryId: 'dr-live',
      text: 'live',
    });
    expect(after.listForChild('child')[0]!.state).toBe('pending');
  });
});

describe('delegation result schema migration (#3158)', () => {
  /** The tables exactly as f352640350 created them. */
  const F352_SCHEMA = `CREATE TABLE delegation_result_owners (
    child_conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    parent_conversation_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    child_agent TEXT, suppressed_turn_id TEXT, armed_at INTEGER NOT NULL);
  CREATE TABLE delegation_result_deliveries (
    child_conversation_id TEXT NOT NULL, transition_key TEXT NOT NULL,
    transition TEXT NOT NULL, parent_conversation_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL, child_turn_id TEXT, outcome TEXT NOT NULL,
    delivery_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
    fence TEXT, decision TEXT, result_json TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (child_conversation_id, transition_key));`;
  /** The tables exactly as bbd41adcba created them. */
  const BBD41_SCHEMA = `CREATE TABLE delegation_result_owners (
    child_conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    parent_conversation_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    owner_attribution TEXT NOT NULL, owner_principal_json TEXT, child_agent TEXT,
    suppressed_turn_id TEXT, suppress_next INTEGER NOT NULL DEFAULT 0,
    suppress_token TEXT, armed_at INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL);
  CREATE TABLE delegation_result_deliveries (
    child_conversation_id TEXT NOT NULL, transition_key TEXT NOT NULL,
    transition TEXT NOT NULL, parent_conversation_id TEXT NOT NULL,
    child_session_id TEXT NOT NULL, child_turn_id TEXT, outcome TEXT NOT NULL,
    delivery_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
    fence TEXT, cancelled_by TEXT, decision TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, result_json TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (child_conversation_id, transition_key));`;

  const stores: EventStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  test.each(
    [
      [
        'f352640350',
        F352_SCHEMA,
        `INSERT INTO delegation_result_owners
       (child_conversation_id, task_id, parent_conversation_id, owner_user_id, armed_at)
       VALUES ('child', 'child', 'parent', 'human:local:owner', ${Date.now()})`,
      ],
      [
        'bbd41adcba',
        BBD41_SCHEMA,
        `INSERT INTO delegation_result_owners
       (child_conversation_id, task_id, parent_conversation_id, owner_user_id,
        owner_attribution, armed_at, last_activity_at)
       VALUES ('child', 'child', 'parent', 'human:local:owner', 'verified-bound', ${Date.now()}, ${Date.now()})`,
      ],
    ].flatMap((row) =>
      ['turn-1', 'invocation-legacy-native'].map((native) => ({
        name: row[0],
        schema: row[1],
        owner: row[2],
        native,
      })),
    ),
  )(
    'a database with $name schema is migrated and still delivers native $native',
    async ({ name: _name, schema, owner, native }) => {
      const path = join(
        makeTempDir('delegation-migration-'),
        'orchestration.sqlite',
      );
      const old = new DatabaseSync(path);
      old.exec(schema);
      old.exec(owner);
      old.close();

      const eventStore = new EventStore(path);
      stores.push(eventStore);
      const store = eventStore.delegationResultStore();
      expect(store.owner('child')?.actor.attribution).toBe(
        _name === 'f352640350' ? 'unattributed-agent' : 'verified-bound',
      );
      const starts: string[] = [];
      let indeterminate = true;
      let sequence = 0;
      const append = (method: string, fields = {}) => {
        sequence += 1;
        eventStore.appendEvent({
          eventId: `migrated-${_name}-${sequence}`,
          provider: 'claude',
          threadId: 'child',
          createdAt: new Date(sequence).toISOString(),
          method,
          ...fields,
        } as never);
      };
      const delivery = new DelegationResultDelivery({
        store,
        foldEvents: (threadId) =>
          eventStore
            .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
            .map((stored) => ({
              sequence: stored.sequence,
              event: stored.payload,
            })),
        headSequence: (threadId) =>
          eventStore.readSessionInventoryHighWater(threadId),
        turnEvents: (threadId, turnId, methods, limit) =>
          eventStore
            .listTurnEventsByMethods(threadId, turnId, methods, limit)
            .map((stored) => ({
              method: stored.method,
              payload: stored.payload,
            })),
        conversationOf: (threadId) => threadId,
        currentSessionId: (conversationId) => conversationId,
        readInputlessTurnDisposition: (threadId) =>
          eventStore.readInputlessTurnDisposition(threadId),
        coordinatorBusy: () => false,
        sessionOwnerId: () => 'human:local:owner',
        start: async ({ clientTurnId }) => {
          starts.push(clientTurnId);
          if (indeterminate) {
            indeterminate = false;
            return { outcome: 'indeterminate' };
          }
          return {
            outcome: 'started',
            conversationId: 'parent',
            sessionId: 'parent',
            turnId: 'parent-turn',
          };
        },
        steer: async () => ({ outcome: 'unsupported-engine' }),
        subscribe: () => () => {},
        logger: { warn: vi.fn() },
        retryDelaysMs: [],
      });
      append('turn.started', { turnId: native });
      append('turn.completed', { turnId: native, outputText: 'done' });
      // First attempt is unconfirmed (exercises attempts and unconfirmed),
      // the startup re-drive lands under the same id.
      await delivery.reconcile();
      expect(store.listForChild('child')[0]).toMatchObject({
        state: 'claimed',
        attempts: 1,
        unconfirmed: 'start:parent',
      });
      await delivery.reconcile();
      delivery.stop();
      expect(starts).toEqual([starts[0], starts[0]]);
      expect(store.listForChild('child')[0]!.state).toBe('delivered');
      expect(JSON.parse(store.listForChild('child')[0]!.transitionKey)).toEqual(
        ['station.delegation-result/2', 'child', 'native', native],
      );
    },
  );
});

describe('delegation result schema migration, fix round 4 (#3158)', () => {
  /** The tables exactly as f352640350 created them (owners only). */
  const F352_OWNERS = `CREATE TABLE delegation_result_owners (
    child_conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
    parent_conversation_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
    child_agent TEXT, suppressed_turn_id TEXT, armed_at INTEGER NOT NULL)`;
  const ARMED_AT = 100 * DAY;
  const insertF352Owner = (db: DatabaseSync) =>
    db.exec(
      `INSERT INTO delegation_result_owners
       (child_conversation_id, task_id, parent_conversation_id, owner_user_id, armed_at)
       VALUES ('child', 'child', 'parent', 'human:local:owner', ${ARMED_AT})`,
    );
  const lastActivity = (db: DatabaseSync) =>
    (
      db
        .prepare(
          'SELECT last_activity_at FROM delegation_result_owners WHERE child_conversation_id = ?',
        )
        .get('child') as { last_activity_at: number }
    ).last_activity_at;

  test('a half-migrated owner (column added, never backfilled) is repaired and not pruned', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(F352_OWNERS);
    insertF352Owner(db);
    // The state an earlier, non-transactional migration left on a crash.
    db.exec(
      `ALTER TABLE delegation_result_owners
       ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0`,
    );
    expect(lastActivity(db)).toBe(0);
    migrateDelegationResultSchema(db);
    expect(lastActivity(db)).toBe(ARMED_AT);
    const store = createSqliteDelegationResultStore(db, () => ARMED_AT + 1);
    store.prune();
    expect(store.owner('child')).toBeDefined();
  });

  test('a migration that fails part-way changes nothing, and the next run completes it', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(F352_OWNERS);
    insertF352Owner(db);
    // Crash between adding the column and backfilling it.
    const crashing = {
      exec(sql: string) {
        if (sql.includes('SET last_activity_at = armed_at'))
          throw new Error('crash');
        db.exec(sql);
      },
      prepare: (sql: string) => db.prepare(sql),
      get isTransaction() {
        return db.isTransaction;
      },
    };
    expect(() => migrateDelegationResultSchema(crashing)).toThrow('crash');
    const columns = (
      db.prepare('PRAGMA table_info(delegation_result_owners)').all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    expect(columns).not.toContain('last_activity_at');
    expect(columns).not.toContain('owner_attribution');
    migrateDelegationResultSchema(db);
    expect(lastActivity(db)).toBe(ARMED_AT);
  });

  test('the migration nests inside a caller transaction', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(F352_OWNERS);
    insertF352Owner(db);
    db.exec('BEGIN');
    migrateDelegationResultSchema(db);
    db.exec('COMMIT');
    expect(lastActivity(db)).toBe(ARMED_AT);
  });

  /** The tables exactly as 92dba6f9fd created them. */
  const SCHEMA_92DBA = `CREATE TABLE IF NOT EXISTS delegation_result_owners (
  child_conversation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_attribution TEXT NOT NULL,
  owner_principal_json TEXT,
  child_agent TEXT,
  armed_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegation_result_owners_task
  ON delegation_result_owners (task_id);
CREATE TABLE IF NOT EXISTS delegation_result_deliveries (
  child_conversation_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  transition TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  child_turn_id TEXT,
  outcome TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  fence TEXT,
  decision TEXT,
  unconfirmed TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (child_conversation_id, transition_key)
);
CREATE INDEX IF NOT EXISTS delegation_result_deliveries_open
  ON delegation_result_deliveries (state, parent_conversation_id);
CREATE TABLE IF NOT EXISTS delegation_result_suppressions (
  token TEXT PRIMARY KEY,
  child_conversation_id TEXT NOT NULL,
  turn_id TEXT,
  spent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegation_result_suppressions_child
  ON delegation_result_suppressions (child_conversation_id, spent);
CREATE TABLE IF NOT EXISTS delegation_result_cancel_links (
  child_conversation_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (child_conversation_id, transition_key, token)
);
CREATE INDEX IF NOT EXISTS delegation_result_cancel_links_token
  ON delegation_result_cancel_links (token)`;

  test('a 92dba6f9fd suppression still waiting for its turn migrates as unlogged; a named one stays explicit', () => {
    const path = join(makeTempDir('delegation-92dba-'), 'orchestration.sqlite');
    const now = Date.now();
    const old = new DatabaseSync(path);
    old.exec(SCHEMA_92DBA);
    old.exec(
      `INSERT INTO delegation_result_owners
       (child_conversation_id, task_id, parent_conversation_id, owner_user_id,
        owner_attribution, armed_at, last_activity_at)
       VALUES ('child', 'child', 'parent', 'human:local:owner', 'verified-bound', ${now}, ${now})`,
    );
    // Recorded just now, inside the unlogged-turn window.
    old.exec(
      `INSERT INTO delegation_result_suppressions
       (token, child_conversation_id, turn_id, spent, created_at)
       VALUES ('waiting', 'child', NULL, 0, ${now}), ('named', 'child', 'turn-named', 0, ${now})`,
    );
    old.close();

    const eventStore = new EventStore(path);
    try {
      const store = eventStore.delegationResultStore();
      const record = (turnId: string) => {
        store.record({
          childConversationId: 'child',
          transitionKey: `settled:child:${turnId}`,
          transition: 'settled',
          parentConversationId: 'parent',
          childSessionId: 'child',
          childTurnId: turnId,
          outcome: 'completed',
          deliveryId: `dr-${turnId}`,
          text: 'result',
        });
        return store
          .listForChild('child')
          .find((row) => row.childTurnId === turnId)!.state;
      };
      // The waiting one binds to the next turn, which completed normally:
      // an unlogged-turn suppression delivers it. The named one cancels.
      store.bindUnloggedSuppressions('child', 'turn-next');
      expect(record('turn-next')).toBe('pending');
      expect(record('turn-named')).toBe('cancelled');
    } finally {
      eventStore.close();
    }
  });
});

describe('upgrading a home created at f352640350 (#3158)', () => {
  test('reconcile delivers its pending row as unattributed, and a new arm succeeds', async () => {
    const path = join(
      makeTempDir('delegation-upgrade-'),
      'orchestration.sqlite',
    );
    const old = new DatabaseSync(path);
    // f352640350's tables, its armed owner and its pending row, verbatim.
    old.exec(`CREATE TABLE delegation_result_owners (
      child_conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      parent_conversation_id TEXT NOT NULL, owner_user_id TEXT NOT NULL,
      child_agent TEXT, suppressed_turn_id TEXT, armed_at INTEGER NOT NULL);
    CREATE INDEX delegation_result_owners_task ON delegation_result_owners (task_id);
    CREATE TABLE delegation_result_deliveries (
      child_conversation_id TEXT NOT NULL, transition_key TEXT NOT NULL,
      transition TEXT NOT NULL, parent_conversation_id TEXT NOT NULL,
      child_session_id TEXT NOT NULL, child_turn_id TEXT, outcome TEXT NOT NULL,
      delivery_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
      fence TEXT, decision TEXT, result_json TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (child_conversation_id, transition_key));
    CREATE INDEX delegation_result_deliveries_open
      ON delegation_result_deliveries (state, parent_conversation_id);`);
    const armedAt = Date.now() - 1_000;
    old
      .prepare(
        `INSERT INTO delegation_result_owners
           (child_conversation_id, task_id, parent_conversation_id, owner_user_id,
            child_agent, armed_at)
         VALUES ('task:old-child', 'task:old-child', 'parent', 'human:local:owner', 'writer', ?)`,
      )
      .run(armedAt);
    old
      .prepare(
        `INSERT INTO delegation_result_deliveries
           (child_conversation_id, transition_key, transition, parent_conversation_id,
            child_session_id, child_turn_id, outcome, delivery_id, text, state,
            created_at, updated_at)
         VALUES ('task:old-child', 'settled:task:old-child:turn-1', 'settled', 'parent',
                 'task:old-child', 'turn-1', 'completed', 'dr-old', 'old result',
                 'pending', ?, ?)`,
      )
      .run(armedAt, armedAt);
    old.close();

    const eventStore = new EventStore(path);
    try {
      const store = eventStore.delegationResultStore();
      const owner = store.owner('task:old-child');
      // Never upgraded: an owner recorded before attribution was stored.
      expect(owner?.actor.attribution).toBe('unattributed-agent');
      const starts: Array<{ attribution: string; text: string }> = [];
      const delivery = new DelegationResultDelivery({
        store,
        foldEvents: () => [],
        headSequence: () => 0,
        turnEvents: () => [],
        conversationOf: (threadId) => threadId,
        currentSessionId: (conversationId) => conversationId,
        readInputlessTurnDisposition: (threadId) =>
          eventStore.readInputlessTurnDisposition(threadId),
        coordinatorBusy: () => false,
        sessionOwnerId: () => 'human:local:owner',
        start: async ({ actor, text, parentConversationId }) => {
          starts.push({ attribution: actor.attribution, text });
          return {
            outcome: 'started',
            conversationId: parentConversationId,
            sessionId: parentConversationId,
            turnId: 'parent-turn',
          };
        },
        steer: async () => ({ outcome: 'unsupported-engine' }),
        subscribe: () => () => {},
        logger: { warn: vi.fn() },
        retryDelaysMs: [],
      });
      await delivery.reconcile();
      expect(starts).toEqual([
        { attribution: 'unattributed-agent', text: 'old result' },
      ]);
      expect(store.listForChild('task:old-child')[0]).toMatchObject({
        state: 'delivered',
        attempts: 0,
      });
      // A new delegation arms on the upgraded tables.
      delivery.arm({
        childConversationId: 'task:new-child',
        taskId: 'task:new-child',
        parentConversationId: 'parent',
        actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
      });
      expect(store.owner('task:new-child')?.actor.attribution).toBe(
        'verified-bound',
      );
      delivery.stop();
    } finally {
      eventStore.close();
    }
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

/**
 * Fix round 3, item 1: an unconfirmed steer re-driven after a restart goes
 * through the REAL `steerTurn` path (`OrchestrationService.dispatchWithReceipt`
 * over a real EventStore). Its receipt read runs before every refusal branch,
 * so a steer whose claim was recorded is answered from that receipt and is
 * never re-sent, and never followed by a start. The steer port is the
 * production one `runtime-routes.ts` wires.
 */
describe('unconfirmed steer re-drive over the real steer receipt (#3158)', () => {
  const PARENT_THREAD = 'parent-thread';
  let sequence = 0;

  function open(path: string) {
    const eventStore = new EventStore(path);
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(new GateTestAdapter()),
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const append = (threadId: string, method: string, fields = {}) => {
      sequence += 1;
      eventStore.appendEvent({
        eventId: `steer-redrive-${sequence}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(
          Date.UTC(2026, 9, 13, 0, 0, sequence),
        ).toISOString(),
        method,
        ...fields,
      } as never);
    };
    return { eventStore, service, append };
  }

  function coordinator(
    world: ReturnType<typeof open>,
    steer: DelegationResultDeliveryPortsSteer,
    starts: string[],
  ) {
    return new DelegationResultDelivery({
      store: world.eventStore.delegationResultStore(),
      foldEvents: (threadId) =>
        world.eventStore
          .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
          .map((stored) => ({
            sequence: stored.sequence,
            event: stored.payload,
          })),
      headSequence: (threadId) =>
        world.eventStore.readSessionInventoryHighWater(threadId),
      turnEvents: (threadId, turnId, methods, limit) =>
        world.eventStore
          .listTurnEventsByMethods(threadId, turnId, methods, limit)
          .map((stored) => ({
            ...(stored.turnId ? { turnId: stored.turnId } : {}),
            method: stored.method,
            payload: stored.payload,
          })),
      conversationOf: (threadId) =>
        threadId === PARENT_THREAD ? 'parent' : threadId,
      currentSessionId: (conversationId) =>
        conversationId === 'parent' ? PARENT_THREAD : conversationId,
      readInputlessTurnDisposition: (threadId) =>
        world.eventStore.readInputlessTurnDisposition(threadId),
      readInvocationTerminal: (threadId, invocationId, turnId) =>
        world.eventStore.readInvocationTerminal(threadId, invocationId, turnId),
      coordinatorBusy: () => false,
      sessionOwnerId: (threadId) =>
        world.service.sessionRecordedOwnerId(threadId),
      start: async ({ clientTurnId }) => {
        starts.push(clientTurnId);
        return {
          outcome: 'started',
          conversationId: 'parent',
          sessionId: PARENT_THREAD,
          turnId: 'parent-turn-new',
        };
      },
      steer,
      subscribe: () => () => {},
      logger: { warn: vi.fn() },
      retryDelaysMs: [],
    });
  }

  /**
   * The production steer port (`createDelegationResultSteerPort`, the one
   * `runtime-routes.ts` wires) over the real service, with the dispatch
   * context it passes there.
   */
  const realSteer = (
    world: ReturnType<typeof open>,
  ): DelegationResultDeliveryPortsSteer =>
    createDelegationResultSteerPort((command, context) =>
      world.service.dispatchWithReceipt(command, context),
    );

  async function steerLostThenRestart(options: {
    /** The engine took the steer before its answer was lost. */
    claimed: boolean;
    /** The engine confirmed it on a turn (`confirmSteerInput`). */
    confirmedTurn?: string;
  }) {
    const path = join(makeTempDir('steer-redrive-'), 'orchestration.sqlite');
    const first = open(path);
    first.eventStore.delegationResultStore().arm({
      childConversationId: 'child',
      taskId: 'child',
      parentConversationId: 'parent',
      actor: { userId: 'human:local:owner', attribution: 'verified-bound' },
    });
    // The parent's start record names its owner, as a real start writes it;
    // the steer below runs as that owner and passes the service's read check.
    first.append(PARENT_THREAD, 'session.started', {
      sessionId: PARENT_THREAD,
      metadata: { userId: 'human:local:owner' },
    });
    first.append(PARENT_THREAD, 'turn.started', { turnId: 'parent-turn-a' });
    const before: string[] = [];
    // The steer reaches the receipt layer (or not) and its answer is lost.
    const lost = coordinator(
      first,
      async ({ threadId, text, clientInputId }) => {
        const input = { threadId, clientInputId, input: text };
        if (options.claimed) {
          expect(first.eventStore.claimSteerInput(input)).toBe(true);
          if (options.confirmedTurn)
            first.eventStore.confirmSteerInput(input, options.confirmedTurn);
        }
        return { outcome: 'indeterminate' };
      },
      before,
    );
    first.append('child', 'turn.started', { turnId: 'child-turn-1' });
    first.append('child', 'turn.completed', {
      turnId: 'child-turn-1',
      outputText: 'done',
    });
    await lost.reconcile();
    expect(
      first.eventStore.delegationResultStore().listForChild('child'),
    ).toEqual([
      expect.objectContaining({
        state: 'claimed',
        unconfirmed: `steer:${PARENT_THREAD}`,
      }),
    ]);
    // The parent's turn ends while the process is down.
    first.append(PARENT_THREAD, 'turn.completed', { turnId: 'parent-turn-a' });
    lost.stop();
    first.eventStore.close();

    const second = open(path);
    // The parent's Session as a restart leaves it: recorded, no engine yet.
    second.eventStore.upsertSession({
      provider: 'claude',
      threadId: PARENT_THREAD,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } as never);
    const starts: string[] = [];
    const steered: string[] = [];
    const steer = realSteer(second);
    const redrive = coordinator(
      second,
      async (input) => {
        steered.push(input.clientInputId);
        return steer(input);
      },
      starts,
    );
    await redrive.reconcile();
    await redrive.reconcile();
    // Let a released row's immediate re-check run before reading the result.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await redrive.idle();
    const row = second.eventStore
      .delegationResultStore()
      .listForChild('child')[0]!;
    redrive.stop();
    second.eventStore.close();
    return { row, starts, steered };
  }

  test('a claimed but unconfirmed steer answers from its receipt and is never followed by a start', async () => {
    const { row, starts, steered } = await steerLostThenRestart({
      claimed: true,
    });
    expect(steered.length).toBeGreaterThan(0);
    expect(starts).toEqual([]);
    expect(row).toMatchObject({
      state: 'claimed',
      unconfirmed: `steer:${PARENT_THREAD}`,
    });
  });

  test('a claimed and confirmed steer settles delivered from its receipt, with no start', async () => {
    const { row, starts } = await steerLostThenRestart({
      claimed: true,
      confirmedTurn: 'parent-turn-a',
    });
    expect(starts).toEqual([]);
    expect(row.state).toBe('delivered');
  });

  test('a steer that never reached the receipt layer is released and then started once', async () => {
    const { row, starts, steered } = await steerLostThenRestart({
      claimed: false,
    });
    expect(steered.length).toBeGreaterThan(0);
    expect(starts).toHaveLength(1);
    expect(row.state).toBe('delivered');
  });
});

test.each([
  'retained',
  'retired',
  'queued',
  'queued-consistent',
  'queued-native-collision',
  'queued-native-collision-consistent',
  'raw-after-B',
  'queued-malformed',
  'queued-unknown',
  'consistent',
  'compat-earliestnativeA-pending',
  ...(['old', 'v2', 'oldambiguous', 'earliestnative'] as const).flatMap(
    (format) =>
      (format === 'earliestnative'
        ? ([
            'pending',
            'claimed',
            'consumed',
            'delivered',
            'cancelled',
            'refused',
            'undeliverable',
          ] as const)
        : (['pending', 'claimed', 'consumed', 'delivered'] as const)
      ).map((state) => `compat-${format}-${state}` as const),
  ),
] as const)(
  'real result delivery validates %s invocation scope before its first bounded output effect',
  async (order) => {
    const eventStore = new EventStore(':memory:');
    const store = eventStore.delegationResultStore();
    let olderNativeRow:
      | ReturnType<typeof store.listForChild>[number]
      | undefined;
    if (order === 'compat-earliestnativeA-pending') {
      const a = eventStore.sessionTurnBoundaryAuthority().reserve!(
        'child',
        '2029-01-01T00:00:00Z',
      );
      if (a.kind !== 'owner')
        throw new Error('independent actual A prerequisite');
      const inputA = captureTurnIntent(
        { threadId: 'child', input: 'A' },
        { binding: {}, requiresFreshCompanions: false },
      );
      expect(
        a.claim.prepareIntent!(inputA, undefined, '2029-01-01T00:00:01Z'),
      ).toEqual({ kind: 'applied' });
      expect(a.claim.beginInvocation('2029-01-01T00:00:02Z')).toEqual({
        kind: 'applied',
      });
      expect(a.claim.accepted('N', '2029-01-01T00:00:03Z')).toEqual({
        kind: 'applied',
      });
      eventStore.appendEvent({
        eventId: 'owned-A-start',
        threadId: 'child',
        provider: 'claude',
        method: 'turn.started',
        turnId: 'N',
        invocationId: inputA.intent.invocationId,
        prompt: 'A',
        createdAt: '2029-01-01T00:00:04Z',
      });
      eventStore.appendEvent({
        eventId: 'owned-A-done',
        threadId: 'child',
        provider: 'claude',
        method: 'turn.completed',
        turnId: 'N',
        invocationId: inputA.intent.invocationId,
        outputText: 'OLDER A OUTPUT',
        createdAt: '1900-01-01T00:00:00Z',
      });
      expect(
        eventStore.readInvocationTerminal(
          'child',
          inputA.intent.invocationId,
          'N',
        ).kind,
      ).toBe('found');
      store.arm({
        childConversationId: 'child',
        taskId: 'child',
        parentConversationId: 'parent',
        actor: { userId: 'owner', attribution: 'verified-bound' },
      });
      const key = 'settled:child:N';
      store.record({
        childConversationId: 'child',
        transitionKey: key,
        transition: 'settled',
        parentConversationId: 'parent',
        childSessionId: 'child',
        childTurnId: 'N',
        outcome: 'completed',
        deliveryId: `dr-${createHash('sha256').update(`child\u0000${key}`).digest('hex').slice(0, 40)}`,
        text: 'OLDER A OUTPUT',
      });
      olderNativeRow = store.listForChild('child')[0];
    }
    const starts: string[] = [];
    const deliveryKeys: string[] = [];
    const owned = eventStore.sessionTurnBoundaryAuthority().reserve!(
      'child',
      '2030-01-01T00:00:00Z',
    );
    if (owned.kind !== 'owner') throw new Error('result claim prerequisite');
    const capture = captureTurnIntent(
      { threadId: 'child', input: 'B' },
      { binding: {}, requiresFreshCompanions: false },
    );
    expect(
      owned.claim.prepareIntent!(capture, undefined, '2030-01-01T00:00:01Z'),
    ).toEqual({ kind: 'applied' });
    expect(owned.claim.beginInvocation('2030-01-01T00:00:02Z')).toEqual({
      kind: 'applied',
    });
    const invocationId = capture.intent.invocationId;
    const native =
      order.startsWith('queued-native-collision') ||
      order.startsWith('compat-oldambiguous')
        ? `invocation-${invocationId}`
        : 'N';
    expect(owned.claim.accepted(native, '2030-01-01T00:00:03Z')).toEqual({
      kind: 'applied',
    });
    let parentBusy = false;
    const delivery = new DelegationResultDelivery({
      store,
      foldEvents: (threadId) =>
        eventStore
          .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
          .map((stored) => ({
            sequence: stored.sequence,
            event: stored.payload,
          })),
      headSequence: (threadId) =>
        eventStore.readSessionInventoryHighWater(threadId),
      turnEvents: (threadId, turnId, methods, limit, invocationId) =>
        eventStore.listTurnEventsByMethods(
          threadId,
          turnId,
          methods,
          limit,
          invocationId,
        ),
      conversationOf: (threadId) => threadId,
      currentSessionId: (id) => id,
      readInputlessTurnDisposition: (threadId) =>
        eventStore.readInputlessTurnDisposition(threadId),
      readInvocationTerminal: (threadId, invocationId, turnId) =>
        eventStore.readInvocationTerminal(threadId, invocationId, turnId),
      coordinatorBusy: (threadId) => {
        if (threadId === 'parent') return parentBusy;
        const read = eventStore
          .sessionTurnBoundaryAuthority()
          .hasPossibleEffect('child');
        return read.kind !== 'available' || read.active;
      },
      sessionOwnerId: () => (order.endsWith('-refused') ? 'stranger' : 'owner'),
      start: async ({ text, clientTurnId }) => {
        starts.push(text);
        deliveryKeys.push(clientTurnId);
        if (order.endsWith('-undeliverable'))
          throw new Error('clean no-effect parent refusal');
        if (order.endsWith('-claimed')) return { outcome: 'indeterminate' };
        return {
          outcome: 'started',
          conversationId: 'parent',
          sessionId: 'parent',
          turnId: 'parent-turn',
        };
      },
      steer: async () => ({ outcome: 'unsupported-engine' }),
      subscribe: () => () => {},
      logger: { warn() {} },
      retryDelaysMs: [],
    });
    const base = {
      provider: 'claude',
      threadId: 'child',
      createdAt: '2030-01-01T00:00:00Z',
    };
    try {
      eventStore.appendEvent({
        ...base,
        eventId: 'A-start',
        method: 'turn.started',
        turnId: native,
        invocationId: 'A',
        prompt: 'A',
      });
      eventStore.appendEvent({
        ...base,
        eventId: 'A-done',
        method: 'turn.completed',
        turnId: native,
        invocationId: 'A',
        outputText: 'OLD A OUTPUT',
      });
      eventStore.appendEvent({
        ...base,
        eventId: 'B-start',
        method: 'turn.started',
        turnId: native,
        invocationId,
        prompt: 'B',
      });
      eventStore.appendEvent({
        ...base,
        eventId: 'late-A',
        method: 'turn.completed',
        turnId: native,
        invocationId: 'A',
        outputText: 'LATE OLD A OUTPUT',
      });
      store.arm({
        childConversationId: 'child',
        taskId: 'child',
        parentConversationId: 'parent',
        actor: { userId: 'owner', attribution: 'verified-bound' },
      });
      await delivery.reconcile();
      expect(starts).toEqual([]);
      if (order === 'raw-after-B') {
        eventStore.appendEvent({
          ...base,
          eventId: 'raw-start',
          method: 'turn.started',
          turnId: native,
          prompt: 'unproven legacy',
        });
        eventStore.appendEvent({
          ...base,
          eventId: 'raw-terminal',
          method: 'turn.completed',
          turnId: native,
          outputText: 'UNPROVEN OUTPUT',
        });
        await delivery.reconcile();
        expect(
          eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect('child'),
        ).toEqual({ kind: 'available', active: true });
        expect(
          eventStore
            .listEvents('child')
            .find((row) => row.id === 'raw-terminal')?.payload.invocationId,
        ).toBeUndefined();
        expect(starts).toEqual([]);
        expect(store.listForChild('child')).toEqual([]);
      }
      const done: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent =
        {
          ...base,
          ...(order.startsWith('compat-earliestnative')
            ? { createdAt: '1900-01-01T00:00:00Z' }
            : {}),
          eventId: 'B-done',
          method: 'turn.completed',
          turnId: native,
          invocationId,
          outputText: 'EXACT B OUTPUT',
        };
      const conflicting: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent =
        {
          ...base,
          eventId: 'B-conflict',
          method: 'turn.completed',
          turnId: 'M',
          invocationId,
        };
      if (order === 'retained')
        eventStore['db']
          .prepare(
            `INSERT INTO orchestration_events(id,provider,thread_id,turn_id,method,payload,created_at,sequence,global_sequence) VALUES(?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            conflicting.eventId,
            base.provider,
            base.threadId,
            'M',
            conflicting.method,
            JSON.stringify(conflicting),
            base.createdAt,
            5,
            5,
          );
      eventStore.appendEvent(done);
      if (order === 'compat-earliestnativeA-pending') {
        await delivery.reconcile();
        expect(starts).toEqual([]);
        expect(store.listForChild('child')).toEqual([olderNativeRow]);
        return;
      }
      if (order.startsWith('compat-')) {
        const [, format, state] = order.split('-');
        parentBusy =
          state === 'pending' || state === 'consumed' || state === 'cancelled';
        await delivery.reconcile();
        if (state === 'consumed') store.consume('child');
        if (state === 'cancelled')
          store.beginCancel('child', 'historical-stop', null);
        if (state === 'undeliverable')
          for (let attempt = 1; attempt < 5; attempt++)
            await delivery.reconcile();
        const original = store.listForChild('child')[0];
        if (!original) throw new Error('actual recorded result prerequisite');
        expect(original.state).toBe(state);
        const key =
          format === 'earliestnative'
            ? `settled:child:${native}`
            : format === 'old' || format === 'oldambiguous'
              ? `settled:child:invocation-${invocationId}`
              : JSON.stringify([
                  'station.delegation-result/2',
                  'child',
                  'invocation',
                  invocationId,
                ]);
        if (format === 'earliestnative') {
          const historicalDeliveryId = `dr-${createHash('sha256').update(`child\u0000${key}`).digest('hex').slice(0, 40)}`;
          eventStore['db']
            .prepare(
              'UPDATE delegation_result_deliveries SET transition_key=?,delivery_id=?',
            )
            .run(key, historicalDeliveryId);
        } else
          eventStore['db']
            .prepare('UPDATE delegation_result_deliveries SET transition_key=?')
            .run(key);
        const before = store.listForChild('child')[0]!;
        parentBusy = false;
        const calls = starts.length;
        await delivery.reconcile();
        expect(store.listForChild('child')).toHaveLength(1);
        expect(store.listForChild('child')[0]?.deliveryId).toBe(
          before.deliveryId,
        );
        expect(store.listForChild('child')[0]?.transitionKey).toBe(key);
        if (format === 'oldambiguous' || format === 'earliestnative') {
          expect(starts).toHaveLength(calls);
          expect(store.listForChild('child')[0]).toEqual(before);
        } else if (state === 'pending') expect(starts).toHaveLength(1);
        else if (state === 'claimed') {
          expect(starts.length).toBeGreaterThanOrEqual(calls);
          expect(new Set(deliveryKeys).size).toBe(1);
        } else expect(starts).toHaveLength(calls);
        return;
      }
      if (
        order === 'retired' ||
        order === 'queued' ||
        order === 'queued-consistent' ||
        order === 'queued-malformed' ||
        order === 'queued-unknown' ||
        order.startsWith('queued-native-collision')
      ) {
        expect(
          eventStore['db']
            .prepare('SELECT * FROM orchestration_turn_boundaries')
            .all(),
        ).toEqual([]);
        const witness = eventStore['db']
          .prepare(
            'SELECT terminal_retirement FROM orchestration_prepared_turns',
          )
          .get() as { terminal_retirement: string };
        expect(
          JSON.parse(witness.terminal_retirement).terminal.terminalEventId,
        ).toBe('B-done');
        if (order.startsWith('queued')) {
          parentBusy = true;
          await delivery.reconcile();
          expect(store.listForChild('child')).toHaveLength(1);
          expect(starts).toEqual([]);
          parentBusy = false;
        }
        if (order === 'queued-malformed' || order === 'queued-unknown') {
          eventStore['db']
            .prepare('UPDATE delegation_result_deliveries SET transition_key=?')
            .run(
              order === 'queued-malformed'
                ? 'settled:child:unsupported-host-key'
                : 'settled:child:invocation-unknown',
            );
        } else if (
          order !== 'queued-consistent' &&
          order !== 'queued-native-collision-consistent'
        )
          eventStore.appendEvent(conflicting);
      }
      const raw = {
        deliveries: store.listForChild('child'),
        events: eventStore['db']
          .prepare('SELECT * FROM orchestration_events')
          .all(),
        audit: eventStore['db']
          .prepare('SELECT * FROM orchestration_prepared_turns')
          .all(),
        boundary: eventStore['db']
          .prepare('SELECT * FROM orchestration_turn_boundaries')
          .all(),
      };
      await delivery.reconcile();
      if (
        order !== 'consistent' &&
        order !== 'queued-consistent' &&
        order !== 'queued-native-collision-consistent' &&
        order !== 'raw-after-B'
      ) {
        expect(starts).toEqual([]);
        expect(store.listForChild('child')).toEqual(raw.deliveries);
        expect(
          eventStore['db'].prepare('SELECT * FROM orchestration_events').all(),
        ).toEqual(raw.events);
        expect(
          eventStore['db']
            .prepare('SELECT * FROM orchestration_prepared_turns')
            .all(),
        ).toEqual(raw.audit);
        expect(
          eventStore['db']
            .prepare('SELECT * FROM orchestration_turn_boundaries')
            .all(),
        ).toEqual(raw.boundary);
        return;
      }
      await delivery.reconcile();
      expect(starts).toHaveLength(1);
      expect(starts[0]).toContain('EXACT B OUTPUT');
      expect(starts[0]).not.toContain('OLD A OUTPUT');
      await delivery.reconcile();
      expect(starts).toHaveLength(1);
      expect(JSON.parse(store.listForChild('child')[0]!.transitionKey)).toEqual(
        ['station.delegation-result/2', 'child', 'invocation', invocationId],
      );
    } finally {
      delivery.stop();
      eventStore.close();
    }
  },
);

test.each([
  'weak',
  'queued',
  'inputless',
  'inputless-stale-local',
  'scoped-terminal',
  'older-exact',
  'inactive-history',
] as const)(
  'real service never-tagged producer uses actual custody for %s wait/result effects',
  async (mode) => {
    const eventStore = new EventStore(
      join(makeTempDir('weak-producer-custody-'), 'events.sqlite'),
    );
    const eventBus = new EventBus();
    class WeakAdapter extends GateTestAdapter {
      readonly sent: Parameters<GateTestAdapter['sendTurn']>[0][] = [];
      readonly opened = new Set<string>();
      override async hasSession(threadId?: string) {
        return threadId !== undefined && this.opened.has(threadId);
      }
      override async startSession(
        input: Parameters<GateTestAdapter['startSession']>[0],
      ) {
        const session = await super.startSession(input);
        this.opened.add(input.threadId);
        this.events.push({
          eventId: `session:${input.threadId}`,
          provider: 'claude',
          threadId: input.threadId,
          sessionId: input.threadId,
          method: 'session.started',
          createdAt: session.createdAt,
          metadata: input.metadata,
        });
        return session;
      }
      override async sendTurn(
        input: Parameters<GateTestAdapter['sendTurn']>[0],
      ) {
        this.sent.push(input);
        if (input.threadId === 'child')
          this.events.push({
            eventId: `raw-start:${this.sent.length}`,
            provider: 'claude',
            threadId: 'child',
            turnId: 'N',
            method: 'turn.started',
            prompt: input.input,
            ...(input.input === 'A'
              ? { invocationId: input.invocationId }
              : {}),
            createdAt: new Date().toISOString(),
          });
        return {
          threadId: input.threadId,
          turnId: input.threadId === 'child' ? 'N' : 'parent-N',
        };
      }
    }
    const adapter = new WeakAdapter();
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus,
      eventStore,
      logger: { debug() {}, warn() {} },
    });
    service.initialize();
    let parentBusy = mode === 'queued' || mode === 'older-exact';
    const starts: string[] = [];
    const steers: string[] = [];
    const ports: DelegationResultDeliveryPorts = {
      store: eventStore.delegationResultStore(),
      foldEvents: (thread) =>
        eventStore
          .listEventsByMethods(thread, ACTIVE_TURN_FOLD_METHODS)
          .map((row) => ({ sequence: row.sequence, event: row.payload })),
      headSequence: (thread) =>
        eventStore.readSessionInventoryHighWater(thread),
      turnEvents: (thread, native, methods, limit, invocation) =>
        eventStore.listTurnEventsByMethods(
          thread,
          native,
          methods,
          limit,
          invocation,
        ),
      conversationOf: (thread) => thread,
      currentSessionId: (id) => id,
      coordinatorBusy: (thread) =>
        thread === 'parent'
          ? parentBusy
          : mode === 'inputless-stale-local' || service.hasActiveTurn(thread),
      readInputlessTurnDisposition: (thread) =>
        eventStore.readInputlessTurnDisposition(thread),
      readInvocationTerminal: (thread, invocation, native) =>
        eventStore.readInvocationTerminal(thread, invocation, native),
      sessionOwnerId: (thread) => service.sessionRecordedOwnerId(thread),
      start: async ({ text, clientTurnId }) => {
        starts.push(text);
        const result = await service.dispatch(
          {
            type: 'sendTurn',
            input: { threadId: 'parent', input: text, clientTurnId },
          },
          { userId: 'owner' },
        );
        return {
          outcome: 'started',
          conversationId: 'parent',
          sessionId: 'parent',
          turnId: (result as { turnId: string }).turnId,
        };
      },
      steer: async ({ text }) => {
        steers.push(text);
        return { outcome: 'unsupported-engine' };
      },
      subscribe: () => () => {},
      logger: { warn() {} },
      retryDelaysMs: [],
    };
    const delivery = new DelegationResultDelivery(ports);
    const waitPorts: SessionTurnWaitPorts = {
      ...ports,
      subscribe: (_thread, listener) =>
        eventStore.observeCommits({
          eventCommitted() {
            listener();
          },
        }),
    };
    const controller = new AbortController();
    let waiting: Promise<unknown> | undefined;
    const emit = async (
      event: import('@kontourai/station-contracts/runtime-events').CanonicalRuntimeEvent,
    ) => {
      adapter.events.push(event);
      await vi.waitFor(() =>
        expect(eventStore.hasEventId(event.eventId)).toBe(true),
      );
    };
    const base = {
      provider: 'claude',
      threadId: 'child',
      turnId: 'N',
      createdAt: '2030-01-01T00:00:00Z',
    };
    try {
      for (const threadId of ['child', 'parent'])
        await service.dispatch(
          {
            type: 'startSession',
            input: {
              threadId,
              provider: 'claude',
              metadata: { userId: 'owner' },
            },
          },
          { userId: 'owner' },
        );
      await vi.waitFor(() =>
        expect(
          eventStore
            .listEvents('parent')
            .find((row) => row.id === 'session:parent')?.payload,
        ).toMatchObject({ metadata: { userId: 'owner' } }),
      );
      expect(service.sessionRecordedOwnerId('parent')).toBe('owner');
      ports.store.arm({
        childConversationId: 'child',
        taskId: 'child',
        parentConversationId: 'parent',
        actor: { userId: 'owner', attribution: 'verified-bound' },
      });
      let cursor = eventStore.readSessionInventoryHighWater('child');
      if (mode === 'queued' || mode.startsWith('inputless')) {
        await emit({
          ...base,
          eventId: 'legacy-start',
          method: 'turn.started',
          prompt: 'inputless',
          metadata: { trigger: 'provider' },
        });
        await emit({
          ...base,
          eventId: 'legacy-done',
          method: 'turn.completed',
          outputText: 'GENUINE LEGACY',
          metadata: { trigger: 'provider' },
        });
        expect(
          eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect('child'),
        ).toEqual({ kind: 'available', active: false });
        if (mode === 'queued') {
          await delivery.reconcile();
          expect(starts).toEqual([]);
          expect(ports.store.listForChild('child')[0]?.state).toBe('pending');
          cursor = eventStore.readSessionInventoryHighWater('child');
        }
      }
      if (mode === 'older-exact') {
        await service.dispatch(
          {
            type: 'sendTurn',
            input: { threadId: 'child', input: 'A', clientTurnId: 'A' },
          },
          { userId: 'owner' },
        );
        const invocationA = adapter.sent.find(
          (input) => input.input === 'A',
        )?.invocationId;
        expect(invocationA).toBeTypeOf('string');
        await emit({
          ...base,
          eventId: 'owned-A-done',
          method: 'turn.completed',
          invocationId: invocationA,
          outputText: 'EXACT OLDER A',
        });
        await delivery.reconcile();
        expect(ports.store.listForChild('child')).toHaveLength(1);
        expect(starts).toEqual([]);
      }
      if (!mode.startsWith('inputless')) {
        await service.dispatch(
          {
            type: 'sendTurn',
            input: { threadId: 'child', input: 'B', clientTurnId: 'B' },
          },
          { userId: 'owner' },
        );
        await vi.waitFor(() =>
          expect(
            eventStore
              .listEvents('child')
              .some(
                (row) =>
                  row.method === 'turn.started' &&
                  row.payload.method === 'turn.started' &&
                  row.payload.prompt === 'B',
              ),
          ).toBe(true),
        );
        const invocationB = adapter.sent.find(
          (input) => input.input === 'B',
        )?.invocationId;
        expect(invocationB).toBeTypeOf('string');
        expect(service.hasActiveTurn('child')).toBe(true);
        if (mode === 'inactive-history') {
          await emit({
            ...base,
            eventId: 'proved-B-history',
            method: 'turn.completed',
            invocationId: invocationB,
            outputText: 'B done',
          });
          expect(
            eventStore
              .sessionTurnBoundaryAuthority()
              .hasPossibleEffect('child'),
          ).toEqual({ kind: 'available', active: false });
          const afterProof = eventStore.readSessionInventoryHighWater('child');
          await emit({
            ...base,
            eventId: 'unassigned-later-start',
            method: 'turn.started',
            prompt: 'later raw',
          });
          await emit({
            ...base,
            eventId: 'unassigned-later-terminal',
            method: 'turn.completed',
          });
          expect(eventStore.readInputlessTurnDisposition('child')).toEqual({
            kind: 'unknown',
          });
          expect(
            evaluateSessionWait(waitPorts, 'child', 'idle', 0).satisfied,
          ).toBe(true);
          expect(
            evaluateSessionWait(waitPorts, 'child', 'turn-settled', afterProof)
              .satisfied,
          ).toBe(false);
          return;
        }
        const before = {
          boundary: eventStore['db']
            .prepare(
              "SELECT * FROM orchestration_turn_boundaries WHERE thread_id='child'",
            )
            .all(),
          audit: eventStore['db']
            .prepare(
              "SELECT * FROM orchestration_prepared_turns WHERE thread_id='child'",
            )
            .all(),
          dedup: eventStore['db']
            .prepare('SELECT * FROM orchestration_turn_dedup WHERE dedup_key=?')
            .all(turnDedupKey('child', 'B')),
        };
        let outcome: unknown;
        waiting = new SessionTurnWaiter(waitPorts)
          .wait({
            callerSessionId: 'caller',
            threadId: 'child',
            until: 'turn-settled',
            afterEventCursor: cursor,
            timeoutMs: 10000,
            signal: controller.signal,
          })
          .then((value) => {
            outcome = value;
            return value;
          });
        await emit({
          ...base,
          eventId: 'B-terminal',
          method: 'turn.completed',
          ...(mode === 'scoped-terminal' ? { invocationId: invocationB } : {}),
          outputText: mode === 'scoped-terminal' ? 'EXACT B' : 'UNPROVEN B',
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (mode === 'weak' || mode === 'queued') {
          expect(service.hasActiveTurn('child')).toBe(true);
          expect(
            eventStore
              .listEvents('child')
              .filter(
                (row) =>
                  row.method === 'turn.started' ||
                  row.method === 'turn.completed',
              )
              .every((row) => row.payload.invocationId === undefined),
          ).toBe(true);
          const pending = ports.store.listForChild('child');
          const priorSteers = steers.length;
          parentBusy = false;
          await delivery.reconcile();
          expect(starts).toEqual([]);
          expect(steers).toHaveLength(priorSteers);
          expect(ports.store.listForChild('child')).toEqual(pending);
          expect(outcome).toBeUndefined();
          expect(
            evaluateSessionWait(waitPorts, 'child', 'idle', 0).satisfied,
          ).toBe(false);
          expect(
            evaluateSessionWait(waitPorts, 'child', 'turn-settled', cursor)
              .satisfied,
          ).toBe(false);

          expect(
            eventStore['db']
              .prepare(
                "SELECT * FROM orchestration_turn_boundaries WHERE thread_id='child'",
              )
              .all(),
          ).toEqual(before.boundary);
          expect(
            eventStore['db']
              .prepare(
                "SELECT * FROM orchestration_prepared_turns WHERE thread_id='child'",
              )
              .all(),
          ).toEqual(before.audit);
          expect(
            eventStore['db']
              .prepare(
                'SELECT * FROM orchestration_turn_dedup WHERE dedup_key=?',
              )
              .all(turnDedupKey('child', 'B')),
          ).toEqual(before.dedup);
        } else {
          const settled = evaluateSessionWait(
            waitPorts,
            'child',
            'turn-settled',
            cursor,
          );
          expect(settled.satisfied).toBe(true);
          expect(eventStore.readInputlessTurnDisposition('child')).toEqual({
            kind: 'unknown',
          });
          expect(settled.view.settledTurn?.invocationId).toBe(
            adapter.sent.find(
              (input) => input.input === (mode === 'older-exact' ? 'A' : 'B'),
            )?.invocationId,
          );
          parentBusy = false;
          await delivery.reconcile();
          expect(starts).toHaveLength(1);
          expect(starts[0]).toContain(
            mode === 'older-exact' ? 'EXACT OLDER A' : 'EXACT B',
          );
          expect(starts[0]).not.toContain('UNPROVEN B');
        }
      } else {
        expect(eventStore.readInputlessTurnDisposition('child')).toEqual({
          kind: 'inputless',
        });
        expect(
          evaluateSessionWait(waitPorts, 'child', 'turn-settled', cursor)
            .satisfied,
        ).toBe(true);
        await delivery.reconcile();
        expect(starts).toHaveLength(1);
        expect(starts[0]).toContain('GENUINE LEGACY');
      }
      expect(
        adapter.sent.filter((input) => input.threadId === 'parent'),
      ).toHaveLength(mode === 'weak' || mode === 'queued' ? 0 : 1);
    } finally {
      controller.abort();
      await waiting;
      delivery.stop();
      adapter.events.close();
      await service.shutdown();
      eventStore.close();
    }
  },
);

test('inputless disposition holds corrupt captured markers and unavailable audit source without mutation', () => {
  const eventStore = new EventStore(':memory:');
  try {
    expect(eventStore.readInputlessTurnDisposition('untouched')).toEqual({
      kind: 'inputless',
    });
    const owned = eventStore.sessionTurnBoundaryAuthority().reserve!(
      'captured',
      '2030-01-01T00:00:00Z',
    );
    if (owned.kind !== 'owner') throw new Error('actual owner prerequisite');
    const capture = captureTurnIntent(
      { threadId: 'captured', input: 'B' },
      { binding: {}, requiresFreshCompanions: false },
    );
    expect(
      owned.claim.prepareIntent!(capture, undefined, '2030-01-01T00:00:01Z'),
    ).toEqual({ kind: 'applied' });
    const original = eventStore['db']
      .prepare('SELECT * FROM orchestration_turn_boundaries')
      .all();
    const captured = original.find(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        'invocation_id' in row &&
        row.invocation_id === capture.intent.invocationId,
    );
    if (
      typeof captured !== 'object' ||
      captured === null ||
      !('body_ref' in captured) ||
      typeof captured.body_ref !== 'string'
    )
      throw new Error('actual complete captured marker prerequisite');
    eventStore['db']
      .prepare(
        'UPDATE orchestration_turn_boundaries SET body_ref=NULL WHERE invocation_id=?',
      )
      .run(capture.intent.invocationId);
    const before = eventStore['db']
      .prepare('SELECT * FROM orchestration_turn_boundaries')
      .all();
    expect(eventStore.readInputlessTurnDisposition('captured')).toEqual({
      kind: 'unknown',
    });
    expect(
      eventStore['db']
        .prepare('SELECT * FROM orchestration_turn_boundaries')
        .all(),
    ).toEqual(before);
    eventStore['db']
      .prepare(
        'UPDATE orchestration_turn_boundaries SET body_ref=? WHERE invocation_id=?',
      )
      .run(captured.body_ref, capture.intent.invocationId);
    expect(
      eventStore['db']
        .prepare('SELECT * FROM orchestration_turn_boundaries')
        .all(),
    ).toEqual(original);
    expect(
      eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect('untouched'),
    ).toEqual({ kind: 'available', active: false });
    expect(eventStore.readInputlessTurnDisposition('untouched')).toEqual({
      kind: 'inputless',
    });
    const audit = eventStore['db']
      .prepare('SELECT * FROM orchestration_prepared_turns')
      .all();
    eventStore['db'].exec(
      'SAVEPOINT unavailable_audit; DROP TABLE orchestration_prepared_turns',
    );
    const prepare = eventStore['db'].prepare.bind(eventStore['db']);
    const failures: { sql: string; error: unknown }[] = [];
    const observed = vi
      .spyOn(eventStore['db'], 'prepare')
      .mockImplementation((sql) => {
        try {
          return prepare(sql);
        } catch (error) {
          failures.push({ sql, error });
          throw error;
        }
      });
    try {
      expect(
        eventStore.readInputlessTurnDisposition('untouched'),
        'unavailable audit must refuse after the strict records were restored',
      ).toEqual({ kind: 'unknown' });
      expect(failures).toHaveLength(1);
      expect(failures[0]?.sql).toContain('FROM orchestration_prepared_turns');
      expect(failures[0]?.error).toBeInstanceOf(Error);
      expect(failures[0]?.error).toMatchObject({
        message: expect.stringContaining(
          'no such table: orchestration_prepared_turns',
        ),
      });
      expect(
        eventStore['db']
          .prepare('SELECT * FROM orchestration_turn_boundaries')
          .all(),
      ).toEqual(original);
    } finally {
      observed.mockRestore();
      eventStore['db'].exec(
        'ROLLBACK TO unavailable_audit; RELEASE unavailable_audit',
      );
    }
    expect(
      eventStore['db']
        .prepare('SELECT * FROM orchestration_turn_boundaries')
        .all(),
    ).toEqual(original);
    expect(
      eventStore['db']
        .prepare('SELECT * FROM orchestration_prepared_turns')
        .all(),
    ).toEqual(audit);
    expect(eventStore.readInputlessTurnDisposition('untouched')).toEqual({
      kind: 'inputless',
    });
  } finally {
    eventStore.close();
  }
});
