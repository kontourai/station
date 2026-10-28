/**
 * #3628: the coordinator designation and its wake bounds, over the real
 * EventStore SQLite connection. A "restart" closes the store and opens a new
 * one on the same file. Timers are scripted so coalescing is observable.
 */
import { join } from 'node:path';
import {
  COORDINATOR_WAKE_COALESCE_MS,
  COORDINATOR_WAKE_DEDUPE_WINDOW_MS,
  COORDINATOR_WAKE_MAX_ITEMS_PER_TURN,
  COORDINATOR_WAKE_MAX_PENDING_ITEMS,
  COORDINATOR_WAKE_MAX_PER_HOUR,
  COORDINATOR_WAKE_RETRY_DELAYS_MS,
  COORDINATOR_WAKE_WINDOW_MS,
  coordinatorWakeClientTurnId,
} from '@kontourai/station-contracts/coordinator';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type CoordinatorAttentionItem,
  CoordinatorWakeDelivery,
  coordinatorAttentionOf,
  readCoordinatorDelivery,
  wireCoordinatorWakes,
} from '../coordinator-session.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import type { ThreadInboxPayload } from '../thread-inbox.js';

const makeTempDir = trackTempDirs();
const OWNER = 'human:local:owner';
const OTHER = 'human:tailnet:other';
const COORDINATOR = 'conversation-coordinator';

const opened: EventStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

function openStore(path: string): EventStore {
  const store = new EventStore(path);
  opened.push(store);
  return store;
}

function closeStore(store: EventStore) {
  opened.splice(opened.indexOf(store), 1);
  store.close();
}

interface Harness {
  delivery: CoordinatorWakeDelivery;
  submitted: {
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
  }[];
  withdrawn: { conversationId: string; userId: string }[];
  /** Fire every armed timer whose delay has passed by `advance`. */
  advance(ms: number): void;
  clock: { now: number };
}

