import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { EventStore } from '../event-store.js';
import { captureTurnIntent } from '../prepared-turn-intent.js';
import {
  evaluateSessionWait,
  SESSION_WAIT_MAX_PER_CALLER,
  SESSION_WAIT_MAX_TIMEOUT_MS,
  SESSION_WAIT_MAX_TOTAL,
  SessionTurnWaiter,
  type SessionTurnWaitPorts,
  type SessionWaitFoldEvent,
} from '../session-turn-wait.js';

const event = (
  method: string,
  turnId: string,
  sequence: number,
): SessionWaitFoldEvent => ({
  sequence,
  event: { method, turnId, threadId: 't1' } as unknown as CanonicalRuntimeEvent,
});

/** A Session whose log the test appends to, waking subscribers like the bus does. */
function fakeSession() {
  const log: SessionWaitFoldEvent[] = [];
  const listeners = new Set<() => void>();
  const state = { coordinatorBusy: false };
  const ports: SessionTurnWaitPorts = {
    foldEvents: () => [...log],
    headSequence: () => log.at(-1)?.sequence ?? 0,
    readInputlessTurnDisposition: () => ({ kind: 'inputless' }),
    coordinatorBusy: () => state.coordinatorBusy,
    subscribe: (_thread, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ports,
    state,
    listeners,
    append(method: string, turnId: string) {
      log.push(event(method, turnId, (log.at(-1)?.sequence ?? 0) + 1));
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('evaluateSessionWait', () => {
  test('idle is satisfied exactly when no turn is open and the coordinator holds none', () => {
    const session = fakeSession();
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      true,
    );
    session.append('turn.started', 'a');
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0)).toMatchObject({
      satisfied: false,
      view: { state: 'running', openTurnId: 'a' },
    });
    session.append('turn.completed', 'a');
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      true,
    );
    // A turn the adapter accepted before its turn.started was logged.
    session.state.coordinatorBusy = true;
    expect(evaluateSessionWait(session.ports, 't1', 'idle', 0).satisfied).toBe(
      false,
    );
  });

  test('turn-settled sees a turn that finished after the cursor, with its outcome', () => {
    const session = fakeSession();
    session.append('turn.started', 'old');
    session.append('turn.completed', 'old');
    const cursor = 2;
    session.append('turn.started', 'new');
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', cursor)
        .satisfied,
    ).toBe(false);
    session.append('turn.aborted', 'new');
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', cursor),
    ).toMatchObject({
      satisfied: true,
      view: {
        state: 'idle',
        settledTurn: { turnId: 'new', outcome: 'aborted', sequence: 4 },
        eventCursor: 4,
      },
    });
    // The earlier turn's settle is before the cursor and does not count.
    expect(
      evaluateSessionWait(session.ports, 't1', 'turn-settled', 4).satisfied,
    ).toBe(false);
  });
});

