/**
 * #3158 fix round 2: the delivery store's retention against a controllable
 * clock, driven through the coordinator's own event subscription, and the
 * bound on the event store's turn-scoped read.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PENDING_TURN_INTERRUPT_TTL_MS } from '@kontourai/station-contracts/orchestration';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
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
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';

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
      outcome: 'completed' | 'aborted' = 'aborted',
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

  test('two held turns each take one interrupt, oldest first', () => {
    const { store, settle, clock } = bare();
    store.beginCancel('child', 'token-1', undefined);
    clock.now = 1;
    store.beginCancel('child', 'token-2', undefined);
    store.bindUnloggedSuppressions('child', 'turn-a');
    store.bindUnloggedSuppressions('child', 'turn-a'); // re-read of the same turn
    expect(settle('turn-a')).toBe('cancelled');
    store.bindUnloggedSuppressions('child', 'turn-b');
    expect(settle('turn-b')).toBe('cancelled');
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

  test.each([
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
  ])(
    'a database with the %s schema is migrated and still delivers',
    async (_name, schema, owner) => {
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
      append('turn.started', { turnId: 'turn-1' });
      append('turn.completed', { turnId: 'turn-1', outputText: 'done' });
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
    },
  );
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
 * never re-sent, and never followed by a start. The port maps the outcome as
 * the production steer port in `runtime-routes.ts` does.
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
      coordinatorBusy: () => false,
      sessionOwnerId: () => 'human:local:owner',
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

  /** The production steer port's outcome mapping, over the real service. */
  const realSteer =
    (world: ReturnType<typeof open>): DelegationResultDeliveryPortsSteer =>
    async ({ threadId, text, clientInputId }) => {
      let dispatched: { result?: unknown };
      try {
        dispatched = await world.service.dispatchWithReceipt({
          type: 'steerTurn',
          threadId,
          input: text,
          clientInputId,
        });
      } catch {
        return { outcome: 'indeterminate' };
      }
      const result = dispatched.result as
        | { outcome?: string; turnId?: string }
        | undefined;
      switch (result?.outcome) {
        case 'steered':
          return { outcome: 'steered', turnId: result.turnId ?? '' };
        case 'no-active-turn':
        case 'unsupported-engine':
        case 'concurrent-steer':
          return { outcome: result.outcome };
        default:
          return { outcome: 'indeterminate' };
      }
    };

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