function harness(
  store: EventStore,
  options: {
    readable?: (userId: string, sessionId: string) => boolean;
    delegatedBy?: (conversationId: string) => string | undefined;
    submitOutcome?: () => 'queued' | 'capacity' | 'throw';
  } = {},
): Harness {
  const clock = { now: Date.UTC(2026, 9, 28, 9) };
  const timers: { at: number; callback: () => void; live: boolean }[] = [];
  const submitted: Harness['submitted'] = [];
  const withdrawn: Harness['withdrawn'] = [];
  const delivery = new CoordinatorWakeDelivery({
    store: store.coordinatorStore(),
    mayRead: options.readable ?? (() => true),
    conversationOf: (sessionId) => sessionId,
    delegatedBy: options.delegatedBy ?? (() => undefined),
    submit: (input) => {
      submitted.push(input);
      const outcome = options.submitOutcome?.();
      if (outcome === 'throw') throw new Error('inbox unavailable');
      return outcome === 'capacity'
        ? { outcome: 'capacity', limit: 1 }
        : {
            outcome: 'queued',
            entry: {} as never,
          };
    },
    withdrawQueuedWakes: (conversationId, userId) => {
      withdrawn.push({ conversationId, userId });
      return 1;
    },
    logger: { warn: vi.fn() },
    now: () => clock.now,
    setTimer: (callback, delayMs) => {
      const timer = { at: clock.now + delayMs, callback, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  return {
    delivery,
    submitted,
    withdrawn,
    clock,
    advance(ms) {
      clock.now += ms;
      for (;;) {
        const due = timers.find((t) => t.live && t.at <= clock.now);
        if (!due) return;
        due.live = false;
        due.callback();
      }
    },
  };
}

const item = (
  n: number,
  kind: CoordinatorAttentionItem['kind'] = 'failed',
): CoordinatorAttentionItem => ({
  kind,
  sessionId: `session-worker-${n}`,
  itemKey: `${kind}:turn-completion:session-worker-${n}:turn-1`,
  title: `Worker ${n} title`,
});

const designate = (
  store: EventStore,
  userId = OWNER,
  conversationId = COORDINATOR,
) =>
  store.coordinatorStore().designate({
    conversationId,
    actor: { userId },
    replace: false,
    now: 1,
  });

describe('coordinator designation', () => {
  test('a designation survives a restart, and a second one is refused unless it replaces', () => {
    const path = join(makeTempDir('coordinator-'), 'orchestration.sqlite');
    const first = openStore(path);
    expect(designate(first)).toMatchObject({
      outcome: 'designated',
      designation: { conversationId: COORDINATOR },
    });
    closeStore(first);

    const second = openStore(path);
    expect(second.coordinatorStore().designation(OWNER)).toMatchObject({
      conversationId: COORDINATOR,
      actor: { userId: OWNER },
    });
    // Same conversation again: nothing changes.
    expect(designate(second)).toMatchObject({ outcome: 'designated' });
    // A different one: refused, the first is kept.
    expect(designate(second, OWNER, 'conversation-other')).toEqual({
      outcome: 'refused',
      code: 'coordinator_already_designated',
    });
    expect(second.coordinatorStore().designation(OWNER)?.conversationId).toBe(
      COORDINATOR,
    );
    // An explicit replace moves it.
    expect(
      second.coordinatorStore().designate({
        conversationId: 'conversation-other',
        actor: { userId: OWNER },
        replace: true,
        now: 2,
      }),
    ).toMatchObject({
      outcome: 'designated',
      designation: { conversationId: 'conversation-other' },
    });
    // Another person cannot take a conversation that is already someone's.
    expect(designate(second, OTHER, 'conversation-other')).toEqual({
      outcome: 'refused',
      code: 'coordinator_conversation_taken',
    });
    expect(second.coordinatorStore().undesignate(OWNER)).toBe(true);
    expect(second.coordinatorStore().designation(OWNER)).toBeUndefined();
    expect(second.coordinatorStore().undesignate(OWNER)).toBe(false);
  });
});

describe('coordinator wake bounds', () => {
  const freshStore = () =>
    openStore(join(makeTempDir('coordinator-wake-'), 'orchestration.sqlite'));

  test('a burst is one wake after the coalescing window, and a repeat of an item is never sent again', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store);
    expect(COORDINATOR_WAKE_COALESCE_MS).toBe(30_000);
    expect(h.delivery.observe(item(1))).toEqual([
      { userId: OWNER, outcome: 'recorded' },
    ]);
    h.delivery.observe(item(2, 'needs-you'));
    h.delivery.observe(item(1));
    h.advance(COORDINATOR_WAKE_COALESCE_MS - 1);
    expect(h.submitted).toHaveLength(0);
    h.advance(1);
    expect(h.submitted).toHaveLength(1);
    const [wake] = h.submitted;
    expect(wake!.conversationId).toBe(COORDINATOR);
    expect(wake!.clientTurnId).toMatch(/^coordinator-wake:/);
    expect(wake!.payload.clientOrigin).toMatchObject({
      actor: { kind: 'internal' },
    });
    expect(wake!.payload.actor).toEqual({ userId: OWNER });
    expect(wake!.payload.message).toContain(
      'This message is from Station, not the person.',
    );
    expect(wake!.payload.message).toContain('Failed: Session session-worker-1');
    expect(wake!.payload.message).toContain(
      'Needs the person: Session session-worker-2',
    );
    // Delivered, then observed again: still the same item.
    expect(h.delivery.observe(item(1))).toEqual([
      { userId: OWNER, outcome: 'duplicate' },
    ]);
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toHaveLength(1);
  });

  test('the hourly cap refuses the wake past it, holds its items, and sends them when a slot opens', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store);
    expect(COORDINATOR_WAKE_MAX_PER_HOUR).toBe(12);
    for (let n = 1; n <= COORDINATOR_WAKE_MAX_PER_HOUR; n += 1) {
      h.delivery.observe(item(n));
      h.advance(COORDINATOR_WAKE_COALESCE_MS);
    }
    expect(h.submitted).toHaveLength(COORDINATOR_WAKE_MAX_PER_HOUR);
    // max + 1: recorded, but no wake.
    h.delivery.observe(item(100));
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toHaveLength(COORDINATOR_WAKE_MAX_PER_HOUR);
    expect(h.delivery.flush(OWNER)).toBe('capped');
    expect(store.coordinatorStore().waitingItems(OWNER)).toHaveLength(1);
    // The oldest wake leaves the window: the held item goes, once.
    h.advance(COORDINATOR_WAKE_WINDOW_MS);
    expect(h.submitted).toHaveLength(COORDINATOR_WAKE_MAX_PER_HOUR + 1);
    expect(h.submitted.at(-1)!.payload.message).toContain(
      'Session session-worker-100',
    );
    expect(store.coordinatorStore().waitingItems(OWNER)).toHaveLength(0);
  });

  test('waiting items are refused past their cap, and one wake names at most its item limit', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store);
    expect(COORDINATOR_WAKE_MAX_PENDING_ITEMS).toBe(100);
    expect(COORDINATOR_WAKE_MAX_ITEMS_PER_TURN).toBe(10);
    for (let n = 1; n <= COORDINATOR_WAKE_MAX_PENDING_ITEMS; n += 1)
      expect(h.delivery.observe(item(n))).toEqual([
        { userId: OWNER, outcome: 'recorded' },
      ]);
    expect(
      h.delivery.observe(item(COORDINATOR_WAKE_MAX_PENDING_ITEMS + 1)),
    ).toEqual([{ userId: OWNER, outcome: 'full' }]);
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    const message = h.submitted[0]!.payload.message;
    expect(message.match(/^- Failed: /gm)).toHaveLength(
      COORDINATOR_WAKE_MAX_ITEMS_PER_TURN,
    );
    expect(message).toContain('- and 90 more;');
  });

  test('the coordinator is not woken by its own conversation, a child it delegated, or work its person cannot read', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store, {
      readable: (_user, sessionId) => sessionId !== 'session-private',
      delegatedBy: (conversationId) =>
        conversationId === 'session-child' ? COORDINATOR : undefined,
    });
    expect(h.delivery.observe({ ...item(1), sessionId: COORDINATOR })).toEqual(
      [],
    );
    expect(
      h.delivery.observe({ ...item(2), sessionId: 'session-child' }),
    ).toEqual([]);
    expect(
      h.delivery.observe({
        ...item(4, 'finished'),
        sessionId: 'session-child',
      }),
    ).toEqual([]);
    expect(
      h.delivery.observe({ ...item(3), sessionId: 'session-private' }),
    ).toEqual([]);
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toHaveLength(0);
  });

  test.each(['capacity', 'throw'] as const)(
    'a wake the inbox took nothing of (%s) is tried again on its own after the first retry delay',
    (refusal) => {
      const store = freshStore();
      designate(store);
      let outcome: 'queued' | 'capacity' | 'throw' = refusal;
      const h = harness(store, { submitOutcome: () => outcome });
      expect(COORDINATOR_WAKE_RETRY_DELAYS_MS[0]).toBe(60_000);
      h.delivery.observe(item(1));
      h.advance(COORDINATOR_WAKE_COALESCE_MS);
      expect(h.submitted).toHaveLength(1);
      expect(store.coordinatorStore().waitingItems(OWNER)).toHaveLength(1);
      outcome = 'queued';
      h.advance(60_000 - 1);
      expect(h.submitted).toHaveLength(1);
      h.advance(1);
      expect(h.submitted).toHaveLength(2);
      expect(h.submitted[1]!.clientTurnId).not.toBe(
        h.submitted[0]!.clientTurnId,
      );
      expect(store.coordinatorStore().waitingItems(OWNER)).toEqual([]);
    },
  );

  test('retries back off along the delays, the last repeating, and stay within the hourly cap', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store, { submitOutcome: () => 'capacity' });
    expect(COORDINATOR_WAKE_RETRY_DELAYS_MS).toEqual([
      60_000, 300_000, 900_000, 3_600_000,
    ]);
    h.delivery.observe(item(1));
    const attempts: number[] = [];
    const start = h.clock.now;
    for (let minute = 0; minute < 6 * 60; minute += 1) {
      h.advance(30_000);
      h.advance(30_000);
      while (attempts.length < h.submitted.length)
        attempts.push(h.clock.now - start);
    }
    const gaps = attempts.slice(1).map((at, i) => at - attempts[i]!);
    expect(gaps.slice(0, 5)).toEqual([
      60_000, 300_000, 900_000, 3_600_000, 3_600_000,
    ]);
    const firstHour = attempts.filter((at) => at < 3_600_000);
    expect(firstHour.length).toBeLessThanOrEqual(COORDINATOR_WAKE_MAX_PER_HOUR);
  });

  test('an item whose Session became unreadable while it waited is dropped, not sent', () => {
    const store = freshStore();
    designate(store);
    let readable = true;
    const h = harness(store, { readable: () => readable });
    h.delivery.observe(item(1));
    h.delivery.observe(item(2));
    readable = false;
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toEqual([]);
    expect(store.coordinatorStore().waitingItems(OWNER)).toEqual([]);
    // Dropped, not forgotten: the same item stays a duplicate in the window.
    readable = true;
    expect(h.delivery.observe(item(1))).toEqual([
      { userId: OWNER, outcome: 'duplicate' },
    ]);
  });

  test('a delivered item is a duplicate for the dedupe window, and only then may recur', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store);
    expect(COORDINATOR_WAKE_DEDUPE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    h.delivery.observe(item(1));
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toHaveLength(1);
    h.clock.now +=
      COORDINATOR_WAKE_DEDUPE_WINDOW_MS - COORDINATOR_WAKE_COALESCE_MS - 1;
    expect(h.delivery.observe(item(1))).toEqual([
      { userId: OWNER, outcome: 'duplicate' },
    ]);
    h.clock.now += 2;
    expect(h.delivery.observe(item(1))).toEqual([
      { userId: OWNER, outcome: 'recorded' },
    ]);
  });

  test('retiring a conversation withdraws its queued wakes for that person', () => {
    const store = freshStore();
    designate(store);
    const h = harness(store);
    expect(h.delivery.retire(OWNER, COORDINATOR)).toBe(1);
    expect(h.withdrawn).toEqual([
      { conversationId: COORDINATOR, userId: OWNER },
    ]);
  });

  test('a deleted coordinator conversation is forgotten, so another chat can be designated', () => {
    const store = freshStore();
    designate(store);
    store.coordinatorStore().recordItem(OWNER, item(1), 1);
    expect(store.coordinatorStore().forgetConversation(COORDINATOR)).toBe(
      OWNER,
    );
    expect(store.coordinatorStore().designation(OWNER)).toBeUndefined();
    expect(store.coordinatorStore().waitingItems(OWNER)).toEqual([]);
    expect(designate(store, OWNER, 'conversation-next')).toMatchObject({
      outcome: 'designated',
    });
    expect(
      store.coordinatorStore().forgetConversation('nobody'),
    ).toBeUndefined();
  });

  test('a wake a restart cut short after its commit is handed over again under the same key', () => {
    const path = join(
      makeTempDir('coordinator-restart-'),
      'orchestration.sqlite',
    );
    const first = openStore(path);
    designate(first);
    const claimed = first.coordinatorStore().claimWake({
      designation: first.coordinatorStore().designation(OWNER)!,
      now: 10,
      compose: () => 'framed',
    });
    expect(claimed.outcome).toBe('empty');
    first.coordinatorStore().recordItem(OWNER, item(1), 10);
    const wake = first.coordinatorStore().claimWake({
      designation: first.coordinatorStore().designation(OWNER)!,
      now: 11,
      compose: () => 'framed',
    });
    if (wake.outcome !== 'claimed') throw new Error('not claimed');
    // The process dies before the inbox hand-off.
    closeStore(first);

    const second = openStore(path);
    const h = harness(second);
    h.delivery.reconcile();
    expect(h.submitted).toEqual([
      expect.objectContaining({
        conversationId: COORDINATOR,
        clientTurnId: coordinatorWakeClientTurnId(wake.wake.id),
        payload: expect.objectContaining({ message: 'framed' }),
      }),
    ]);
    expect(second.coordinatorStore().wake(wake.wake.id)?.state).toBe('sent');
    h.delivery.reconcile();
    expect(h.submitted).toHaveLength(1);
  });
});