describe('SessionTurnWaiter', () => {
  test('the defaults are the documented literals', () => {
    expect(SESSION_WAIT_MAX_PER_CALLER).toBe(4);
    expect(SESSION_WAIT_MAX_TOTAL).toBe(256);
    expect(SESSION_WAIT_MAX_TIMEOUT_MS).toBe(50_000);
    // And a waiter built without limits uses them.
    const session = fakeSession();
    const waiter = new SessionTurnWaiter(session.ports) as unknown as {
      limits: { perCaller: number; total: number };
    };
    expect(waiter.limits).toEqual({ perCaller: 4, total: 256 });
  });

  test('turn-settled with no cursor and nothing running is already settled', async () => {
    const session = fakeSession();
    const waiter = new SessionTurnWaiter(session.ports);
    expect(
      await waiter.wait({
        callerSessionId: 'c',
        threadId: 't1',
        until: 'turn-settled',
        timeoutMs: 1000,
      }),
    ).toMatchObject({ kind: 'settled', alreadyIdle: true, state: 'idle' });
    expect(waiter.active).toBe(0);
  });

  test('without a cursor it waits for the turn running now, and wakes on its terminal event', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const pending = waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'turn-settled',
      timeoutMs: 5000,
    });
    expect(waiter.active).toBe(1);
    session.append('turn.completed', 'a');
    expect(await pending).toMatchObject({
      kind: 'settled',
      settledTurn: { turnId: 'a', outcome: 'completed' },
    });
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
  });

  test('a timeout reports the Session still running and leaves it so', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const result = await waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'idle',
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      kind: 'timeout',
      state: 'running',
      openTurnId: 'a',
    });
    // The waiter holds no port that could act on the Session, and the log is
    // untouched: nothing was appended by the wait.
    expect(session.ports.foldEvents('t1')).toHaveLength(1);
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
  });

  test('an aborted request frees its slot and its subscription, and never resolves as settled', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const controller = new AbortController();
    const pending = waiter.wait({
      callerSessionId: 'c',
      threadId: 't1',
      until: 'idle',
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    expect(waiter.active).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ kind: 'aborted' });
    expect(waiter.active).toBe(0);
    expect(session.listeners.size).toBe(0);
    expect(
      await waiter.wait({
        callerSessionId: 'c',
        threadId: 't1',
        until: 'idle',
        timeoutMs: 5,
        signal: AbortSignal.abort(),
      }),
    ).toEqual({ kind: 'aborted' });
  });

  test('at most 4 waits per calling session and 256 in all, refused rather than queued', async () => {
    const session = fakeSession();
    session.append('turn.started', 'a');
    const waiter = new SessionTurnWaiter(session.ports);
    const hold = (caller: string) =>
      waiter.wait({
        callerSessionId: caller,
        threadId: 't1',
        until: 'idle',
        timeoutMs: 60_000,
      });
    expect(SESSION_WAIT_MAX_PER_CALLER).toBe(4);
    const held = Array.from({ length: 4 }, () => hold('c1'));
    expect(await hold('c1')).toEqual({ kind: 'capacity', scope: 'caller' });
    // Another caller is unaffected.
    const other = hold('c2');
    expect(waiter.active).toBe(5);
    session.append('turn.completed', 'a');
    await Promise.all([...held, other]);
    expect(waiter.active).toBe(0);
    // The station-wide cap.
    session.append('turn.started', 'b');
    const small = new SessionTurnWaiter(session.ports, {
      perCaller: 10,
      total: 3,
    });
    const three = ['a', 'b', 'c'].map((caller) =>
      small.wait({
        callerSessionId: caller,
        threadId: 't1',
        until: 'idle',
        timeoutMs: 60_000,
      }),
    );
    expect(
      await small.wait({
        callerSessionId: 'd',
        threadId: 't1',
        until: 'idle',
        timeoutMs: 5,
      }),
    ).toEqual({ kind: 'capacity', scope: 'station' });
    session.append('turn.completed', 'b');
    await Promise.all(three);
  });
});

test('invocation wait holds when actual terminal read support is missing for reused native ids', () => {
  const base = {
    provider: 'claude',
    threadId: 't1',
    createdAt: '2030-01-01T00:00:00Z',
  };
  const log: SessionWaitFoldEvent[] = [
    {
      sequence: 1,
      event: {
        ...base,
        eventId: 'A-start',
        method: 'turn.started',
        turnId: 'N',
        invocationId: 'A',
        prompt: 'A',
      },
    },
    {
      sequence: 2,
      event: {
        ...base,
        eventId: 'A-done',
        method: 'turn.completed',
        turnId: 'N',
        invocationId: 'A',
      },
    },
    {
      sequence: 3,
      event: {
        ...base,
        eventId: 'B-start',
        method: 'turn.started',
        turnId: 'N',
        invocationId: 'B',
        prompt: 'B',
      },
    },
    {
      sequence: 4,
      event: {
        ...base,
        eventId: 'A-late',
        method: 'turn.completed',
        turnId: 'N',
        invocationId: 'A',
        createdAt: '2100-01-01T00:00:00Z',
      },
    },
  ];
  const ports = {
    foldEvents: () => log,
    headSequence: () => log.length,
    coordinatorBusy: () => false,
  };
  expect(evaluateSessionWait(ports, 't1', 'turn-settled', 2)).toMatchObject({
    satisfied: false,
    view: { state: 'running', openTurnId: 'N' },
  });
  log.push({
    sequence: 5,
    event: {
      ...base,
      eventId: 'B-done',
      method: 'turn.completed',
      turnId: 'N',
      invocationId: 'B',
      createdAt: '1900-01-01T00:00:00Z',
    },
  });
  expect(evaluateSessionWait(ports, 't1', 'turn-settled', 2)).toMatchObject({
    satisfied: false,
    view: { state: 'running', openTurnId: 'N' },
  });
});