describe('coordinatorAttentionOf', () => {
  test('maps the attention tiers and leaves out stops and records naming no Session', () => {
    const base = { id: 'n1', title: 'Your agent finished', metadata: {} };
    expect(
      coordinatorAttentionOf({
        ...base,
        category: 'turn-completed',
        metadata: { sessionId: 's1', dedupeTag: 'turn-completion:s1:t1' },
      }),
    ).toEqual({
      kind: 'finished',
      sessionId: 's1',
      itemKey: 'finished:turn-completion:s1:t1',
      title: 'Your agent finished',
    });
    expect(
      coordinatorAttentionOf({
        ...base,
        category: 'approval-request',
        metadata: { sessionId: 's1' },
      }),
    ).toMatchObject({
      kind: 'needs-you',
      itemKey: 'needs-you:notification:n1',
    });
    expect(
      coordinatorAttentionOf({
        ...base,
        category: 'turn-stopped',
        metadata: { sessionId: 's1' },
      }),
    ).toBeUndefined();
    expect(
      coordinatorAttentionOf({ ...base, category: 'pairing-request' }),
    ).toBeUndefined();
    expect(
      coordinatorAttentionOf({
        ...base,
        category: 'agent-info',
        metadata: { sessionId: 's1' },
      }),
    ).toBeUndefined();
  });
});

describe('wireCoordinatorWakes', () => {
  test('a NOTIFICATION_DELIVERED frame on the bus becomes a waiting item', () => {
    const store = openStore(
      join(makeTempDir('coordinator-bus-'), 'orchestration.sqlite'),
    );
    designate(store);
    const bus = new EventBus();
    const wired = wireCoordinatorWakes({
      eventBus: bus,
      eventStore: store,
      store: store.coordinatorStore(),
      threadInbox: { submit: vi.fn() as never },
      mayRead: () => true,
      logger: { warn: vi.fn() },
      setTimer: () => () => {},
    });
    bus.emit(SERVER_EVENTS.NOTIFICATION_DELIVERED, {
      id: 'n1',
      category: 'turn-failed',
      title: 'Your agent needs attention',
      metadata: {
        sessionId: 'session-worker',
        dedupeTag: 'turn-completion:session-worker:t1',
      },
    });
    expect(store.coordinatorStore().waitingItems(OWNER)).toEqual([
      {
        kind: 'failed',
        sessionId: 'session-worker',
        itemKey: 'failed:turn-completion:session-worker:t1',
        title: 'Your agent needs attention',
      },
    ]);
    wired.unsubscribe();
  });
});

describe('a delegated child waiting on the person', () => {
  test('wakes the coordinator that delegated it, since #3158 only returns settled turns', () => {
    const store = openStore(
      join(makeTempDir('coordinator-child-'), 'orchestration.sqlite'),
    );
    designate(store);
    const h = harness(store, {
      delegatedBy: (conversationId) =>
        conversationId === 'session-child' ? COORDINATOR : undefined,
    });
    expect(
      h.delivery.observe({
        ...item(5, 'needs-you'),
        sessionId: 'session-child',
      }),
    ).toEqual([{ userId: OWNER, outcome: 'recorded' }]);
    h.advance(COORDINATOR_WAKE_COALESCE_MS);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.payload.message).toContain(
      'Needs the person: Session session-child',
    );
  });
});