test.each([
  'wrong-native',
  'missing-native',
  'exact-native',
  'session',
  'early-missing-native',
  'raw-start-terminal',
] as const)(
  'real accepted B/N wait requires exact native custody for %s terminal',
  async (kind) => {
    const store = new EventStore(':memory:');
    const authority = store.sessionTurnBoundaryAuthority();
    const owned = authority.reserve!('t', '2030-01-01T00:00:00Z');
    if (owned.kind !== 'owner') throw new Error('wait reserve prerequisite');
    const capture = captureTurnIntent(
      { threadId: 't', input: 'B' },
      { binding: {}, requiresFreshCompanions: false },
    );
    expect(
      owned.claim.prepareIntent!(capture, undefined, '2030-01-01T00:00:01Z'),
    ).toEqual({ kind: 'applied' });
    expect(owned.claim.beginInvocation('2030-01-01T00:00:02Z')).toEqual({
      kind: 'applied',
    });
    if (kind !== 'early-missing-native')
      expect(owned.claim.accepted('N', '2030-01-01T00:00:03Z')).toEqual({
        kind: 'applied',
      });
    const base = {
      provider: 'claude',
      threadId: 't',
      createdAt: '2030-01-01T00:00:04Z',
    };
    store.appendEvent({
      ...base,
      eventId: 'B-start',
      method: 'turn.started',
      turnId: 'N',
      invocationId: capture.intent.invocationId,
      prompt: 'B',
    });
    const ports: SessionTurnWaitPorts = {
      foldEvents: () =>
        store
          .listEvents('t')
          .map((row) => ({ sequence: row.sequence, event: row.payload })),
      headSequence: () => store.readSessionInventoryHighWater('t'),
      readInputlessTurnDisposition: (threadId) =>
        store.readInputlessTurnDisposition(threadId),
      readInvocationTerminal: (threadId, invocationId, turnId) =>
        store.readInvocationTerminal(threadId, invocationId, turnId),
      coordinatorBusy: () => {
        const read = authority.hasPossibleEffect('t');
        return read.kind !== 'available' || read.active;
      },
      subscribe: (_thread, listener) =>
        store.observeCommits({
          eventCommitted() {
            listener();
          },
        }),
    };
    const controller = new AbortController();
    let outcome: unknown;
    const waiting = new SessionTurnWaiter(ports)
      .wait({
        callerSessionId: 'caller',
        threadId: 't',
        until: 'turn-settled',
        afterEventCursor: 1,
        timeoutMs: 10000,
        signal: controller.signal,
      })
      .then((value) => {
        outcome = value;
        return value;
      });
    try {
      if (kind === 'raw-start-terminal') {
        store.appendEvent({
          ...base,
          eventId: 'raw-start',
          method: 'turn.started',
          turnId: 'N',
          prompt: 'legacy observation',
        });
        store.appendEvent({
          ...base,
          eventId: 'raw-complete',
          method: 'turn.completed',
          turnId: 'N',
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(authority.hasPossibleEffect('t')).toEqual({
          kind: 'available',
          active: true,
        });
        expect(
          store.listEvents('t').find((row) => row.id === 'raw-start')?.payload
            .invocationId,
        ).toBeUndefined();
        expect(
          store.listEvents('t').find((row) => row.id === 'raw-complete')
            ?.payload.invocationId,
        ).toBeUndefined();
        expect(
          evaluateSessionWait(ports, 't', 'turn-settled', 1).satisfied,
        ).toBe(false);
        expect(outcome).toBeUndefined();
        store.appendEvent({
          ...base,
          eventId: 'exact-B-complete',
          method: 'turn.completed',
          turnId: 'N',
          invocationId: capture.intent.invocationId,
        });
      } else if (kind === 'session') {
        const ended: CanonicalRuntimeEvent = {
          ...base,
          eventId: 'session-end',
          method: 'session.exited',
          sessionId: 't',
          exitCode: 0,
        };
        store.appendEvent(ended);
        expect(authority.observe(ended)).toEqual({ kind: 'applied' });
      } else
        store.appendEvent({
          ...base,
          eventId: 'B-error',
          method: 'runtime.error',
          severity: 'error',
          message: kind,
          invocationId: capture.intent.invocationId,
          ...(['missing-native', 'early-missing-native'].includes(kind)
            ? {}
            : { turnId: kind === 'wrong-native' ? 'M' : 'N' }),
        });
      await Promise.resolve();
      if (kind === 'wrong-native' || kind === 'missing-native') {
        expect(authority.hasPossibleEffect('t')).toEqual({
          kind: 'available',
          active: true,
        });
        expect(outcome).toBeUndefined();
        if (kind === 'wrong-native') {
          store.appendEvent({
            ...base,
            eventId: 'B-exact-after-contradiction',
            method: 'turn.completed',
            turnId: 'N',
            invocationId: capture.intent.invocationId,
          });
          await Promise.resolve();
          expect(outcome).toBeUndefined();
          expect(authority.hasPossibleEffect('t')).toEqual({
            kind: 'available',
            active: true,
          });
        }
        controller.abort();
        await expect(waiting).resolves.toEqual({ kind: 'aborted' });
      } else
        await expect(waiting).resolves.toMatchObject({
          kind: 'settled',
          settledTurn: {
            outcome:
              kind === 'session'
                ? 'exited'
                : kind === 'raw-start-terminal'
                  ? 'completed'
                  : 'error',
          },
        });
    } finally {
      controller.abort();
      await waiting;
      store.close();
    }
  },
);