describe('a restart re-send', () => {
  test('re-composes a cut-short wake without items whose Session became unreadable', () => {
    const path = join(
      makeTempDir('coordinator-restart-read-'),
      'orchestration.sqlite',
    );
    const first = openStore(path);
    designate(first);
    first.coordinatorStore().recordItem(OWNER, item(1), 10);
    first.coordinatorStore().recordItem(OWNER, item(2), 10);
    const claimed = first.coordinatorStore().claimWake({
      designation: first.coordinatorStore().designation(OWNER)!,
      now: 11,
      compose: () => 'framed with both',
    });
    if (claimed.outcome !== 'claimed') throw new Error('not claimed');
    closeStore(first);

    const second = openStore(path);
    const h = harness(second, {
      readable: (_user, sessionId) => sessionId !== 'session-worker-2',
    });
    h.delivery.reconcile();
    expect(h.submitted).toEqual([]);
    expect(second.coordinatorStore().wake(claimed.wake.id)).toMatchObject({
      state: 'failed',
      reasonCode: 'source_unreadable',
    });
    h.advance(0);
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]!.payload.message).toContain(
      'Session session-worker-1',
    );
    expect(h.submitted[0]!.payload.message).not.toContain('session-worker-2');
  });
});

describe('readCoordinatorDelivery', () => {
  const ports = (input: {
    events?: { method: string; provider?: string; metadata?: unknown }[];
    running?: boolean;
    boundary?: boolean;
  }) => ({
    currentSessionId: () => 'session-current',
    lifecycleEvents: () => input.events ?? [],
    turnRunning: () => input.running ?? false,
    boundaryActive: () => input.boundary ?? false,
  });
  const started = (servers: string[], provider = 'codex') => ({
    method: 'session.started',
    provider,
    metadata: { capabilityDelivery: { toolServers: { requested: servers } } },
  });

  test('wakes are blocked when the inbox would read an idle Session as busy (#4051)', () => {
    expect(readCoordinatorDelivery('c', ports({ boundary: true })).wakes).toBe(
      'blocked',
    );
    expect(
      readCoordinatorDelivery('c', ports({ boundary: true, running: true }))
        .wakes,
    ).toBe('ready');
    expect(readCoordinatorDelivery('c', ports({})).wakes).toBe('ready');
  });

  test('tools are pending only while a live Session started without station-control', () => {
    expect(
      readCoordinatorDelivery('c', ports({ events: [started(['github'])] })),
    ).toEqual({ wakes: 'ready', toolsPending: true, engine: 'codex' });
    expect(
      readCoordinatorDelivery(
        'c',
        ports({ events: [started(['station-control', 'github'])] }),
      ).toolsPending,
    ).toBe(false);
    expect(
      readCoordinatorDelivery(
        'c',
        ports({ events: [started([]), { method: 'session.exited' }] }),
      ).toolsPending,
    ).toBe(false);
    expect(readCoordinatorDelivery('c', ports({})).toolsPending).toBe(false);
  });
});

describe('EventStore.deleteThread', () => {
  test('deleting the coordinator conversation retires its designation', () => {
    const store = openStore(
      join(makeTempDir('coordinator-delete-'), 'orchestration.sqlite'),
    );
    designate(store);
    store.deleteThread(COORDINATOR);
    expect(store.coordinatorStore().designation(OWNER)).toBeUndefined();
    expect(designate(store, OWNER, 'conversation-next')).toMatchObject({
      outcome: 'designated',
    });
  });
});
